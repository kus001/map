import requests
from helpers.print_color import red, green, blue, magenta
from geopy.geocoders import Nominatim

geolocator = Nominatim(user_agent="map_walking_thirdspace")

startingAddress = input("Enter starting address: ")
startLocation = geolocator.geocode(startingAddress)
startLat = startLocation.latitude
startLong = startLocation.longitude

endingAddress = input("Enter ending address: ")
endLocation = geolocator.geocode(endingAddress)
endLat = endLocation.latitude
endLong = endLocation.longitude

url = f"http://router.project-osrm.org/route/v1/walking/{startLong},{startLat};{endLong},{endLat}?overview=false"
response = requests.get(url).json()

distance = response['routes'][0]['distance']
duration = response['routes'][0]['duration'] # fix duration, the timing is wayyyy off

print()
print("Walking: ")
print()
print(blue(f"Distance: {distance / 1000:.2f} km"))
print(green(f"Duration: {duration / 60:.2f} minutes"))

# add input detection ASAP