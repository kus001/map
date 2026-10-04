# Geocoding.py
#
# Resolution order, fastest/most-reliable first:
#   1. known_places.json  — user-defined ("home", "work", ...)
#   2. geocode_cache.json — every address ever successfully resolved before
#   3. local_geocode.py   — municipal open-data address points, offline, no network
#   4. Nominatim          — last resort; rate-limited and biased to the Waterloo Region
#                            bounding box so city/province no longer need to be typed

import json
import re
from functools import lru_cache
from pathlib import Path

from helpers.local_geocode import local_geocode, search_local
from geopy.geocoders import Nominatim
from geopy.extra.rate_limiter import RateLimiter

PROJECT_ROOT = (Path(__file__).resolve().parents[1])
KNOWN_PLACES_PATH = (PROJECT_ROOT / "helpers" / "known_places.json")
GEOCODE_CACHE_PATH = (PROJECT_ROOT / "transit_data" / "geocode_cache.json")

# Roughly the the Region of Waterloo bounding box, used to bias Nominatim results to the local area.
# This is not a hard limit and thus results outside this box can still be returned.
# i.e. if they are a better match than any local results.
WATERLOO_REGION_VIEWBOX = [(43.65, -80.65), (43.30, -80.25)]  # (north-west), (south-east)
_COORDINATE_RE = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$")

_geolocator = Nominatim(user_agent="thirdspace_map_router/1.0")

_geocode = RateLimiter(
    _geolocator.geocode,
    min_delay_seconds=1,
    max_retries=2,
    error_wait_seconds=2,
    swallow_exceptions=True
)

def _normalize_cache_key(address):
    return re.sub(r"\s+", " ", address.strip().lower())

def _load_known_places():
    try:
        with KNOWN_PLACES_PATH.open(encoding="utf-8") as file:
            raw = json.load(file)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    return {
        key.lower(): tuple(value)
        for key, value in raw.items()
        if not key.startswith("_") and isinstance(value, list) and len(value) == 2
    }

def _load_cache():
    try:
        with GEOCODE_CACHE_PATH.open(encoding="utf-8") as file:
            raw = json.load(file)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    return {key: tuple(value) for key, value in raw.items()}

def _save_cache():
    GEOCODE_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with GEOCODE_CACHE_PATH.open("w", encoding="utf-8") as file:
        json.dump({key: list(value) for key, value in _cache.items()}, file)

_known_places = _load_known_places()
_cache = _load_cache()

def _coordinates_from_text(value):
    match = _COORDINATE_RE.match(value)
    if not match:
        return None
    lat = float(match.group(1))
    lon = float(match.group(2))

    if (-90 <= lat <= 90 and -180 <= lon <= 180):
        return (lat, lon)

    return None

def remember_place(label, lat, lon):
    key = _normalize_cache_key(label)
    coordinates = (float(lat), float(lon))

    if not key:
        return

    if (_cache.get(key) != coordinates):
        _cache[key] = coordinates
        _save_cache()

def get_coordinates(address):
    clean_address = address.strip()
    if not clean_address:
        return None

    direct_coordinates = (_coordinates_from_text(clean_address))

    if (direct_coordinates is not None):
        return (direct_coordinates)

    key = _normalize_cache_key(clean_address)

    if key in _known_places:
        return _known_places[key]

    if key in _cache:
        return _cache[key]

    local_result = local_geocode(clean_address)
    if local_result is not None:
        # _cache[key] = tuple(local_result)
        # _save_cache()
        return tuple(local_result)

    
    location = _geocode(
        clean_address,
        timeout=10,
        viewbox=WATERLOO_REGION_VIEWBOX,
        bounded=False,  # prefer results in the region but don't hard-exclude real matches outside it
        country_codes="ca"
    )

    if location is None:
        return None

    coordinates = (float(location.latitude), float(location.longitude))
    _cache[key] = coordinates
    _save_cache()
    return coordinates

@lru_cache(maxsize=256)
def _search_places_cached(query, limit):
    clean_query = re.sub(r"\s+", " ", query.strip())
    if (len(clean_query) < 2):
        return tuple()

    results = search_local(clean_query, limit=limit)

    return tuple((result["label"], result["lat"], result["lon"], result["source"]) for result in results[:limit])

def search_places(query, limit=6):
    limit = max(1, min(int(limit), 10))
    return [
        {
        "label": label,
        "lat": lat,
        "lon": lon,
        "source": source
        }
        for (label, lat, lon, source) in _search_places_cached(query, limit)
    ]