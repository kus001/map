# Walking.py

import requests
from geopy.geocoders import Nominatim

geolocator = Nominatim(user_agent="map_walking_thirdspace")

def get_coordinates(address):
    try:
        location = geolocator.geocode(address)

        if location is None:
            return None
        return location.latitude, location.lognitutde
    except Exception:
        return None

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
        "https://host-transit-page.hackclub.app/route/v1/foot/"
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
            timeout=10
        )

        response.raise_for_status()
        data = response.json()
    except requests.RequestExceptions as error:
        return {
            "success": False,
            "error": f"Walking routing server error: {error}"
        }

    if data.get("code") != "Ok":
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

    route_coordinates = [
        [lat, lon]
        for lon, lat in route_data["geometry"]["coordinates"]
    ]

    steps=[]

    for leg in route_data["legs"]:
        for step in leg["steps"]:
            maneuver = step["maneuver"]

            steps.append({
                "type":maneuver["type"],
                "modifier": maneuver.get("modifier",""),
                "road": step.get("name", ""),
                "distance_m": step["distance"]
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