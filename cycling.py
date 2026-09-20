import requests
import os
from dotenv import load_dotenv
from helpers.print_color import red, green, blue
from geopy.geocoders import Nominatim

load_dotenv()

API_KEY = os.getenv("cycling_API")
geolocator = Nominatim(user_agent="map_cycling_thirdspace")

# api stuff
headers = {
    'Accept': 'application/json, application/geo+json, application/gpx+xml, img/png; charset=utf-8',
}

startingAddress = input("Enter starting address: ")
startLocation = geolocator.geocode(startingAddress)
startLat = startLocation.latitude
startLong = startLocation.longitude

endingAddress = input("Enter ending address: ")
endLocation = geolocator.geocode(endingAddress)
endLat = endLocation.latitude
endLong = endLocation.longitude

# url = (
#     f"http://router.project-osrm.org/route/v1/bike/" # find better url
#     f"{endLong},{endLat}"
#     f"?overview=false"
#     )

# response = requests.get(url).json()

# distance = response["routes"][0]["distance"]
# duration = response["routes"][0]["duration"]

url = f'https://api.heigit.org/openrouteservice/v2/directions/cycling-regular?api_key={API_KEY}&start={startLong},{startLat}&end={endLong},{endLat}'
call = requests.get(url, headers=headers)

print(call.status_code, call.reason)
print(call.text)

response = call.json()
distance = response['features'][0]['properties']['summary']['distance']
duration = response['features'][0]['properties']['summary']['duration']
stops = response['features'][0]['properties']['segments'][0]['steps']

print()
print("Cycling: ")
print()
print(blue(f"Distance: {distance/1000:.2f} km"))
print(green(f"Duration: {duration / 60:.2f} minutes"))

for stop in stops:
    direction = stop['instruction']
    name = stop['name']
    distanceStop = stop['distance']

    # add km conversions later
    print(f"{direction} on {name} for {distanceStop} m")