# Walking.py

import requests

from geocoding import get_coordinates

WALKING_ROUTER_URL = (
    "https://host-transit-page.hackclub.app/"
    "route/v1/foot"
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

    url = (
        f"{WALKING_ROUTER_URL}/"
        f"{start_lon},{start_lat};"
        f"{end_lon},{end_lat}"
    )

    params = {
        "overview": "full",
        "geometries": "geojson",
        "steps": "true"
    }

    try:
        response = requests.get(
            url,
            params=params,
            timeout=15
        )

        response.raise_for_status()

        data = response.json()

    except requests.RequestExceptions as error:
        return {
            "success": False,
            "error": f"Walking routing server error: {error}"
        }

    except ValueError:
        return {
            "success": False,
            "error": "Walking routing server returned invalid data."
        }

    code = data.get("code")

    if code is not None and code != "Ok":
        return {
            "success": False,
            "error": data.get("message", "No walking route could be found.")
        }

    if not data.get("routes"):
        return {
            "success": False,
            "error": "No walking route could be found."
        }

    route_data = data["routes"][0]

    distance_km = route_data["distance"] / 1000
    duration_min = route_data["duration"] / 60

    geometry = route_data["geometry"]["coordinates"]

    route_coordinates = [
        [lat, lon]
        for lon, lat in geometry
    ]

    steps=[]

    for leg in route_data.get("legs", []):
        for step in leg.get("steps", []):
            maneuver = step.get("maneuver", {})

            steps.append({
                "instruction": "",
                "type":maneuver.get("type", ""),
                "modifier": maneuver.get("modifier",""),
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