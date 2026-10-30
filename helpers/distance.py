import math


def find_dist(coord1: tuple[int, int], coord2: tuple[int, int]) -> float:
    lat1, lon1 = coord1
    lat2, lon2 = coord2

    rad_lat = math.radians(lat1)

    deg_to_km = 111.32
    dlat = (lat2 - lat1) * deg_to_km
    dlon = (lon2 - lon1) * deg_to_km * math.cos(rad_lat)

    distance = math.sqrt(dlat**2 + dlon**2) * 1000

    return distance
