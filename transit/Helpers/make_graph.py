import csv
from heapq import heappop, heappush
from pathlib import Path

graph = {}

# Assumes that the GTFS data is already downloaded and unzipped in the "transit/GTFS" directory.
with open(Path("transit") / "GTFS_Files" / "go" / "stops.txt", encoding="utf-8-sig", mode="r") as f:
    reader = csv.DictReader(f)
    stops = list(reader)

with open(Path("transit") / "GTFS_Files" / "go" / "stop_times.txt", encoding="utf-8-sig", mode="r") as f:
    reader = csv.DictReader(f)
    stop_times = list(reader)

for stop in stops:
    stop_id = stop["stop_id"]
    stop_name = stop["stop_name"]
    stop_lat = stop["stop_lat"]
    stop_lon = stop["stop_lon"]
    #print(f"Stop ID: {stop_id}, Name: {stop_name}, Latitude: {stop_lat}, Longitude: {stop_lon}")

stop_times = sorted(stop_times, key=lambda x: (x["trip_id"], x["stop_sequence"]))

last_stop_id = None

i = 0

for stop_time in stop_times:
    trip_id = stop_time["trip_id"]
    stop_id = stop_time["stop_id"]

    if last_stop_id is not None and last_stop_id != stop_id:
        if graph.get(stop_id, None) is None:
            graph[stop_id] = []
        else:
            if (last_stop_id, 1) not in graph[stop_id]:
                graph[stop_id].append((last_stop_id, 1))
                graph[stop_id].append(trip_id)
            if (stop_id, 1) not in graph[last_stop_id]:
                graph[last_stop_id].append((stop_id, 1))
                graph[last_stop_id].append(trip_id)

    arrival_time = stop_time["arrival_time"]
    departure_time = stop_time["departure_time"]
    #print(f"Trip ID: {trip_id}, Stop ID: {stop_id}, Arrival Time: {arrival_time}, Departure Time: {departure_time}")

    last_stop_id = stop_id

for list in graph:
    print(f"\nStop ID: {list}")

    for i in range(len(graph[list])):
        if isinstance(graph[list][i], tuple):
            print(f"Connection: {graph[list][i]}", end=", ")
        else:
            print(f"Trip ID: {graph[list][i]}")