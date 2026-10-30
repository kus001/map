"""get_transit_route: the public entry point that builds a full route response."""

import time
from datetime import datetime, timedelta

from . import agencies
from .advanced_planning import connection_reliability, latest_departure_before
from .go_realtime import (
    configured as go_realtime_configured,
    gtfs_snapshot as go_gtfs_snapshot,
    live_departures as go_live_departures,
    match_departure as match_go_departure,
)
from .gtfs_metadata import shape_for_trip
from .realtime import (
    matching_alerts,
    snapshot as realtime_snapshot,
    vehicle_for_trip,
)
from helpers.coords import nearest_stops
from helpers.geocoding import explain_address_problem, get_coordinates
from helpers.time_management import us
from walking import get_walking_route

from . import store
from .config import (
    MAX_TRANSIT_ALTERNATIVES,
    REALTIME_SCHEDULE_WINDOW_HOURS,
    TRANSIT_DETAILED_WALKS,
    TRANSIT_GO_BOARD_ENRICHMENT,
    TRANSIT_PREFERENCES,
    TRANSIT_TIMEZONE,
)
from .display import delay_status_label, display_headsign, normalize_color, vehicle_label
from .freshness import expired_note
from .geo import (
    access_walk_minutes,
    coord,
    dist_m,
    polyline_distance_m,
    raw_stop_id,
    stop_agency,
    stop_coords,
    stop_name,
)
from .loader import ensure_transit_loaded
from .paths import _path_walk_jobs, combine_realtime, group_path, is_transit_edge
from .search import generate_alternative_paths, search_transit, transit_preference_profile
from .timeutil import (
    gtfs_service_clock,
    normalize_departure_datetime,
    shifted_time_label,
    time_label,
)
from .vehicles import live_vehicle_is_usable
from .walks import _walk_id, _walk_key, fetch_walks, walking_geometry


def _replay_timeline(timeline, depart_dt, midnight, grace_s=30) -> None | dict:
    """Walk the finished journey forward in time to get the TRUE arrival.
    Returns None if any ride lacks times (caller keeps the legacy estimate).
    """
    t = depart_dt
    missed_by = 0.0
    for event in timeline:
        if event[0] == "walk":
            t += timedelta(minutes=float(event[1]))
            continue
        _, dep_s, arr_s, _trip = event
        if dep_s is None or arr_s is None:
            return None
        dep = midnight + timedelta(seconds=float(dep_s))
        arr = midnight + timedelta(seconds=float(arr_s))
        late = (t - dep).total_seconds()
        if late > grace_s:
            missed_by = max(missed_by, late / 60)
        t = arr
    return {
        "arrival": t,
        "duration_min": max(0.0, (t - depart_dt).total_seconds() / 60),
        "missed_connection": missed_by > 0,
        "missed_by_min": round(missed_by, 1),
    }


def _direct_walking_option(start, end, start_address, end_address, departure, transit_minutes,
                           arrive_by, preference_key, preference):
    """A walking-only route shaped like a transit route, or None unless walking is the best option.

    "Best" means walking from the departure time gets you there no later than the best
    transit journey (`transit_minutes`). The walk is routed like any other walking leg: the
    local OSRM inside its coverage area, the usual fallbacks outside it.
    """
    straight = dist_m(start, end)
    if straight <= 35 or not TRANSIT_DETAILED_WALKS:
        return None
    # cheap exit: a walk this far (even allowing for the pace being a bit quicker) can't win
    if access_walk_minutes(straight) * 0.7 > transit_minutes:
        return None

    walk = walking_geometry(start, end)
    if walk.get("geometry_source") == "straight_estimate" or not walk.get("coordinates"):
        return None  # no real walking route to show (every provider failed)
    duration = float(walk["duration_min"])
    distance = float(walk["distance_m"])
    if duration > transit_minutes:
        return None
    arrival = departure + timedelta(minutes=duration)
    if arrive_by is not None and arrival > arrive_by:
        return None

    walk_id = _walk_id(start, end)
    coordinates = walk["coordinates"]
    steps = [{
        "type": "walk",
        "walk_id": walk_id,
        "instruction": f"Walk {max(1, round(duration))} min to {end_address}",
        "from": start_address,
        "to": end_address,
        "duration_min": duration,
        "distance_m": distance,
        "coordinates": coordinates[0],
        "to_coordinates": coordinates[-1],
        "directions": walk.get("steps") or [],
    }]
    distance_km = distance / 1000
    return {
        "route_number": 1,
        "distance_km": distance_km,
        "duration_min": duration,
        "average_speed": distance_km / (duration / 60) if duration > 0 else 0.0,
        "steps": steps,
        "stops": steps,
        "segments": [{"type": "walking", "coordinates": coordinates, "walk_id": walk_id}],
        "transit_stops": [],
        "live_vehicles": [],
        "route_coordinates": [coord(point) for point in coordinates],
        "pending_walks": [],
        "realtime": {
            "available": False, "feed_connected": False, "feed_age_seconds": None,
            "used_live_updates": False, "scheduled_vehicle_fallback": False,
            "live_sources": [], "grt_connected": False,
            "go_configured": go_realtime_configured(), "go_connected": False,
            "go_used_live_updates": False, "suppressed_for_scheduled_trip": False,
        },
        "departure_datetime": departure.isoformat(),
        "next_service": False,
        "transit_preference": preference_key,
        "transit_preference_label": preference["label"],
        "transfer_reliability": connection_reliability(steps),
        "arrival_estimate_datetime": arrival.isoformat(),
        "arrival_basis": "walking",
        "missed_connection": False,
        "missed_by_min": 0.0,
        "arrive_by_datetime": arrive_by.isoformat() if arrive_by else None,
        "access_walk_limit_m": None,
        "access_walk_limit_expanded": False,
        "walks_estimated": False,
        "route_variant": "walking",
        "walking_only": True,
    }


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
    arrive_by=None,
    bias=None,
    _shared=None,
    _picked=None,
    _walks=None,
) -> dict:

    ensure_transit_loaded() # kept for legacy lazy loading

    timing_start = timing.get("start", us()) if timing is not None else None
    requested_departure = normalize_departure_datetime(departure_datetime)

    def mark(name: str):
        """Add a time stamp with the name of 'name'"""
        if timing is not None:
            timing[name] = us() - timing_start

    start = coord(start_coordinates) if isinstance(start_coordinates, (list, tuple)) and len(start_coordinates) >= 2 else get_coordinates(start_address, bias=end_coordinates or bias)
    end = coord(end_coordinates) if isinstance(end_coordinates, (list, tuple)) and len(end_coordinates) >= 2 else get_coordinates(end_address, bias=start or bias)
    mark("geocode")

    if start is None:
        return {
            "success": False,
            "error": explain_address_problem(
                start_address, "Starting address couldn't be found.",
                bias=end or bias,
            ),
        }
    if end is None:
        return {
            "success": False,
            "error": explain_address_problem(
                end_address, "Destination couldn't be found.",
                bias=start or bias,
            ),
        }

    start = coord(start); end = coord(end)

    if _shared is None:
        grt_realtime = realtime_snapshot()
        go_realtime = go_gtfs_snapshot()
        realtime = combine_realtime(grt_realtime, go_realtime)
        current_time = datetime.now(TRANSIT_TIMEZONE)
    else:
        grt_realtime, go_realtime, realtime, current_time = _shared

    realtime_allowed = (
        abs((requested_departure - current_time).total_seconds())
        <= REALTIME_SCHEDULE_WINDOW_HOURS * 3600
    )

    routing_realtime = dict(realtime)
    if not realtime_allowed:
        routing_realtime["available"] = False
        routing_realtime["vehicles"] = {}

    start_options = nearest_stops(store.stops, *start)
    end_options = nearest_stops(store.stops, *end)
    mark("nearest_stops")

    preference_key, preference = transit_preference_profile(transit_preference)

    requested_arrival = normalize_departure_datetime(arrive_by) if arrive_by else None
    if _picked is not None:
        path, search_time, best_start, best_end = _picked
    else:
        arrive_search_path = None
        if requested_arrival is not None:



            fastest_profile = TRANSIT_PREFERENCES["fastest"]
            probe_heuristics = {}

            def probe(candidate_time):
                return search_transit(
                    start_options, end_options, routing_realtime,
                    departure_datetime=candidate_time,
                    soft_walk_m=fastest_profile["soft_walk_m"],
                    walk_penalty=fastest_profile["walk_penalty"],
                    max_nearby_stops=fastest_profile["max_nearby_stops"],
                    excluded_route_keys=excluded_route_keys,
                    _heuristic_values=probe_heuristics,
                )

            found = latest_departure_before(requested_arrival, probe)
            if found is None:
                return {"success": False,
                        "error": "No transit journey could reach your destination before this time (searched the previous 6 hours)."}
            requested_departure, arrive_search_path = found
            mark("arrive_by_search")

        astar_stats = {}

        path, search_time, best_start, best_end = search_transit(
            start_options,
            end_options,
            routing_realtime,
            departure_datetime=requested_departure,
            soft_walk_m=preference["soft_walk_m"],
            walk_penalty=preference["walk_penalty"],
            max_nearby_stops=preference["max_nearby_stops"],
            excluded_route_keys=excluded_route_keys,
            _stats=astar_stats,
        )

        print(f"A* stats: {astar_stats}")

        if requested_arrival is not None:
            if (path is None or requested_departure + timedelta(minutes=float(search_time))
                    > requested_arrival - timedelta(minutes=2)):
                path, search_time, best_start, best_end = arrive_search_path

    next_service = False


    if path is None and departure_datetime is None and requested_arrival is None:
        morning = requested_departure.replace(hour=6, minute=0, second=0, microsecond=0)
        if morning <= requested_departure:
            morning += timedelta(days=1)
        if morning - requested_departure <= timedelta(hours=24):
            next_realtime = dict(routing_realtime)
            next_realtime["available"] = False
            next_realtime["trip_updates"] = {}
            next_realtime["vehicles"] = {}
            found = search_transit(
                start_options, end_options, next_realtime,
                departure_datetime=morning,
                soft_walk_m=preference["soft_walk_m"],
                walk_penalty=preference["walk_penalty"],
                max_nearby_stops=preference["max_nearby_stops"],
                excluded_route_keys=excluded_route_keys,
            )
            if found[0] is not None:
                path, search_time, best_start, best_end = found
                requested_departure = morning
                routing_realtime = next_realtime
                realtime_allowed = False
                next_service = True

    mark("routing")

    if path is None or best_start is None or best_end is None:
        setup_note = "".join(
            f" {a.label} timetable not installed; run python -m transit.agency_setup {a.id}."
            for a in agencies.OWN_CACHE_AGENCIES
            if not a.cache_path.exists()
        ) + expired_note()
        return {"success": False,
                "error": "No transit departure found for this time. Try Depart at with a daytime departure." + setup_note}

    if not any(is_transit_edge(path[i][2] or {}) for i in range(1, len(path))):
        # Walking between the stops is cheapest, so no ride is needed. Still look for the best
        # journey that uses transit, so it can be offered next to the walking route.
        forced = search_transit(
            start_options, end_options, routing_realtime,
            departure_datetime=requested_departure,
            soft_walk_m=preference["soft_walk_m"],
            walk_penalty=preference["walk_penalty"],
            max_nearby_stops=preference["max_nearby_stops"],
            excluded_route_keys=excluded_route_keys,
            require_transit=True,
        )
        if forced[0] is None or forced[2] is None or forced[3] is None:
            return get_walking_route(start_address, end_address, start_coordinates=start, end_coordinates=end)
        path, search_time, best_start, best_end = forced
        mark("transit_option_search")

    prepared = []
    if include_alternatives and MAX_TRANSIT_ALTERNATIVES > 1:
        prepared = generate_alternative_paths(
            start_options, end_options, routing_realtime, requested_departure,
            (path, search_time, best_start, best_end),
            want=MAX_TRANSIT_ALTERNATIVES - 1,
            requested_arrival=requested_arrival,
            excluded_route_keys=excluded_route_keys,
        )
        mark("alternatives_search")

    groups = group_path(path)
    first = path[0]
    last = path[-1]
    walk_jobs = _path_walk_jobs(path, start, end, best_start, best_end)
    if _walks is None:
        all_jobs = {}
        for candidate in [(path, search_time, best_start, best_end), *(item["found"] for item in prepared)]:
            for job in _path_walk_jobs(candidate[0], start, end, candidate[2], candidate[3]).values():
                all_jobs.setdefault(_walk_key(job[0], job[1]), job)
        results = fetch_walks(all_jobs)
        _walks = results
    walks = {key: _walks.get(_walk_key(job[0], job[1]))
             for key, job in walk_jobs.items()}
    mark("walking_geometry")

    service_date, _ = gtfs_service_clock(requested_departure)
    service_midnight = datetime(service_date.year, service_date.month, service_date.day,
                                tzinfo=TRANSIT_TIMEZONE)
    timeline = []

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
    start_is_stop = dist_m(start, stop_coords(first)) <= 45
    end_is_stop = dist_m(end, stop_coords(last)) <= 75
    walk_adjustment = (
        -(access_walk_minutes(best_start[0]) if start_is_stop else 0.0)
        -(access_walk_minutes(best_end[0]) if end_is_stop else 0.0)
    )

    start_walk = walks.get("start")
    if start_walk and start_walk["distance_m"] > 10:
        first_name = stop_name(first)
        segments.append(
            {"type": "walking", "coordinates": start_walk["coordinates"],
             "walk_id": _walk_id(*walk_jobs['start'][:2])}
        )
        steps.append(
            {
                "type": "walk",
                "walk_id": _walk_id(*walk_jobs['start'][:2]),
                "instruction": f"Walk {max(1, round(start_walk['duration_min']))} min to {first_name}",
                "from": start_address,
                "to": first_name,
                "duration_min": start_walk["duration_min"],
                "distance_m": start_walk["distance_m"],
                "coordinates": start_walk["coordinates"][0] if start_walk.get("coordinates") else list(start),
                "to_coordinates": start_walk["coordinates"][-1] if start_walk.get("coordinates") else list(stop_coords(first)),
                "directions": start_walk.get("steps") or [],
            }
        )
        total_distance += start_walk["distance_m"]
        timeline.append(("walk", float(start_walk["duration_min"])))
        walk_adjustment += start_walk["duration_min"] - access_walk_minutes(
            best_start[0]
        )

    for index, group in enumerate(groups):
        if group["type"] == "walking":
            if dist_m(group["from_coords"], group["to_coords"]) <= 35:
                walk_adjustment -= group["ride_min"]
                continue
            walk = walks.get(f"leg:{index}") or walking_geometry(
                group["from_coords"], group["to_coords"], group["ride_min"]
            )
            duration = float(walk["duration_min"])
            distance = float(walk["distance_m"])
            transfer = duration <= 0.15 or distance <= 25

            walk_id = _walk_id(*walk_jobs[f'leg:{index}'][:2])
            segments.append({"type": "walking", "coordinates": walk["coordinates"], "walk_id": walk_id})
            steps.append(
                {
                    "type": "transfer" if transfer else "walk",
                    "walk_id": walk_id,
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
                    "to_coordinates": walk["coordinates"][-1] if walk.get("coordinates") else list(group["to_coords"]),
                    "directions": walk.get("steps") or [],
                }
            )
            total_distance += distance
            timeline.append(("walk", duration))
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
        route_color = group.get("route_color")

        if meta:
            route_name = (
                meta.get("route_short_name")
                or meta.get("route_long_name")
                or route_name
                or meta.get("route_id")
            )
            headsign = headsign or meta.get("headsign")
            route_type = meta.get("route_type")
            route_color = normalize_color(meta.get("route_color")) or route_color

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

        if (agency == "go" and realtime_allowed and go_realtime_configured() and TRANSIT_GO_BOARD_ENRICHMENT):
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

        shown_headsign = display_headsign(route_name, headsign)
        instruction = f"Take {vehicle} route {route_name}"
        if shown_headsign:
            instruction += f" toward {shown_headsign}"
        instruction += f" from {group['from_name']} to {group['to_name']}"

        step = {
            "type": "transit",
            "instruction": instruction,
            "vehicle": vehicle,
            "agency": agency,
            "agency_label": agencies.label(agency),
            "route": route_name,
            "route_color": route_color,
            "headsign": headsign,
            "display_headsign": shown_headsign,
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

            "to_coordinates": list(group["to_coords"]),
            # every stop after the boarding stop, in order (the last one is where you get off)
            "stop_list": [
                {
                    "name": stop_name(stop),
                    "coordinates": list(point),
                    "stop_id": raw_stop_id(stop[0]),
                }
                for stop, point in zip(group["stops"][1:], stop_points[1:])
            ],
        }

        if go_live is None and step_realtime:
            step["live_source"] = agencies.label(agency)
            step["live_status"] = delay_status_label(step_delay_min)

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

        if group["departure_time"] is not None and group["arrival_time"] is not None:
            step["departure_datetime"] = (service_midnight + timedelta(seconds=float(group["departure_time"]))).isoformat()
            step["arrival_datetime"] = (service_midnight + timedelta(seconds=float(group["arrival_time"]))).isoformat()
        timeline.append(("ride", group["departure_time"], group["arrival_time"], trip_id))
        steps.append(step)


        used_trip_ids.add(str(trip_id))
        route_ids.add(str(route_name))
        if meta and meta.get("route_id"):
            route_ids.add(str(meta["route_id"]))

        live_vehicle = vehicle_for_trip(routing_realtime, agency, trip_id)
        vehicle_key = (agency, trip_id)
        if live_vehicle_is_usable(live_vehicle, current_time):
            if vehicle_key not in used_vehicle_keys:
                live_vehicles.append(
                    {
                        **live_vehicle,
                        "route": route_name,
                        "headsign": headsign,
                        "display_headsign": shown_headsign,
                        "position_source": "live",
                        "estimated": False,
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
                "agency_label": agencies.label(stop_agency(stop_id)),
                "name": stop_name(stop),
                "coordinates": stop_coords(stop),
            }
            if not transit_stops or transit_stops[-1]["id"] != item["id"]:
                transit_stops.append(item)

    end_walk = walks.get("end")
    if end_walk and end_walk["distance_m"] > 10:
        last_name = stop_name(last)
        segments.append({"type": "walking", "coordinates": end_walk["coordinates"],
                         "walk_id": _walk_id(*walk_jobs['end'][:2])})
        steps.append(
            {
                "type": "walk",
                "walk_id": _walk_id(*walk_jobs['end'][:2]),
                "instruction": f"Walk {max(1, round(end_walk['duration_min']))} min from {last_name} to {end_address}",
                "from": last_name,
                "to": end_address,
                "duration_min": end_walk["duration_min"],
                "distance_m": end_walk["distance_m"],
                "coordinates": end_walk["coordinates"][0] if end_walk.get("coordinates") else stop_coords(last),
                "to_coordinates": end_walk["coordinates"][-1] if end_walk.get("coordinates") else list(end),
                "directions": end_walk.get("steps") or [],
            }
        )
        total_distance += end_walk["distance_m"]
        timeline.append(("walk", float(end_walk["duration_min"])))
        walk_adjustment += end_walk["duration_min"] - access_walk_minutes(best_end[0])

    route_coordinates = []
    for segment in segments:
        for point in segment["coordinates"]:
            point = coord(point)
            if not route_coordinates or route_coordinates[-1] != point:
                route_coordinates.append(point)


    legacy_total = max(0.0, float(search_time) + walk_adjustment)
    replay = _replay_timeline(timeline, requested_departure, service_midnight)
    if replay is not None:
        total_time = replay["duration_min"]
        arrival_dt = replay["arrival"]
    else:
        total_time = legacy_total
        arrival_dt = requested_departure + timedelta(minutes=total_time)


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

    # any other agency (TTC, ...) counts as a live source once a trip on it actually got live data
    for other in sorted(used_agencies - {"grt_busses", "grt_trains", "go", ""}):
        if any(step.get("agency") == other and step.get("realtime") for step in steps):
            live_sources.append(agencies.label(other))

    any_live_feed_connected = bool(live_sources)
    realtime_info = {
        "available": bool(realtime_allowed and live_sources),
        "feed_connected": any_live_feed_connected,
        "feed_age_seconds": feed_age if grt_connected_for_route else None,
        "used_live_updates": any(step.get("realtime") for step in steps),
        "scheduled_vehicle_fallback": any(
            bool(vehicle.get("estimated")) for vehicle in live_vehicles
        ),
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

        "stops": steps,
        "segments": segments,
        "transit_stops": transit_stops,
        "live_vehicles": live_vehicles,
        "route_coordinates": route_coordinates,
        "pending_walks": [
            {"start": list(job[0]), "end": list(job[1])}
            for key, job in walk_jobs.items()
            if TRANSIT_DETAILED_WALKS and walks.get(key, {}).get("geometry_source") == "straight_estimate"
            and dist_m(job[0], job[1]) > 35
        ],
        "realtime": realtime_info,
        "departure_datetime": requested_departure.isoformat(),
        "next_service": next_service,
        "transit_preference": preference_key,
        "transit_preference_label": preference["label"],
        "transfer_reliability": connection_reliability(steps),
        "arrival_estimate_datetime": arrival_dt.isoformat(),
        "arrival_basis": "timeline" if replay is not None else "legacy",
        "missed_connection": bool(replay and replay["missed_connection"]),
        "missed_by_min": replay["missed_by_min"] if replay else 0.0,
        "arrive_by_datetime": requested_arrival.isoformat() if requested_arrival else None,
        "access_walk_limit_m": preference["soft_walk_m"] or None,
        "access_walk_limit_expanded": False,
    }



    route["walks_estimated"] = bool(route["pending_walks"])

    if requested_arrival is not None:


        if arrival_dt > requested_arrival:
            return {"success": False, "error": "No route meets your arrival deadline after accounting for walking time."}

    alerts = matching_alerts(realtime, route_ids, used_stop_ids, trip_ids=used_trip_ids,
                             agency_ids=used_agencies)
    mark("formatting")

    route["route_variant"] = "balanced"
    routes = [route]
    if prepared:
        shared = (grt_realtime, go_realtime, realtime, current_time)
        for item in prepared:
            alternate = get_transit_route(
                start_address, end_address,
                departure_datetime=item["departure"],
                timing=None,
                transit_preference=item["pref"],
                start_coordinates=start, end_coordinates=end,
                include_alternatives=False,
                arrive_by=requested_arrival,
                _shared=shared, _picked=item["found"], _walks=_walks,
            )
            if not alternate.get("success") or not alternate.get("routes"):
                continue
            candidate = alternate["routes"][0]
            candidate["route_number"] = len(routes) + 1
            candidate["route_variant"] = item["variant"]
            routes.append(candidate)
    mark("alternatives_format")

    # Walking can be the best way to get there. Offer it as an option alongside the transit
    # journeys instead of replacing them. (Only on the main request, not on the per-route
    # re-runs for alternatives or the "fastest"/"less walking" alternative searches.)
    recommended_route_number = 1
    if _picked is None and excluded_route_keys is None:
        walking_option = _direct_walking_option(
            start, end, start_address, end_address, requested_departure, total_time,
            requested_arrival, preference_key, preference,
        )
        mark("direct_walk")
        if walking_option is not None:
            walking_option["route_number"] = len(routes) + 1
            routes.append(walking_option)
            recommended_route_number = walking_option["route_number"]

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
        "next_service": next_service,
        "transit_preference": preference_key,
        "arrive_by_datetime": requested_arrival.isoformat() if requested_arrival else None,
        "arrival_estimate_datetime": route["arrival_estimate_datetime"],
        "fastest_route_number": fastest["route_number"],
        "shortest_route_number": shortest["route_number"],
        # the route to show first: walking when it beats every transit journey, else the best transit one
        "recommended_route_number": recommended_route_number,
    }
