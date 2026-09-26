# walking.py

import requests
import os
from helpers.coords import get_coordinates
from dotenv import load_dotenv
from helpers.print_color import red, green, blue

load_dotenv()

API_KEY = os.getenv("API")

def get_walking_route(start_address, end_address):
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

    startLat, startLon = start
    endLat, endLon = end

    # api stuff
    headers = {
        'Accept': 'application/json, application/geo+json, application/gpx+xml, img/png; charset=utf-8',
    }

    url = f'https://api.heigit.org/openrouteservice/v2/directions/foot-walking?api_key={API_KEY}&start={startLon},{startLat}&end={endLon},{endLat}'
    call = requests.get(url, headers=headers)

    try:
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        data = response.json()

    except requests.RequestException as error:
        return {
            "success": False,
            "error": f"walking routing server error: {error}"
        }

    # if data.get("code") != "Ok":
    #     return {
    #         "success": False,
    #         "error": data.get("message", "No cycling route could be found.")
    #     }

    if not data.get("features"):
        return {
            "success": False,
            "error": "No walking route could be found."
        }

    route_data = data['features'][0]
    properties = route_data['properties']
    distance_km = (data['features'][0]['properties']['summary']['distance'])/1000
    duration_min = (data['features'][0]['properties']['summary']['distance'])/60

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
            "coordinates": [startLat, startLon]
        },

        "end": {
            "address": end_address,
            "coordinates": [endLat, endLon]
        },

        "routes": [route],

        "fastest_route_number": 1,
        "shortest_route_number": 1
    }