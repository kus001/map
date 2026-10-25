"""Approximate (city-level) visitor location, with no browser permission prompt.

The host's edge network already works out roughly where a request came from and
passes it along as headers (Vercel and Cloudflare both do). Reading those costs
nothing, needs no third-party IP lookup, and the value never leaves our server
except back to the same visitor.

Hosts that don't send those headers (local development, a plain self-hosted server)
can set ``MAP_APPROX_LOCATION="lat,lon"`` as the answer to give instead.

It is only good for "somewhere near here": biasing search results and picking the
first view of the map.
"""

import math
import os

# (latitude header, longitude header); headers are matched case-insensitively
_HEADER_PAIRS = (
    ("x-vercel-ip-latitude", "x-vercel-ip-longitude"),
    ("cf-iplatitude", "cf-iplongitude"),
)

# 2 decimals is ~1 km: plenty for a bias or a map centre, and no more precise than
# the data really is.
_DECIMALS = 2


def clean_point(lat, lon):
    """[lat, lon] rounded to city-level precision, or None if it isn't a real place."""
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(lat) and math.isfinite(lon)):
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    if lat == 0 and lon == 0:  # "null island": what a failed lookup tends to produce
        return None
    return [round(lat, _DECIMALS), round(lon, _DECIMALS)]


def configured_fallback():
    """[lat, lon] from MAP_APPROX_LOCATION ("lat,lon"), or None if unset or malformed."""
    lat, _, lon = os.getenv("MAP_APPROX_LOCATION", "").partition(",")
    return clean_point(lat.strip() or None, lon.strip() or None)


def from_headers(headers):
    """Approximate [lat, lon] for a request: the host's headers, else the configured
    fallback, else None."""
    for lat_name, lon_name in _HEADER_PAIRS:
        point = clean_point(headers.get(lat_name), headers.get(lon_name))
        if point is not None:
            return point
    return configured_fallback()
