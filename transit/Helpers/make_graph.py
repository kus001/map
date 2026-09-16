import csv
from heapq import heappop, heappush
from pathlib import Path

# Assumes that the GTFS data is already downloaded and unzipped in the "transit/GTFS" directory.
with open(Path("transit") / "GTFS_Files" / "go" / "stops.txt", encoding="utf-8-sig", mode="r") as f:
    reader = csv.DictReader(f)
    stops = list(reader)

print(stops)

for stop in stops:
    stop_id = stop["stop_id"]
    stop_name = stop["stop_name"]
    stop_lat = stop["stop_lat"]
    stop_lon = stop["stop_lon"]
    print(f"Stop ID: {stop_id}, Name: {stop_name}, Latitude: {stop_lat}, Longitude: {stop_lon}")