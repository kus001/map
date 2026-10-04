from heapq import nsmallest
from helpers.distance import find_dist

def nearest_stop(all_stops, lat, lon):
    return min(
        ([find_dist((stop[0], stop[1]), (lat, lon)), (stop_id, stop)] for stop_id, stop in all_stops.items()),
        key=lambda item: item[0],
        default=[float("inf"), None]
    )

def nearest_stops(all_stops, lat, lon, amount_of_stops=50):
    amount = max(1, int(amount_of_stops))
    return nsmallest(
        amount,
        ([find_dist((stop[0], stop[1]), (lat, lon)), (stop_id, stop)] for stop_id, stop in all_stops.items()),
        key=lambda item: item[0]
    )