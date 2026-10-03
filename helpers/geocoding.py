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
import sys
from pathlib import Path
from local_geocode import local_geocode

cwd = Path.cwd()
sys.path.append(str(cwd / "helpers"))

from geopy.geocoders import Nominatim
from geopy.extra.rate_limiter import RateLimiter

KNOWN_PLACES_PATH = Path(__file__).parent / "known_places.json"
GEOCODE_CACHE_PATH = Path("transit_data") / "geocode_cache.json"

# Roughly the the Region of Waterloo bounding box, used to bias Nominatim results to the local area.
# This is not a hard limit and thus results outside this box can still be returned.
# i.e. if they are a better match than any local results.
WATERLOO_REGION_VIEWBOX = [(43.65, -80.65), (43.30, -80.25)]  # (north-west), (south-east)

geolocator = Nominatim(user_agent="thirdspace_map_router/1.0")

geocode = RateLimiter(
    geolocator.geocode,
    min_delay_seconds=1,
    max_retries=2,
    error_wait_seconds=2,
    swallow_exceptions=False
)

def _normalize_cache_key(address):
    return re.sub(r"\s+", " ", address.strip().lower())

def _load_known_places():
    try:
        with open(KNOWN_PLACES_PATH, encoding="utf-8") as f:
            raw = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    return {
        k.lower(): tuple(v)
        for k, v in raw.items()
        if not k.startswith("_") and isinstance(v, list) and len(v) == 2
    }

def _load_cache():
    try:
        with open(GEOCODE_CACHE_PATH, encoding="utf-8") as f:
            raw = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    return {k: tuple(v) for k, v in raw.items()}

def _save_cache():
    GEOCODE_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(GEOCODE_CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump({k: list(v) for k, v in _cache.items()}, f)

_known_places = _load_known_places()
_cache = _load_cache()

def get_coordinates(address):
    clean_address = address.strip()
    if not clean_address:
        return None

    key = _normalize_cache_key(clean_address)

    if key in _known_places:
        return _known_places[key]

    if key in _cache:
        return _cache[key]

    local_result = local_geocode(clean_address)
    if local_result is not None:
        _cache[key] = local_result
        _save_cache()
        return local_result

    try:
        location = geocode(
            clean_address,
            timeout=10,
            viewbox=WATERLOO_REGION_VIEWBOX,
            bounded=False,  # prefer results in the region but don't hard-exclude real matches outside it
        )

        if location is None:
            return None

        coordinates = (location.latitude, location.longitude)
        _cache[key] = coordinates
        _save_cache()
        return coordinates

    except Exception as error:
        print("GEOCODING ERROR:", clean_address, repr(error))
        return None
