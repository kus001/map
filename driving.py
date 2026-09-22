# Driving.py

import requests

from geocoding import get_coordinates

OSRM_URL = (
    "https://router.project-osrm.org/"
    "route/v1/driving"
)

def get_driving_route(start_address, end_address, alternatives=3):

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

    url = (
        f"{OSRM_URL}/"
        f"{start_lon},{start_lat};"
        f"{end_lon},{end_lat}"

    )

    params = {
        "overview": "full",
        "geometries": "geojson",
        "steps": "true",
        "alternatives": alternatives
    }

    try:
        response = requests.get(
            url,
            params=params,
            timeout=15
        )

        response.raise_for_status()

        data = response.json()

    except requests.RequestException as error:
        return {
            "success": False,
            "error": f"Driving routing server error: {error}"
        }

    except ValueError:
        return {
            "success": False,
            "error": "Driving routing server returned invalid data."
        }

    if data.get("code") != "Ok":
        return {
            "success": False,
            "error": data.get("message", "No driving route could be found.")
        }

    if not data.get("routes"):
        return {
            "success": False,
            "error": "No driving routes were found."
        }

    routes = []

    for index, route_data in enumerate(data["routes"]):

        distance_km = route_data['distance'] / 1000
        duration_min = route_data['duration'] / 60

        if duration_min > 0:
            average_speed = distance_km / (duration_min / 60)
        else:
            average_speed = 0

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
                    "type": maneuver.get("type", ""),
                    "modifier": maneuver.get("modifier", ""),
                    "road": step.get("name", ""),
                    "name": step.get("name", ""),
                    "distance_m": step.get("distance", 0)
                })

        routes.append({
            "route_number": index + 1,
            "distance_km": distance_km,
            "duration_min": duration_min,
            "average_speed": average_speed,
            "steps": steps,
            "route_coordinates": route_coordinates
        })

    fastest_route = min(routes, key=lambda route: route["duration_min"])
    shortest_route = min(routes, key=lambda route: route["distance_km"])

    return {
        "success": True,

        "mode": "driving",

        "start": {
            "address": start_address,
            "coordinates": [start_lat, start_lon]
        },

        "end": {
            "address": end_address,
            "coordinates": [end_lat, end_lon]
        },

        "routes": routes,

        "fastest_route_number": 
            fastest_route["route_number"],

        "shortest_route_number":
            shortest_route["route_number"]
    }