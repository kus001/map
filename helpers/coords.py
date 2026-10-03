from pathlib import Path
import sys

cwd = Path.cwd()
sys.path.append(str(cwd / "helpers"))

from distance import find_dist

def nearest_stop(all_stops:dict, lat:int, long:int) -> list:
    closest_stop = [
        float('inf'),
        None
    ]

    for stop_id in all_stops:
        stop = all_stops[stop_id]
        slat, slong, sname = stop

        dist = find_dist((slat, slong), (lat, long))

        if dist < closest_stop[0]:
            closest_stop = [
                dist,
                (stop_id, stop)
            ]
    
    return closest_stop

def nearest_stops(all_stops:dict, lat:int, long:int, amount_of_stops:int=50) -> list:
    closest_stops = [[
        float('inf'),
        None
    ]]

    for stop_id in all_stops:
        stop = all_stops[stop_id]
        slat, slong, sname = stop

        dist = find_dist((slat, slong), (lat, long))

        closest_stops.append([
            dist,
            (stop_id, stop)
        ])

        closest_stops.sort(key=lambda x: x[0])
        closest_stops = closest_stops[:amount_of_stops]

    return closest_stops