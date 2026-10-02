import csv
import sys
import shutil
import pickle
from pathlib import Path
from datetime import datetime

cwd = Path.cwd()
sys.path.append(str(cwd / "helpers"))

from distance import find_dist
from print_color import bold, green
from _transit.download_gtfs import download_gtfs
from time_management import time_to_seconds, delta_time_in_minutes

graph = {}
node_positions = {}
all_stops = {}
trip_to_route = {}
trip_to_service = {}  # trip_id -> service_id, needed to check which days a trip actually runs
calendar = {}         # service_id -> {"days": [mon..sun bool], "start": date, "end": date}
calendar_dates = {}   # (service_id, "YYYYMMDD") -> exception_type (1 = added, 2 = removed)
_seen_trip_hops = set()  # (stop_id, neighbor_stop_id, trip_id) already added — O(1) dedup instead of O(n) list scan

WEEKDAY_FIELDS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]

def service_active(service_id, check_date):
    """Whether a GTFS service_id actually runs on check_date (a datetime.date),
    per the standard GTFS rule: calendar_dates.txt exceptions override calendar.txt's
    weekly pattern for that exact date; otherwise the weekly pattern applies."""
    date_str = check_date.strftime("%Y%m%d")

    exception = calendar_dates.get((service_id, date_str))
    if exception == 1:
        return True   # explicitly added for this date, regardless of the weekly pattern
    if exception == 2:
        return False  # explicitly removed for this date, regardless of the weekly pattern

    cal = calendar.get(service_id)
    if cal is None:
        return False  # no weekly pattern and no explicit addition — doesn't run

    if not (cal["start"] <= check_date <= cal["end"]):
        return False

    return cal["days"][check_date.weekday()]  # Monday=0 .. Sunday=6, matches WEEKDAY_FIELDS

def add_neighbor(stop_id, neighbor_stop_id, trip_id, distance=1, departure_time=None, arrival_time=None):
    if departure_time:
        departure_time = time_to_seconds(departure_time)
        arrival_time   = time_to_seconds(arrival_time)

    # Every scheduled trip on this route for this hop is kept
    hop_key = (stop_id, neighbor_stop_id, trip_id)
    if hop_key in _seen_trip_hops:
        return  # already have this exact scheduled trip
    _seen_trip_hops.add(hop_key)

    # Key edges by route (not just by neighbor stop)
    route_key = trip_to_route[trip_id]["route"] if trip_id is not None else "__walk__"

    if stop_id not in graph:
        graph[stop_id] = {}
    if neighbor_stop_id not in graph[stop_id]:
        graph[stop_id][neighbor_stop_id] = {}
    if route_key not in graph[stop_id][neighbor_stop_id]:
        graph[stop_id][neighbor_stop_id][route_key] = []

    trips = graph[stop_id][neighbor_stop_id][route_key]

    edge = {"distance": distance, "trip_id": trip_id, "departure_time": departure_time, "arrival_time": arrival_time}
    if trip_id is not None:
        edge["route"] = trip_to_route[trip_id]
    trips.append(edge)

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
            trip_to_service[row["trip_id"]] = row["service_id"]

    cal_path = Path("transit_data") / "GTFS_Files" / agency / "calendar.txt"
    if cal_path.exists():
        with open(cal_path, encoding="utf-8-sig", mode="r") as f:
            reader = csv.DictReader(f)
            for row in reader:
                calendar[row["service_id"]] = {
                    "days": [row[d] == "1" for d in WEEKDAY_FIELDS],
                    "start": datetime.strptime(row["start_date"], "%Y%m%d").date(),
                    "end": datetime.strptime(row["end_date"], "%Y%m%d").date(),
                }

    cal_dates_path = Path("transit_data") / "GTFS_Files" / agency / "calendar_dates.txt"
    if cal_dates_path.exists():
        with open(cal_dates_path, encoding="utf-8-sig", mode="r") as f:
            reader = csv.DictReader(f)
            for row in reader:
                calendar_dates[(row["service_id"], row["date"])] = int(row["exception_type"])

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
            global graph, node_positions, trip_to_service, calendar, calendar_dates
            load = pickle.load(f)
            graph = load.graph
            node_positions = load.node_positions
            # getattr guards against loading a cache built before calendar filtering existed
            trip_to_service = getattr(load, "trip_to_service", {})
            calendar = getattr(load, "calendar", {})
            calendar_dates = getattr(load, "calendar_dates", {})
    else:
        for agency in agencies:
            add_agency_to_graph(agency, force_download=force_download)

        # Sort each hop's scheduled trips by departure time (walk edges sort first,
        # they have no departure_time and are always available)
        for stop_id in graph:
            for neighbor_id in graph[stop_id]:
                for route_key in graph[stop_id][neighbor_id]:
                    graph[stop_id][neighbor_id][route_key].sort(
                        key=lambda t: (t["departure_time"] is None, t["departure_time"] or 0)
                    )

        # Save the graph to a pickle file
        with open(Path("transit_data") / GRAPH_NAME, "wb") as f:
            pickle.dump(Graph(graph, node_positions, trip_to_service, calendar, calendar_dates), f)

class Graph:
    def __init__(self, graph, node_positions, trip_to_service=None, calendar=None, calendar_dates=None):
        self.graph = graph
        self.node_positions = node_positions
        # These default to the current module-level dicts at pickle time; a graph loaded from
        # an OLD cache built before this feature existed will get empty dicts here instead —
        # is_trip_active gracefully treats that as "no calendar info, don't filter" rather than crashing.
        self.trip_to_service = trip_to_service if trip_to_service is not None else {}
        self.calendar = calendar if calendar is not None else {}
        self.calendar_dates = calendar_dates if calendar_dates is not None else {}

    def get_neighbors(self, stop_id):
        return self.graph.get(stop_id, {})

    def get_position(self, stop_id):
        return self.node_positions.get(stop_id, (None, None))

    def is_trip_active(self, trip_id, check_date):
        """Whether trip_id actually runs on check_date. Trips with no known service
        calendar (e.g. loaded from a pre-calendar-filtering cache) are treated as always
        active, so this degrades safely rather than silently dropping every trip."""
        if not self.trip_to_service and not self.calendar and not self.calendar_dates:
            return True

        service_id = self.trip_to_service.get(trip_id)
        if service_id is None:
            return True

        date_str = check_date.strftime("%Y%m%d")
        exception = self.calendar_dates.get((service_id, date_str))
        if exception == 1:
            return True
        if exception == 2:
            return False

        cal = self.calendar.get(service_id)
        if cal is None:
            return False

        if not (cal["start"] <= check_date <= cal["end"]):
            return False

        return cal["days"][check_date.weekday()]

def make_graph():
    add_multiple_agencies_to_graph("grt_trains", "grt_busses", "go")
    return Graph(graph, node_positions, trip_to_service, calendar, calendar_dates)

if __name__ == "__main__":
    make_graph()

    for stop_id in graph:
        if len(graph[stop_id]) > 5:
            print(bold(f"\nStop ID {stop_id}:"))
            for stop in graph[stop_id]:
                for route_key, trips in graph[stop_id][stop].items():
                    for edge in trips:
                        print(f"  Neighbor: {stop},\t\tRoute: {route_key},\t\tDistance: {edge['distance']},\t\tTrip ID: {edge['trip_id']},\t\tDeparts: {edge['departure_time']}")
