"""Geocoding helpers for the map router.

Resolution order (see resolve_address):
1. Literal ``lat, lon`` coordinates.
2. Curated aliases in ``known_places.json`` and ``transit_data/geocode_cache.json``.
3. Places selected from autocomplete during the current server session.
4. Waterloo Region's local address-point index (exact, typo-corrected, or ambiguous).
5. Nominatim as a last-resort network geocoder, cross-checked against the local
   street data when the local index knew the street but not the exact civic number.

Autocomplete (search_places) additionally mixes in a few TomTom place suggestions
(helpers/tomtom_places.py) when TOMTOM_API_KEY is set. Picking one remembers its
coordinates for the session, so routing doesn't need to geocode it again.
"""

import json
import math
import re
import threading
import time
from collections import OrderedDict
from difflib import SequenceMatcher
from functools import lru_cache
from pathlib import Path

from geopy.geocoders import Nominatim

from helpers import named_places, tomtom_places
from helpers.local_geocode import resolve_detailed, search_local

PROJECT_ROOT = Path(__file__).resolve().parents[1]
KNOWN_PLACES_PATH = PROJECT_ROOT / "transit_data" / "known_places.json"
GEOCODE_CACHE_PATH = PROJECT_ROOT / "transit_data" / "geocode_cache.json"


WATERLOO_REGION_VIEWBOX = [
    (43.65, -80.65),
    (43.30, -80.25),
]
REGION_CENTER = (43.46, -80.52)

# How far around the user's (approximate) position Nominatim should look first. This is a
# preference, not a fence (bounded=False), so a farther place can still win on importance.
_NEARBY_HALF_SPAN_DEG = 0.3  # ~33 km north-south

_COORDINATE_RE = re.compile(
    r"^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$"
)

_geolocator = Nominatim(user_agent="thirdspace_map_router/2.0")

_NOMINATIM_MIN_INTERVAL = 1.0
_NOMINATIM_TIMEOUT = 2.5
_NEGATIVE_TTL = 15 * 60
_NEGATIVE_MAX = 500
_nominatim_lock = threading.Lock()
_last_nominatim_call = 0.0
_negative_cache = OrderedDict()
_negative_lock = threading.Lock()

_NOMINATIM_DISAGREE_KM = 5.0

# Network results depend on where the asker is, so they must not go in the shared
# (text-only) caches above: one visitor's location would decide everyone's answer.
# They live here instead, per ~25 km bucket of bias, in memory only.
_NETWORK_CACHE_MAX = 500
_network_cache = OrderedDict()
_network_lock = threading.Lock()


def _bias_bucket(bias):
    point = _valid_point(bias) if bias else None
    if point is None:
        return None
    return (round(point[0] * 4) / 4, round(point[1] * 4) / 4)


def _network_recall(key, bias):
    cache_key = (key, _bias_bucket(bias))
    with _network_lock:
        found = _network_cache.get(cache_key)
        if found is not None:
            _network_cache.move_to_end(cache_key)
        return found


def _network_remember(key, bias, found):
    cache_key = (key, _bias_bucket(bias))
    with _network_lock:
        _network_cache[cache_key] = found
        _network_cache.move_to_end(cache_key)
        while len(_network_cache) > _NETWORK_CACHE_MAX:
            _network_cache.popitem(last=False)


def _viewbox_around(bias):
    """Nominatim viewbox (two opposite corners) centred on ``bias``, else the home region."""
    point = _valid_point(bias) if bias else None
    if point is None:
        return WATERLOO_REGION_VIEWBOX
    lat, lon = point
    half_lat = _NEARBY_HALF_SPAN_DEG
    # a degree of longitude is shorter away from the equator; keep the box roughly square
    half_lon = min(half_lat / max(math.cos(math.radians(lat)), 0.2), 5.0)
    return [
        (min(lat + half_lat, 90.0), max(lon - half_lon, -180.0)),
        (max(lat - half_lat, -90.0), min(lon + half_lon, 180.0)),
    ]


def _normalize_key(value):
    return re.sub(r"\s+", " ", str(value).strip().lower())


def _write_coordinate_map(data, path=GEOCODE_CACHE_PATH, reload=True):
    """Write the JSON file"""
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)

    if reload:
        global _cached_places, _saved_aliases
        _cached_places = _load_coordinate_map(GEOCODE_CACHE_PATH)
        _saved_aliases = _load_coordinate_map(KNOWN_PLACES_PATH)

def _km(a, b):
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    h = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    )
    return 6371.0 * 2 * math.asin(math.sqrt(h))


def _valid_point(point) -> None|tuple[float, float]:
    """Check if the point is valid, returns None if it isn't, otherwise the point"""
    try:
        lat, lon = float(point[0]), float(point[1])
    except (TypeError, ValueError, IndexError, KeyError):
        return None
    if -90 <= lat <= 90 and -180 <= lon <= 180:
        return (lat, lon)
    return None


def _load_coordinate_map(path):
    """Load a simple {name: [lat, lon]} JSON file safely."""
    try:
        with path.open(encoding="utf-8") as file:
            raw = json.load(file)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}

    result = {}

    for key, value in raw.items():
        if str(key).startswith("_"):
            continue

        if not isinstance(value, (list, tuple)) or len(value) != 2:
            continue

        point = _valid_point(value)
        if point is not None:
            result[_normalize_key(key)] = point

    return result



_cached_places = _load_coordinate_map(GEOCODE_CACHE_PATH)
_saved_aliases = _load_coordinate_map(KNOWN_PLACES_PATH)

_runtime_cache = OrderedDict(_cached_places)
_runtime_lock = threading.Lock()


def _remember_runtime(key, coordinates):
    with _runtime_lock:
        _runtime_cache[key] = coordinates
        _write_coordinate_map(_runtime_cache)


def _recall_runtime(key):
    with _runtime_lock:
        coordinates = _runtime_cache.get(key)
        if coordinates is not None:
            _runtime_cache.move_to_end(key)
        return coordinates


def remember_place(label, lat, lon):
    """Remember an autocomplete result for this server session only.

    The frontend calls this after the user selects an autocomplete suggestion so
    routing can reuse its exact coordinates. Nothing is written to disk.
    """
    key = _normalize_key(label)
    if not key:
        return

    point = _valid_point((lat, lon))
    if point is not None:
        _remember_runtime(key, point)




_LOWER_WORDS = {"of", "the", "and", "at", "de", "du"}
_known_places = None
_known_lock = threading.Lock()


def _display_name(key):
    words = key.split()
    if len(words) == 1 and len(words[0]) <= 4:
        return words[0].upper()
    shown = []
    for index, word in enumerate(words):
        if len(word) <= 2 and word.isalpha() and word not in _LOWER_WORDS:
            shown.append(word.upper())
        elif index and word in _LOWER_WORDS:
            shown.append(word)
        else:
            shown.append(word.capitalize())
    return " ".join(shown)


def _known_groups():
    """[(coordinates, display_name, [alias keys])], one group per distinct place."""
    global _known_places

    if _known_places is None:
        with _known_lock:
            if _known_places is None:
                grouped = {}
                for source in (_saved_aliases, _cached_places):
                    for key, coordinates in source.items():
                        grouped.setdefault(coordinates, []).append(key)
                _known_places = [
                    (coordinates, _display_name(max(keys, key=len)), keys)
                    for coordinates, keys in grouped.items()
                ]
    return _known_places


def _alias_score(query, alias):
    if alias == query:
        return 3.0
    if alias.startswith(query):
        return 2.5
    if any(word.startswith(query) for word in alias.split()[1:]):
        return 2.0
    if len(query) >= 3 and query in alias:
        return 1.0
    if len(query) >= 4:
        ratio = SequenceMatcher(None, query, alias).ratio()
        if ratio >= 0.8:
            return ratio
    return 0.0


def _search_known(query, limit, bias):
    q = _normalize_key(query)
    if len(q) < 2:
        return []

    scored = []
    for coordinates, display, keys in _known_groups():
        score = max(_alias_score(q, key) for key in keys)
        if score <= 0:
            continue
        dist = _km(bias, coordinates) if bias else 0.0
        scored.append((-score, round(dist, 1), display, coordinates))

    scored.sort()
    return [
        {"label": display, "lat": coordinates[0], "lon": coordinates[1], "source": "known"}
        for _score, _dist, display, coordinates in scored[:limit]
    ]


def _negative_hit(key):
    now = time.monotonic()
    with _negative_lock:
        expiry = _negative_cache.get(key)
        if expiry is None:
            return False
        if expiry < now:
            del _negative_cache[key]
            return False
        return True


def _remember_negative(key):
    with _negative_lock:
        _negative_cache[key] = time.monotonic() + _NEGATIVE_TTL
        _negative_cache.move_to_end(key)
        while len(_negative_cache) > _NEGATIVE_MAX:
            _negative_cache.popitem(last=False)


# Nearness penalty when choosing between candidates, in the same units as Nominatim's
# "importance" (0..1): 0.1 per 25 km, capped at 0.4 (reached at 100 km). So a place
# next door beats an equally relevant one in the next city, while a genuinely famous
# far place (importance well above a local one) can still win.
_NEAR_PENALTY_KM = 250.0
_NEAR_PENALTY_MAX = 0.4


def _pick_nominatim(locations, bias):
    """Choose between Nominatim candidates: importance, pulled toward the closer one.

    With no ``bias`` the reference is the middle of the home region.
    """
    reference = _valid_point(bias) if bias else None
    reference = reference or REGION_CENTER
    best, best_score = None, None

    for rank, location in enumerate(locations):
        raw = getattr(location, "raw", None) or {}
        try:
            importance = float(raw.get("importance") or 0.0)
        except (TypeError, ValueError):
            importance = 0.0
        dist = _km(reference, (location.latitude, location.longitude))
        score = importance - min(dist / _NEAR_PENALTY_KM, _NEAR_PENALTY_MAX) - rank * 0.01
        if best_score is None or score > best_score:
            best, best_score = location, score

    return best


def _nominatim_lookup(query, bias=None):
    """Return (lat, lon, label) from Nominatim, or None."""
    key = _normalize_key(query)
    if _negative_hit(key):
        return None

    global _last_nominatim_call
    locations = None

    with _nominatim_lock:
        wait = _NOMINATIM_MIN_INTERVAL - (time.monotonic() - _last_nominatim_call)
        if wait > 0:
            time.sleep(wait)
        _last_nominatim_call = time.monotonic()

        try:
            locations = _geolocator.geocode(
                query,
                exactly_one=False,
                limit=5,
                timeout=_NOMINATIM_TIMEOUT,
                viewbox=_viewbox_around(bias),
                bounded=False,
                country_codes="ca",
            )
        except Exception:

            return None

    if not locations:
        _remember_negative(key)
        return None

    chosen = _pick_nominatim(locations, bias)
    return (
        float(chosen.latitude),
        float(chosen.longitude),
        getattr(chosen, "address", None) or query,
    )

_named_locations = {}


def _in_region(point):
    (south, west), (north, east) = WATERLOO_REGION_VIEWBOX[1], WATERLOO_REGION_VIEWBOX[0]
    return min(south, north) <= point[0] <= max(south, north) and \
        min(west, east) <= point[1] <= max(west, east)


def _locate_named(entry, allow_network=True):
    """(lat, lon) for a named place, or None if it can't be placed (yet)."""
    known = _named_locations.get(entry["id"])
    if known is not None:
        return known

    point = entry["coordinates"]

    if point is None and entry["address"]:
        status, payload = resolve_detailed(entry["address"])
        if status == "ok":
            point = (float(payload[2]), float(payload[3]))
        elif status == "approximate":
            point = (float(payload[0]), float(payload[1]))

    if point is None and allow_network:
        text = (
            entry["query"]
            or entry["address"]
            or ", ".join(part for part in (entry["name"], entry["city"]) if part)
        )
        found = _nominatim_lookup(text)

        if found is not None and _in_region((found[0], found[1])):
            point = (found[0], found[1])

    if point is not None:
        _named_locations[entry["id"]] = point
    return point


def _named_options(entries, bias, allow_network):
    located = []
    for entry in entries:
        point = _locate_named(entry, allow_network=allow_network)
        if point is not None:
            located.append({"label": entry["name"], "lat": point[0], "lon": point[1]})
    return _sort_options(located, bias)


def _search_named(query, limit, bias):
    """Autocomplete for named places. Ones that still need the network are left out
    until they have been located, so typing never waits on a slow lookup."""
    scored = []
    for score, entry in named_places.search(query, limit * 2):
        point = _locate_named(entry, allow_network=False)
        if point is None:
            continue
        dist = _km(bias, point) if bias else 0.0
        scored.append((-score, round(dist, 1), entry["name"], point))

    scored.sort()
    return [
        {"label": name, "lat": point[0], "lon": point[1], "source": "known"}
        for _score, _dist, name, point in scored[:limit]
    ]


def prime_named_places():
    """Locate every named place now; ones that need the network finish in the
    background so startup is never held up. Returns a one-line summary."""
    entries = named_places.entries()
    pending = [e for e in entries if _locate_named(e, allow_network=False) is None]

    if pending:
        def work():
            found = sum(1 for entry in pending if _locate_named(entry) is not None)
            if found:
                _search_places_cached.cache_clear()

        threading.Thread(target=work, name="named-places-prime", daemon=True).start()

    return (
        f"{len(entries) - len(pending)} placed offline"
        + (f", {len(pending)} resolving in background" if pending else "")
    )


def _coordinates_from_text(value):
    match = _COORDINATE_RE.match(value)
    if not match:
        return None

    return _valid_point((match.group(1), match.group(2)))


def _result(status, point=None, label=None, source=None, options=None):
    return {
        "status": status,
        "lat": point[0] if point else None,
        "lon": point[1] if point else None,
        "label": label,
        "source": source,
        "options": options or [],
    }


def _entry_option(entry):
    return {"label": entry[4], "lat": entry[2], "lon": entry[3]}


def _sort_options(options, bias):
    if bias:
        options.sort(key=lambda o: _km(bias, (o["lat"], o["lon"])))
    return options


def resolve_address(address, bias=None, allow_network=True):
    """Resolve typed text to a place, explaining failures instead of guessing.

    Returns a dict: ``status`` is "ok", "approximate" (street known, civic number
    placed beside its nearest neighbour), "ambiguous" / "mismatch" (``options`` lists
    candidates the user should choose from) or "not_found".
    ``bias`` is an optional (lat, lon) used to order options and pick between
    otherwise equal network results.
    """
    clean = str(address).strip()
    if not clean:
        return _result("not_found")

    bias = _valid_point(bias) if bias else None

    direct = _coordinates_from_text(clean)
    if direct is not None:
        return _result("ok", direct, clean, "coordinates")

    key = _normalize_key(clean)

    for source in (_cached_places, _saved_aliases):
        if key in source:
            return _result("ok", source[key], clean, "known")

    named = named_places.find_exact(clean)
    if named:
        options = _named_options(named, bias, allow_network=True)
        if len(options) == 1:
            only = options[0]
            return _result("ok", (only["lat"], only["lon"]), only["label"], "named")
        if len(options) > 1:
            return _result("ambiguous", options=options)

    remembered = _recall_runtime(key)
    if remembered is not None:
        return _result("ok", remembered, clean, "session")

    status, payload = resolve_detailed(clean)

    if status == "ok":
        point = (float(payload[2]), float(payload[3]))
        _remember_runtime(key, point)
        return _result("ok", point, payload[4], "local")

    if status in ("ambiguous", "mismatch"):
        options = _sort_options([_entry_option(e) for e in payload], bias)
        return _result(status, options=options)

    approximate = None
    if status == "approximate":
        approximate = ((float(payload[0]), float(payload[1])), payload[2])

    found = _network_recall(key, bias)
    if found is None and allow_network:
        found = _nominatim_lookup(clean, bias)

    if found is not None:
        point = (found[0], found[1])
        if approximate is None or _km(point, approximate[0]) <= _NOMINATIM_DISAGREE_KM:
            _network_remember(key, bias, found)
            return _result("ok", point, found[2], "nominatim")

    if approximate is not None:
        return _result("approximate", approximate[0], approximate[1], "local")

    return _result("not_found")


def get_coordinates(address, bias=None):
    """(lat, lon) for typed text, or None when it is missing or needs a choice."""
    result = resolve_address(address, bias=bias)
    if result["status"] in ("ok", "approximate"):
        return (result["lat"], result["lon"])
    return None


def address_options(address, bias=None):
    """Local-only check: (status, options) when the user must choose or correct."""
    named = named_places.find_exact(str(address))
    if len(named) > 1:
        options = _named_options(named, bias, allow_network=False)
        if len(options) > 1:
            return "ambiguous", options

    status, payload = resolve_detailed(str(address).strip())
    if status in ("ambiguous", "mismatch") and payload:
        return status, _sort_options([_entry_option(e) for e in payload], bias)
    return status, []


def explain_address_problem(address, default="Address couldn't be found.", bias=None):
    """Human-readable reason get_coordinates() returned None, with suggestions
    (nearest ``bias`` first when given)."""
    status, options = address_options(address, bias=bias)
    labels = [option["label"] for option in options]

    if status == "ambiguous" and labels:
        return "That address matches more than one place. Pick one: " + "; ".join(labels)

    if status == "mismatch" and labels:
        return "No address with that street type. Did you mean: " + "; ".join(labels)

    return default


def _bias_key(bias):
    point = _valid_point(bias) if bias else None
    if point is None:
        return None
    return (round(point[0], 2), round(point[1], 2))


@lru_cache(maxsize=512)
def _search_places_cached(query, limit, bias_key) -> tuple:
    clean_query = re.sub(r"\s+", " ", str(query).strip())
    if len(clean_query) < 2:
        return tuple()

    named = _search_named(clean_query, limit, bias_key)
    known = _search_known(clean_query, limit, bias_key)
    local = search_local(clean_query, limit=limit, bias=bias_key)



    ordered = (
        local + named + known
        if clean_query[0].isdigit()
        else named + known + local
    )

    merged, seen = [], set()
    for result in ordered:
        label_key = result["label"].lower()
        if label_key in seen:
            continue
        seen.add(label_key)
        merged.append((result["label"], result["lat"], result["lon"], result["source"]))
        if len(merged) >= limit:
            break

    return tuple(merged)


_TOMTOM_MAX_EXTRA = 3


def _tomtom_extras(query, limit, bias):
    """A few TomTom place suggestions to sit alongside the local results (never raises)."""
    wanted = min(_TOMTOM_MAX_EXTRA, limit // 2)
    if wanted < 1:
        return []
    try:
        return tomtom_places.search(query, limit=wanted, bias=_valid_point(bias) if bias else None)
    except Exception:
        return []


def search_places(query, limit=6, bias=None):
    """Return autocomplete results: curated places, civic addresses, streets, plus a few
    TomTom places (``source: "tomtom"``) when a TOMTOM_API_KEY is configured.

    The React frontend merges these with MapTiler POI/place suggestions. ``bias`` is
    an optional (lat, lon) used to rank equally good matches by nearness. At most
    ``limit`` results are returned in total; TomTom's share is small and is left out
    entirely when there's no key, so offline operation is unchanged.
    """
    limit = max(1, min(int(limit), 10))

    local = [
        {"label": label, "lat": lat, "lon": lon, "source": source}
        for label, lat, lon, source in _search_places_cached(
            query, limit, _bias_key(bias)
        )
    ]

    seen = {item["label"].lower() for item in local}
    extras = [
        item for item in _tomtom_extras(query, limit, bias)
        if item["label"].lower() not in seen
    ]

    return local[: limit - len(extras)] + extras
