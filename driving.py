# driving.py

import requests
from geopy.geocoders import Nominatim

geolocator = Nominatim(user_agent="map_driving_thirdspace")

def get_coordinates(address):

    try:
        location = geolocator.geocode(address)

        if location is None:
            return None

        return location.latitude, location.longitude
    
    except Exception:
        return None

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
        f"https://router.project-osrm.org/route/v1/driving/"
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
            timeout=10
        )

        response.raise_for_status()

        data = response.json()

    except requests.RequestException as error:
        return {
            "success": False,
            "error": f"Routing server error: {error}"
        }

    if data.get("code") != "Ok":
        return {
            "success": False,
            "error": data.get(
                "message",
                "No driving route could be found."
            )
        }

    if not data.get("routes"):
        return {
            "success": False,
            "error": "No driving routes were found."
        }

    routes = []

    for i, route_data in enumerate(data["routes"]):

        distance_km = route_data['distance'] / 1000
        duration_min = route_data['duration'] / 60

        if duration_min > 0:
            average_speed = distance_km / (duration_min / 60)
        else:
            average_speed = 0

        route_coordinates = [
            [lat, lon]
            for lon, lat in route_data["geometry"]["coordinates"]
        ]

        steps=[]

        for leg in route_data["legs"]:
            for step in leg["steps"]:
                maneuver = step["maneuver"]

                steps.append({
                    "type": maneuver["type"],
                    "modifier": maneuver.get("modifier", ""),
                    "road": step.get("name", ""),
                    "distance_m": step["distance"]
                })

        routes.append({
            "route_number": i + 1,
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

def select_route(result, route_number):
    if not result["success"]:
        return None

    for route in result["routes"]:
        if route["route_number"] == route_number:
            return route
    return None

def get_route_labels(result, route):
    labels = []

    if (
        route["route_number"] == result["fastest_route_number"]
    ):
        labels.append("FASTEST")

    if (
        route["route_number"] == result["shortest_route_number"]
    ):
        labels.append("SHORTEST")

    return labels

def print_route_options(result):
    if not result["success"]:
        print(result["error"])
        return

    print(f"Found {len(result['routes'])} route(s):")
    for route in result['routes']:
        labels = get_route_labels(result, route)
        label_text = ""

        if labels:
            label_text = " [" + ", ".join(labels) + "]"

        print(
            f"Route {route['route_number']}"
            f"{label_text}: "
            f"{route['distance_km']:.2f} km, "
            f"{route['duration_min']:.2f} min, "
        )

def choose_route_cli(result):
    if not result["success"]:
        return None

    while True:

        try:
            choice = int(
                input(
                    f"\nChoose route "
                f"(1-{len(result['routes'])}): "
                )
            )

            selected = select_route(
                result, choice
            )

            if selected is not None:
                return selected

            print("Invalid route number.")

        except ValueError:
            print("Please enter a number.")

def format_direction(step):

    direction_type = (
        step["type"]
        .replace("_", " ")
        .title()
    )

    modifier = step["modifier"]
    road = step["road"]
    distance = step["distance_m"]

    text = direction_type

    if modifier:
        text += f" {modifier}"

    if road:
        text += f" onto {road}"

    if distance >= 1000:
        text += f" for {distance / 1000:.2f} km"
    else:
        text += f" for {distance:.0f} m"

    return text

def print_directions(route):

    print(f"Route {route['route_number']} Directions:")

    for step in route["steps"]:
        print(format_direction(step))

# Internal use only

if __name__ == "__main__":
    start = input("Starting address: ")
    end = input("Destination: ")

    result = get_driving_route(start, end)

    if not result["success"]:
        print(result["error"])

    else:
        print_route_options(result)

        selected_route = choose_route_cli(result)

        print(
            f"Selected Route "
            f"{selected_route['route_number']}"
        )

        print(
            f"Distance: "
            f"{selected_route['distance_km']:.2f} km, "
        )

        print(
            f"Duration: "
            f"{selected_route['duration_min']:.2f} min"
        )

        print_directions(selected_route )