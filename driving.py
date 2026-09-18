import requests
from geopy.geocoders import Nominatim
from helpers.print_color import red, green, blue

geolocator = Nominatim(user_agent="map_driving_thirdspace")

def get_coordinates(address):
    location = geolocator.geocode(address)

    if location is None:
        return None

    return location.latitude, location.longitude

def get_driving_route(start_address, end_address):
    start = get_coordinates(start_address)
    end = get_coordinates(end_address)

    if start is None or end is None:
        return None

    start_lat, start_lon = start
    end_lat, end_lon = end

    url = (
        f"https://router.project-osrm.org/route/v1/driving/"
        f"{start_lon},{start_lat};"
        f"{end_lon},{end_lat}"
        f"?overview=full&geometries=geojson&steps=true"
    )

    response = requests.get(url, timeout=10)
    data = response.json()

    if data.get("code") != "Ok":
        return None

    route = data["routes"][0]

    distance_km = route["distance"] / 1000
    duration_min = route["duration"] / 60

    route_coordinates = [
        [lat, lon]
        for lon, lat in route["geometry"]["coordinates"]
    ]

    steps=[]

    for leg in route["legs"]:
        for step in leg["steps"]:
            maneuver = step["maneuver"]

            step_info = {
                "type": maneuver["type"],
                "modifier": maneuver.get("modifier", ""),
                "road": step.get("name", ""),
                "distance_m": step["distance"]
            }

            steps.append(step_info)

    return {
        "mode" : "driving",
        "distance_km": distance_km,
        "duration_min": duration_min,
        "steps": steps,
        "route_coordinates": route_coordinates,
        "start": [start_lat, start_lon],
        "end": [end_lat, end_lon]
    }