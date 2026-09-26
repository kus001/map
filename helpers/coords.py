from pathlib import Path
import sys

cwd = Path.cwd()
sys.path.append(str(cwd / "helpers"))

from geopy.geocoders import Nominatim
from distance import find_dist
geolocator = Nominatim(user_agent="map_walking_thirdspace")

def get_coordinates(address):
    try: 
        location = geolocator.geocode(address)

        if location is None:
            return None
        return location.latitude, location.longitude
    except Exception as error:
        return None

def nearest_stop(all_stops, lat, long):
    closest_stop = [
        float('inf'),
        None
    ]

    for stop_id in all_stops:
        stop = all_stops[stop_id]
        slat, slong, sname = stop

        dist = find_dist((lat, long))

        if dist < closest_stop[0]:
            closest_stop = [
                dist,
                (stop_id, stop)
            ]

    print(closest_stop)