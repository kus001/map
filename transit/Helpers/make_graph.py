import csv
from heapq import heappop, heappush
from pathlib import Path

graph = {}

def add_neighbor(stop_id, neighbor_stop_id, trip_id, distance=1):
    if stop_id not in graph:
        graph[stop_id] = []
    graph[stop_id].append([(neighbor_stop_id, distance), trip_id])

# Assumes that the GTFS data is already downloaded and unzipped in the "transit/GTFS" directory.
with open(Path("transit") / "GTFS_Files" / "go" / "stops.txt", encoding="utf-8-sig", mode="r") as f:
    reader = csv.DictReader(f)
    stops = list(reader)

with open(Path("transit") / "GTFS_Files" / "go" / "stop_times.txt", encoding="utf-8-sig", mode="r") as f:
    reader = csv.DictReader(f)

    trips = {}

    for row in reader:
        trip_id = row["trip_id"]
        stop_id = row["stop_id"]
        arrival_time = row["arrival_time"]
        departure_time = row["departure_time"]
        sequence = int(row["stop_sequence"])

        if trip_id not in trips:
            trips[trip_id] = []

        trips[trip_id].append(({
            "stop_id": stop_id,
            "arrival_time": arrival_time,
            "departure_time": departure_time
        }, sequence))

for trip_id in trips:
    trips[trip_id].sort(key=lambda x: x[1])

# for stop in stops:
#     stop_id = stop["stop_id"]
#     stop_name = stop["stop_name"]
#     stop_lat = stop["stop_lat"]
#     stop_lon = stop["stop_lon"]
#     print(f"Stop ID: {stop_id}, Name: {stop_name}, Latitude: {stop_lat}, Longitude: {stop_lon}")

i = 0

for trip_id in trips:
    last_stop = None
    for stop, sequence in trips[trip_id]:
        stop_id = stop["stop_id"]
        add_neighbor(last_stop, stop_id, trip_id) if last_stop else None
        last_stop = stop_id

        i += 1

    if i > 1000:
        break

for stop_id in graph:
    print(f"Stop ID: {stop_id}, Neighbors: {graph[stop_id]}")