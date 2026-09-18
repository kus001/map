import requests
from geopy.geocoders import Nominatim
from websockets import route
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
        f"?overview=full"
        f"&geometries=geojson"
        f"&steps=true"
        f"&alternatives=true"
    )

    response = requests.get(url, timeout=10)
    data = response.json()

    if data.get("code") != "Ok":
        return None

    routes = []

    print("Number of routes found:", len(data[("routes")]))

    for i, route_data in enumerate(data["routes"]):

        distance_km = route_data['distance'] / 1000
        duration_min = route_data['duration'] / 60

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
            "distance_km": distance_km,
            "duration_min": duration_min,
            "steps": steps,
            "route_coordinates": route_coordinates
        })

        print(
            f"Route {i + 1}: "
            f"{distance_km:.2f} km, "
            f"{duration_min:.2f} min"
        )

    fastest_route = min(routes, key=lambda r: r["duration_min"])
    shortest_route = min(routes, key=lambda r: r["distance_km"])

    return {
        "mode": "driving",
        "start": [start_lat, start_lon],
        "end": [end_lat, end_lon],
        "routes": routes
    }

route = get_driving_route("toronto, ontario", "ottawa, ontario")

