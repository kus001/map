"""Helpers for routes found by the search: grouping, signatures, realtime merging."""

from .display import normalize_color, route_details
from .geo import access_walk_minutes, dist_m, raw_stop_id, stop_agency, stop_coords, stop_name


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


def _namespaced_trip_keys(items):
    """The router's trip ids are '<agency>:<id>' but live feeds key trips by the raw id."""
    out = {}
    for (agency, trip_id), value in items.items():
        prefix = f"{agency}:"
        trip_id = str(trip_id)
        out[(agency, trip_id if trip_id.startswith(prefix) else prefix + trip_id)] = value
    return out


def combine_realtime(*snapshots):
    """Merge realtime snapshots (the GTFS-RT feeds from realtime.py, GO's own feed, ...) into one.

    Trip updates only count from snapshots that are themselves fresh (``available``); vehicles and
    alerts are always merged.
    """
    trip_updates, vehicles, alerts = {}, {}, []
    for snapshot in snapshots:
        if snapshot.get("available"):
            trip_updates.update(snapshot.get("trip_updates", {}))
        vehicles.update(snapshot.get("vehicles", {}))
        alerts.extend(snapshot.get("alerts", []))
    timestamps = [v for v in (snapshot.get("feed_timestamp") for snapshot in snapshots) if v]
    return {
        "loaded_at": max((float(snapshot.get("loaded_at") or 0) for snapshot in snapshots), default=0.0),
        "trip_updates": _namespaced_trip_keys(trip_updates),
        "vehicles": _namespaced_trip_keys(vehicles),
        "alerts": alerts,
        "available": any(snapshot.get("available") for snapshot in snapshots),
        "alerts_available": any(snapshot.get("alerts_available") for snapshot in snapshots),
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
                "route_color": normalize_color(edge.get("route", {}).get("route_color"))
                    if transit and isinstance(edge.get("route"), dict) else None,
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


def _path_walk_jobs(path, start, end, best_start, best_end):
    groups = group_path(path)
    jobs = {}
    if dist_m(start, stop_coords(path[0])) > 45:
        jobs['start'] = (start, stop_coords(path[0]), access_walk_minutes(best_start[0]))
    if dist_m(end, stop_coords(path[-1])) > 75:
        jobs['end'] = (stop_coords(path[-1]), end, access_walk_minutes(best_end[0]))
    for i, group in enumerate(groups):
        if group["type"] == "walking" and dist_m(group["from_coords"], group["to_coords"]) > 35:
            jobs[f"leg:{i}"] = (group["from_coords"], group["to_coords"], group["ride_min"])
    return jobs


def _transit_groups(path):
    return [g for g in group_path(path) if g["type"] == "transit"]


def _alt_signature(path):
    """Stop-to-stop pattern of the transit legs (ignores which bus/time)."""
    return tuple(
        (str(g["agency"]), str(g["route"]),
         raw_stop_id(g["stops"][0][0]), raw_stop_id(g["stops"][-1][0]))
        for g in _transit_groups(path)
    )
