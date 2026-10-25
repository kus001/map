"""TomTom (Orbis) place search, used as an extra autocomplete source.

TomTom's Suggest endpoint returns titles but *no coordinates*, so each suggestion is
followed by a Details call that fetches its position. Results are cached (positions
for good, suggestion lists for a few minutes) to keep the number of billable calls low.

All coordinates TomTom sends or expects are GeoJSON order, ``[lon, lat]``. The rest of
this project uses ``(lat, lon)``, so the conversion happens only inside this file.

Run ``python -m helpers.tomtom_places "tim hortons"`` to try it against the live API.
"""

import os
import sys
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from json import dumps

import requests
from dotenv import load_dotenv

load_dotenv()

# Only used by the command-line demo below (lat,lon), not by the server.
testcoords = list(map(float, os.getenv("testcoords", "43.65373,-79.38403").split(",")))

PLACES = {
    # "bathroom": "public_bathroom",
    # "bicycle_parking": "bicycle_parking",
    # "religious_site": ("church", "gurudwara", "mosque", "pagoda", "synagog", "temple"),
}

SUGGEST_URL = "https://api.tomtom.com/maps/orbis/places/suggest"
DETAILS_URL = "https://api.tomtom.com/maps/orbis/places/details/{type}/{id}"

# Which kinds of result to ask for: "poi", "address", "street", "intersection", "area".
# Civic addresses and streets in Waterloo Region are already covered by the local index,
# so this is just POIs by default.
SEARCH_TYPES = ["poi"]
COUNTRY_CODES = ["CA"]

# Don't spend API calls on one or two typed letters.
MIN_QUERY_LENGTH = 3
MAX_RESULTS = 5
TIMEOUT = (1.5, 2.5)  # connect, read (seconds) -- autocomplete must never hang

# Details path segment for each result type (used when a result has no ``more`` link)
_DETAILS_TYPE = {
    "poi": "pois",
    "address": "addresses",
    "street": "streets",
    "intersection": "intersections",
    "area": "areas",
}

_SUGGEST_TTL = 10 * 60
_SUGGEST_CACHE_MAX = 300
_POSITION_CACHE_MAX = 2000

_lock = threading.Lock()
_suggest_cache = OrderedDict()  # (query, bias bucket) -> (expires, results)
_position_cache = OrderedDict()  # place id -> (lat, lon)
_paused_until = 0.0  # set after the key is rejected or the quota is hit


def _api_key():
    return os.getenv("TOMTOM_API_KEY", "").strip()


def available():
    return bool(_api_key())


def _headers(attributes):
    return {
        "Accept": "application/json",
        "Accept-Language": "en-CA,en",
        "Attributes": attributes,
        "TomTom-Api-Version": "3",
        "TomTom-Api-Key": _api_key(),
    }


def _pause_for(response):
    """Stop calling TomTom for a while after a bad key (401/403) or rate limit (429)."""
    global _paused_until
    if response.status_code in (401, 403):
        delay = 30 * 60
    elif response.status_code == 429:
        delay = 5 * 60
    else:
        return
    with _lock:
        _paused_until = time.monotonic() + delay


def _is_paused():
    with _lock:
        return time.monotonic() < _paused_until


def _bias_bucket(bias):
    try:
        return round(float(bias[0]), 2), round(float(bias[1]), 2)
    except (TypeError, ValueError, IndexError):
        return None


def _remember(cache, key, value, limit):
    with _lock:
        cache[key] = value
        cache.move_to_end(key)
        while len(cache) > limit:
            cache.popitem(last=False)


def _suggest(query, bias, limit):
    """Raw Suggest results (a list of dicts, no coordinates yet), or [] on any failure."""
    body = {
        "query": query,
        "maxResults": max(1, min(int(limit), 10)),
        "geopoliticalView": "Unified",
        "filters": {
            "types": SEARCH_TYPES,
            # "countryCodesIso2": COUNTRY_CODES,
        },
    }
    if bias:
        point = {"type": "point", "coordinates": [bias[1], bias[0]]}  # [lon, lat]
        body["origin"] = point  # only fills in distanceInMeters
        body["preferences"] = {"geometry": point}  # actually nudges the ranking

    try:
        response = requests.post(
            SUGGEST_URL,
            headers={
                **_headers("results(id,type,title,subtitles,more)"),
                "Content-Type": "application/json",
            },
            json=body,
            timeout=TIMEOUT,
        )
    except requests.RequestException:
        return []

    if not response.ok:
        _pause_for(response)
        return []

    try:
        return response.json().get("results") or []
    except ValueError:
        return []


def _details_path(result):
    """(type, id) for the Details URL, taken from the result's ``more`` link if it has one."""
    arguments = {}
    for item in (result.get("more") or {}).get("pathParameters") or []:
        arguments[item.get("parameter")] = item.get("argument")
    if arguments.get("type") and arguments.get("id"):
        return arguments["type"], arguments["id"]

    place_type = _DETAILS_TYPE.get(result.get("type"))
    if place_type and result.get("id"):
        return place_type, result["id"]
    return None


def _position(result):
    """(lat, lon) for a Suggest result via Details, or None."""
    path = _details_path(result)
    if path is None:
        return None

    place_type, place_id = path
    with _lock:
        known = _position_cache.get(place_id)
    if known is not None:
        return known

    try:
        response = requests.get(
            DETAILS_URL.format(type=place_type, id=place_id),
            headers=_headers("id,type,title,position"),
            timeout=TIMEOUT,
        )
    except requests.RequestException:
        return None

    if not response.ok:
        _pause_for(response)
        return None

    try:
        lon, lat = response.json()["position"]["coordinates"][:2]
        point = (float(lat), float(lon))
    except (ValueError, KeyError, TypeError):
        return None

    if not (-90 <= point[0] <= 90 and -180 <= point[1] <= 180):
        return None

    _remember(_position_cache, place_id, point, _POSITION_CACHE_MAX)
    return point


def _label(result):
    """'Title, first subtitle'. The subtitle (usually the street address) keeps different
    branches of the same chain from looking like duplicates in the dropdown."""
    title = str(result.get("title") or "").strip()
    subtitles = result.get("subtitles") or []
    subtitle = str(subtitles[0]).strip() if subtitles else ""
    if title and subtitle and subtitle.lower() not in title.lower():
        return f"{title}, {subtitle}"
    return title or subtitle


def search(query, limit=3, bias=None):
    """Autocomplete-style place search.

    ``bias`` is an optional ``(lat, lon)``; closer places rank higher but nothing is
    excluded by distance. Returns up to ``limit`` dicts shaped like the other search
    sources: ``{"label", "lat", "lon", "source": "tomtom", "kind"}``. Never raises:
    a missing key, a network error or a rejected request just gives ``[]``.
    """
    query = " ".join(str(query).split())
    limit = max(1, min(int(limit), MAX_RESULTS))

    if len(query) < MIN_QUERY_LENGTH or not available() or _is_paused():
        return []

    cache_key = (query.lower(), limit, _bias_bucket(bias))
    with _lock:
        cached = _suggest_cache.get(cache_key)
        if cached and cached[0] > time.monotonic():
            _suggest_cache.move_to_end(cache_key)
            return [dict(item) for item in cached[1]]

    suggestions = [r for r in _suggest(query, bias, limit) if r.get("type") != "discoverAction"]
    if not suggestions:
        return []

    with ThreadPoolExecutor(max_workers=len(suggestions)) as pool:
        points = list(pool.map(_position, suggestions))

    results = []
    for suggestion, point in zip(suggestions, points):
        label = _label(suggestion)
        if point is None or not label:
            continue
        results.append(
            {
                "label": label,
                "lat": point[0],
                "lon": point[1],
                "source": "tomtom",
                "kind": suggestion.get("type"),
            }
        )

    # Only remember complete answers, so a hiccup in a Details call isn't cached.
    if len(results) == len(suggestions):
        _remember(_suggest_cache, cache_key, (time.monotonic() + _SUGGEST_TTL, results), _SUGGEST_CACHE_MAX)
    return [dict(item) for item in results]


if __name__ == "__main__":
    text = " ".join(sys.argv[1:]) or "coffee"
    if not available():
        sys.exit("Set TOMTOM_API_KEY (in .env or the environment) first.")
    print(f"Searching for {text!r} near {testcoords}")
    print(dumps(search(text, limit=MAX_RESULTS, bias=tuple(testcoords)), indent=4))
