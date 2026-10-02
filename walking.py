# walking.py

import requests
import os
from helpers.coords import get_coordinates
from dotenv import load_dotenv
from helpers.print_color import red, green, blue

load_dotenv()

API_KEY = os.getenv("API")

WALKING_URL = (
    "https://api.heigit.org/"
    "openrouteservice/v2/directions/foot-walking"
)

def get_walking_route(start_address, end_address):
    if not API_KEY:
        return {
            "success": False,
            "error": ("OpenRouteService API Key is missing.")
        }

    start = get_coordinates(start_address)
    end = get_coordinates(end_address)

    if start is None:
        return {
            "success": False,
            "error": "starting address couldn't be found"
        }
    if end is None:
        return {
            "success": False,
            "error": "destination couldn't be found"
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
        response = requests.get(WALKING_URL, headers=headers, params=params, timeout=15)
        response.raise_for_status()
        data = response.json()

    except requests.RequestException as error:
        return {
            "success": False,
            "error": f"Walking routing server error: {error}"
        }

    except ValueError:
        return {
            "success": False,
            "error": ("Walking routing server returned invalid data.")
        }

    if not data.get("features"):
        return {
            "success": False,
            "error": "No walking route could be found."
        }

    route_data = data['features'][0]
    properties = route_data['properties']
    summary = properties.get("summary",{})
    distance_km = summary.get("distance", 0)/1000;
    duration_min = summary.get("duration", 0)/60;

    geometry = route_data["geometry"]["coordinates"]

    route_coordinates = [
        [lat, lon]
        for lon, lat in geometry
    ]

    steps = []

    for segment in properties["segments"]:
        for step in segment["steps"]:

            steps.append({
                "instruction": step.get("instruction", ""),
                "type": "walking",
                "modifier": "",
                "road": step.get("name", ""),
                "name": step.get("name", ""),
                "distance_m": step.get("distance", 0)
            })

    route = {
        "route_number": 1,
        "distance_km": distance_km,
        "duration_min": duration_min,
        "steps": steps,
        "route_coordinates": route_coordinates
    }

    return {
        "success": True,

        "mode": "walking",

        "start": {
            "address": start_address,
            "coordinates": [start_lat, start_lon]
        },

        "end": {
            "address": end_address,
            "coordinates": [end_lat, end_lon]
        },

        "routes": [route],

        "fastest_route_number": 1,
        "shortest_route_number": 1
    }