# Geocoding.py

from functools import lru_cache

from geopy.geocoders import Nominatim
from geopy.extra.rate_limiter import RateLimiter

geolocator = Nominatim(user_agent="thirdspace_map_router/1.0")

geocode = RateLimiter(
    geolocator.geocode,
    min_delay_seconds=1,
    max_retries=2,
    error_wait_seconds=2,
    swallow_exceptions=False
)

@lru_cache(maxsize=512)
def get_coordinates(address):

    clean_address = address.strip()

    if not clean_address:
        return None

    try:
        print("Geocoding:", clean_address)

        location = geocode(clean_address, timeout=10)

        if location is None:
            print("NOT FOUND:", clean_address)
            return None

        coordinates = (location.latitude, location.longitude)

        print("FOUND:", clean_address, coordinates)

        return coordinates
    
    except Exception as error:
        print("GEOCODING ERROR:", clean_address, repr(error))

        return None