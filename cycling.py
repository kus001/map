import requests
import os
from dotenv import load_dotenv
from helpers.print_color import red, green, blue
from geopy.geocoders import Nominatim

load_dotenv()

API_KEY = os.getenv("cycling_API")
geolocator = Nominatim(user_agent="map_cycling_thirdspace")

def get_coordinates(address):
    try: 
        location = geolocator.geocode(address)

        if location is None:
            return None
        return location.latitude, location.longitude
    except Exception as error:
        return None

def get_cycling_route(start_address, end_address):
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

    # api stuff
    headers = {
        'Accept': 'application/json, application/geo+json, application/gpx+xml, img/png; charset=utf-8',
    }

    url = f'https://api.heigit.org/openrouteservice/v2/directions/cycling-regular?api_key={API_KEY}&start={startLong},{startLat}&end={endLong},{endLat}'
    call = requests.get(url, headers=headers)

    try:
        response = requests.get(url, params=params, timeout=10)
        response.raise_for_status()
        data = response.json()
    except requests.RequestException as error:
        return {
            "success": False,
            "error": f"cycling routing server error: {error}"
        }

    if data.get("code") != "Ok":
        return {
            "success": False,
            "error": data.get("message", "No cycling route could be found.")
        }

    if not data.get("routes"):
        return {
            "success": False,
            "error": "No cycling route could be found."
        }

    route_data = data['features'][0]
    properties = route_data['properties']

    route_coordinates = [
        [lat, lon]
        for lon, lat in route_data['geometry']["coordinates"]
    ]

    steps = []

    # gonna be different than the regular api
    for segment in properties["segments"]:
        for step in segment["steps"]:

            steps.append({
                "instruction": step.get("instruction", ""),
                "name": step.get("name", ""),
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