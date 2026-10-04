import math
import os
import time
from bisect import bisect_left
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from functools import lru_cache
from heapq import heappop, heappush
from itertools import count
from zoneinfo import ZoneInfo

import requests
from dotenv import load_dotenv

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
from helpers.geocoding import get_coordinates
from helpers.time_management import seconds_to_time, time_to_seconds, us
from walking import get_walking_route

load_dotenv()

ORS_API_KEY = os.getenv("API")
ORS_WALKING_URL = (
    "https://api.heigit.org/openrouteservice/v2/directions/foot-walking"
)

TRANSIT_TIMEZONE = ZoneInfo("America/Toronto")
MAX_NEARBY_STOPS = 4
MAX_ACCESS_WALK_METERS = 1200
TRANSFER_BUFFER_MIN = 4
HEURISTIC_SPEED_KMH = 200.0
ACCESS_WALK_SPEED_MPS = 1.35

_data = make_graph()
graph = _data.graph
stops = _data.node_positions

# Realtime updates refresh in the background. If the feed is unavailable, routing
# automatically falls back to the static GTFS schedule.
start_background_refresh()


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
        return seconds_to_time(int(round(value)))
    except Exception:
        return None


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


@lru_cache(maxsize=512)
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

    if straight_distance <= 35:
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


_SCHEDULE_CACHE = {}


def schedule_info(trips):
    key = id(trips)
    cached = _SCHEDULE_CACHE.get(key)
    if cached is not None:
        return cached

    ordered = sorted(
        trips,
        key=lambda trip: (
            trip.get("departure_time") is None,
            trip.get("departure_time") or float("inf"),
        ),
    )

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
    return info


@lru_cache(maxsize=100_000)
def trip_active(trip_id, date):
    return _data.is_trip_active(trip_id, date)


def candidate_stops(options):
    ordered = sorted((o for o in options if o[1] is not None), key=lambda o: o[0])
    nearby = [o for o in ordered if o[0] <= MAX_ACCESS_WALK_METERS]
    return (nearby or ordered)[:MAX_NEARBY_STOPS]


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

    if realtime.get("available") and agency in {"grt_busses", "grt_trains"}:
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
    safety_buffer=TRANSFER_BUFFER_MIN,
):
    now = datetime.now(TRANSIT_TIMEZONE)
    service_date = now.date()
    now_seconds = time_to_seconds(now.strftime("%H:%M:%S"))

    start_options = candidate_stops(start_options)
    end_options = candidate_stops(end_options)

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
            optimistic = (
                straight_km / HEURISTIC_SPEED_KMH * 60
                + access_walk_minutes(option[0])
            )
            best = min(best, optimistic)

        heuristic_cache[stop_id] = best
        return best

    queue = []
    costs = {}
    parent = {}
    seed_costs = {}
    tie = count()

    for stop_id, option in starts.items():
        access_min = access_walk_minutes(option[0])
        state = (stop_id, None)
        costs[state] = (access_min, 0)
        seed_costs[state] = access_min
        heappush(
            queue,
            (
                access_min + heuristic(stop_id),
                access_min,
                0,
                next(tie),
                stop_id,
                None,
            ),
        )

    best_total = float("inf")
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

        if stop_id in ends:
            total = current_g + access_walk_minutes(ends[stop_id][0])
            if total < best_total:
                best_total = total
                best_state = state
                best_end = ends[stop_id]

        current_arrival = now_seconds + current_g * 60
        is_seed = state in seed_costs and abs(seed_costs[state] - current_g) < 1e-9
        agency = stop_agency(stop_id)

        for neighbor_id, route_options in graph.get(stop_id, {}).items():
            for route_key, trips in route_options.items():
                choices = []

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
                            realtime,
                            agency,
                            continuing,
                            raw_stop_id(stop_id),
                        )
                        arrival, arr_delay, live_arr = adjusted_arrival(
                            realtime,
                            agency,
                            continuing,
                            raw_stop_id(neighbor_id),
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
                            schedule,
                            agency,
                            stop_id,
                            neighbor_id,
                            earliest,
                            service_date,
                            realtime,
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
                            (
                                wait_min + ride_min,
                                str(trip.get("trip_id")),
                                edge,
                                boardings + 1,
                            )
                        )

                for extra, trip_id, edge, new_boardings in choices:
                    new_g = current_g + extra
                    next_state = (neighbor_id, trip_id)
                    new_key = (round(new_g, 6), new_boardings)

                    if new_key >= costs.get(
                        next_state, (float("inf"), float("inf"))
                    ):
                        continue

                    lower_bound = new_g + heuristic(neighbor_id)
                    if lower_bound >= best_total:
                        continue

                    costs[next_state] = new_key
                    parent[next_state] = (state, edge)
                    heappush(
                        queue,
                        (
                            lower_bound,
                            new_key[0],
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

    return path, best_total, starts[start_stop_id], best_end


def is_transit_edge(edge):
    return bool(edge.get("trip_id") or edge.get("route"))


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


def get_transit_route(start_address, end_address, timing=None):
    timing_start = timing.get("start", us()) if timing is not None else None

    def mark(name):
        if timing is not None:
            timing[name] = us() - timing_start

    start = get_coordinates(start_address)
    end = get_coordinates(end_address)
    mark("geocode")

    if start is None:
        return {"success": False, "error": "Starting address couldn't be found."}
    if end is None:
        return {"success": False, "error": "Destination couldn't be found."}

    start = coord(start)
    end = coord(end)
    realtime = realtime_snapshot()

    start_options = nearest_stops(stops, *start)
    end_options = nearest_stops(stops, *end)
    mark("nearest_stops")

    path, search_time, best_start, best_end = search_transit(
        start_options, end_options, realtime
    )
    mark("routing")

    if path is None or best_start is None or best_end is None:
        return {"success": False, "error": "No transit route found."}

    if not any(is_transit_edge(path[i][2] or {}) for i in range(1, len(path))):
        return get_walking_route(start_address, end_address)

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
    used_stop_ids = set()
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

        segments.append(
            {
                "type": "transit",
                "vehicle": vehicle,
                "route": route_name,
                "headsign": headsign,
                "trip_id": trip_id,
                "color": route_color,
                "coordinates": geometry,
            }
        )

        instruction = f"Take {vehicle} route {route_name}"
        if headsign:
            instruction += f" toward {headsign}"
        instruction += f" from {group['from_name']} to {group['to_name']}"

        steps.append(
            {
                "type": "transit",
                "instruction": instruction,
                "vehicle": vehicle,
                "route": route_name,
                "headsign": headsign,
                "from": group["from_name"],
                "to": group["to_name"],
                "stops": group["stop_count"],
                "wait_min": group["wait_min"],
                "ride_duration_min": group["ride_min"],
                "duration_min": group["wait_min"] + group["ride_min"],
                "distance_m": distance,
                "departure_time": time_label(group["departure_time"]),
                "arrival_time": time_label(group["arrival_time"]),
                "realtime": group["realtime"],
                "delay_min": group["delay_seconds"] / 60,
            }
        )

        total_distance += distance
        route_ids.add(str(route_name))
        if meta and meta.get("route_id"):
            route_ids.add(str(meta["route_id"]))

        live_vehicle = vehicle_for_trip(realtime, agency, trip_id)
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
    distance_km = total_distance / 1000

    feed_timestamp = realtime.get("feed_timestamp")
    feed_age = (
        max(0, int(time.time() - feed_timestamp)) if feed_timestamp else None
    )

    realtime_info = {
        "available": bool(realtime.get("available")),
        "feed_age_seconds": feed_age,
        "used_live_updates": any(step.get("realtime") for step in steps),
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
    }

    alerts = matching_alerts(realtime, route_ids, used_stop_ids)
    mark("formatting")

    return {
        "success": True,
        "mode": "transit",
        "start": {"address": start_address, "coordinates": start},
        "end": {"address": end_address, "coordinates": end},
        "routes": [route],
        "alerts": alerts,
        "fastest_route_number": 1,
        "shortest_route_number": 1,
    }
