"""Candidate stop selection and the A* transit search (plus alternative routes)."""

import math
import time
from bisect import bisect_left
from datetime import timedelta
from heapq import heappop, heappush
from itertools import count

from . import agencies
from .realtime import adjusted_arrival, adjusted_departure, trip_update

from . import store
from .config import (
    ALT_MIN_HEADWAY_MIN,
    HEURISTIC_SPEED_KMH,
    MAX_NEARBY_STOPS,
    TRANSFER_BUFFER_MIN,
    TRANSIT_ALT_BUDGET_SECONDS,
    TRANSIT_PREFERENCES,
)
from .display import route_details
from .geo import access_walk_minutes, raw_stop_id, stop_agency
from .paths import _alt_signature, _transit_groups, is_transit_edge, route_keys_for_path
from .schedule import _active_services, schedule_info, trip_active
from .timeutil import gtfs_service_clock, normalize_departure_datetime


def transit_preference_profile(value) -> tuple[str, dict]:
    if isinstance(value, (int, float)):
        return (
            f"P{value}",
            {
                "label": f"P{value}",
                "soft_walk_m": 100,
                "walk_penalty": float(value),
                "max_nearby_stops": MAX_NEARBY_STOPS,
            }
        )
    key = str(value or "balanced").strip().lower()
    if key not in TRANSIT_PREFERENCES:
        key = "balanced"
    return key, TRANSIT_PREFERENCES[key]


def candidate_stops(options, max_distance_m=None, max_count=MAX_NEARBY_STOPS):
    """Nearest stops first. A distance cap is now optional (None = no hard limit)."""
    ordered = sorted((o for o in options if o[1] is not None), key=lambda o: o[0])
    if max_distance_m is not None:
        ordered = [o for o in ordered if o[0] <= max_distance_m]
    return ordered[:max_count]


def access_walk_cost(distance_m, soft_walk_m, walk_penalty):
    real = access_walk_minutes(distance_m)
    excess_m = max(0.0, float(distance_m) - float(soft_walk_m))
    return real, access_walk_minutes(excess_m) * float(walk_penalty)


def _candidate_trip_realtime_compact(trips, agency, from_stop, to_stop, earliest, date, realtime):
    """Array-based twin of the realtime branch below (identical selection rules).

    Trips with no realtime update (the vast majority) are decided from the int
    arrays alone; an edge dict is only built for trips that have an update and for
    the single winner.
    """
    deps, arrs, tids = trips.deps, trips.arrs, trips.tids
    trip_ids = trips.pools.trip_ids
    limit = earliest + 2 * 3600
    from_raw, to_raw = raw_stop_id(from_stop), raw_stop_id(to_stop)
    best = None
    best_departure = float("inf")
    active_services = _active_services(date)
    service_of = store._data.trip_to_service.get

    for i in range(bisect_left(deps, earliest - 2 * 3600), len(deps)):
        static_departure = deps[i]
        if static_departure > limit and best is not None:
            break

        trip_id = trip_ids[tids[i]]
        if active_services is not None:
            service_id = service_of(trip_id)
            if service_id is not None and service_id not in active_services:
                continue

        if trip_update(realtime, agency, trip_id) is None:
            departure, dep_delay, live_dep = float(static_departure), 0.0, False
            if departure < earliest or departure >= best_departure:
                continue
            arrival, arr_delay, live_arr = float(arrs[i]), 0.0, False
        else:
            trip = trips._edge(i)
            departure, dep_delay, live_dep = adjusted_departure(
                realtime, agency, trip, from_raw
            )
            if departure is None or departure < earliest or departure >= best_departure:
                continue
            arrival, arr_delay, live_arr = adjusted_arrival(
                realtime, agency, trip, to_raw
            )

        best_departure = departure
        best = (i, departure, arrival, dep_delay, live_dep or live_arr, arr_delay)

    if best is None:
        return None
    i, departure, arrival, dep_delay, live, arr_delay = best
    return (trips._edge(i), departure, arrival, dep_delay, live, arr_delay)


def _candidate_trip(schedule, agency, from_stop, to_stop, earliest, date, realtime) -> tuple|None:
    """Find candidate trips"""
    times = schedule["times"]

    if realtime.get("available") and agencies.has_realtime(agency):
        if hasattr(schedule["trips"], "tids"):
            return _candidate_trip_realtime_compact(
                schedule["trips"], agency, from_stop, to_stop, earliest, date, realtime
            )


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

    trips = schedule["trips"]
    if hasattr(trips, "tids"):


        active = _active_services(date)
        ids = trips.pools.trip_ids
        service_of = store._data.trip_to_service.get if active is not None else None
        for i in range(bisect_left(trips.deps, earliest), len(trips.deps)):
            trip_id = ids[trips.tids[i]]
            if active is not None:
                service = service_of(trip_id)
                if service is not None and service not in active:
                    continue
            return (trips._edge(i), float(trips.deps[i]),
                    float(trips.arrs[i]), 0.0, False, 0.0)
        return None

    index = bisect_left(times, earliest)
    for trip in trips[index:]:
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
    _heuristic_values=None,
    excluded_trip_ids=None,
    boarding_penalty=0.0,
):
    departure_datetime = normalize_departure_datetime(departure_datetime)
    excluded_trip_ids = {str(t) for t in (excluded_trip_ids or ())}
    boarding_penalty = float(boarding_penalty or 0.0)
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

    heuristic_cache = _heuristic_values if _heuristic_values is not None else {}




    goal_terms = []
    rad = math.radians
    for goal_id, option in ends.items():
        lat, lon = store.stops[goal_id][:2]
        end_real, end_pen = access_walk_cost(option[0], soft_walk_m, walk_penalty)
        goal_terms.append((rad(lat), rad(lon), end_real + end_pen))

    def heuristic(stop_id):
        cached = heuristic_cache.get(stop_id)
        if cached is not None:
            return cached
        lat, lon = store.stops[stop_id][:2]
        lat, lon = rad(lat), rad(lon)
        best = float("inf")
        for end_lat, end_lon, walk_cost in goal_terms:
            dx = (end_lon - lon) * 6_371_000 * math.cos((lat + end_lat) / 2)
            dy = (end_lat - lat) * 6_371_000
            optimistic = math.hypot(dx, dy) / 1000 / HEURISTIC_SPEED_KMH * 60 + walk_cost
            if optimistic < best:
                best = optimistic
        heuristic_cache[stop_id] = best
        return best

    queue = []
    costs = {}
    scores = {}
    penalty_of = {}
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

    best_total = float("inf")
    best_real = float("inf")
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

        for neighbor_id, route_options in store.graph.get(stop_id, {}).items():
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

                for extra, trip_id, edge, new_boardings in choices:
                    if excluded_trip_ids and trip_id is not None and trip_id in excluded_trip_ids:
                        continue
                    if excluded_route_keys and is_transit_edge(edge):
                        excluded_name, _ = route_details(edge)
                        if (agency, str(excluded_name or edge.get("route") or "")) in excluded_route_keys:
                            continue
                    new_g = current_g + extra
                    new_pen = current_pen
                    if boarding_penalty and new_boardings > boardings:
                        new_pen += boarding_penalty
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
        path.append((state[0], store.stops[state[0]], edge))
        state = previous

    start_stop_id = state[0]
    path.append((start_stop_id, store.stops[start_stop_id], None))
    path.reverse()

    return path, best_real, starts[start_stop_id], best_end


def generate_alternative_paths(start_options, end_options, realtime, departure, base, want, requested_arrival=None, excluded_route_keys=None):
    """Diverse alternatives to the primary journey `base`.

    base = (path, minutes, best_start, best_end) as returned by search_transit.
    Returns up to `want` dicts: {found, pref, variant, departure, arrive_min}
    sorted by arrival. Candidates come from re-running the same A* with
    different objectives/constraints:
      fastest / less_walking   other ranking profiles
      fewer_transfers          heavy per-boarding penalty
      next_bus                 ban the exact trips used (next bus of the same
                               route, or another route)
      other_route              ban whole routes used by the primary journey
      diverse                  ban everything already shown so far
      later_departure          leave 10/20 minutes later (plain departure only)
    A candidate is kept only if it is a different journey: another route/stop
    pattern, or the same pattern on a bus at least ALT_MIN_HEADWAY_MIN apart.
    """
    from collections import deque

    started = time.perf_counter()
    base_path, base_minutes = base[0], float(base[1])
    base_groups = _transit_groups(base_path)
    accepted = []
    shown = [(_alt_signature(base_path),
              base_groups[0]["departure_time"] if base_groups else None,
              tuple(str(g["trip_id"]) for g in base_groups))]
    banned_trips = {str(g["trip_id"]) for g in base_groups}
    banned_routes = set(route_keys_for_path(base_path))
    base_excluded = {(str(a), str(r)) for a, r in (excluded_route_keys or set())}

    queue = deque()

    def enqueue(variant, pref, shift=0, trips=(), routes=(), safety_buffer=0.0):
        queue.append({"variant": variant, "pref": pref, "shift": shift,
                      "trips": set(trips), "routes": set(routes),
                      "safety_buffer": safety_buffer})

    # order matters!

    enqueue("less_walking", "less_walking")
    enqueue("safer_transfers", "balanced", safety_buffer=13.0)
    enqueue("safer_transfers", "balanced", safety_buffer=20.0)
    enqueue("fastest", "fastest")
    for group in base_groups:
        enqueue("next_bus", "fastest", trips={str(group["trip_id"])})
    for key in route_keys_for_path(base_path):
        enqueue("other_route", "fastest", routes={key})
    if requested_arrival is None:
        enqueue("later_departure", "balanced", shift=10)

    searches = 0
    while queue and len(accepted) < want and searches < 40:
        if time.perf_counter() - started > TRANSIT_ALT_BUDGET_SECONDS:
            break
        job = queue.popleft()
        profile = TRANSIT_PREFERENCES[job["pref"]]
        depart_at = departure + timedelta(minutes=job["shift"])
        searches += 1
        found = search_transit(
            start_options, end_options, realtime,
            departure_datetime=depart_at,
            soft_walk_m=profile["soft_walk_m"],
            walk_penalty=profile["walk_penalty"],
            max_nearby_stops=profile["max_nearby_stops"],
            excluded_route_keys=base_excluded | job["routes"],
            excluded_trip_ids=job["trips"],
            safety_buffer=job["safety_buffer"],
        )
        path, minutes = found[0], found[1]
        if not path or not any(is_transit_edge(item[2] or {}) for item in path[1:]):
            continue
        arrive_min = float(minutes) + job["shift"]
        if requested_arrival and depart_at + timedelta(minutes=float(minutes)) > requested_arrival:
            continue
        if arrive_min > base_minutes * 1.9 + 15:
            continue

        groups = _transit_groups(path)


        if any(
            (a["agency"], str(a["route"])) == (b["agency"], str(b["route"]))
            for a, b in zip(groups, groups[1:])
        ):
            continue
        signature = _alt_signature(path)
        first_dep = groups[0]["departure_time"] if groups else None
        trips = tuple(str(g["trip_id"]) for g in groups)
        duplicate = False
        for other_sig, other_dep, other_trips in shown:
            if trips == other_trips:
                duplicate = True
            elif signature == other_sig and (
                first_dep is None or other_dep is None
                or abs(float(first_dep) - float(other_dep)) < ALT_MIN_HEADWAY_MIN * 60
            ):
                duplicate = True
            if duplicate:
                break
        if duplicate:
            continue

        shown.append((signature, first_dep, trips))
        accepted.append({"found": found, "pref": job["pref"], "variant": job["variant"],
                         "departure": depart_at, "arrive_min": arrive_min})


        banned_trips |= set(trips)
        banned_routes |= set(route_keys_for_path(path))
        if len(accepted) < want:
            enqueue("diverse", "fastest", trips=banned_trips)
            enqueue("diverse", "less_walking", trips=banned_trips)
            enqueue("diverse", "fastest", routes=banned_routes)

    accepted.sort(key=lambda item: item["arrive_min"])
    return accepted[:want]
