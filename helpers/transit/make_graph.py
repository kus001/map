import csv
import sys
import math
import pickle
from heapq import heappop, heappush
from pathlib import Path

cwd = Path.cwd()
sys.path.append(str(cwd / "helpers"))

from download_gtfs import download_gtfs
from time_management import time_to_seconds, seconds_to_time, delta_time, delta_time_in_minutes
from print_color import bold

graph = {}
all_stops = []

def find_dist(coord1, coord2):
    lat1, lon1 = coord1
    lat2, lon2 = coord2

    rad_lat = math.radians(lat1)

    deg_to_km = 111.32  # Approximate conversion factor from degrees to kilometers
    dlat = (lat2 - lat1) * deg_to_km
    dlon = (lon2 - lon1) * deg_to_km * math.cos(rad_lat)

    distance = math.sqrt(dlat**2 + dlon**2) * 1000  # Convert to meters

    return distance

def add_neighbor(stop_id, neighbor_stop_id, trip_id, distance=1):
    if stop_id not in graph:
        graph[stop_id] = {}
    elif neighbor_stop_id in graph[stop_id]:
        return  # Avoid adding duplicate neighbors
    graph[stop_id][neighbor_stop_id] = {"distance": distance}
    graph[stop_id][neighbor_stop_id]["trip_id"] = trip_id

def add_agency_to_graph(agency, force_download=False):
    if not Path("transit") / "GTFS_Files" / agency or force_download:
        print(f"Downloading GTFS data for {agency}...")
        download_gtfs(agency)

    with open(Path("transit") / "GTFS_Files" / agency / "stops.txt", encoding="utf-8-sig", mode="r") as f:
        reader = csv.DictReader(f)
        stops = list(reader)
        all_stops.extend(stops)  # Add the stops to the global list of all stops

    for stop in stops:
        for stop2 in all_stops:
            if stop["stop_id"] != stop2["stop_id"]:
                stop_coords2 = (float(stop2["stop_lat"]), float(stop2["stop_lon"]))
                stop_coords = (float(stop["stop_lat"]), float(stop["stop_lon"]))
                distance = find_dist(stop_coords, stop_coords2)
                if distance < 100:
                    add_neighbor(agency + ":" + stop["stop_id"], agency + ":" + stop2["stop_id"], None, distance//6/10)  # Convert distance to minutes assuming average walking speed of 1 m/s
                    add_neighbor(agency + ":" + stop2["stop_id"], agency + ":" + stop["stop_id"], None, distance//6/10)  # Convert distance to minutes assuming average walking speed of 1 m/s

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
        last_departure_time = None
        for stop in trips[trip_id]:
            stop_id = stop["stop_id"]
            stop_arrival_time = stop["arrival_time"]
            stop_departure_time = stop["departure_time"]
            if last_stop is not None and last_stop != stop_id:
                dt = delta_time_in_minutes(last_departure_time, stop_arrival_time)
                add_neighbor(agency + ":" + last_stop, agency + ":" + stop_id, trip_id, distance=(dt[0]+dt[1]//6/10, last_departure_time, stop_arrival_time))  # Use the time difference in minutes as the distance
            last_stop = stop_id
            last_departure_time = stop_departure_time

def add_multiple_agencies_to_graph(*agencies, force_download=False, force_rebuild=False):
    GRAPH_NAME = f"{'_&_'.join(agencies)}.pkl"
    if not force_rebuild:
        if Path(Path("transit") / GRAPH_NAME).exists():
            with open(Path("transit") / GRAPH_NAME, "rb") as f:
                global graph
                graph = pickle.load(f)
        else:
            for agency in agencies:
                add_agency_to_graph(agency, force_download=force_download)

            # Save the graph to a pickle file
            with open(Path("transit") / GRAPH_NAME, "wb") as f:
                pickle.dump(graph, f)
    else:
        for agency in agencies:
            add_agency_to_graph(agency, force_download=force_download)

        # Save the graph to a pickle file
        with open(Path("transit") / GRAPH_NAME, "wb") as f:
            pickle.dump(graph, f)

if __name__ == "__main__":
    add_multiple_agencies_to_graph("grt_trains", "grt_busses", "go", force_download=False, force_rebuild=False)

    for stop_id in graph:
        if len(graph[stop_id]) > 5:
            print(bold(f"\nStop ID {stop_id}:"))
            for stop in graph[stop_id]:
                print(f"  Neighbor: {stop},\t\tDistance: {graph[stop_id][stop]['distance']},\t\tTrip ID: {graph[stop_id][stop]['trip_id']}")