import requests
from geopy.geocoders import Nominatim
from helpers.print_color import red, green, blue

# Temp
import folium

geolocator = Nominatim(user_agent="map_driving_thirdspace")

def get_coordinates(address):
    location = geolocator.geocode(address)

    if location is None:
        return None

    return location.latitude, location.longitude

def get_driving_route(start_address, end_address):
    start = get_coordinates(start_address)
    end = get_coordinates(end_address)

    if start is None:
        print(red("Starting address couldn't be found."))
        return

    if end is None:
        print(red("Destination couldn't be found."))
        return

    start_lat, start_lon = start
    end_lat, end_lon = end

    url = (
        f"https://router.project-osrm.org/route/v1/driving/"
        f"{start_lon},{start_lat};"
        f"{end_lon},{end_lat}"
        f"?overview=full&geometries=geojson&steps=true"
    )

    response = requests.get(url, timeout=10)

    # Debugging output
    """
    print("URL:", url)
    print("Status:", response.status_code)
    print("Response:", response.text)
    """

    if response.status_code != 200:
        print(red("Routing server error."))
        return

    data = response.json()

    if data.get("code") != "Ok" or not data.get("routes"):
        print(red("No driving route found."))
        return

    route = data["routes"][0]

    geometry = route["geometry"]["coordinates"]

    route_coordinates = []

    for lon, lat in geometry: 
        route_coordinates.append([lat,lon])

    # Temp Map View

    map_center = route_coordinates[0]
    m = folium.Map(location=map_center, zoom_start=13, tiles="CartoDB positron")
    folium.PolyLine(route_coordinates, weight=6).add_to(m)
    folium.Marker(route_coordinates[0], popup="Start").add_to(m)
    folium.Marker(route_coordinates[-1], popup="Destination").add_to(m)
    m.save("driving_route.html")


    distance_km = route["distance"] / 1000
    duration_min = route["duration"] / 60

    print("Driving:")
    print(blue(f"Distance: {distance_km:.2f} km"))
    print(green(f"Duration: {duration_min:.1f} minutes"))

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

    print("Directions:")
    for step in steps:
        direction = step["type"].replace("_", " ").title()
        modifier = step["modifier"]
        road = step["road"]
        distance = step["distance_m"]

        if modifier:
            direction += f" {modifier}"

        if road:
            print(f"{direction} onto {road} - {distance:.0f} m")

        else:
            print(f"{direction} - {distance:.0f} m")

    return {
        "mode" : "driving",
        "distance_km": distance_km,
        "duration_min": duration_min,
        "steps": steps,
        "route_coordinates": route_coordinates
    }

starting_address = input("Enter starting address: ")
ending_address = input("Enter ending address:")

get_driving_route(starting_address, ending_address)