import csv
from heapq import heappop, heappush
from pathlib import Path

graph = {}

def add_neighbor(stop_id, neighbor_stop_id, trip_id, distance=1):
    if stop_id not in graph:
        graph[stop_id] = []
    elif (neighbor_stop_id, distance) in graph[stop_id]:
        return  # Avoid adding duplicate neighbors
    graph[stop_id].append((neighbor_stop_id, distance))
    graph[stop_id].append(trip_id)  # Add the trip_id to the list of neighbors

def add_agency_to_graph(agency):
    # Assumes that the GTFS data is already downloaded and unzipped in the "transit/GTFS" directory.
    with open(Path("transit") / "GTFS_Files" / agency / "stops.txt", encoding="utf-8-sig", mode="r") as f:
        reader = csv.DictReader(f)
        stops = list(reader)

    with open(Path("transit") / "GTFS_Files" / agency / "stop_times.txt", encoding="utf-8-sig", mode="r") as f:
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

            trips[trip_id].append({
                "stop_id": stop_id,
                "arrival_time": arrival_time,
                "departure_time": departure_time,
                "sequence": sequence
            })

    for trip_id in trips:
        trips[trip_id].sort(key=lambda x: x["sequence"])

    for trip_id in trips:
        last_stop = None
        for stop in trips[trip_id]:
            stop_id = stop["stop_id"]
            if last_stop is not None and last_stop != stop_id:
                #if :
                    add_neighbor(last_stop, stop_id, trip_id)
            last_stop = stop_id

    for stop_id in graph:
        print(bold(f"Stop ID {stop_id}:"))
        for item in graph[stop_id]:
            if isinstance(item, tuple):
                neighbor_stop_id, distance = item
                print(f"\tNeighbor Stop ID: {neighbor_stop_id}, Distance: {distance}")
            else:
                trip_id = item
                print(f"\t\tTrip ID: {trip_id}")

def add_multiple_agencies_to_graph(*agencies):
    for agency in agencies:
        add_agency_to_graph(agency)

if __name__ == "__main__":
    add_multiple_agencies_to_graph("grt_trains", "grt_busses", "go")