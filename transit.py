import math
import os
import time
import threading
from collections import OrderedDict
from bisect import bisect_left
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from functools import lru_cache
from heapq import heappop, heappush
from itertools import count
from zoneinfo import ZoneInfo

import requests
from dotenv import load_dotenv

from helpers._transit.go_realtime import (
    configured as go_realtime_configured,
    gtfs_snapshot as go_gtfs_snapshot,
    live_departures as go_live_departures,
    match_departure as match_go_departure,
    start_gtfs_background_refresh,
)
from helpers._transit.gtfs_metadata import shape_for_trip
from helpers._transit.make_graph import make_graph
from helpers._transit.realtime import (
    adjusted_arrival,
    adjusted_departure,
    matching_alerts,
    snapshot as realtime_snapshot,
    start_background_refresh,
    vehicle_for_trip,
)
from helpers.coords import nearest_stops
from helpers.geocoding import explain_address_problem, get_coordinates
from helpers.time_management import seconds_to_time, us
from walking import get_walking_route

load_dotenv()

ORS_API_KEY = os.getenv("API")
ORS_WALKING_URL = (
    "https://api.heigit.org/openrouteservice/v2/directions/foot-walking"
)

TRANSIT_TIMEZONE = ZoneInfo("America/Toronto")

MAX_NEARBY_STOPS = 250
FASTEST_NEARBY_STOPS = 600

TRANSIT_PREFERENCES = {
    "balanced": {
        "label": "Balanced",
        "soft_walk_m": 700,
        "walk_penalty": 1.0,   # each minute walked past soft_walk_m counts double
        "max_nearby_stops": MAX_NEARBY_STOPS,
    },
    "less_walking": {
        "label": "Less walking",
        "soft_walk_m": 300,
        "walk_penalty": 2.0,   # each minute past soft_walk_m counts triple
        "max_nearby_stops": MAX_NEARBY_STOPS,
    },
    "fastest": {
        "label": "Fastest",
        "soft_walk_m": 0,
        "walk_penalty": 0.0,   # no limiter: pure time
        "max_nearby_stops": FASTEST_NEARBY_STOPS,
    },
}

TRANSFER_BUFFER_MIN = 4
HEURISTIC_SPEED_KMH = 200.0
ACCESS_WALK_SPEED_MPS = 1.35
SERVICE_DAY_ROLLOVER_HOUR = 4
REALTIME_SCHEDULE_WINDOW_HOURS = 3
TRANSIT_DETAILED_WALKS = os.getenv("TRANSIT_DETAILED_WALKS", "0") == "1"
MAX_TRANSIT_ALTERNATIVES = max(1, min(int(os.getenv("TRANSIT_ALTERNATIVES", "3")), 4))
TRANSIT_GO_BOARD_ENRICHMENT = os.getenv("TRANSIT_GO_BOARD_ENRICHMENT", "0") == "1"

_data = None
graph = None
stops = None
_transit_load_lock = threading.Lock()
_realtime_started = False


def ensure_transit_loaded(verbose=False):
    """Load the heavy transit graph only when transit is actually needed.

    `verbose=True` is used by the standalone local transit tester so the old
    loading messages are still available without spamming the production log.
    Returns the graph load time in seconds, or 0.0 if it was already loaded.
    """
    global _data, graph, stops, _realtime_started

    if _data is not None:
        if verbose:
            print(f"Transit data already loaded ({len(stops):,} stops).")
        return 0.0

    with _transit_load_lock:
        if _data is not None:
            if verbose:
                print(f"Transit data already loaded ({len(stops):,} stops).")
            return 0.0

        if verbose:
            print("Loading transit data...")

        load_started = time.perf_counter()
        loaded = make_graph()
        load_seconds = time.perf_counter() - load_started

        _data = loaded
        graph = loaded.graph
        stops = loaded.node_positions

        if not _realtime_started:
            start_background_refresh()
            start_gtfs_background_refresh()
            _realtime_started = True

        if verbose:
            print(
                f"Transit data loaded in {load_seconds:.3f}s "
                f"({len(stops):,} stops)."
            )

        return load_seconds


def coord(value):
    return [float(value[0]), float(value[1])]


def stop_coords(entry):
    return coord(entry[1])


def stop_name(entry):
    info = entry[1]
    return str(info[2]) if len(info) > 2 and info[2] else str(entry[0])


def stop_agency(stop_id):
    return str(stop_id).split(":", 1)[0]


def raw_stop_id(stop_id):
    text = str(stop_id)
    return text.split(":", 1)[1] if ":" in text else text


def access_walk_minutes(distance_m):
    return float(distance_m) / ACCESS_WALK_SPEED_MPS / 60


def haversine_m(a, b):
    lat1, lon1 = map(float, a[:2])
    lat2, lon2 = map(float, b[:2])
    radius = 6_371_000.0

    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)

    h = (
        math.sin(dp / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    )
    return 2 * radius * math.asin(math.sqrt(h))


def polyline_distance_m(points):
    if not points or len(points) < 2:
        return 0.0
    return sum(haversine_m(points[i - 1], points[i]) for i in range(1, len(points)))


def time_label(value):
    if value is None:
        return None

    try:
        # GTFS permits times past 24:00 for trips that continue after midnight.
        # Convert those back to a normal clock time for the UI.
        seconds = int(round(float(value))) % (24 * 3600)
        return seconds_to_time(seconds)[:5]
    except Exception:
        return None


def shifted_time_label(value, minutes):
    label = value if isinstance(value, str) else time_label(value)
    if not label:
        return None

    try:
        hour, minute = [int(part) for part in str(label).split(":")[:2]]
        total = (hour * 60 + minute + int(round(float(minutes or 0)))) % (24 * 60)
        return f"{total // 60:02d}:{total % 60:02d}"
    except (TypeError, ValueError):
        return label


def normalize_departure_datetime(value):
    """Return an aware America/Toronto datetime for a requested departure."""
    if value is None:
        return datetime.now(TRANSIT_TIMEZONE)

    if isinstance(value, datetime):
        parsed = value
    else:
        parsed = datetime.fromisoformat(str(value).strip())

    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=TRANSIT_TIMEZONE)

    return parsed.astimezone(TRANSIT_TIMEZONE)


def gtfs_service_clock(departure_datetime):
    """Translate local date/time to GTFS service date + seconds since service midnight."""
    service_date = departure_datetime.date()
    seconds = (
        departure_datetime.hour * 3600
        + departure_datetime.minute * 60
        + departure_datetime.second
    )

    # Trips after midnight are commonly represented as 24:xx, 25:xx, etc.
    if departure_datetime.hour < SERVICE_DAY_ROLLOVER_HOUR:
        service_date -= timedelta(days=1)
        seconds += 24 * 3600

    return service_date, seconds


def route_details(edge):
    route_info = edge.get("route")
    headsign = edge.get("headsign")

    if isinstance(route_info, dict):
        route_name = (
            route_info.get("route")
            or route_info.get("route_short_name")
            or route_info.get("name")
            or route_info.get("route_id")
        )
        headsign = route_info.get("headsign") or headsign
    else:
        route_name = str(route_info) if route_info else None

    return route_name, str(headsign) if headsign is not None else None


def normalize_color(value):
    value = str(value or "").strip().lstrip("#")
    if len(value) == 6 and all(c in "0123456789abcdefABCDEF" for c in value):
        return f"#{value}"
    return None


def vehicle_label(agency, route_type=None):
    print(route_type)
    labels = {
        "0": "tram",
        "1": "subway",
        "2": "train",
        "3": "bus",
        "4": "ferry",
        "5": "tram",
        "6": "gondola",
        "7": "funicular",
        "11": "trolleybus",
        "12": "monorail",
    }

    if route_type is not None and str(route_type) in labels:
        return labels[str(route_type)]
    if agency == "grt_trains":
        return "train"
    if agency == "grt_busses":
        return "bus"
    if agency == "go":
        return "train/bus"
    return "transit"


@lru_cache(maxsize=64)
def _walking_route_cached(start_lat, start_lon, end_lat, end_lon):
    if not ORS_API_KEY:
        return None

    try:
        response = requests.get(
            ORS_WALKING_URL,
            headers={
                "Authorization": ORS_API_KEY,
                "Accept": "application/json, application/geo+json",
            },
            params={
                "start": f"{start_lon},{start_lat}",
                "end": f"{end_lon},{end_lat}",
            },
            timeout=12,
        )
        response.raise_for_status()

        feature = response.json()["features"][0]
        summary = feature.get("properties", {}).get("summary", {})

        return {
            "coordinates": [
                [float(lat), float(lon)]
                for lon, lat in feature["geometry"]["coordinates"]
            ],
            "distance_m": float(summary.get("distance", 0)),
            "duration_min": float(summary.get("duration", 0)) / 60,
        }
    except Exception:
        return None


def walking_geometry(start, end, fallback_min=None):
    start = coord(start)
    end = coord(end)
    straight_distance = haversine_m(start, end)

    if fallback_min is None:
        fallback_min = access_walk_minutes(straight_distance)

    if straight_distance <= 35 or not TRANSIT_DETAILED_WALKS:
        return {
            "coordinates": [start, end],
            "distance_m": straight_distance,
            "duration_min": float(fallback_min),
        }

    result = _walking_route_cached(
        round(start[0], 6),
        round(start[1], 6),
        round(end[0], 6),
        round(end[1], 6),
    )

    if result:
        return result

    return {
        "coordinates": [start, end],
        "distance_m": straight_distance,
        "duration_min": float(fallback_min),
    }


_SCHEDULE_CACHE = OrderedDict()
MAX_SCHEDULE_CACHE_ENTRIES = 256


def schedule_info(trips):
    """Return binary-search helpers without allowing the cache to grow forever."""
    key = id(trips)
    cached = _SCHEDULE_CACHE.get(key)
    if cached is not None:
        _SCHEDULE_CACHE.move_to_end(key)
        return cached

    # make_graph stores scheduled trips in departure order, so avoid making another
    # full copy of every edge's trip list.
    ordered = trips
    info = {
        "trips": ordered,
        "times": [
            trip.get("departure_time")
            if trip.get("departure_time") is not None
            else float("inf")
            for trip in ordered
        ],
        "by_trip": {
            str(trip.get("trip_id")): trip
            for trip in ordered
            if trip.get("trip_id") is not None
        },
    }

    _SCHEDULE_CACHE[key] = info
    _SCHEDULE_CACHE.move_to_end(key)

    while len(_SCHEDULE_CACHE) > MAX_SCHEDULE_CACHE_ENTRIES:
        _SCHEDULE_CACHE.popitem(last=False)

    return info


@lru_cache(maxsize=20_000)
def trip_active(trip_id, date):
    return _data.is_trip_active(trip_id, date)


def access_walk_cost(distance_m, soft_walk_m, walk_penalty):
    """Return (real_minutes, penalty_minutes) for walking distance_m to/from a stop.

    Only the real minutes advance the clock. The penalty is added to a route's
    ranking score so long walks get steadily less attractive instead of being
    cut off at a fixed distance.
    """
    real = access_walk_minutes(distance_m)
    excess_m = max(0.0, float(distance_m) - float(soft_walk_m))
    return real, access_walk_minutes(excess_m) * float(walk_penalty)


def candidate_stops(options, max_distance_m=None, max_count=MAX_NEARBY_STOPS):
    """Nearest stops first. A distance cap is now optional (None = no hard limit)."""
    ordered = sorted((o for o in options if o[1] is not None), key=lambda o: o[0])
    if max_distance_m is not None:
        ordered = [o for o in ordered if o[0] <= max_distance_m]
    return ordered[:max_count]


def transit_preference_profile(value):
    key = str(value or "balanced").strip().lower()
    if key not in TRANSIT_PREFERENCES:
        key = "balanced"
    return key, TRANSIT_PREFERENCES[key]


def _candidate_trip(
    schedule,
    agency,
    from_stop,
    to_stop,
    earliest,
    date,
    realtime,
):
    times = schedule["times"]

    if realtime.get("available") and agency in {"grt_busses", "grt_trains", "go"}:
        # Search a little before the scheduled time because a late vehicle may have had
        # an earlier static departure while still being catchable now.
        index = bisect_left(times, earliest - 2 * 3600)
        best = None
        best_departure = float("inf")

        for trip in schedule["trips"][index:]:
            static_departure = trip.get("departure_time")
            if static_departure is None:
                continue

            if static_departure > earliest + 2 * 3600 and best is not None:
                break

            trip_id = trip.get("trip_id")
            if trip_id is None or not trip_active(trip_id, date):
                continue

            departure, dep_delay, live_dep = adjusted_departure(
                realtime, agency, trip, raw_stop_id(from_stop)
            )
            if departure is None or departure < earliest or departure >= best_departure:
                continue

            arrival, arr_delay, live_arr = adjusted_arrival(
                realtime, agency, trip, raw_stop_id(to_stop)
            )

            best_departure = departure
            best = (
                trip,
                departure,
                arrival,
                dep_delay,
                live_dep or live_arr,
                arr_delay,
            )

        return best

    index = bisect_left(times, earliest)
    for trip in schedule["trips"][index:]:
        trip_id = trip.get("trip_id")
        if trip_id is not None and trip_active(trip_id, date):
            arrival = trip.get("arrival_time")
            return (
                trip,
                float(trip["departure_time"]),
                float(arrival) if arrival is not None else None,
                0.0,
                False,
                0.0,
            )

    return None


def search_transit(
    start_options,
    end_options,
    realtime,
    departure_datetime=None,
    safety_buffer=TRANSFER_BUFFER_MIN,
    soft_walk_m=1000,
    walk_penalty=1.0,
    max_nearby_stops=MAX_NEARBY_STOPS,
    excluded_route_keys=None,
):
    """Returns (path, real_minutes, start_option, end_option).

    real_minutes is true door-to-door time (walk + wait + ride + walk), with no
    penalty included, so callers can compare it against other modes.
    """
    departure_datetime = normalize_departure_datetime(departure_datetime)
    service_date, now_seconds = gtfs_service_clock(departure_datetime)
    excluded_route_keys = {
        (str(agency), str(route)) for agency, route in (excluded_route_keys or set())
    }

    start_options = candidate_stops(start_options, None, max_nearby_stops)
    end_options = candidate_stops(end_options, None, max_nearby_stops)

    if not start_options or not end_options:
        return None, float("inf"), None, None

    starts = {}
    ends = {}

    for option in start_options:
        stop_id = option[1][0]
        if stop_id not in starts or option[0] < starts[stop_id][0]:
            starts[stop_id] = option

    for option in end_options:
        stop_id = option[1][0]
        if stop_id not in ends or option[0] < ends[stop_id][0]:
            ends[stop_id] = option

    heuristic_cache = {}

    def heuristic(stop_id):
        cached = heuristic_cache.get(stop_id)
        if cached is not None:
            return cached
        here = coord(stops[stop_id])
        best = float("inf")
        for goal_id, option in ends.items():
            target = coord(stops[goal_id])
            straight_km = haversine_m(here, target) / 1000
            end_real, end_pen = access_walk_cost(option[0], soft_walk_m, walk_penalty)
            # Still admissible: ride time is a lower bound, penalties are >= 0.
            optimistic = straight_km / HEURISTIC_SPEED_KMH * 60 + end_real + end_pen
            best = min(best, optimistic)
        heuristic_cache[stop_id] = best
        return best

    queue = []
    costs = {}        # state -> (true minutes g, boardings)
    scores = {}       # state -> (g + penalty, boardings)  used for pruning
    penalty_of = {}   # state -> accumulated soft penalty (minutes)
    parent = {}
    seed_costs = {}
    tie = count()

    for stop_id, option in starts.items():
        access_min, start_pen = access_walk_cost(option[0], soft_walk_m, walk_penalty)
        state = (stop_id, None)
        costs[state] = (access_min, 0)
        scores[state] = (round(access_min + start_pen, 6), 0)
        penalty_of[state] = start_pen
        seed_costs[state] = access_min
        heappush(
            queue,
            (
                access_min + start_pen + heuristic(stop_id),
                access_min,
                0,
                next(tie),
                stop_id,
                None,
            ),
        )

    best_total = float("inf")   # ranking score (includes penalties)
    best_real = float("inf")    # true minutes of the best-ranked route
    best_state = None
    best_end = None

    while queue:
        priority, popped_g, popped_boardings, _, stop_id, current_trip = heappop(queue)

        if priority >= best_total:
            break

        state = (stop_id, current_trip)
        current_g, boardings = costs.get(state, (float("inf"), float("inf")))

        if abs(current_g - popped_g) > 1e-9 or boardings != popped_boardings:
            continue

        current_pen = penalty_of.get(state, 0.0)

        if stop_id in ends:
            end_real, end_pen = access_walk_cost(
                ends[stop_id][0], soft_walk_m, walk_penalty
            )
            total = current_g + current_pen + end_real + end_pen
            if total < best_total:
                best_total = total
                best_real = current_g + end_real
                best_state = state
                best_end = ends[stop_id]

        current_arrival = now_seconds + current_g * 60
        is_seed = state in seed_costs and abs(seed_costs[state] - current_g) < 1e-9
        agency = stop_agency(stop_id)

        for neighbor_id, route_options in graph.get(stop_id, {}).items():
            for route_key, trips in route_options.items():
                choices = []

                # ---- unchanged: build `choices` for __walk__ edges, continuing
                # ---- trips, and new boardings exactly as in the original ----
                if route_key == "__walk__":
                    if not trips:
                        continue
                    edge = dict(trips[0])
                    edge["_wait_minutes"] = 0.0
                    edge["_realtime"] = False
                    edge["_ride_minutes"] = float(edge.get("distance", 0))
                    choices.append((edge["_ride_minutes"], None, edge, boardings))
                else:
                    schedule = schedule_info(trips)
                    continuing = (
                        schedule["by_trip"].get(str(current_trip))
                        if current_trip is not None
                        else None
                    )
                    if continuing is not None:
                        departure, dep_delay, live_dep = adjusted_departure(
                            realtime, agency, continuing, raw_stop_id(stop_id)
                        )
                        arrival, arr_delay, live_arr = adjusted_arrival(
                            realtime, agency, continuing, raw_stop_id(neighbor_id)
                        )
                        if departure is None:
                            continue
                        static_duration = float(continuing.get("distance", 0))
                        if arrival is not None:
                            ride_min = max(0.0, (arrival - current_arrival) / 60)
                        else:
                            ride_min = static_duration
                        edge = dict(continuing)
                        edge["_wait_minutes"] = 0.0
                        edge["_realtime"] = bool(live_dep or live_arr)
                        edge["_delay_seconds"] = arr_delay if live_arr else dep_delay
                        edge["_actual_departure_time"] = departure
                        edge["_actual_arrival_time"] = arrival
                        edge["_ride_minutes"] = ride_min
                        choices.append((ride_min, str(current_trip), edge, boardings))
                    else:
                        earliest = current_arrival
                        if not is_seed:
                            earliest += safety_buffer * 60
                        selected = _candidate_trip(
                            schedule, agency, stop_id, neighbor_id,
                            earliest, service_date, realtime,
                        )
                        if selected is None:
                            continue
                        trip, departure, arrival, dep_delay, has_live, arr_delay = selected
                        wait_min = max(0.0, (departure - current_arrival) / 60)
                        static_duration = float(trip.get("distance", 0))
                        ride_min = (
                            max(0.0, (arrival - departure) / 60)
                            if arrival is not None
                            else static_duration
                        )
                        edge = dict(trip)
                        edge["_wait_minutes"] = wait_min
                        edge["_realtime"] = bool(has_live)
                        edge["_delay_seconds"] = arr_delay if has_live else dep_delay
                        edge["_actual_departure_time"] = departure
                        edge["_actual_arrival_time"] = arrival
                        edge["_ride_minutes"] = ride_min
                        choices.append(
                            (wait_min + ride_min, str(trip.get("trip_id")), edge, boardings + 1)
                        )
                # ---- end unchanged block ----

                for extra, trip_id, edge, new_boardings in choices:
                    new_g = current_g + extra
                    new_pen = current_pen
                    next_state = (neighbor_id, trip_id)
                    new_score = (round(new_g + new_pen, 6), new_boardings)

                    if new_score >= scores.get(next_state, (float("inf"), float("inf"))):
                        continue

                    lower_bound = new_g + new_pen + heuristic(neighbor_id)
                    if lower_bound >= best_total:
                        continue

                    costs[next_state] = (new_g, new_boardings)
                    scores[next_state] = new_score
                    penalty_of[next_state] = new_pen
                    parent[next_state] = (state, edge)
                    heappush(
                        queue,
                        (
                            lower_bound,
                            new_g,
                            new_boardings,
                            next(tie),
                            neighbor_id,
                            trip_id,
                        ),
                    )

    if best_state is None:
        return None, float("inf"), None, None

    path = []
    state = best_state
    while state in parent:
        previous, edge = parent[state]
        path.append((state[0], stops[state[0]], edge))
        state = previous

    start_stop_id = state[0]
    path.append((start_stop_id, stops[start_stop_id], None))
    path.reverse()

    return path, best_real, starts[start_stop_id], best_end


def is_transit_edge(edge):
    return bool(edge.get("trip_id") or edge.get("route"))


def route_keys_for_path(path):
    keys = []
    seen = set()
    for index in range(1, len(path)):
        previous_stop = path[index - 1]
        edge = path[index][2] or {}
        if not is_transit_edge(edge):
            continue
        route_name, _ = route_details(edge)
        key = (stop_agency(previous_stop[0]), str(route_name or edge.get("route") or ""))
        if key[1] and key not in seen:
            seen.add(key)
            keys.append(key)
    return keys


def route_signature(route):
    signature = []
    for step in route.get("steps", []):
        if step.get("type") == "transit":
            signature.append((
                str(step.get("agency") or ""),
                str(step.get("route") or ""),
                str(step.get("from_stop_id") or ""),
                str(step.get("to_stop_id") or ""),
            ))
    return tuple(signature)


def combine_realtime(grt, go):
    # Do not let a healthy feed from one agency make stale TripUpdates from the
    # other agency look valid. Each source must be fresh before its delays and
    # cancellations are allowed to affect A* routing.
    trip_updates = (
        dict(grt.get("trip_updates", {})) if grt.get("available") else {}
    )
    if go.get("available"):
        trip_updates.update(go.get("trip_updates", {}))

    # Position feeds are independent of TripUpdates and are replaced on every
    # refresh, so valid positions can still be displayed during a delay-feed
    # outage.
    vehicles = dict(grt.get("vehicles", {}))
    vehicles.update(go.get("vehicles", {}))
    timestamps = [v for v in (grt.get("feed_timestamp"), go.get("feed_timestamp")) if v]
    return {
        "loaded_at": max(float(grt.get("loaded_at") or 0), float(go.get("loaded_at") or 0)),
        "trip_updates": trip_updates,
        "vehicles": vehicles,
        "alerts": list(grt.get("alerts", [])) + list(go.get("alerts", [])),
        "available": bool(grt.get("available") or go.get("available")),
        "alerts_available": bool(grt.get("alerts_available") or go.get("alerts_available")),
        "feed_timestamp": max(timestamps) if timestamps else None,
    }


def group_path(path):
    groups = []
    current = None

    for index in range(1, len(path)):
        previous_stop = path[index - 1]
        current_stop = path[index]
        edge = current_stop[2] or {}
        transit = is_transit_edge(edge)

        if transit:
            route_name, headsign = route_details(edge)
            trip_id = str(edge.get("trip_id")) if edge.get("trip_id") is not None else None
            key = ("transit", trip_id or route_name or str(edge.get("route")))
        else:
            route_name = None
            headsign = None
            trip_id = None
            key = ("walking",)

        if current is None or current["key"] != key:
            if current is not None:
                groups.append(current)

            current = {
                "key": key,
                "type": "transit" if transit else "walking",
                "agency": stop_agency(previous_stop[0]),
                "trip_id": trip_id,
                "route": route_name,
                "headsign": headsign,
                "from_name": stop_name(previous_stop),
                "to_name": stop_name(current_stop),
                "from_coords": stop_coords(previous_stop),
                "to_coords": stop_coords(current_stop),
                "stops": [previous_stop, current_stop],
                "stop_count": 1,
                "ride_min": float(
                    edge.get("_ride_minutes", edge.get("distance", 0))
                ),
                "wait_min": float(edge.get("_wait_minutes", 0)),
                "departure_time": edge.get(
                    "_actual_departure_time", edge.get("departure_time")
                ),
                "arrival_time": edge.get(
                    "_actual_arrival_time", edge.get("arrival_time")
                ),
                "scheduled_departure_time": edge.get("departure_time"),
                "scheduled_arrival_time": edge.get("arrival_time"),
                "realtime": bool(edge.get("_realtime", False)),
                "delay_seconds": float(edge.get("_delay_seconds", 0) or 0),
            }
            continue

        current["to_name"] = stop_name(current_stop)
        current["to_coords"] = stop_coords(current_stop)
        current["stops"].append(current_stop)
        current["stop_count"] += 1
        current["ride_min"] += float(
            edge.get("_ride_minutes", edge.get("distance", 0))
        )
        current["wait_min"] += float(edge.get("_wait_minutes", 0))
        current["realtime"] = current["realtime"] or bool(
            edge.get("_realtime", False)
        )

        if edge.get("_delay_seconds") is not None:
            current["delay_seconds"] = float(edge.get("_delay_seconds") or 0)

        if current["departure_time"] is None:
            current["departure_time"] = edge.get(
                "_actual_departure_time", edge.get("departure_time")
            )

        arrival = edge.get("_actual_arrival_time", edge.get("arrival_time"))
        if arrival is not None:
            current["arrival_time"] = arrival
        scheduled_arrival = edge.get("arrival_time")
        if scheduled_arrival is not None:
            current["scheduled_arrival_time"] = scheduled_arrival

    if current is not None:
        groups.append(current)

    return groups


def fetch_walks(jobs):
    if not jobs:
        return {}

    results = {}

    with ThreadPoolExecutor(max_workers=min(3, len(jobs))) as pool:
        futures = {
            pool.submit(walking_geometry, start, end, fallback): key
            for key, (start, end, fallback) in jobs.items()
        }

        for future in as_completed(futures):
            key = futures[future]
            try:
                results[key] = future.result()
            except Exception:
                start, end, fallback = jobs[key]
                results[key] = {
                    "coordinates": [list(start), list(end)],
                    "distance_m": haversine_m(start, end),
                    "duration_min": fallback,
                }

    return results


def get_transit_route(
    start_address,
    end_address,
    departure_datetime=None,
    timing=None,
    transit_preference="balanced",
    start_coordinates=None,
    end_coordinates=None,
    excluded_route_keys=None,
    include_alternatives=True,
):
    ensure_transit_loaded()

    timing_start = timing.get("start", us()) if timing is not None else None
    requested_departure = normalize_departure_datetime(departure_datetime)

    def mark(name):
        if timing is not None:
            timing[name] = us() - timing_start

    start = coord(start_coordinates) if isinstance(start_coordinates, (list, tuple)) and len(start_coordinates) >= 2 else get_coordinates(start_address)
    end = coord(end_coordinates) if isinstance(end_coordinates, (list, tuple)) and len(end_coordinates) >= 2 else get_coordinates(end_address)
    mark("geocode")

    if start is None:
        return {
            "success": False,
            "error": explain_address_problem(
                start_address, "Starting address couldn't be found."
            ),
        }
    if end is None:
        return {
            "success": False,
            "error": explain_address_problem(
                end_address, "Destination couldn't be found."
            ),
        }

    start = coord(start)
    end = coord(end)

    grt_realtime = realtime_snapshot()
    go_realtime = go_gtfs_snapshot()
    realtime = combine_realtime(grt_realtime, go_realtime)
    current_time = datetime.now(TRANSIT_TIMEZONE)
    realtime_allowed = (
        abs((requested_departure - current_time).total_seconds())
        <= REALTIME_SCHEDULE_WINDOW_HOURS * 3600
    )

    routing_realtime = dict(realtime)
    if not realtime_allowed:
        routing_realtime["available"] = False
        routing_realtime["vehicles"] = {}

    start_options = nearest_stops(stops, *start)
    end_options = nearest_stops(stops, *end)
    mark("nearest_stops")

    preference_key, preference = transit_preference_profile(transit_preference)

    path, search_time, best_start, best_end = search_transit(
        start_options,
        end_options,
        routing_realtime,
        departure_datetime=requested_departure,
        soft_walk_m=preference["soft_walk_m"],
        walk_penalty=preference["walk_penalty"],
        max_nearby_stops=preference["max_nearby_stops"],
    )

    mark("routing")

    if path is None or best_start is None or best_end is None:
        return {"success": False, "error": "No transit route found."}

    if not any(is_transit_edge(path[i][2] or {}) for i in range(1, len(path))):
        return get_walking_route(start_address, end_address, start_coordinates=start, end_coordinates=end)

    groups = group_path(path)
    first = path[0]
    last = path[-1]

    walk_jobs = {
        "start": (
            start,
            stop_coords(first),
            access_walk_minutes(best_start[0]),
        ),
        "end": (
            stop_coords(last),
            end,
            access_walk_minutes(best_end[0]),
        ),
    }

    for index, group in enumerate(groups):
        if group["type"] == "walking":
            walk_jobs[f"leg:{index}"] = (
                group["from_coords"],
                group["to_coords"],
                group["ride_min"],
            )

    walks = fetch_walks(walk_jobs)
    mark("walking_geometry")

    segments = []
    steps = []
    transit_stops = []
    live_vehicles = []
    used_vehicle_keys = set()
    route_ids = set()
    go_departure_boards = {}
    go_realtime_connected = bool(go_realtime.get("available") or go_realtime.get("vehicles_available") or go_realtime.get("alerts_available"))
    go_realtime_used = False
    used_stop_ids = set()
    used_trip_ids = set()
    total_distance = 0.0
    walk_adjustment = 0.0

    start_walk = walks.get("start")
    if start_walk and start_walk["distance_m"] > 10:
        first_name = stop_name(first)
        segments.append(
            {"type": "walking", "coordinates": start_walk["coordinates"]}
        )
        steps.append(
            {
                "type": "walk",
                "instruction": f"Walk {max(1, round(start_walk['duration_min']))} min to {first_name}",
                "from": start_address,
                "to": first_name,
                "duration_min": start_walk["duration_min"],
                "distance_m": start_walk["distance_m"],
                "coordinates": start_walk["coordinates"][0] if start_walk.get("coordinates") else list(start),
            }
        )
        total_distance += start_walk["distance_m"]
        walk_adjustment += start_walk["duration_min"] - access_walk_minutes(
            best_start[0]
        )

    for index, group in enumerate(groups):
        if group["type"] == "walking":
            walk = walks.get(f"leg:{index}") or walking_geometry(
                group["from_coords"], group["to_coords"], group["ride_min"]
            )
            duration = float(walk["duration_min"])
            distance = float(walk["distance_m"])
            transfer = duration <= 0.15 or distance <= 25

            segments.append({"type": "walking", "coordinates": walk["coordinates"]})
            steps.append(
                {
                    "type": "transfer" if transfer else "walk",
                    "instruction": (
                        f"Transfer at {group['to_name']}"
                        if transfer
                        else f"Walk {max(1, round(duration))} min from {group['from_name']} to {group['to_name']}"
                    ),
                    "from": group["from_name"],
                    "to": group["to_name"],
                    "duration_min": duration,
                    "distance_m": distance,
                    "coordinates": walk["coordinates"][0] if walk.get("coordinates") else list(group["from_coords"]),
                }
            )
            total_distance += distance
            walk_adjustment += duration - group["ride_min"]
            continue

        agency = group["agency"]
        trip_id = group["trip_id"]
        stop_points = [stop_coords(stop) for stop in group["stops"]]

        geometry, meta = shape_for_trip(
            agency,
            trip_id,
            stop_points[0],
            stop_points[-1],
            group["route"],
            group["headsign"],
        )
        if not geometry:
            geometry = stop_points

        route_name = group["route"]
        headsign = group["headsign"]
        route_type = None
        route_color = None

        if meta:
            route_name = (
                route_name
                or meta.get("route_short_name")
                or meta.get("route_long_name")
                or meta.get("route_id")
            )
            headsign = headsign or meta.get("headsign")
            route_type = meta.get("route_type")
            route_color = normalize_color(meta.get("route_color"))

        route_name = route_name or "Transit"
        vehicle = vehicle_label(agency, route_type)
        distance = polyline_distance_m(geometry)

        scheduled_departure = time_label(group.get("scheduled_departure_time"))
        scheduled_arrival = time_label(group.get("scheduled_arrival_time"))
        displayed_departure = time_label(group["departure_time"])
        displayed_arrival = time_label(group["arrival_time"])
        step_realtime = bool(group["realtime"])
        step_delay_min = float(group["delay_seconds"] / 60)
        go_live = None

        # GRT exposes public GTFS-RT feeds, while GO's useful live departure board
        # is provided through the key-protected OpenMetrolinx NextService API.
        # Query only the final chosen GO leg so route searches do not hammer the API.
        if (
            agency == "go"
            and realtime_allowed
            and go_realtime_configured()
            and TRANSIT_GO_BOARD_ENRICHMENT
        ):
            boarding_stop_code = raw_stop_id(group["stops"][0][0])
            board = go_departure_boards.get(boarding_stop_code)
            if board is None:
                board = go_live_departures(boarding_stop_code, limit=16)
                go_departure_boards[boarding_stop_code] = board

            if board.get("connected"):
                go_realtime_connected = True
                go_live = match_go_departure(
                    board.get("departures", []),
                    trip_id=trip_id,
                    route_name=route_name,
                    scheduled_time=scheduled_departure,
                    headsign=headsign,
                )

            if go_live is not None:
                go_realtime_used = True
                step_realtime = True
                step_delay_min = float(go_live.get("delay_min") or 0)
                displayed_departure = (
                    go_live.get("computed_time")
                    or go_live.get("scheduled_time")
                    or scheduled_departure
                )
                displayed_arrival = shifted_time_label(
                    scheduled_arrival, step_delay_min
                )

        segments.append(
            {
                "type": "transit",
                "vehicle": vehicle,
                "route": route_name,
                "headsign": headsign,
                "trip_id": trip_id,
                "agency": agency,
                "color": route_color,
                "coordinates": geometry,
            }
        )

        instruction = f"Take {vehicle} route {route_name}"
        if headsign:
            instruction += f" toward {headsign}"
        instruction += f" from {group['from_name']} to {group['to_name']}"

        step = {
            "type": "transit",
            "instruction": instruction,
            "vehicle": vehicle,
            "agency": agency,
            "route": route_name,
            "headsign": headsign,
            "trip_id": trip_id,
            "route_id": meta.get("route_id") if meta else None,
            "from": group["from_name"],
            "to": group["to_name"],
            "from_stop_id": raw_stop_id(group["stops"][0][0]),
            "to_stop_id": raw_stop_id(group["stops"][-1][0]),
            "stops": group["stop_count"],
            "wait_min": group["wait_min"],
            "ride_duration_min": group["ride_min"],
            "duration_min": group["wait_min"] + group["ride_min"],
            "distance_m": distance,
            "departure_time": displayed_departure,
            "arrival_time": displayed_arrival,
            "scheduled_departure_time": scheduled_departure,
            "scheduled_arrival_time": scheduled_arrival,
            "realtime": step_realtime,
            "delay_min": step_delay_min,
            "coordinates": stop_points[0] if stop_points else list(group["from_coords"]),
        }

        if go_live is not None:
            step.update(
                {
                    "live_source": "GO Transit",
                    "live_status": go_live.get("status"),
                    "cancelled": bool(go_live.get("cancelled")),
                    "trip_number": go_live.get("trip_number"),
                    "scheduled_platform": go_live.get("scheduled_platform") or None,
                    "platform": (
                        go_live.get("actual_platform")
                        or go_live.get("scheduled_platform")
                        or None
                    ),
                    "platform_live": bool(go_live.get("actual_platform")),
                    "live_update_time": go_live.get("update_time"),
                }
            )

        steps.append(step)

        total_distance += distance
        used_trip_ids.add(str(trip_id))
        route_ids.add(str(route_name))
        if meta and meta.get("route_id"):
            route_ids.add(str(meta["route_id"]))

        live_vehicle = vehicle_for_trip(routing_realtime, agency, trip_id)
        if live_vehicle:
            vehicle_key = (agency, trip_id)
            if vehicle_key not in used_vehicle_keys:
                live_vehicles.append(
                    {
                        **live_vehicle,
                        "route": route_name,
                        "headsign": headsign,
                    }
                )
                used_vehicle_keys.add(vehicle_key)

        for stop in group["stops"]:
            stop_id = str(stop[0])
            used_stop_ids.add(raw_stop_id(stop_id))
            item = {
                "id": stop_id,
                "raw_id": raw_stop_id(stop_id),
                "agency": stop_agency(stop_id),
                "name": stop_name(stop),
                "coordinates": stop_coords(stop),
            }
            if not transit_stops or transit_stops[-1]["id"] != item["id"]:
                transit_stops.append(item)

    end_walk = walks.get("end")
    if end_walk and end_walk["distance_m"] > 10:
        last_name = stop_name(last)
        segments.append({"type": "walking", "coordinates": end_walk["coordinates"]})
        steps.append(
            {
                "type": "walk",
                "instruction": f"Walk {max(1, round(end_walk['duration_min']))} min from {last_name} to {end_address}",
                "from": last_name,
                "to": end_address,
                "duration_min": end_walk["duration_min"],
                "distance_m": end_walk["distance_m"],
                "coordinates": end_walk["coordinates"][0] if end_walk.get("coordinates") else stop_coords(last),
            }
        )
        total_distance += end_walk["distance_m"]
        walk_adjustment += end_walk["duration_min"] - access_walk_minutes(best_end[0])

    route_coordinates = []
    for segment in segments:
        for point in segment["coordinates"]:
            point = coord(point)
            if not route_coordinates or route_coordinates[-1] != point:
                route_coordinates.append(point)

    total_time = max(0.0, float(search_time) + walk_adjustment)

    if preference_key == "fastest":
        if access_walk_minutes(haversine_m(start, end)) <= total_time:
            direct_walk = walking_geometry(start, end)
            if direct_walk["duration_min"] <= total_time:
                return get_walking_route(start_address, end_address)

    distance_km = total_distance / 1000

    feed_timestamp = grt_realtime.get("feed_timestamp")
    feed_age = (
        max(0, int(time.time() - feed_timestamp)) if feed_timestamp else None
    )

    used_agencies = {
        str(step.get("agency") or "")
        for step in steps
        if step.get("type") == "transit"
    }
    uses_grt = bool({"grt_busses", "grt_trains"} & used_agencies)
    uses_go = "go" in used_agencies
    if uses_go and any(step.get("agency") == "go" and step.get("realtime") for step in steps):
        go_realtime_used = True
    grt_connected_for_route = bool(uses_grt and grt_realtime.get("available"))
    go_connected_for_route = bool(uses_go and go_realtime_connected)

    live_sources = []
    if grt_connected_for_route:
        live_sources.append("GRT")
    if go_connected_for_route:
        live_sources.append("GO Transit")

    any_live_feed_connected = bool(
        grt_connected_for_route or go_connected_for_route
    )
    realtime_info = {
        "available": bool(
            realtime_allowed
            and (grt_connected_for_route or go_connected_for_route)
        ),
        "feed_connected": any_live_feed_connected,
        "feed_age_seconds": feed_age if grt_connected_for_route else None,
        "used_live_updates": any(step.get("realtime") for step in steps),
        "live_sources": live_sources,
        "grt_connected": grt_connected_for_route,
        "go_configured": go_realtime_configured(),
        "go_connected": go_connected_for_route,
        "go_used_live_updates": bool(go_realtime_used),
        "suppressed_for_scheduled_trip": bool(
            not realtime_allowed
            and (
                (uses_grt and grt_realtime.get("available"))
                or (uses_go and go_realtime_configured())
            )
        ),
    }

    route = {
        "route_number": 1,
        "distance_km": distance_km,
        "duration_min": total_time,
        "average_speed": (
            distance_km / (total_time / 60) if total_time > 0 else 0.0
        ),
        "steps": steps,
        # Keep this alias for compatibility with older frontend code that used route.stops.
        "stops": steps,
        "segments": segments,
        "transit_stops": transit_stops,
        "live_vehicles": live_vehicles,
        "route_coordinates": route_coordinates,
        "realtime": realtime_info,
        "departure_datetime": requested_departure.isoformat(),
        "transit_preference": preference_key,
        "transit_preference_label": preference["label"],
        "access_walk_limit_m": preference["soft_walk_m"] or None,
        "access_walk_limit_expanded": False,  # kept so older frontend code doesn't break
    }

    alerts = matching_alerts(realtime, route_ids, used_stop_ids, trip_ids=used_trip_ids)
    mark("formatting")

    routes = [route]
    if include_alternatives and MAX_TRANSIT_ALTERNATIVES > 1:
        signatures = {route_signature(route)}
        attempted_exclusions = set()
        queue_exclusions = [{key} for key in route_keys_for_path(path)]

        while queue_exclusions and len(routes) < MAX_TRANSIT_ALTERNATIVES:
            exclusion = queue_exclusions.pop(0)
            frozen = frozenset(exclusion)
            if frozen in attempted_exclusions:
                continue
            attempted_exclusions.add(frozen)

            alternate = get_transit_route(
                start_address,
                end_address,
                departure_datetime=requested_departure,
                timing=None,
                transit_preference=preference_key,
                start_coordinates=start,
                end_coordinates=end,
                excluded_route_keys=exclusion,
                include_alternatives=False,
            )
            if not alternate.get("success") or not alternate.get("routes"):
                continue

            candidate = alternate["routes"][0]
            signature = route_signature(candidate)
            if not signature or signature in signatures:
                continue

            signatures.add(signature)
            candidate["route_number"] = len(routes) + 1
            routes.append(candidate)

            # If the alternative itself uses another service, try excluding that
            # next. This often produces a third genuinely different option.
            candidate_keys = {
                (str(step.get("agency") or ""), str(step.get("route") or ""))
                for step in candidate.get("steps", [])
                if step.get("type") == "transit" and step.get("route")
            }
            for key in candidate_keys:
                queue_exclusions.append(set(exclusion) | {key})

    fastest = min(routes, key=lambda item: float(item.get("duration_min", float("inf"))))
    shortest = min(routes, key=lambda item: float(item.get("distance_km", float("inf"))))

    return {
        "success": True,
        "mode": "transit",
        "start": {"address": start_address, "coordinates": start},
        "end": {"address": end_address, "coordinates": end},
        "routes": routes,
        "alerts": alerts,
        "departure_datetime": requested_departure.isoformat(),
        "transit_preference": preference_key,
        "fastest_route_number": fastest["route_number"],
        "shortest_route_number": shortest["route_number"],
    }


def _local_test_color_helpers():
    """Load the project's old terminal colors only for standalone testing."""
    try:
        from helpers.print_color import bold, blue, green, magenta, red, yellow
        return bold, blue, green, magenta, red, yellow
    except Exception:
        # The web server never needs the color helper. If its optional console
        # dependency is unavailable, keep the local tester usable without color.
        identity = lambda value, *args, **kwargs: str(value)
        return identity, identity, identity, identity, identity, identity


def _print_local_route_result(result, timing, graph_load_seconds):
    """Pretty-print a transit response for `python transit.py` testing."""
    import json

    bold, blue, green, magenta, red, yellow = _local_test_color_helpers()

    timing_report = {
        "graph_load": f"{graph_load_seconds * 1000:.3f} ms",
    }

    for key, value in timing.items():
        if key == "start":
            continue
        timing_report[key] = f"{value / 1000:.3f} ms"

    print(red(json.dumps(timing_report, indent=4)) + "\n")

    if not result.get("success"):
        print(red(result.get("error", "Transit route failed.")))
        return

    route = result["routes"][0]
    steps = route.get("steps", [])

    print(bold("Directions:"))
    for step in steps:
        instruction = step.get("instruction", "")
        step_type = step.get("type", "")

        if step_type == "walk":
            print(green(instruction))
        elif step_type == "transfer":
            print(magenta(instruction))
        elif step_type == "transit":
            meta = []
            if step.get("departure_time") and step.get("arrival_time"):
                meta.append(f"{step['departure_time']} -> {step['arrival_time']}")
            if step.get("stops"):
                meta.append(f"{step['stops']} stops")
            if step.get("realtime"):
                meta.append("LIVE")

            suffix = f" ({' | '.join(meta)})" if meta else ""
            print(blue(instruction + suffix))
        else:
            print(yellow(instruction))

    print()
    print(
        bold(
            f"Estimated commute time: {route.get('duration_min', 0):.1f} minutes"
        )
    )
    print(f"Distance: {route.get('distance_km', 0):.2f} km")
    print(f"Departure: {route.get('departure_datetime', 'now')}")
    print(f"Transit preference: {route.get('transit_preference_label', 'Balanced')}")
    if route.get("access_walk_limit_expanded"):
        print(
            yellow(
                f"Nearby-stop search expanded to {route.get('access_walk_limit_m', '?')} m "
                "because no complete route was found in the smaller walking tier."
            )
        )

    realtime = route.get("realtime", {})
    if realtime.get("available"):
        print(green("Realtime transit feed available."))
    elif realtime.get("feed_connected"):
        print(yellow("Realtime feed connected, but scheduled data was used."))
    else:
        print(yellow("Realtime unavailable; scheduled GTFS data was used."))


if __name__ == "__main__":
    # Restore the old standalone local transit tester while keeping production
    # imports quiet and memory-efficient.
    bold, blue, green, magenta, red, yellow = _local_test_color_helpers()

    print(bold("=" * 64))
    print(bold("Map Router - LOCAL TRANSIT TEST"))
    print(bold("=" * 64))

    graph_load_seconds = ensure_transit_loaded(verbose=True)

    start_address = input(bold("Starting Address: ")).strip()
    end_address = input(bold("End Address: ")).strip()

    departure_text = input(
        bold(
            "Departure date/time [Enter = now, or YYYY-MM-DD HH:MM]: "
        )
    ).strip()

    departure_datetime = None
    if departure_text:
        try:
            departure_datetime = datetime.fromisoformat(departure_text)
            if departure_datetime.tzinfo is None:
                departure_datetime = departure_datetime.replace(
                    tzinfo=TRANSIT_TIMEZONE
                )
            else:
                departure_datetime = departure_datetime.astimezone(
                    TRANSIT_TIMEZONE
                )
        except ValueError:
            print(red("Invalid date/time. Using current time instead."))
            departure_datetime = None

    preference_text = input(
        bold(
            "Transit preference [Enter = balanced, less_walking, fastest]: "
        )
    ).strip().lower()
    if preference_text not in TRANSIT_PREFERENCES:
        preference_text = "balanced"

    print("\nFinding transit route...\n")

    timing = {"start": us()}
    result = get_transit_route(
        start_address,
        end_address,
        departure_datetime=departure_datetime,
        timing=timing,
        transit_preference=preference_text,
    )

    _print_local_route_result(result, timing, graph_load_seconds)
