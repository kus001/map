# walking.py

import requests
from helpers.print_color import red, green, blue, magenta
from geopy.geocoders import Nominatim

geolocator = Nominatim(user_agent="map_walking_thirdspace")

def format_direction(step):
    direction = step["maneuver"]["type"].replace("_", " ").title()
    modifier = step["maneuver"].get("modifier", "")
    road = step.get("name", "unnamed road").replace("New Name", red("Unnamed Road")) # fix these, .replace() doesnt work
    distance = step["distance"]

    # make directions
    result = direction
    if modifier:
        result += f" {modifier}"
    result += f" onto {road} for" 

    # distance
    # add km convertions 
    result += blue(f" {distance} m")

    return result

while True: 
    try: 
        startingAddress = input("Enter starting address: ")
        startLocation = geolocator.geocode(startingAddress)
        startLat = startLocation.latitude
        startLong = startLocation.longitude

        endingAddress = input("Enter ending address: ")
        endLocation = geolocator.geocode(endingAddress)
        endLat = endLocation.latitude
        endLong = endLocation.longitude

        # url = f"http://router.project-osrm.org/route/v1/walking/{startLong},{startLat};{endLong},{endLat}?overview=false"

        url = (
            f"https://host-transit-page.hackclub.app/route/v1/foot/"
            f"{startLong},{startLat};"
            f"{endLong},{endLat}"
            f"?overview=full&steps=true"
        )

        response = requests.get(url).json()

        distance = response['routes'][0]['distance']
        duration = response['routes'][0]['duration'] # DURATION CALCULATION FIXED VIA SERVER CHANGE
        legs = response['routes'][0]['legs'] # direction steps

        # (feedback from madhav) The duration is was off since it is calculating for the driving route. I have updated the API to use my custom server, which should fix it

        print()
        print("Walking: ")
        print()
        print(blue(f"Distance: {distance / 1000:.2f} km"))
        print(green(f"Duration: {duration / 60:.2f} minutes"))

        for leg in legs:
            for step in leg["steps"]:
                print(f"{format_direction(step)}")

    except AttributeError:
        print(red("Enter valid address!"))