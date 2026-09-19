import math


def find_dist(coord1, coord2):
    lat1, lon1 = coord1
    lat2, lon2 = coord2

    rad_lat = math.radians(lat1)

    deg_to_km = 111.32  # Approximate conversion factor from degrees to kilometers
    dlat = (lat2 - lat1) * deg_to_km
    dlon = (lon2 - lon1) * deg_to_km * math.cos(rad_lat)

    distance = math.sqrt(dlat**2 + dlon**2) * 1000  # Convert to meters

    return distance