import csv
import shutil
import sys
from datetime import datetime
import pickle
from pathlib import Path

cwd = Path.cwd()
sys.path.append(str(cwd / "helpers"))

from _transit.download_gtfs import download_gtfs
from time_management import time_to_seconds, seconds_to_time, delta_time, delta_time_in_minutes
from print_color import bold, green
from distance import find_dist

graph = {}
node_positions = {}
all_stops = {}
trip_to_route = {}

def add_neighbor(stop_id, neighbor_stop_id, trip_id, distance=1, departure_time=None, arrival_time=None):
    if departure_time:
        departure_time = time_to_seconds(departure_time)
        arrival_time   = time_to_seconds(arrival_time)
        now = time_to_seconds(datetime.now().strftime("%H:%M:%S"))
        if departure_time <= now + 60:
            return
    
    if stop_id not in graph:
        graph[stop_id] = {}
    elif neighbor_stop_id in graph[stop_id]:
        return  # Avoid adding duplicate neighbors
    graph[stop_id][neighbor_stop_id] = {"distance": distance}
    graph[stop_id][neighbor_stop_id]["trip_id"] = trip_id
    graph[stop_id][neighbor_stop_id]["departure_time"] = departure_time
    graph[stop_id][neighbor_stop_id]["arrival_time"] = arrival_time

    if trip_id is not None:
        graph[stop_id][neighbor_stop_id]["route"] = trip_to_route[trip_id]

def add_stop_position(stop_id, lat, lon, name=None):
    if stop_id not in node_positions:
        node_positions[stop_id] = (lat, lon, name)

def add_agency_to_graph(agency, force_download=False):
    if not (Path("transit_data") / "GTFS_Files" / agency).exists() or force_download:
        print(f"\nDownloading GTFS data for {bold(agency.upper())}...")
        if download_gtfs(agency) == 0:
            print(green(f"Downloaded GTFS data for {agency.upper()}."))

    with open(Path("transit_data") / "GTFS_Files" / agency / "trips.txt", encoding="utf-8-sig", mode="r") as f:
        reader = csv.DictReader(f)
        for row in reader:
            trip_to_route[row["trip_id"]] = {
                "headsign": row["trip_headsign"],
                "route"   : row["route_id"]
            }

    with open(Path("transit_data") / "GTFS_Files" / agency / "stops.txt", encoding="utf-8-sig", mode="r") as f:
        reader = csv.DictReader(f)
        stops = list(reader)
        all_stops[agency] = stops  # Add the stops to the global dictionary of all stops

    for stop in stops:
        add_stop_position(agency + ":" + stop["stop_id"], float(stop["stop_lat"]), float(stop["stop_lon"]), stop["stop_name"])
        for agency2 in all_stops:
            for stop2 in all_stops[agency2]:
                if stop["stop_id"] != stop2["stop_id"]:
                    stop_coords2 = (float(stop2["stop_lat"]), float(stop2["stop_lon"]))
                    stop_coords = (float(stop["stop_lat"]), float(stop["stop_lon"]))
                    distance = find_dist(stop_coords, stop_coords2)
                    if distance < 100:
                        add_neighbor(agency + ":" + stop["stop_id"], agency2 + ":" + stop2["stop_id"], None, distance/60)  # Convert distance to minutes assuming average walking speed of 1 m/s
                        add_neighbor(agency2 + ":" + stop2["stop_id"], agency + ":" + stop["stop_id"], None, distance/60)  # Convert distance to minutes assuming average walking speed of 1 m/s

    with open(Path("transit_data") / "GTFS_Files" / agency / "stop_times.txt", encoding="utf-8-sig", mode="r") as f:
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
                add_neighbor(agency + ":" + last_stop, agency + ":" + stop_id, trip_id, distance=dt[0]+dt[1]//6/10, departure_time=last_departure_time, arrival_time=stop_arrival_time)  # Use the time difference in minutes as the distance
            last_stop = stop_id
            last_departure_time = stop_departure_time

def add_multiple_agencies_to_graph(*agencies, force_download=False, force_rebuild=False):
    GRAPH_NAME = f"{'_&_'.join(agencies)}.pkl"

    if force_rebuild:
        shutil.rmtree(Path("transit_data")) if Path("transit_data").exists() else None

    if Path(Path("transit_data") / GRAPH_NAME).exists():
        with open(Path("transit_data") / GRAPH_NAME, "rb") as f:
            global graph, node_positions
            load = pickle.load(f)
            graph = load.graph
            node_positions = load.node_positions
    else:
        for agency in agencies:
            add_agency_to_graph(agency, force_download=force_download)

        # Save the graph to a pickle file
        '''with open(Path("transit_data") / GRAPH_NAME, "wb") as f:
            pickle.dump(Graph(graph, node_positions), f)'''

class Graph:
    def __init__(self, graph, node_positions):
        self.graph = graph
        self.node_positions = node_positions

    def get_neighbors(self, stop_id):
        return self.graph.get(stop_id, {})

    def get_position(self, stop_id):
        return self.node_positions.get(stop_id, (None, None))

def make_graph():
    add_multiple_agencies_to_graph("grt_trains", "grt_busses", "go")
    return Graph(graph, node_positions)

if __name__ == "__main__":
    make_graph()

    for stop_id in graph:
        if len(graph[stop_id]) > 5:
            print(bold(f"\nStop ID {stop_id}:"))
            for stop in graph[stop_id]:
                print(f"  Neighbor: {stop},\t\tDistance: {graph[stop_id][stop]['distance']},\t\tTrip ID: {graph[stop_id][stop]['trip_id']}")