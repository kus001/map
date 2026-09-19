import requests
from helpers.print_color import red, green, blue
from geopy.geocoders import Nominatim

geolocator = Nominatim(user_agent="map_cycling_thirdspace")

startingAddress = input("Enter starting address: ")
startLocation = geolocator.geocode(startingAddress)
startLat = startLocation.latitude
startLong = startLocation.longitude

endingAddress = input("Enter ending address: ")
endLocation = geolocator.geocode(endingAddress)
endLat = endLocation.latitude
endLong = endLocation.longitude

url = (
    f"https://host-transit-page.hackclub.app/route/v1/bike/"
    f"{startLong},{startLat};"
    f"{endLong},{endLat}"
    f"?overview=false"
    )

response = requests.get(url).json()

distance = response["routes"][0]["distance"]
duration = response["routes"][0]["duration"]

print()
print("Cycling: ")
print()
print(blue(f"Distance: {distance/1000:.2f} km"))
print(green(f"Duration: {duration / 60:.2f} minutes"))