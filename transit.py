import asyncio
import math
import os
import time
import threading
from collections import OrderedDict
from bisect import bisect_left
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from datetime import datetime, timedelta
from functools import lru_cache
from heapq import heappop, heappush
from itertools import count
from zoneinfo import ZoneInfo
import httpx
from dotenv import load_dotenv

from helpers._transit.go_realtime import (
    configured as go_realtime_configured,
    gtfs_snapshot as go_gtfs_snapshot,
    live_departures as go_live_departures,
    match_departure as match_go_departure,
    start_gtfs_background_refresh,
)
from helpers._transit.gtfs_metadata import shape_for_trip
from helpers._transit.advanced_planning import latest_departure_before, connection_reliability
from helpers._transit.stop_boards import upcoming_departures
from helpers._transit.make_graph import make_graph
from helpers._transit.realtime import (
    adjusted_arrival,
    adjusted_departure,
    matching_alerts,
    trip_update,
    snapshot as realtime_snapshot,
    start_background_refresh,
    vehicle_for_trip,
)
from helpers.coords import nearest_stops
from helpers.geocoding import explain_address_problem, get_coordinates
from helpers.time_management import seconds_to_time, us
from helpers.fast_osrm import osrm_route
from walking import get_walking_route

load_dotenv()

ORS_API_KEY = os.getenv("API")
ORS_WALKING_URL = (
    "https://api.heigit.org/openrouteservice/v2/directions/foot-walking"
)

TRANSIT_TIMEZONE = ZoneInfo("America/Toronto")

MAX_NEARBY_STOPS = 32
FASTEST_NEARBY_STOPS = 64
TRANSIT_PREFERENCES = {
    "balanced": {
        "label": "Balanced",
        "soft_walk_m": 300,
        "walk_penalty": 1.0,   # each minute walked past soft_walk_m counts double
        "max_nearby_stops": MAX_NEARBY_STOPS,
    },
    "less_walking": {
        "label": "Less walking",
        "soft_walk_m": 0,
        "walk_penalty": 2.0,   # Walking time counts triple ...
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
HEURISTIC_SPEED_KMH = 100.0   # Decreased heuristic because we don't have fast trains here sob sob sob
ACCESS_WALK_SPEED_MPS = 1
SERVICE_DAY_ROLLOVER_HOUR = 4
REALTIME_SCHEDULE_WINDOW_HOURS = 3
TRANSIT_DETAILED_WALKS = os.getenv("TRANSIT_DETAILED_WALKS", "1") == "1"
MAX_TRANSIT_ALTERNATIVES = max(1, min(int(os.getenv("TRANSIT_ALTERNATIVES", "3")), 10))
TRANSIT_GO_BOARD_ENRICHMENT = os.getenv("TRANSIT_GO_BOARD_ENRICHMENT", "0") == "1"
LIVE_VEHICLE_MAX_AGE_SECONDS = max(30, int(os.getenv("LIVE_VEHICLE_MAX_AGE_SECONDS", "120")))

_data = None
graph = None
stops = None
_transit_load_lock = threading.Lock()
_realtime_started = False
_scheduled_trip_cache = OrderedDict()
_scheduled_trip_cache_lock = threading.Lock()
MAX_SCHEDULED_TRIP_CACHE_ENTRIES = 256
_ttc_lock = threading.Lock()
_ttc_loaded = False


def _in_toronto(point):
    lat, lon = point[:2]
    return 43.54 <= lat <= 43.92 and -79.72 <= lon <= -79.05


def maybe_load_ttc(*points):
    """Load TTC on demand if it was not already loaded at startup.

    The server normally calls load_ttc() during warmup (see helpers/warmup.py), so
    this is a cheap flag check on every request. It remains as a safety net when
    startup preloading of TTC is disabled with MAP_PRELOAD_TTC=0.
    """
    if _ttc_loaded:
        return
    from helpers._transit.ttc_setup import CACHE
    if not CACHE.exists() or not any(_in_toronto(p) for p in points if p):
        return
    load_ttc()


def load_ttc() -> bool:
    """Merge the compact TTC schedule into the shared graph (idempotent).

    Returns True if TTC data is loaded after the call.
    """
    global _ttc_loaded
    from helpers._transit.ttc_setup import CACHE
    if _ttc_loaded:
        return True
    if not CACHE.exists():
        return False
    with _ttc_lock:
        if _ttc_loaded:
            return True
        import pickle
        with CACHE.open("rb") as file:
            ttc = pickle.load(file)
        ensure_transit_loaded()

        # Join TTC to GO at nearby platforms, without comparing every stop to every other.
        go_index = {}
        for sid, pos in stops.items():
            if not sid.startswith("go:") or not _in_toronto(pos):
                continue
            key = (round(pos[0] * 1000), round(pos[1] * 1000))
            go_index.setdefault(key, []).append((sid, pos))
        for sid, pos in ttc.node_positions.items():
            key = (round(pos[0] * 1000), round(pos[1] * 1000))
            for x in range(key[0] - 2, key[0] + 3):
                for y in range(key[1] - 2, key[1] + 3):
                    for go_id, go_pos in go_index.get((x, y), []):
                        distance = dist_m(pos, go_pos)
                        if distance <= 160:
                            leg = [{"distance": distance / 75}]
                            graph.setdefault(sid, {}).setdefault(go_id, {})["__walk__"] = leg
                            graph.setdefault(go_id, {}).setdefault(sid, {})["__walk__"] = leg
        for sid, neighbors in ttc.graph.items():
            old = graph.setdefault(sid, {})
            for neighbor, routes in neighbors.items():
                old.setdefault(neighbor, {}).update(routes)
        stops.update(ttc.node_positions)
        _data.trip_to_service.update(ttc.trip_to_service)
        _data.calendar.update(ttc.calendar)
        _data.calendar_dates.update(ttc.calendar_dates)
        _ACTIVE_SERVICE_CACHE.clear()
        _ttc_loaded = True
        print(f"TTC loaded: {len(ttc.node_positions):,} stops", flush=True)
        return True


def ensure_transit_loaded(verbose: bool=False) -> float:
    "Load the heavy transit graph only when transit is actually needed."
    global _data, graph, stops, _realtime_started

    if _data is not None:
        if verbose:
            print(f"Transit data already loaded ({len(stops):,} stops).")
        return 0.0

    with _transit_load_lock:
        if _data is not None:
            if verbose: print(f"Transit data already loaded ({len(stops):,} stops).")
            return 0.0

        if verbose: print("Loading transit data...")

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
            print(f"Transit data loaded in {load_seconds:.3f}s ({len(stops):,} stops).")

        return load_seconds


def coord(value) -> list[float, float]:
    return [float(value[0]), float(value[1])]


def stop_coords(entry) -> list[float, float]:
    return coord(entry[1])


def stop_name(entry) -> str:
    info = entry[1]
    return str(info[2]) if len(info) > 2 and info[2] else str(entry[0])


def stop_agency(stop_id) -> str:
    return str(stop_id).split(":", 1)[0]


def raw_stop_id(stop_id) -> str:
    text = str(stop_id)
    return text.split(":", 1)[1] if ":" in text else text


def access_walk_minutes(distance_m) -> float:
    """Walk time between two points"""
    return float(distance_m) / ACCESS_WALK_SPEED_MPS / 60


def dist_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Approximate distance between two points in metres."""
    lat1, lon1 = map(float, a[:2])
    lat2, lon2 = map(float, b[:2])

    avg_lat = math.radians((lat1 + lat2) / 2)

    dx = math.radians(lon2 - lon1) * 6_371_000 * math.cos(avg_lat)
    dy = math.radians(lat2 - lat1) * 6_371_000

    return math.hypot(dx, dy)


def polyline_distance_m(points) -> float:
    if not points or len(points) < 2:
        return 0.0
    return sum(dist_m(points[i - 1], points[i]) for i in range(1, len(points)))


def point_along_polyline(points, fraction):
    """Return a distance-weighted point along a polyline."""
    if not points:
        return None
    if len(points) == 1:
        return [float(points[0][0]), float(points[0][1])]

    fraction = max(0.0, min(1.0, float(fraction)))
    lengths = [
        dist_m(points[index - 1], points[index])
        for index in range(1, len(points))
    ]
    total = sum(lengths)
    if total <= 0:
        return [float(points[0][0]), float(points[0][1])]

    target = total * fraction
    travelled = 0.0
    for index, segment_length in enumerate(lengths, start=1):
        if travelled + segment_length >= target:
            local = 0.0 if segment_length <= 0 else (target - travelled) / segment_length
            start = points[index - 1]
            end = points[index]
            return [
                float(start[0]) + (float(end[0]) - float(start[0])) * local,
                float(start[1]) + (float(end[1]) - float(start[1])) * local,
            ]
        travelled += segment_length

    return [float(points[-1][0]), float(points[-1][1])]


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
        for from_stop, neighbors in graph.items():
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

            # During a scheduled dwell, keep the estimate at the stop instead of
            # making the vehicle jump immediately onto the next segment.
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

        from_coordinates = stop_coords((active["from_stop"], stops[active["from_stop"]]))
        to_coordinates = stop_coords((active["to_stop"], stops[active["to_stop"]]))
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



# Keep map-wide schedule estimation independent of route calculation. Only
# nearby graph edges are inspected, never an entire timetable for every request.
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

    # Access to nearest stops is O(stops log N), then only a few graph neighbors.
    nearby = nearest_stops(stops, latitude, longitude, amount_of_stops=105)
    vehicles = {}
    for distance, entry in nearby:
        if distance > radius_m + 500:
            break
        from_stop = entry[0]
        agency = stop_agency(from_stop)
        if agency not in ("grt_busses", "grt_trains", "go", "ttc"):
            continue
        for to_stop, route_options in graph.get(from_stop, {}).items():
            end = stops.get(to_stop)
            if end is None:
                continue
            for route_key, trips in route_options.items():
                if route_key == "__walk__" or not trips:
                    continue
                info = schedule_info(trips)
                idx = bisect_left(info["times"], seconds)
                # Schedules are in departure order. The active trip should have
                # left very recently. Scan a bounded window, not the entire day.
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
                    start = stops[from_stop]
                    lat = float(start[0]) + (float(end[0])-float(start[0]))*fraction
                    lon = float(start[1]) + (float(end[1])-float(start[1]))*fraction
                    if dist_m((lat, lon), (latitude, longitude)) > radius_m:
                        continue
                    route, headsign = route_details(edge)
                    veh_key = (agency, trip_id)
                    vehicles[veh_key] = {
                        "agency": agency, "trip_id": trip_id,
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


def route_details(edge) -> tuple[str|None, str|None]:
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


def normalize_color(value) -> str|None:
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
        return "tram"
    if agency == "grt_busses":
        return "bus"
    if agency == "go":
        return "train/bus"
    if agency == "ttc":
        return "TTC"
    return "transit"


_WALK_CACHE = OrderedDict()
MAX_WALK_CACHE_ENTRIES = 512
MAX_CONCURRENT_WALK_REQUESTS = 6
WALK_BATCH_BUDGET_SECONDS = max(0.0, min(0.5, float(os.getenv("TRANSIT_WALK_BUDGET_SECONDS", "0.05"))))
WALK_BACKGROUND_SECONDS = 7.0


def run_async(coro):
    """Run a coroutine from synchronous code and return its result.

    Normal case: no event loop is running in this thread, so asyncio.run() is used.
    If this is called from inside a running loop (for example an `async def` web
    handler), asyncio.run() would raise, so the coroutine is run on a fresh loop in a
    short-lived helper thread instead.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)

    box = {}

    def runner():
        try:
            box["value"] = asyncio.run(coro)
        except BaseException as exc:  # re-raised in the caller below
            box["error"] = exc

    worker = threading.Thread(target=runner)
    worker.start()
    worker.join()
    if "error" in box:
        raise box["error"]
    return box["value"]


def _walk_client():
    return httpx.AsyncClient(
        headers={
            "Authorization": ORS_API_KEY or "",
            "Accept": "application/json, application/geo+json",
        },
        timeout=httpx.Timeout(1.3, connect=0.55),
    )


def _ors_walk_directions(feature, coordinates):
    """Turn-by-turn steps from an ORS foot-walking feature."""
    directions = []
    for segment in feature.get("properties", {}).get("segments", []):
        for step in segment.get("steps", []):
            # ORS type 10 is "arrive at your destination". Inside a transit
            # route a walk ends at a stop, so that line would be misleading.
            if step.get("type") == 10:
                continue

            point = None
            way_points = step.get("way_points") or []
            if way_points:
                try:
                    index = int(way_points[0])
                    if 0 <= index < len(coordinates):
                        point = list(coordinates[index])
                except (TypeError, ValueError):
                    pass

            directions.append(
                {
                    "instruction": step.get("instruction", ""),
                    "type": "walking",
                    "modifier": "",
                    "road": step.get("name", ""),
                    "name": step.get("name", ""),
                    "distance_m": float(step.get("distance", 0) or 0),
                    "duration_min": float(step.get("duration", 0) or 0) / 60,
                    "coordinates": point,
                }
            )
    return directions


def _osrm_walk(start_lat, start_lon, end_lat, end_lon):
    """Foot-routing fallback (public OSRM) with the same shape as the ORS result."""
    route = osrm_route("walking", start_lat, start_lon, end_lat, end_lon)
    coordinates = [
        [float(lat), float(lon)] for lon, lat in route["geometry"]["coordinates"]
    ]

    directions = []
    for leg in route.get("legs", []):
        for step in leg.get("steps", []):
            maneuver = step.get("maneuver") or {}
            if maneuver.get("type") == "arrive":
                continue
            location = maneuver.get("location") or []
            directions.append(
                {
                    "instruction": "",
                    "type": maneuver.get("type", "continue"),
                    "modifier": maneuver.get("modifier", ""),
                    "road": step.get("name", ""),
                    "name": step.get("name", ""),
                    "distance_m": float(step.get("distance", 0) or 0),
                    "duration_min": float(step.get("duration", 0) or 0) / 60,
                    "coordinates": (
                        [float(location[1]), float(location[0])]
                        if len(location) >= 2
                        else None
                    ),
                }
            )

    return {
        "coordinates": coordinates,
        "distance_m": float(route.get("distance", 0)),
        "duration_min": float(route.get("duration", 0)) / 60,
        "steps": directions,
    }


async def _fetch_walking_route(client, start_lat, start_lon, end_lat, end_lon):
    key = (start_lat, start_lon, end_lat, end_lon)
    cached = _WALK_CACHE.get(key)
    if cached is not None:
        return cached

    result = None

    if ORS_API_KEY:
        try:
            response = await client.get(
                ORS_WALKING_URL,
                params={
                    "start": f"{start_lon},{start_lat}",
                    "end": f"{end_lon},{end_lat}",
                },
            )
            response.raise_for_status()

            feature = response.json()["features"][0]
            summary = feature.get("properties", {}).get("summary", {})
            coordinates = [
                [float(lat), float(lon)]
                for lon, lat in feature["geometry"]["coordinates"]
            ]

            result = {
                "coordinates": coordinates,
                "geometry_source": "pedestrian_network",
                "distance_m": float(summary.get("distance", 0)),
                "duration_min": float(summary.get("duration", 0)) / 60,
                "steps": _ors_walk_directions(feature, coordinates),
            }
        except Exception:
            result = None

    if result is None:
        # Use the walking router without spawning background threads. Timeouts
        # can now actually cancel the request when a public service hangs.
        try:
            from helpers.fast_osrm import WALK_URL
            response = await client.get(
                f"{WALK_URL}/{start_lon},{start_lat};{end_lon},{end_lat}",
                params={"overview": "full", "geometries": "geojson",
                        "steps": "true", "alternatives": "false"},
            )
            response.raise_for_status()
            body = response.json()
            if body.get("code") == "Ok" and body.get("routes"):
                route = body["routes"][0]
                geometry = route.get("geometry", {}).get("coordinates", [])
                points = [[float(lat), float(lon)] for lon, lat in geometry]
                directions = []
                for leg in route.get("legs", []):
                    for step in leg.get("steps", []):
                        maneuver = step.get("maneuver") or {}
                        if maneuver.get("type") == "arrive":
                            continue
                        location = maneuver.get("location") or []
                        directions.append({
                            "instruction": "", "type": maneuver.get("type", "continue"),
                            "modifier": maneuver.get("modifier", ""),
                            "road": step.get("name", ""), "name": step.get("name", ""),
                            "distance_m": float(step.get("distance", 0) or 0),
                            "duration_min": float(step.get("duration", 0) or 0) / 60,
                            "coordinates": [float(location[1]), float(location[0])]
                            if len(location) >= 2 else None,
                        })
                if len(points) >= 2:
                    result = {"coordinates": points,
                              "geometry_source": "pedestrian_network",
                              "distance_m": float(route.get("distance", 0)),
                              "duration_min": float(route.get("duration", 0)) / 60,
                              "steps": directions}
        except Exception:
            result = None

    # Failures are not cached, so a temporary routing error doesn't stick.
    _WALK_CACHE[key] = result
    while len(_WALK_CACHE) > MAX_WALK_CACHE_ENTRIES:
        try:
            _WALK_CACHE.popitem(last=False)
        except KeyError:
            break
    return result


def _straight_walk(start, end, straight_distance, fallback_min):
    return {
        "coordinates": [start, end],
        "distance_m": straight_distance,
        "duration_min": float(fallback_min),
        "geometry_source": "straight_estimate",
    }


async def walking_geometry_async(client, start, end, fallback_min=None) -> dict:
    start = coord(start)
    end = coord(end)
    maybe_load_ttc(start, end)
    straight_distance = dist_m(start, end)

    if fallback_min is None:
        fallback_min = access_walk_minutes(straight_distance)

    if straight_distance <= 35 or not TRANSIT_DETAILED_WALKS:
        return _straight_walk(start, end, straight_distance, fallback_min)

    result = await _fetch_walking_route(
        client,
        round(start[0], 6),
        round(start[1], 6),
        round(end[0], 6),
        round(end[1], 6),
    )
    return result or _straight_walk(start, end, straight_distance, fallback_min)


def walking_geometry(start, end, fallback_min=None) -> dict:
    """Synchronous wrapper kept for existing callers."""
    start = coord(start)
    end = coord(end)
    straight_distance = dist_m(start, end)

    if fallback_min is None:
        fallback_min = access_walk_minutes(straight_distance)

    if straight_distance <= 35 or not TRANSIT_DETAILED_WALKS:
        return _straight_walk(start, end, straight_distance, fallback_min)

    async def one():
        async with _walk_client() as client:
            return await walking_geometry_async(client, start, end, fallback_min)

    return run_async(one())


_SCHEDULE_CACHE = OrderedDict()
MAX_SCHEDULE_CACHE_ENTRIES = 256


def schedule_info(trips):
    """Return binary-search helpers without allowing the cache to grow forever."""
    # Compact graphs carry their own constant-time schedule view (no per-visit rebuild).
    compact_schedule = getattr(trips, "schedule", None)
    if compact_schedule is not None:
        return compact_schedule

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


_ACTIVE_SERVICE_CACHE = {}


def _active_services(date):
    entry = _ACTIVE_SERVICE_CACHE.get(date)
    if entry is None:
        if len(_ACTIVE_SERVICE_CACHE) >= 8:
            _ACTIVE_SERVICE_CACHE.clear()
        entry = (_data.active_service_ids(date),)   # tuple so None can be cached
        _ACTIVE_SERVICE_CACHE[date] = entry
    return entry[0]


def warm_schedule_caches(days_ahead: int = 1) -> int:
    """Pre-compute the per-date active-service sets (today and the next days).

    IMPORTANT: only run after all agencies are loaded.
    """
    ensure_transit_loaded()
    now = normalize_departure_datetime(datetime.now(TRANSIT_TIMEZONE))
    warmed = 0
    for offset in range(max(0, int(days_ahead)) + 1):
        service_date, _seconds = gtfs_service_clock(now + timedelta(days=offset))
        _active_services(service_date)
        warmed += 1
    return warmed


def trip_active(trip_id, date):
    """Same answer as _data.is_trip_active, but one set lookup per call (the old
    20k-entry LRU thrashed against 124k trips and re-ran strftime each miss)."""
    active = _active_services(date)
    if active is None:
        return True
    service_id = _data.trip_to_service.get(trip_id)
    if service_id is None:
        return True
    return service_id in active


def access_walk_cost(distance_m, soft_walk_m, walk_penalty):
    real = access_walk_minutes(distance_m)
    excess_m = max(0.0, float(distance_m) - float(soft_walk_m))
    return real, access_walk_minutes(excess_m) * float(walk_penalty)


def candidate_stops(options, max_distance_m=None, max_count=MAX_NEARBY_STOPS):
    """Nearest stops first. A distance cap is now optional (None = no hard limit)."""
    ordered = sorted((o for o in options if o[1] is not None), key=lambda o: o[0])
    if max_distance_m is not None:
        ordered = [o for o in ordered if o[0] <= max_distance_m]
    return ordered[:max_count]


def transit_preference_profile(value) -> tuple[str, dict]:
    if isinstance(value, (int, float)):
        return (
            f"P{value}", 
            {
                "label": f"P{value}",
                "soft_walk_m": 100,
                "walk_penalty": float(value),   # each minute walked past soft_walk_m counts value times
                "max_nearby_stops": MAX_NEARBY_STOPS,
            }
        )
    key = str(value or "balanced").strip().lower()
    if key not in TRANSIT_PREFERENCES:
        key = "balanced"
    return key, TRANSIT_PREFERENCES[key]


def _candidate_trip_realtime_compact(
    trips, agency, from_stop, to_stop, earliest, date, realtime
):
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
    active_services = _active_services(date)          # hoisted out of the hot loop
    service_of = _data.trip_to_service.get

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


def _candidate_trip(
    schedule,
    agency,
    from_stop,
    to_stop,
    earliest,
    date,
    realtime,
) -> tuple|None:
    """Find candidate trips"""
    times = schedule["times"]

    if realtime.get("available") and agency in {"grt_busses", "grt_trains", "go"}:
        if hasattr(schedule["trips"], "tids"):
            return _candidate_trip_realtime_compact(
                schedule["trips"], agency, from_stop, to_stop, earliest, date, realtime
            )
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

    trips = schedule["trips"]
    if hasattr(trips, "tids"):
        # Most TTC journeys use scheduled departures. Read the packed arrays
        # directly; turning every candidate into a dict gets expensive.
        active = _active_services(date)
        ids = trips.pools.trip_ids
        service_of = _data.trip_to_service.get if active is not None else None
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
):
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

    heuristic_cache = _heuristic_values if _heuristic_values is not None else {}

    # Per-goal constants, computed once instead of on every heuristic() call.
    # The distance maths below mirrors dist_m() operation for operation, so results
    # are bit-identical to calling dist_m(here, target).
    goal_terms = []
    rad = math.radians
    for goal_id, option in ends.items():
        lat, lon = stops[goal_id][:2]
        end_real, end_pen = access_walk_cost(option[0], soft_walk_m, walk_penalty)
        goal_terms.append((rad(lat), rad(lon), end_real + end_pen))

    def heuristic(stop_id):
        cached = heuristic_cache.get(stop_id)
        if cached is not None:
            return cached
        lat, lon = stops[stop_id][:2]
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
                    if excluded_route_keys and is_transit_edge(edge):
                        excluded_name, _ = route_details(edge)
                        if (agency, str(excluded_name or edge.get("route") or "")) in excluded_route_keys:
                            continue
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


async def _fetch_walks_async(jobs):
    gate = asyncio.Semaphore(MAX_CONCURRENT_WALK_REQUESTS)
    results = {}

    async with _walk_client() as client:
        async def one(key, start, end, fallback):
            async with gate:
                try:
                    results[key] = await walking_geometry_async(client, start, end, fallback)
                except Exception:
                    pass

        pending = [asyncio.create_task(one(key, *job)) for key, job in jobs.items()]
        done, waiting = await asyncio.wait(pending, timeout=WALK_BACKGROUND_SECONDS)
        for task in waiting:
            task.cancel()
        if waiting:
            await asyncio.gather(*waiting, return_exceptions=True)

    # A slow public router must not hold up the transit result. Cached/fast
    # sidewalk paths still show the full geometry and walking directions.
    for key, (start, end, fallback) in jobs.items():
        if key not in results:
            length = dist_m(start, end)
            results[key] = _straight_walk(list(start), list(end), length, fallback)
    return results


_walk_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="map-walks")
_walk_batches = {}
_walk_batch_lock = threading.Lock()


def fetch_walks(jobs):
    if not jobs:
        return {}
    if not TRANSIT_DETAILED_WALKS:
        return {key: walking_geometry(start, end, fallback)
                for key, (start, end, fallback) in jobs.items()}

    # DNS and network teardown can exceed an async timeout. Keep that work
    # outside the Flask request thread with a strictly limited worker pool.
    waiting = {key: job for key, job in jobs.items()
               if _WALK_CACHE.get(_walk_key(job[0], job[1])) is None}
    future = None
    if waiting:
        signature = tuple(sorted(waiting))
        with _walk_batch_lock:
            for old_key, old_future in list(_walk_batches.items()):
                if old_future.done():
                    del _walk_batches[old_key]
            future = _walk_batches.get(signature)
            if future is None and len(_walk_batches) < 3:
                future = _walk_pool.submit(run_async, _fetch_walks_async(waiting))
                _walk_batches[signature] = future
        if future is not None:
            try:
                future.result(timeout=WALK_BATCH_BUDGET_SECONDS)
            except Exception:
                pass

    results = {}
    for key, (start, end, fallback) in jobs.items():
        cached = _WALK_CACHE.get(_walk_key(start, end))
        results[key] = cached or _straight_walk(
            list(start), list(end), dist_m(start, end), fallback
        )
    return results


def ready_walks(pairs):
    """Read completed sidewalk requests. No network work happens here."""
    output = {}
    for item in (pairs or [])[:30]:
        if not isinstance(item, dict):
            continue
        a, b = item.get('start'), item.get('end')
        if not isinstance(a, list) or not isinstance(b, list) or len(a) < 2 or len(b) < 2:
            continue
        try:
            key = _walk_key(a, b)
        except (TypeError, ValueError):
            continue
        route = _WALK_CACHE.get(key)
        if route and route.get('coordinates'):
            output[','.join(f'{v:.6f}' for v in key)] = route
    return output


def _walk_key(start, end):
    return tuple(round(float(v), 6) for v in (*start[:2], *end[:2]))


def _walk_id(start, end):
    return ','.join(f'{v:.6f}' for v in _walk_key(start, end))


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


def _path_signature(path):
    # Distinguishes different services without drawing/formatting their geometry.
    return tuple((str(group['agency']), str(group['route']),
                  str(group['from_name']), str(group['to_name']))
                 for group in group_path(path) if group['type'] == 'transit')


def nearby_transit_stops(lat, lon, radius_m=3000, limit=25):
    """Stops around map center; cached graph and bounded response size."""
    ensure_transit_loaded()
    maybe_load_ttc((float(lat), float(lon)))
    radius_m = max(300, min(1500, float(radius_m)))
    limit = max(1, min(50, int(limit)))
    nearest = nearest_stops(stops, float(lat), float(lon), amount_of_stops=limit * 3)
    answer = []
    for distance, (stop_id, info) in nearest:
        if distance > radius_m:
            continue
        agency = stop_agency(stop_id)
        if agency not in ("grt_busses", "grt_trains", "go", "ttc"):
            continue
        if not graph.get(stop_id):
            continue
        answer.append({"id": stop_id, "raw_id": raw_stop_id(stop_id),
                       "agency": agency, "name": info[2] or raw_stop_id(stop_id),
                       "coordinates": coord(info), "distance_m": round(distance)})
        if len(answer) >= limit:
            break
    return answer


def stop_departure_board(stop_id, limit=8, now=None):
    ensure_transit_loaded()
    if stop_id.startswith("ttc:"):
        maybe_load_ttc((43.66, -79.39))
    if stop_id not in stops:
        return None
    now = normalize_departure_datetime(now)
    service_date, service_seconds = gtfs_service_clock(now)
    realtime = combine_realtime(realtime_snapshot(), go_gtfs_snapshot())
    # Use the source's own freshness flag; stale updates must not appear LIVE.
    schedule = upcoming_departures(
        stop_id, graph, service_date=service_date, service_seconds=service_seconds,
        active_trip=trip_active, realtime=realtime, route_details=route_details,
        raw_stop_id=raw_stop_id, adjusted_departure=adjusted_departure,
        limit=max(1,min(12,int(limit))),
    )
    # Arrival-only terminal points can share a boarding platform close by.
    if not schedule:
        centre = coord(stops[stop_id])
        for metres, (other_id, other_info) in nearest_stops(stops, *centre, amount_of_stops=16):
            if metres > 90:
                break
            if other_id == stop_id or stop_agency(other_id) != stop_agency(stop_id):
                continue
            nearby = upcoming_departures(
                other_id, graph, service_date=service_date, service_seconds=service_seconds,
                active_trip=trip_active, realtime=realtime, route_details=route_details,
                raw_stop_id=raw_stop_id, adjusted_departure=adjusted_departure, limit=8,
            )
            if nearby:
                for item in nearby:
                    item['boarding_stop'] = other_info[2] or raw_stop_id(other_id)
                schedule = nearby
                break

    return {"stop_id": stop_id, "name": stops[stop_id][2] or stop_id,
            "agency": stop_agency(stop_id), "departures": schedule,
            "live_count": sum(1 for item in schedule if item['realtime']),
            "source": "GTFS schedule + available realtime updates"}


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
    _shared=None,
    _picked=None,
    _walks=None,
) -> dict:
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

    # TTC has to be in the graph before choosing the nearby stops.
    # Loading it during walking geometry is too late for Toronto routes.
    maybe_load_ttc(start, end)
    mark("ttc_load")

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

    start_options = nearest_stops(stops, *start)
    end_options = nearest_stops(stops, *end)
    mark("nearest_stops")

    preference_key, preference = transit_preference_profile(transit_preference)

    requested_arrival = normalize_departure_datetime(arrive_by) if arrive_by else None
    if _picked is not None:
        path, search_time, best_start, best_end = _picked
    else:
        arrive_search_path = None
        if requested_arrival is not None:
            # Search only the timetable graph, not external pedestrian geometry.
            # The Fastest profile establishes feasibility; then the chosen profile
            # is applied at the latest feasible departure.
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

        path, search_time, best_start, best_end = search_transit(
            start_options,
            end_options,
            routing_realtime,
            departure_datetime=requested_departure,
            soft_walk_m=preference["soft_walk_m"],
            walk_penalty=preference["walk_penalty"],
            max_nearby_stops=preference["max_nearby_stops"],
            excluded_route_keys=excluded_route_keys,
        )

        # A preferred route may walk less but arrive past the requested deadline.
        # In that case use the feasible fastest journey found in the bounded search.
        if requested_arrival is not None:
            if (path is None or requested_departure + timedelta(minutes=float(search_time))
                    > requested_arrival - timedelta(minutes=2)):
                path, search_time, best_start, best_end = arrive_search_path

    next_service = False
    # "Leave now" can be after the last GO connection of the night.
    # Try the next morning once; be explicit that this isn't an immediate departure.
    if path is None and departure_datetime is None and requested_arrival is None:
        morning = requested_departure.replace(hour=6, minute=0, second=0, microsecond=0)
        if morning <= requested_departure:
            morning += timedelta(days=1)
        if (_in_toronto(start) or _in_toronto(end)) and morning - requested_departure <= timedelta(hours=24):
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
        ttc_note = ""
        if _in_toronto(start) or _in_toronto(end):
            from helpers._transit.ttc_setup import CACHE
            if not CACHE.exists():
                ttc_note = " TTC timetable not installed; run python -m helpers._transit.ttc_setup."
        return {"success": False,
                "error": "No transit departure found for this time. Try Depart at with a daytime departure." + ttc_note}

    if not any(is_transit_edge(path[i][2] or {}) for i in range(1, len(path))):
        return get_walking_route(start_address, end_address, start_coordinates=start, end_coordinates=end)

    prepared = []
    if include_alternatives and MAX_TRANSIT_ALTERNATIVES > 1:
        seen = {_path_signature(path)}
        base_keys = route_keys_for_path(path)
        for choice in ("fastest", "less_walking"):
            profile = TRANSIT_PREFERENCES[choice]
            options = [set()] + [{key} for key in base_keys[:3]]
            for excluded in options:
                found = search_transit(
                    start_options, end_options, routing_realtime,
                    departure_datetime=requested_departure,
                    soft_walk_m=profile["soft_walk_m"],
                    walk_penalty=profile["walk_penalty"],
                    max_nearby_stops=profile["max_nearby_stops"],
                    excluded_route_keys=excluded,
                )
                other_path, other_time, other_start, other_end = found
                if not other_path or not any(is_transit_edge(item[2] or {}) for item in other_path[1:]):
                    continue
                if requested_arrival and requested_departure + timedelta(minutes=other_time) > requested_arrival:
                    continue
                signature = _path_signature(other_path)
                if not signature or signature in seen:
                    continue
                seen.add(signature)
                prepared.append((found, choice))
                break
            if len(prepared) + 1 >= MAX_TRANSIT_ALTERNATIVES:
                break
        mark("alternatives_search")

    groups = group_path(path)
    first = path[0]
    last = path[-1]
    walk_jobs = _path_walk_jobs(path, start, end, best_start, best_end)
    if _walks is None:
        all_jobs = {}
        for candidate in [(path, search_time, best_start, best_end), *(item[0] for item in prepared)]:
            for job in _path_walk_jobs(candidate[0], start, end, candidate[2], candidate[3]).values():
                all_jobs.setdefault(_walk_key(job[0], job[1]), job)
        results = fetch_walks(all_jobs)
        _walks = results
    walks = {key: _walks.get(_walk_key(job[0], job[1]))
             for key, job in walk_jobs.items()}
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
            "route_color": route_color,
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
            # Where you get off: lets navigation measure distance to your stop.
            "to_coordinates": list(group["to_coords"]),
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

        # total_distance += distance
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
        walk_adjustment += end_walk["duration_min"] - access_walk_minutes(best_end[0])

    route_coordinates = []
    for segment in segments:
        for point in segment["coordinates"]:
            point = coord(point)
            if not route_coordinates or route_coordinates[-1] != point:
                route_coordinates.append(point)

    total_time = max(0.0, float(search_time) + walk_adjustment)

    # "Fastest" means fastest: if walking the whole way beats transit, return the walk.
    if preference_key == "fastest" and excluded_route_keys is None:
        if access_walk_minutes(dist_m(start, end)) <= total_time:
            direct_walk = walking_geometry(start, end)
            if direct_walk["duration_min"] <= total_time:
                return get_walking_route(
                    start_address,
                    end_address,
                    start_coordinates=start,
                    end_coordinates=end,
                )
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
        # Keep this alias for compatibility with older frontend code that used route.stops.
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
        "arrival_estimate_datetime": (requested_departure + timedelta(minutes=total_time)).isoformat(),
        "arrive_by_datetime": requested_arrival.isoformat() if requested_arrival else None,
        "access_walk_limit_m": preference["soft_walk_m"] or None,
        "access_walk_limit_expanded": False,
    }

    if requested_arrival is not None:
        # The road-following geometry can slightly increase walking time. Do
        # not present a journey as on-time if it now misses the deadline.
        if requested_departure + timedelta(minutes=total_time) > requested_arrival:
            return {"success": False, "error": "No route meets your arrival deadline after accounting for walking time."}

    alerts = matching_alerts(realtime, route_ids, used_stop_ids, trip_ids=used_trip_ids)
    mark("formatting")

    route["route_variant"] = "balanced"
    routes = [route]
    if prepared:
        shared = (grt_realtime, go_realtime, realtime, current_time)
        for picked, choice in prepared:
            alternate = get_transit_route(
                start_address, end_address,
                departure_datetime=requested_departure,
                timing=None,
                transit_preference=choice,
                start_coordinates=start, end_coordinates=end,
                include_alternatives=False,
                arrive_by=requested_arrival,
                _shared=shared, _picked=picked, _walks=_walks,
            )
            if not alternate.get("success") or not alternate.get("routes"):
                continue
            candidate = alternate["routes"][0]
            candidate["route_number"] = len(routes) + 1
            candidate["route_variant"] = choice
            routes.append(candidate)
    mark("alternatives_format")

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
