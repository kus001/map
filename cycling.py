import os
from functools import lru_cache

import requests
from dotenv import load_dotenv

from helpers.geocoding import explain_address_problem, get_coordinates
from helpers.fast_osrm import osrm_route, convert_osrm

load_dotenv()
API_KEY = os.getenv("API")
REQUEST_TIMEOUT = (1.8, 3.5)

CYCLING_PROFILES = {
    "regular": "cycling-regular",
    "road": "cycling-road",
    "mountain": "cycling-mountain",
    "electric": "cycling-electric",
}

ORS_MANEUVER_TYPES = {
    0: ("turn", "left"),
    1: ("turn", "right"),
    2: ("turn", "sharp left"),
    3: ("turn", "sharp right"),
    4: ("turn", "slight left"),
    5: ("turn", "slight right"),
    6: ("continue", "straight"),
    7: ("roundabout", ""),
    8: ("roundabout_exit", ""),
    9: ("u_turn", ""),
    10: ("arrive", ""),
    11: ("depart", ""),
    12: ("continue", "keep left"),
    13: ("continue", "keep right"),
}

_session = requests.Session()
_session.headers.update({"Accept": "application/json, application/geo+json"})


def _maneuver_details(step):
    try:
        maneuver_code = int(step.get("type"))
    except (TypeError, ValueError):
        return "continue", ""
    return ORS_MANEUVER_TYPES.get(maneuver_code, ("continue", ""))


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


@lru_cache(maxsize=256)
def _ors_cycling(profile, start_lat, start_lon, end_lat, end_lon):
    url = f"https://api.heigit.org/openrouteservice/v2/directions/{profile}"
    response = _session.get(
        url,
        headers={"Authorization": API_KEY},
        params={
            "start": f"{start_lon},{start_lat}",
            "end": f"{end_lon},{end_lat}",
        },
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()
    return response.json()


def get_cycling_route(
    start_address,
    end_address,
    route_type="regular",
    start_coordinates=None,
    end_coordinates=None,
):
    profile = CYCLING_PROFILES.get(route_type, "cycling-regular")
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
        profile,
        round(start_lat, 6),
        round(start_lon, 6),
        round(end_lat, 6),
        round(end_lon, 6),
    )

    if route_type == "regular" or not API_KEY:
        try:
            fast = osrm_route("cycling", *key[1:])
            return convert_osrm("cycling", fast, start_address, end_address, start, end, route_type)
        except (requests.RequestException, ValueError, KeyError, TypeError):
            pass

    if not API_KEY:
        return {"success": False, "error": "Cycling routing unavailable; set API for the ORS fallback."}

    try:
        data = _ors_cycling(*key)
    except requests.RequestException as error:
        return {"success": False, "error": f"Cycling routing server error: {error}"}
    except ValueError:
        return {
            "success": False,
            "error": "Cycling routing server returned invalid data.",
        }

    if not data.get("features"):
        return {"success": False, "error": "No cycling route could be found."}

    route_data = data["features"][0]
    properties = route_data.get("properties", {})
    summary = properties.get("summary", {})
    distance_km = float(summary.get("distance", 0) or 0) / 1000
    duration_min = float(summary.get("duration", 0) or 0) / 60
    geometry = route_data.get("geometry", {}).get("coordinates", [])
    route_coordinates = [[lat, lon] for lon, lat in geometry]

    steps = []
    total_ascent = 0.0
    total_descent = 0.0

    for segment in properties.get("segments", []):
        total_ascent += float(segment.get("ascent", 0) or 0)
        total_descent += float(segment.get("descent", 0) or 0)

        for step in segment.get("steps", []):
            step_type, modifier = _maneuver_details(step)
            road_name = str(step.get("name", "") or "").strip()
            instruction = str(step.get("instruction", "") or "").strip()
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
                    "instruction": instruction,
                    "type": step_type,
                    "modifier": modifier,
                    "road": road_name,
                    "name": road_name,
                    "distance_m": float(step.get("distance", 0) or 0),
                    "duration_min": float(step.get("duration", 0) or 0) / 60,
                    "maneuver_type": step.get("type"),
                    "way_points": way_points,
                    "coordinates": step_coordinate,
                }
            )

    average_speed = distance_km / (duration_min / 60) if duration_min > 0 else 0.0
    route = {
        "route_number": 1,
        "distance_km": distance_km,
        "duration_min": duration_min,
        "average_speed": average_speed,
        "steps": steps,
        "route_coordinates": route_coordinates,
    }
    if total_ascent:
        route["ascent_m"] = total_ascent
    if total_descent:
        route["descent_m"] = total_descent

    return {
        "success": True,
        "mode": "cycling",
        "route_type": route_type,
        "start": {"address": start_address, "coordinates": [start_lat, start_lon]},
        "end": {"address": end_address, "coordinates": [end_lat, end_lon]},
        "routes": [route],
        "fastest_route_number": 1,
        "shortest_route_number": 1,
    }
