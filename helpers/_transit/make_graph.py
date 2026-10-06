import csv
import pickle
import sys
from datetime import datetime
from pathlib import Path

from helpers._transit.download_gtfs import download_gtfs
from helpers.distance import find_dist
from helpers.time_management import delta_time_in_minutes, time_to_seconds

PROJECT_ROOT = Path(__file__).resolve().parents[2]
TRANSIT_DATA = PROJECT_ROOT / "transit_data"
GTFS_ROOT = TRANSIT_DATA / "GTFS_Files"

WEEKDAY_FIELDS = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
]

graph = {}
node_positions = {}
all_stops = {}
trip_to_route = {}
trip_to_service = {}
calendar = {}
calendar_dates = {}
_seen_trip_hops = set()
_route_info_cache = {}  # (route_id, headsign) (this is a shared dict, so every trip sharing the same route+headsign reuses only one dict)


def service_active(service_id, check_date):
    date_str = check_date.strftime("%Y%m%d")
    exception = calendar_dates.get((service_id, date_str))

    if exception == 1:
        return True
    if exception == 2:
        return False

    cal = calendar.get(service_id)
    if cal is None or not (cal["start"] <= check_date <= cal["end"]):
        return False

    return cal["days"][check_date.weekday()]


def add_neighbor(
    stop_id,
    neighbor_stop_id,
    trip_id,
    distance=1,
    departure_time=None,
    arrival_time=None,
):
    stop_id = sys.intern(stop_id)
    neighbor_stop_id = sys.intern(neighbor_stop_id)
    if trip_id is not None:
        trip_id = sys.intern(trip_id)

    if departure_time:
        departure_time = time_to_seconds(departure_time)
        arrival_time = time_to_seconds(arrival_time)

    hop_key = (stop_id, neighbor_stop_id, trip_id)
    if hop_key in _seen_trip_hops:
        return
    _seen_trip_hops.add(hop_key)

    route_key = trip_to_route[trip_id]["route"] if trip_id is not None else "__walk__"

    graph.setdefault(stop_id, {})
    graph[stop_id].setdefault(neighbor_stop_id, {})
    graph[stop_id][neighbor_stop_id].setdefault(route_key, [])

    edge = {
        "distance": distance,
        "trip_id": trip_id,
        "departure_time": departure_time,
        "arrival_time": arrival_time,
    }

    if trip_id is not None:
        edge["route"] = trip_to_route[trip_id]

    graph[stop_id][neighbor_stop_id][route_key].append(edge)


def add_stop_position(stop_id, lat, lon, name=None):
    if stop_id not in node_positions:
        node_positions[stop_id] = (lat, lon, name)


def _read_rows(path):
    with path.open("r", encoding="utf-8-sig", newline="") as file:
        return list(csv.DictReader(file))


def add_agency_to_graph(agency, force_download=False):
    gtfs_folder = GTFS_ROOT / agency

    if not gtfs_folder.exists() or force_download:
        print(f"Downloading GTFS data for {agency}...")
        download_gtfs(agency)

    for row in _read_rows(gtfs_folder / "trips.txt"):
        trip_id = sys.intern(row["trip_id"])
        route_id = sys.intern(row["route_id"])
        headsign = row.get("trip_headsign", "")

        route_info_key = (route_id, headsign)
        route_info = _route_info_cache.get(route_info_key)
        if route_info is None:
            route_info = {"headsign": headsign, "route": route_id}
            _route_info_cache[route_info_key] = route_info

        trip_to_route[trip_id] = route_info
        trip_to_service[trip_id] = sys.intern(row["service_id"])

    calendar_path = gtfs_folder / "calendar.txt"
    if calendar_path.exists():
        for row in _read_rows(calendar_path):
            calendar[row["service_id"]] = {
                "days": [row[day] == "1" for day in WEEKDAY_FIELDS],
                "start": datetime.strptime(row["start_date"], "%Y%m%d").date(),
                "end": datetime.strptime(row["end_date"], "%Y%m%d").date(),
            }

    calendar_dates_path = gtfs_folder / "calendar_dates.txt"
    if calendar_dates_path.exists():
        for row in _read_rows(calendar_dates_path):
            calendar_dates[(row["service_id"], row["date"])] = int(
                row["exception_type"]
            )

    agency_stops = _read_rows(gtfs_folder / "stops.txt")
    all_stops[agency] = agency_stops

    for stop in agency_stops:
        full_stop_id = f"{agency}:{stop['stop_id']}"
        stop_coords = (float(stop["stop_lat"]), float(stop["stop_lon"]))

        add_stop_position(
            full_stop_id,
            stop_coords[0],
            stop_coords[1],
            stop.get("stop_name"),
        )

        # Add short walking transfer edges between nearby stops in any loaded agency.
        for other_agency, other_stops in all_stops.items():
            for other_stop in other_stops:
                other_full_id = f"{other_agency}:{other_stop['stop_id']}"
                if other_full_id == full_stop_id:
                    continue

                other_coords = (
                    float(other_stop["stop_lat"]),
                    float(other_stop["stop_lon"]),
                )
                distance = find_dist(stop_coords, other_coords)

                if distance < 100:
                    walking_minutes = distance / 60
                    add_neighbor(
                        full_stop_id,
                        other_full_id,
                        None,
                        walking_minutes,
                    )
                    add_neighbor(
                        other_full_id,
                        full_stop_id,
                        None,
                        walking_minutes,
                    )

    trips = {}
    for row in _read_rows(gtfs_folder / "stop_times.txt"):
        trips.setdefault(row["trip_id"], []).append(
            {
                "stop_id": row["stop_id"],
                "arrival_time": row["arrival_time"],
                "departure_time": row["departure_time"],
                "sequence": int(row["stop_sequence"]),
            }
        )

    for trip_id, trip_stops in trips.items():
        trip_stops.sort(key=lambda item: item["sequence"])
        last_stop = None
        last_departure_time = None

        for stop in trip_stops:
            if last_stop is not None and last_stop != stop["stop_id"]:
                minutes, seconds = delta_time_in_minutes(
                    last_departure_time,
                    stop["arrival_time"],
                )
                duration_min = minutes + seconds / 60

                add_neighbor(
                    f"{agency}:{last_stop}",
                    f"{agency}:{stop['stop_id']}",
                    trip_id,
                    distance=duration_min,
                    departure_time=last_departure_time,
                    arrival_time=stop["arrival_time"],
                )

            last_stop = stop["stop_id"]
            last_departure_time = stop["departure_time"]


def add_multiple_agencies_to_graph(
    *agencies,
    force_download=False,
    force_rebuild=False,
):
    global graph, node_positions, trip_to_service, calendar, calendar_dates

    TRANSIT_DATA.mkdir(parents=True, exist_ok=True)
    graph_path = TRANSIT_DATA / f"{'_&_'.join(agencies)}.pkl"

    if force_rebuild and graph_path.exists():
        graph_path.unlink()

    if graph_path.exists():
        with graph_path.open("rb") as file:
            loaded = pickle.load(file)

        graph = loaded.graph
        node_positions = loaded.node_positions
        trip_to_service = getattr(loaded, "trip_to_service", {})
        calendar = getattr(loaded, "calendar", {})
        calendar_dates = getattr(loaded, "calendar_dates", {})
        return

    for agency in agencies:
        add_agency_to_graph(agency, force_download=force_download)

    # Get rid of useless thingy magigs so they don't eat up all my precious RAM.
    _seen_trip_hops.clear()
    all_stops.clear()
    _route_info_cache.clear()

    for stop_neighbors in graph.values():
        for route_options in stop_neighbors.values():
            for trips in route_options.values():
                trips.sort(
                    key=lambda trip: (
                        trip["departure_time"] is None,
                        trip["departure_time"] or 0,
                    )
                )

    with graph_path.open("wb") as file:
        pickle.dump(
            Graph(
                graph,
                node_positions,
                trip_to_service,
                calendar,
                calendar_dates,
            ),
            file,
        )


class Graph:
    def __init__(
        self,
        graph,
        node_positions,
        trip_to_service=None,
        calendar=None,
        calendar_dates=None,
    ):
        self.graph = graph
        self.node_positions = node_positions
        self.trip_to_service = trip_to_service or {}
        self.calendar = calendar or {}
        self.calendar_dates = calendar_dates or {}

    def get_neighbors(self, stop_id):
        return self.graph.get(stop_id, {})

    def get_position(self, stop_id):
        return self.node_positions.get(stop_id, (None, None))

    def is_trip_active(self, trip_id, check_date):
        # Older prebuilt graph caches may not include service calendars. In that case,
        # keep trips available instead of incorrectly removing every route.
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
        if cal is None or not (cal["start"] <= check_date <= cal["end"]):
            return False

        return cal["days"][check_date.weekday()]


def make_graph():
    add_multiple_agencies_to_graph("grt_trains", "grt_busses", "go")
    return Graph(graph, node_positions, trip_to_service, calendar, calendar_dates)


if __name__ == "__main__":
    built = make_graph()
    print(f"Loaded {len(built.node_positions)} transit stops.")
