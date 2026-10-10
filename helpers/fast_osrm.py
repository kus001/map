"""Small, bounded-latency OSRM foot/bike fallback; no packages or server required.

Public OSRM instances have no uptime SLA; operators may set a private compatible
instance with MAP_WALKING_OSRM_URL or MAP_CYCLING_OSRM_URL.
The value should end at /route/v1/driving (the OSRM protocol uses 'driving' as
its profile label, even for instances configured for foot or bicycle routing).
"""
import os
from functools import lru_cache

import requests

WALK_URL = os.getenv("MAP_WALKING_OSRM_URL", "https://routing.openstreetmap.de/routed-foot/route/v1/driving").rstrip("/")
BIKE_URL = os.getenv("MAP_CYCLING_OSRM_URL", "https://routing.openstreetmap.de/routed-bike/route/v1/driving").rstrip("/")

_session = requests.Session()
_session.headers.update({"User-Agent": "map-router/8.2 (routing demo)"})


@lru_cache(maxsize=256)
def osrm_route(mode, lat1, lon1, lat2, lon2):
    url = WALK_URL if mode == "walking" else BIKE_URL
    response = _session.get(
        f"{url}/{lon1},{lat1};{lon2},{lat2}",
        params={"overview": "full", "geometries": "geojson", "steps": "true", "alternatives": "false"},
        timeout=(1.6, 2.9),
    )
    response.raise_for_status()
    data = response.json()
    if data.get("code") != "Ok" or not data.get("routes"):
        raise ValueError("No route from public OSRM server")
    return data["routes"][0]


def convert_osrm(mode, route, start_address, end_address, start, end, route_type=None):
    distance_km = float(route.get("distance", 0)) / 1000
    duration_min = float(route.get("duration", 0)) / 60
    coords = [[lat, lon] for lon, lat in route.get("geometry", {}).get("coordinates", [])]
    steps = []
    for leg in route.get("legs", []):
        for step in leg.get("steps", []):
            man = step.get("maneuver") or {}
            loc = man.get("location") or []
            steps.append({
                "instruction": "", "type": man.get("type", "continue"),
                "modifier": man.get("modifier", ""), "road": step.get("name", ""),
                "name": step.get("name", ""), "distance_m": step.get("distance", 0),
                "duration_min": float(step.get("duration", 0)) / 60,
                "coordinates": [float(loc[1]), float(loc[0])] if len(loc) >= 2 else None,
            })
    return {
        "success": True, "mode": mode,
        **({"route_type": route_type} if route_type else {}),
        "start": {"address": start_address, "coordinates": list(start)},
        "end": {"address": end_address, "coordinates": list(end)},
        "routes": [{
            "route_number": 1, "distance_km": distance_km, "duration_min": duration_min,
            "average_speed": distance_km / (duration_min / 60) if duration_min else 0,
            "steps": steps, "route_coordinates": coords,
        }],
        "fastest_route_number": 1, "shortest_route_number": 1,
    }
