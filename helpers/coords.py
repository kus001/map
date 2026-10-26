from collections import defaultdict
from heapq import nsmallest
from math import floor

from helpers.distance import find_dist


_cell_size = .02
_cached_id = None
_cached_count = -1
_cells = {}


def _get_grid(all_stops):
    global _cached_id, _cached_count, _cells
    if _cached_id == id(all_stops) and _cached_count == len(all_stops):
        return _cells
    grid = defaultdict(list)
    for stop_id, item in all_stops.items():
        grid[(floor(item[0] / _cell_size), floor(item[1] / _cell_size))].append((stop_id, item))
    _cells = grid
    _cached_id, _cached_count = id(all_stops), len(all_stops)
    return grid


def nearest_stops(all_stops, lat, lon, amount_of_stops=50):
    count = max(1, int(amount_of_stops))
    grid = _get_grid(all_stops)
    x, y = floor(lat / _cell_size), floor(lon / _cell_size)
    candidates = []
    for ring in range(6):
        for dx in range(-ring, ring + 1):
            for dy in range(-ring, ring + 1):
                if ring and max(abs(dx), abs(dy)) != ring:
                    continue
                candidates.extend(grid.get((x + dx, y + dy), ()))

        if len(candidates) >= count and ring >= 2:
            break

    if len(candidates) < count:
        candidates = list(all_stops.items())
    return nsmallest(
        count,
        ((find_dist((item[0], item[1]), (lat, lon)), (stop_id, item))
         for stop_id, item in candidates),
        key=lambda result: result[0],
    )
