# Walking.py

import requests
import os
from dotenv import load_dotenv

from geocoding import get_coordinates

API_KEY = os.getenv("API")

# KUSH: NO ONE TOUCH THIS i gotta make the format right

WALKING_URL = (
    "https://api.openrouteservice.org/v2/directions/foot-walking"
)

def get_walking_route(start_address, end_address):
    start = get_coordinates(start_address)
    end = get_coordinates(end_address)

    if start is None:
        return {
            "success": False,
            "error": "starting address couldn't be found."
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
            WALKING_URL,
            headers=headers,
            params=params,
            timeout=15
        )

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
            "error": "Walking routing server returned invalid data."
        }

    # code = data.get("code")

    # if code is not None and code != "Ok":
    #     return {
    #         "success": False,
    #         "error": data.get("message", "No walking route could be found.")
    #     }

    if not data.get("features"):
        return {
            "success": False,
            "error": "No walking route could be found."
        }

    route_data = data["features"][0]

    properties = route_data.get("properties", {})
    summary = properties.get("route_data", {})
    distance_km = route_data["distance"] / 1000
    duration_min = route_data["duration"] / 60

    geometry = route_data["geometry"]["coordinates"]

    route_coordinates = [
        [lat, lon]
        for lon, lat in geometry
    ]

    steps = []

    # who added total_ascent and total_descent in cycling.py??????

    for leg in route_data.get("segments", []):
        for step in leg.get("steps", []):
            # maneuver = step.get("maneuver", {})
            steps.append({
                "instruction": "",
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
            "address": end,
            "coordinates": [end_lat, end_lon]
        },

        "routes": [route],

        "fastest_route_number": 1,
        
        "shortest_route_number": 1
    }

result = get_walking_route("175 david bergey dr", "300 hazel st")
print(result)