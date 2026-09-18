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
        f"{end_lon},{end_lat};"
        f"?overview=false&steps=true"
    )

    response = requests.get(url, timeout=10)

    if response.status_code != 200:
        print