"""Geocoding helpers for the map router.

Resolution order:
1. Literal ``lat, lon`` coordinates.
2. Curated aliases in ``known_places.json`` (if present).
3. Curated aliases / short forms in ``transit_data/geocode_cache.json``.
4. Places selected from autocomplete during the current server session.
5. Waterloo Region's local address-point index.
6. Nominatim as a last-resort network geocoder.

Important: ``geocode_cache.json`` is treated as project data and is READ ONLY at
runtime. Normal searches, local address lookups, Nominatim results, and
autocomplete selections never get written into it.
"""

import json
import re
from collections import OrderedDict
from functools import lru_cache
from pathlib import Path

from geopy.extra.rate_limiter import RateLimiter
from geopy.geocoders import Nominatim

from helpers.local_geocode import local_resolve, search_local

PROJECT_ROOT = Path(__file__).resolve().parents[1]
KNOWN_PLACES_PATH = PROJECT_ROOT / "helpers" / "known_places.json"
GEOCODE_CACHE_PATH = PROJECT_ROOT / "transit_data" / "geocode_cache.json"

# Rough Waterloo Region viewbox. This biases Nominatim toward local results,
# but bounded=False still allows valid matches elsewhere in Canada.
WATERLOO_REGION_VIEWBOX = [
    (43.65, -80.65),
    (43.30, -80.25),
]

_COORDINATE_RE = re.compile(
    r"^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$"
)

_geolocator = Nominatim(user_agent="thirdspace_map_router/2.0")
_geocode = RateLimiter(
    _geolocator.geocode,
    min_delay_seconds=1,
    max_retries=2,
    error_wait_seconds=2,
    swallow_exceptions=True,
)


def _normalize_key(value):
    return re.sub(r"\s+", " ", str(value).strip().lower())


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

        try:
            lat = float(value[0])
            lon = float(value[1])
        except (TypeError, ValueError):
            continue

        if -90 <= lat <= 90 and -180 <= lon <= 180:
            result[_normalize_key(key)] = (lat, lon)

    return result


# Both of these are persistent project data loaded once at startup.
# They are never modified by this module.
_known_places = _load_coordinate_map(KNOWN_PLACES_PATH)
_saved_aliases = _load_coordinate_map(GEOCODE_CACHE_PATH)

# This is deliberately RAM-only. It speeds up repeated lookups during the current
# Flask session without polluting geocode_cache.json or creating a search-history
# file in the repository. Keep it bounded for low-memory servers.
_RUNTIME_CACHE_MAX = 512
_runtime_cache = OrderedDict()


def _remember_runtime(key, coordinates):
    if key in _runtime_cache:
        _runtime_cache.move_to_end(key)

    _runtime_cache[key] = coordinates

    while len(_runtime_cache) > _RUNTIME_CACHE_MAX:
        _runtime_cache.popitem(last=False)


def _coordinates_from_text(value):
    match = _COORDINATE_RE.match(value)
    if not match:
        return None

    lat = float(match.group(1))
    lon = float(match.group(2))

    if -90 <= lat <= 90 and -180 <= lon <= 180:
        return (lat, lon)

    return None


def remember_place(label, lat, lon):
    """Remember an autocomplete result for this server session only.

    The frontend calls this after the user selects an autocomplete suggestion so
    routing can reuse its exact coordinates. Nothing is written to disk.
    """
    key = _normalize_key(label)
    if not key:
        return

    try:
        coordinates = (float(lat), float(lon))
    except (TypeError, ValueError):
        return

    if not (-90 <= coordinates[0] <= 90 and -180 <= coordinates[1] <= 180):
        return

    _remember_runtime(key, coordinates)


def get_coordinates(address):
    clean_address = str(address).strip()
    if not clean_address:
        return None

    direct_coordinates = _coordinates_from_text(clean_address)
    if direct_coordinates is not None:
        return direct_coordinates

    key = _normalize_key(clean_address)

    # Intentionally saved project aliases / shorthand names.
    if key in _known_places:
        return _known_places[key]

    if key in _saved_aliases:
        return _saved_aliases[key]

    # Exact coordinates remembered from an autocomplete selection this session.
    if key in _runtime_cache:
        _runtime_cache.move_to_end(key)
        return _runtime_cache[key]

    # Civic addresses are resolved from address_points.csv via the generated
    # address_index_cache_v3.pkl. We only keep the result in RAM here.
    status, payload = local_resolve(clean_address)

    if status == "ok":
        coordinates = (float(payload[0]), float(payload[1]))
        _remember_runtime(key, coordinates)
        return coordinates

    if status in ("ambiguous", "mismatch"):
        # Never guess between "Chesapeake Dr" and "Chesapeake Cres" (or between two
        # towns), and never hand an address the municipality knows is different to
        # Nominatim. Returning None lets the caller report it; see
        # explain_address_problem().
        return None

    # Last resort for typed places that were not selected through autocomplete.
    location = _geocode(
        clean_address,
        timeout=10,
        viewbox=WATERLOO_REGION_VIEWBOX,
        bounded=False,
        country_codes="ca",
    )

    if location is None:
        return None

    coordinates = (float(location.latitude), float(location.longitude))
    _remember_runtime(key, coordinates)
    return coordinates


def explain_address_problem(address, default="Address couldn't be found."):
    """Human-readable reason get_coordinates() returned None, with suggestions."""
    status, payload = local_resolve(str(address).strip())

    if status == "ambiguous" and payload:
        return "That address matches more than one place. Pick one: " + "; ".join(payload)

    if status == "mismatch" and payload:
        return "No address with that street type. Did you mean: " + "; ".join(payload)

    return default


@lru_cache(maxsize=256)
def _search_places_cached(query, limit):
    clean_query = re.sub(r"\s+", " ", str(query).strip())
    if len(clean_query) < 2:
        return tuple()

    results = search_local(clean_query, limit=limit)

    return tuple(
        (
            result["label"],
            result["lat"],
            result["lon"],
            result["source"],
        )
        for result in results[:limit]
    )


def search_places(query, limit=6):
    """Return local address autocomplete results.

    The React frontend merges these with MapTiler POI/place suggestions.
    """
    limit = max(1, min(int(limit), 10))

    return [
        {
            "label": label,
            "lat": lat,
            "lon": lon,
            "source": source,
        }
        for label, lat, lon, source in _search_places_cached(query, limit)
    ]
