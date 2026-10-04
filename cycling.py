# Cycling.py

import os

import requests
from dotenv import load_dotenv

from helpers.geocoding import get_coordinates

load_dotenv()

API_KEY = os.getenv("API")

CYCLING_PROFILES = {
    "regular": "cycling-regular",
    "road": "cycling-road",
    "mountain": "cycling-mountain",
    "electric": "cycling-electric",
}

# openrouteservice maneuver codes. We keep the original instruction string too,
# because that gives the clearest turn-by-turn text in the frontend.
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


def _maneuver_details(step):
    maneuver_code = step.get("type")

    try:
        maneuver_code = int(maneuver_code)
    except (TypeError, ValueError):
        return "continue", ""

    return ORS_MANEUVER_TYPES.get(maneuver_code, ("continue", ""))


def get_cycling_route(start_address, end_address, route_type="regular"):
    if not API_KEY:
        return {
            "success": False,
            "error": "Cycling API Key is missing.",
        }

    profile = CYCLING_PROFILES.get(route_type, "cycling-regular")

    start = get_coordinates(start_address)
    end = get_coordinates(end_address)

    if start is None:
        return {
            "success": False,
            "error": "Starting address couldn't be found.",
        }

    if end is None:
        return {
            "success": False,
            "error": "Destination couldn't be found.",
        }

    start_lat, start_lon = start
    end_lat, end_lon = end

    url = (
        "https://api.heigit.org/"
        f"openrouteservice/v2/directions/{profile}"
    )

    headers = {
        "Authorization": API_KEY,
        "Accept": "application/json, application/geo+json",
    }

    params = {
        "start": f"{start_lon},{start_lat}",
        "end": f"{end_lon},{end_lat}",
    }

    try:
        response = requests.get(
            url,
            headers=headers,
            params=params,
            timeout=15,
        )
        response.raise_for_status()
        data = response.json()

    except requests.RequestException as error:
        return {
            "success": False,
            "error": f"Cycling routing server error: {error}",
        }

    except ValueError:
        return {
            "success": False,
            "error": "Cycling routing server returned invalid data.",
        }

    if not data.get("features"):
        return {
            "success": False,
            "error": "No cycling route could be found.",
        }

    route_data = data["features"][0]
    properties = route_data.get("properties", {})
    summary = properties.get("summary", {})

    distance_km = float(summary.get("distance", 0) or 0) / 1000
    duration_min = float(summary.get("duration", 0) or 0) / 60

    geometry = route_data.get("geometry", {}).get("coordinates", [])
    route_coordinates = [
        [lat, lon]
        for lon, lat in geometry
    ]

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

            steps.append({
                # This was previously blank, which is why the UI could only say
                # things such as "Cycling onto Wissler Road".
                "instruction": instruction,
                "type": step_type,
                "modifier": modifier,
                "road": road_name,
                "name": road_name,
                "distance_m": float(step.get("distance", 0) or 0),
                "duration_min": float(step.get("duration", 0) or 0) / 60,
                "maneuver_type": step.get("type"),
                "way_points": step.get("way_points", []),
            })

    average_speed = (
        distance_km / (duration_min / 60)
        if duration_min > 0
        else 0.0
    )

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
        "start": {
            "address": start_address,
            "coordinates": [start_lat, start_lon],
        },
        "end": {
            "address": end_address,
            "coordinates": [end_lat, end_lon],
        },
        "routes": [route],
        "fastest_route_number": 1,
        "shortest_route_number": 1,
    }
