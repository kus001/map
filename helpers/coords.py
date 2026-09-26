from geopy.geocoders import Nominatim
geolocator = Nominatim(user_agent="map_walking_thirdspace")

def get_coordinates(address):
    try: 
        location = geolocator.geocode(address)

        if location is None:
            return None
        return location.latitude, location.longitude
    except Exception as error:
        return None

def nearest_stop(lat, long):
    pass