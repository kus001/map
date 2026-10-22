"""Live-vehicle checks and GTFS-derived approximate vehicle positions."""

import threading
from bisect import bisect_left
from collections import OrderedDict
from datetime import datetime

from . import agencies
from .gtfs_metadata import shape_for_trip
from .realtime import adjusted_arrival, adjusted_departure
from helpers.coords import nearest_stops

from . import store
from .config import LIVE_VEHICLE_MAX_AGE_SECONDS, MAX_SCHEDULED_TRIP_CACHE_ENTRIES, TRANSIT_TIMEZONE
from .display import route_details
from .geo import dist_m, point_along_polyline, raw_stop_id, stop_agency, stop_coords
from .loader import ensure_transit_loaded
from .schedule import schedule_info, trip_active
from .timeutil import gtfs_service_clock, normalize_departure_datetime


def live_vehicle_is_usable(vehicle, now=None):
    """Reject stale GPS fixes so the UI can fall back to a schedule estimate."""
    if not vehicle:
        return False

    timestamp = vehicle.get("timestamp")
    if timestamp in (None, ""):
        return True

    try:
        timestamp = float(timestamp)
    except (TypeError, ValueError):
        return True

    now_timestamp = (now or datetime.now(TRANSIT_TIMEZONE)).timestamp()
    age = now_timestamp - timestamp
    return -60 <= age <= LIVE_VEHICLE_MAX_AGE_SECONDS


_scheduled_trip_cache = OrderedDict()
_scheduled_trip_cache_lock = threading.Lock()


def _load_scheduled_trip_hops(trip_keys):
    """Load static hop schedules for only the requested trips, then cache them.

    The transit graph already contains every GTFS stop-to-stop hop. A selected route
    only needs a handful of trip IDs, so scan once for any uncached IDs and retain
    those timelines for future 15-second refreshes without building another large
    global index in memory.
    """
    ensure_transit_loaded()
    normalized = {(str(agency), str(trip_id)) for agency, trip_id in trip_keys if trip_id}
    if not normalized:
        return {}

    with _scheduled_trip_cache_lock:
        missing = {key for key in normalized if key not in _scheduled_trip_cache}

    if missing:
        wanted_by_agency = {}
        for agency, trip_id in missing:
            wanted_by_agency.setdefault(agency, set()).add(trip_id)

        found = {key: [] for key in missing}
        for from_stop, neighbors in store.graph.items():
            agency = stop_agency(from_stop)
            wanted = wanted_by_agency.get(agency)
            if not wanted:
                continue

            for to_stop, route_options in neighbors.items():
                for trips in route_options.values():
                    if hasattr(trips, "edges_for_trips"):
                        candidates = trips.edges_for_trips(wanted)
                    else:
                        candidates = trips
                    for edge in candidates:
                        trip_id = str(edge.get("trip_id") or "")
                        if trip_id not in wanted:
                            continue
                        departure = edge.get("departure_time")
                        arrival = edge.get("arrival_time")
                        if departure is None or arrival is None:
                            continue
                        found[(agency, trip_id)].append(
                            {
                                **edge,
                                "from_stop": from_stop,
                                "to_stop": to_stop,
                            }
                        )

        with _scheduled_trip_cache_lock:
            for key, hops in found.items():
                hops.sort(key=lambda hop: float(hop.get("departure_time") or 0))
                _scheduled_trip_cache[key] = hops
                _scheduled_trip_cache.move_to_end(key)

            while len(_scheduled_trip_cache) > MAX_SCHEDULED_TRIP_CACHE_ENTRIES:
                _scheduled_trip_cache.popitem(last=False)

    with _scheduled_trip_cache_lock:
        return {key: list(_scheduled_trip_cache.get(key, [])) for key in normalized}


# estimate vehicle positions when realtime isnt available
def scheduled_vehicle_positions(steps, realtime=None, now=None):
    """Estimate selected vehicles from GTFS when a usable live GPS fix is absent.

    Estimates use the complete trip timeline stored in the transit graph, select the
    stop-to-stop hop the vehicle should currently occupy, and interpolate along the
    GTFS shape for that hop. When TripUpdates still work but VehiclePositions do not,
    their delay is applied to the estimate.
    """
    now = normalize_departure_datetime(now or datetime.now(TRANSIT_TIMEZONE))
    service_date, now_seconds = gtfs_service_clock(now)
    realtime = realtime or {}

    valid_steps = [
        step
        for step in (steps or [])
        if isinstance(step, dict)
        and step.get("agency")
        and step.get("trip_id")
    ]
    keys = {(str(step["agency"]), str(step["trip_id"])) for step in valid_steps}
    timelines = _load_scheduled_trip_hops(keys)
    estimates = []
    seen = set()

    for step in valid_steps:
        agency = str(step.get("agency") or "")
        trip_id = str(step.get("trip_id") or "")
        key = (agency, trip_id)
        if key in seen or not trip_active(trip_id, service_date):
            continue

        hops = timelines.get(key) or []
        if not hops:
            continue

        active = None
        active_departure = None
        active_arrival = None
        delay_adjusted = False
        at_stop = False

        for index, hop in enumerate(hops):
            departure, _, live_departure = adjusted_departure(
                realtime, agency, hop, raw_stop_id(hop["from_stop"])
            )
            arrival, _, live_arrival = adjusted_arrival(
                realtime, agency, hop, raw_stop_id(hop["to_stop"])
            )
            if departure is None or arrival is None:
                continue

            delay_adjusted = delay_adjusted or live_departure or live_arrival
            if departure <= now_seconds <= arrival:
                active = hop
                active_departure = float(departure)
                active_arrival = float(arrival)
                break



            if now_seconds < departure and index > 0:
                previous = hops[index - 1]
                previous_arrival, _, previous_live = adjusted_arrival(
                    realtime, agency, previous, raw_stop_id(previous["to_stop"])
                )
                delay_adjusted = delay_adjusted or previous_live
                if previous_arrival is not None and previous_arrival <= now_seconds:
                    active = hop
                    active_departure = float(departure)
                    active_arrival = float(departure)
                    at_stop = True
                break

        if active is None:
            continue

        from_coordinates = stop_coords((active["from_stop"], store.stops[active["from_stop"]]))
        to_coordinates = stop_coords((active["to_stop"], store.stops[active["to_stop"]]))
        if at_stop or active_arrival <= active_departure:
            fraction = 0.0
        else:
            fraction = (now_seconds - active_departure) / (active_arrival - active_departure)

        geometry, _ = shape_for_trip(
            agency,
            trip_id,
            from_coordinates,
            to_coordinates,
            step.get("route") or "",
            step.get("headsign") or "",
        )
        geometry = geometry or [from_coordinates, to_coordinates]
        position = point_along_polyline(geometry, fraction)
        if not position:
            continue

        estimates.append(
            {
                "agency": agency,
                "trip_id": trip_id,
                "route": step.get("route"),
                "headsign": step.get("headsign"),
                "lat": float(position[0]),
                "lon": float(position[1]),
                "timestamp": int(now.timestamp()),
                "position_source": "schedule_adjusted" if delay_adjusted else "scheduled",
                "estimated": True,
                "from_stop_id": raw_stop_id(active["from_stop"]),
                "to_stop_id": raw_stop_id(active["to_stop"]),
            }
        )
        seen.add(key)

    return estimates
_nearby_vehicle_cache = OrderedDict()
_nearby_vehicle_lock = threading.Lock()


def nearby_scheduled_vehicles(latitude, longitude, radius_m=5000, limit=45, now=None):
    """GTFS-based approximate positions of active trips close to the map center.

    This is an offline fallback if a live vehicle feed has no positions nearby.
    Markers are explicitly *estimated* and are not presented as observed GPS.
    """
    ensure_transit_loaded()
    latitude, longitude = float(latitude), float(longitude)
    radius_m = max(500.0, min(float(radius_m), 15000.0))
    limit = max(1, min(int(limit), 70))
    now = normalize_departure_datetime(now or datetime.now(TRANSIT_TIMEZONE))
    service_date, seconds = gtfs_service_clock(now)
    key = (round(latitude, 3), round(longitude, 3), round(radius_m, -3),
           now.date().isoformat(), int(seconds // 30), limit)
    with _nearby_vehicle_lock:
        if key in _nearby_vehicle_cache:
            return list(_nearby_vehicle_cache[key])


    nearby = nearest_stops(store.stops, latitude, longitude, amount_of_stops=105)
    vehicles = {}
    for distance, entry in nearby:
        if distance > radius_m + 500:
            break
        from_stop = entry[0]
        agency = stop_agency(from_stop)
        if not agencies.is_known(agency):
            continue
        for to_stop, route_options in store.graph.get(from_stop, {}).items():
            end = store.stops.get(to_stop)
            if end is None:
                continue
            for route_key, trips in route_options.items():
                if route_key == "__walk__" or not trips:
                    continue
                info = schedule_info(trips)
                idx = bisect_left(info["times"], seconds)


                for edge in trips[max(0, idx - 5):min(len(trips), idx + 2)]:
                    depart = edge.get("departure_time")
                    arrive = edge.get("arrival_time")
                    trip_id = str(edge.get("trip_id") or "")
                    if not trip_id or depart is None or arrive is None:
                        continue
                    depart, arrive = float(depart), float(arrive)
                    if not (depart <= seconds <= arrive + 20):
                        continue
                    if not trip_active(trip_id, service_date):
                        continue
                    fraction = min(1.0, max(0.0, (seconds-depart)/max(1.0, arrive-depart)))
                    start = store.stops[from_stop]
                    lat = float(start[0]) + (float(end[0])-float(start[0]))*fraction
                    lon = float(start[1]) + (float(end[1])-float(start[1]))*fraction
                    if dist_m((lat, lon), (latitude, longitude)) > radius_m:
                        continue
                    route, headsign = route_details(edge)
                    veh_key = (agency, trip_id)
                    vehicles[veh_key] = {
                        "agency": agency, "agency_label": agencies.label(agency),
                        "trip_id": trip_id,
                        "route": route or str(route_key), "headsign": headsign,
                        "lat": lat, "lon": lon, "estimated": True,
                        "position_source": "scheduled_local",
                        "timestamp": int(now.timestamp()),
                        "from_stop_id": raw_stop_id(from_stop),
                        "to_stop_id": raw_stop_id(to_stop),
                    }
                    if len(vehicles) >= limit * 3:
                        break
                if len(vehicles) >= limit * 3:
                    break
            if len(vehicles) >= limit * 3:
                break
        if len(vehicles) >= limit * 3:
            break
    results = sorted(vehicles.values(), key=lambda v: dist_m(
        (v["lat"], v["lon"]), (latitude, longitude)))[:limit]
    with _nearby_vehicle_lock:
        _nearby_vehicle_cache[key] = results
        _nearby_vehicle_cache.move_to_end(key)
        while len(_nearby_vehicle_cache) > 24:
            _nearby_vehicle_cache.popitem(last=False)
    return list(results)
