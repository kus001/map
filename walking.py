import requests
from helpers.print_color import red, green, blue

# get location
startLat = float(input("Enter starting latitute: "))
startLong = float(input("Enter starting longitute: "))
endLat = float(input("Enter ending latitute: "))
endLong = float(input("Enter ending longitude: "))

url = f"http://router.project-osrm.org/route/v1/foot/{startLong},{startLat};{endLong},{endLat}?overview=false"
response = requests.get(url).json()

distance = response['routes'][0]['distance']
duration = response['routes'][0]['duration']

print()
print("Walking: ")
print()
print(blue(f"Distance: {distance / 1000:.2f} km"))
print(f"Duration: {duration / 60:.2f} minutes")