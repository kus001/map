import os
from functools import lru_cache

import requests
from dotenv import load_dotenv

from helpers.geocoding import explain_address_problem, get_coordinates
from helpers.fast_osrm import osrm_route, convert_osrm

load_dotenv()

API_KEY = os.getenv("API")
WALKING_URL = "https://api.heigit.org/openrouteservice/v2/directions/foot-walking"
REQUEST_TIMEOUT = (1.8, 3.5)

_session = requests.Session()
_session.headers.update({"Accept": "application/json, application/geo+json"})


def _resolve_coordinates(address, provided=None):
    if isinstance(provided, (list, tuple)) and len(provided) >= 2:
        try:
            lat = float(provided[0])
            lon = float(provided[1])
            if -90 <= lat <= 90 and -180 <= lon <= 180:
                return lat, lon
        except (TypeError, ValueError):
            pass
    return get_coordinates(address)


@lru_cache(maxsize=192)
def _ors_walking(start_lat, start_lon, end_lat, end_lon):
    response = _session.get(
        WALKING_URL,
        headers={"Authorization": API_KEY},
        params={
            "start": f"{start_lon},{start_lat}",
            "end": f"{end_lon},{end_lat}",
        },
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()
    return response.json()


def get_walking_route(
    start_address,
    end_address,
    start_coordinates=None,
    end_coordinates=None,
):
    start = _resolve_coordinates(start_address, start_coordinates)
    end = _resolve_coordinates(end_address, end_coordinates)

    if start is None:
        return {
            "success": False,
            "error": explain_address_problem(
                start_address, "Starting address couldn't be found."
            ),
        }
    if end is None:
        return {
            "success": False,
            "error": explain_address_problem(
                end_address, "Destination couldn't be found."
            ),
        }

    start_lat, start_lon = map(float, start)
    end_lat, end_lon = map(float, end)
    key = (
        round(start_lat, 6),
        round(start_lon, 6),
        round(end_lat, 6),
        round(end_lon, 6),
    )

    try:
        fast = osrm_route("walking", *key)
        return convert_osrm("walking", fast, start_address, end_address, start, end)
    except (requests.RequestException, ValueError, KeyError, TypeError):
        # Do not make a successful route depend on any one free routing provider.
        pass

    if not API_KEY:
        return {"success": False, "error": "Walking routing unavailable; set API for the ORS fallback."}

    try:
        data = _ors_walking(*key)
    except requests.RequestException as error:
        return {"success": False, "error": f"Walking routing server error: {error}"}
    except ValueError:
        return {
            "success": False,
            "error": "Walking routing server returned invalid data.",
        }

    if not data.get("features"):
        return {"success": False, "error": "No walking route could be found."}

    route_data = data["features"][0]
    properties = route_data.get("properties", {})
    summary = properties.get("summary", {})
    distance_km = float(summary.get("distance", 0) or 0) / 1000
    duration_min = float(summary.get("duration", 0) or 0) / 60
    route_coordinates = [
        [lat, lon] for lon, lat in route_data.get("geometry", {}).get("coordinates", [])
    ]

    steps = []
    for segment in properties.get("segments", []):
        for step in segment.get("steps", []):
            way_points = step.get("way_points") or []
            step_coordinate = None
            if way_points:
                try:
                    point_index = int(way_points[0])
                    if 0 <= point_index < len(route_coordinates):
                        step_coordinate = route_coordinates[point_index]
                except (TypeError, ValueError):
                    pass

            steps.append(
                {
                    "instruction": step.get("instruction", ""),
                    "type": "walking",
                    "modifier": "",
                    "road": step.get("name", ""),
                    "name": step.get("name", ""),
                    "distance_m": step.get("distance", 0),
                    "duration_min": float(step.get("duration", 0) or 0) / 60,
                    "coordinates": step_coordinate,
                }
            )

    route = {
        "route_number": 1,
        "distance_km": distance_km,
        "duration_min": duration_min,
        "steps": steps,
        "route_coordinates": route_coordinates,
    }

    return {
        "success": True,
        "mode": "walking",
        "start": {"address": start_address, "coordinates": [start_lat, start_lon]},
        "end": {"address": end_address, "coordinates": [end_lat, end_lon]},
        "routes": [route],
        "fastest_route_number": 1,
        "shortest_route_number": 1,
    }
