import requests

# lat, long
startLat = int(input("Enter starting latitute: "))
startLong = int(input("Enter starting longitute: "))
endLat = int(input("Enter ending latitute: "))
endLong = int(input("Enter ending longitude: "))

url = f"http://router.project-osrm.org/route/v1/foot/{startLong},{startLat};{endLong},{endLat}?overview=false"
response = requests.get(url).json()

distance = response['routes'][0]['distance']
duration = response['routes'][0]['duration']

print("Walking: ")
print(f"Distance: {distance / 1000:.2f} km")
print(f"Duration: {duration / 60:.2f} minutes")
