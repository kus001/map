# Cycling.py

import os
import requests
from dotenv import load_dotenv

from geocoding import get_coordinates

load_dotenv()

API_KEY = os.getenv(
    "API"
)

CYCLING_URL = None

def get_cycling_route(start_address, end_address, route_type="regular"):

    # KUSH: added diffferent types of biking, will change the route depending on this
    # it would be good if someone could add buttons to the website under cycling to 
    # allow the user to change this setting (PS. WILL BE ADDING THIS TO OTHER MODES)

    if route_type == "road":
        CYCLING_URL = "https://api.openrouteservice.org/v2/directions/cycling-road"
    elif route_type == 'mountain':
        CYCLING_URL = "https://api.openrouteservice.org/v2/directions/cycling-mountain"
    elif route_type == "electric":
        CYCLING_URL = "https://api.openrouteservice.org/v2/directions/cycling-electric"
    else:
        CYCLING_URL = "https://api.openrouteservice.org/v2/directions/cycling-regular"

    if not API_KEY:
        return {
            "success": False,
            "error": "Cycling API Key is missing"
        }

    start = get_coordinates(start_address)

    end = get_coordinates(end_address)

    if start is None:
        return {
            "success": False,
            "error": "Starting address couldn't be found."
        }

    if end is None:
        return {
            "success": False,
            "error": "Destination couldn't be found."
        }

    start_lat, start_lon = start
    end_lat, end_lon = end

    headers = {
        "Authorization": API_KEY,
        "Accept": "application/json, application/geo+json"
    }

    params = {
        "start": f"{start_lon},{start_lat}",
        "end": f"{end_lon},{end_lat}"
    }

    try:
        response = requests.get(
            CYCLING_URL,
            headers=headers,
            params=params,
            timeout=15
        )

        response.raise_for_status()

        data = response.json()

    except requests.RequestExceptions as error:
        return {
            "success": False,
            "error": f"Cycling routing server error: {error}"
        }

    except ValueError:
        return {
            "success": False,
            "error": "Cycling routing server returned invalid data."
        }

    if not data.get("features"):
        return {
            "success": False,
            "error": "No cycling route could be found."
        }

    route_data = data["features"][0]

    properties = route_data.get("properties", {})
    summary = properties.get("summary", {})
    distance_km = route_data["distance"] / 1000
    duration_min = route_data["duration"] / 60

    geometry = route_data["geometry"]["coordinates"]

    route_coordinates = [
        [lat, lon]
        for lon, lat in geometry
    ]

    steps = []

    total_ascent = 0
    total_descent = 0

    for segment in properties.get("segments", []):
        total_ascent += segment.get("ascent", 0)
        total_descent += segment.get("descent", 0)

        for step in segment.get("steps", []):
            steps.append({
                "instruction": "",
                "type": "cycling",
                "modifier": "",
                "road": step.get("name", ""),
                "name": step.get("name", ""),
                "distance_m": step.get("distance", 0)
            })

    if duration_min > 0:
        average_speed = (distance_km / (duration_min / 60))
    else:
        average_speed = 0

    route = {
        "route_number": 1,
        "distance_km": distance_km,
        "duration_min": duration_min,
        "average_speed": average_speed,
        "steps": steps,
        "route_coordinates": route_coordinates
    }

    if total_ascent:
        route["ascent_m"] = (total_ascent)

    if total_descent:
        route["descent_m"] = (total_descent)

    return {
        "success": True,

        "mode": "cycling",

        "start": {
            "address": start_address,
            "coordinates": [start_lat, start_lon]
        },

        "end": {
            "address": end,
            "coordinates": [end_lat, end_lon]
        },

        "routes": [route],

        "fastest_route_number": 1,
        
        "shortest_route_number": 1
    }