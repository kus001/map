import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from zoneinfo import ZoneInfo

import requests

try:
    from google.transit import gtfs_realtime_pb2
except ImportError:
    gtfs_realtime_pb2 = None

TRANSIT_TIMEZONE = ZoneInfo("America/Toronto")
REFRESH_SECONDS = int(os.getenv("GRT_REALTIME_REFRESH_SECONDS", "30"))
REQUEST_TIMEOUT = 3.0
MAX_FRESH_AGE_SECONDS = 180

TRIP_UPDATE_URLS = {
    "grt_busses": os.getenv(
        "GRT_BUS_TRIP_UPDATES_URL",
        "https://webapps.regionofwaterloo.ca/api/grt-routes/api/tripupdates/1",
    ),
    "grt_trains": os.getenv(
        "GRT_LRT_TRIP_UPDATES_URL",
        "https://webapps.regionofwaterloo.ca/api/grt-routes/api/tripupdates/2",
    ),
}

VEHICLE_URLS = {
    "grt_busses": os.getenv(
        "GRT_BUS_VEHICLES_URL",
        "https://webapps.regionofwaterloo.ca/api/grt-routes/api/vehiclepositions/1",
    ),
    "grt_trains": os.getenv(
        "GRT_LRT_VEHICLES_URL",
        "https://webapps.regionofwaterloo.ca/api/grt-routes/api/vehiclepositions/2",
    ),
}

ALERTS_URL = os.getenv(
    "GRT_ALERTS_URL",
    "https://webapps.regionofwaterloo.ca/api/grt-routes/api/alerts",
)

_lock = threading.Lock()
_worker_lock = threading.Lock()
_worker_started = False

_cache = {
    "loaded_at": 0.0,
    "trip_updates": {},
    "vehicles": {},
    "alerts": [],
    "available": False,
    "alerts_available": False,
    "feed_timestamp": None,
}


def _fetch_feed(url):
    if not url or gtfs_realtime_pb2 is None:
        return None

    try:
        response = requests.get(url, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()

        feed = gtfs_realtime_pb2.FeedMessage()
        feed.ParseFromString(response.content)
        return feed
    except Exception:
        return None


def _translation_text(value):
    try:
        for translation in value.translation:
            if translation.text:
                return translation.text
    except Exception:
        pass
    return ""


def _parse_trip_updates(agency, feed):
    updates = {}
    timestamp = None

    if feed is None:
        return updates, timestamp

    try:
        timestamp = int(feed.header.timestamp)
    except Exception:
        pass

    for entity in feed.entity:
        if not entity.HasField("trip_update"):
            continue

        trip_update = entity.trip_update
        trip = trip_update.trip
        trip_id = str(trip.trip_id or "")
        if not trip_id:
            continue

        # GTFS-RT TripDescriptor.CANCELED is enum value 3.
        cancelled = int(trip.schedule_relationship) == 3
        default_delay = None

        try:
            if trip_update.HasField("delay"):
                default_delay = int(trip_update.delay)
        except Exception:
            pass

        stop_updates = {}

        for stop_update in trip_update.stop_time_update:
            stop_id = str(stop_update.stop_id or "")
            if not stop_id:
                continue

            info = {}

            if stop_update.HasField("arrival"):
                try:
                    if stop_update.arrival.HasField("delay"):
                        info["arrival_delay"] = int(stop_update.arrival.delay)
                except Exception:
                    pass

                try:
                    if stop_update.arrival.HasField("time"):
                        info["arrival_time"] = int(stop_update.arrival.time)
                except Exception:
                    pass

            if stop_update.HasField("departure"):
                try:
                    if stop_update.departure.HasField("delay"):
                        info["departure_delay"] = int(stop_update.departure.delay)
                except Exception:
                    pass

                try:
                    if stop_update.departure.HasField("time"):
                        info["departure_time"] = int(stop_update.departure.time)
                except Exception:
                    pass

            stop_updates[stop_id] = info

        updates[(agency, trip_id)] = {
            "cancelled": cancelled,
            "delay": default_delay,
            "stops": stop_updates,
        }

    return updates, timestamp


def _parse_vehicles(agency, feed):
    vehicles = {}
    if feed is None:
        return vehicles

    for entity in feed.entity:
        if not entity.HasField("vehicle"):
            continue

        vehicle = entity.vehicle
        trip_id = str(vehicle.trip.trip_id or "")

        if not trip_id or not vehicle.HasField("position"):
            continue

        item = {
            "agency": agency,
            "trip_id": trip_id,
            "lat": float(vehicle.position.latitude),
            "lon": float(vehicle.position.longitude),
            "timestamp": int(vehicle.timestamp) if vehicle.timestamp else None,
        }

        try:
            if vehicle.position.HasField("bearing"):
                item["bearing"] = float(vehicle.position.bearing)
        except Exception:
            pass

        if vehicle.vehicle.id:
            item["vehicle_id"] = str(vehicle.vehicle.id)

        vehicles[(agency, trip_id)] = item

    return vehicles


def _parse_alerts(feed):
    alerts = []
    if feed is None:
        return alerts

    for entity in feed.entity:
        if not entity.HasField("alert"):
            continue

        alert = entity.alert
        route_ids = []
        stop_ids = []

        for informed in alert.informed_entity:
            if informed.route_id:
                route_ids.append(str(informed.route_id))
            if informed.stop_id:
                stop_ids.append(str(informed.stop_id))

        header = _translation_text(alert.header_text)
        description = _translation_text(alert.description_text)

        if not header and not description:
            continue

        alerts.append(
            {
                "id": str(entity.id),
                "header": header or "Transit service alert",
                "description": description,
                "route_ids": route_ids,
                "stop_ids": stop_ids,
            }
        )

    return alerts


def _refresh_once():
    trip_updates = {}
    vehicles = {}
    alerts = []
    trip_feed_timestamps = []
    alerts_received = False
    jobs = {}

    with ThreadPoolExecutor(max_workers=2) as pool:
        for agency, url in TRIP_UPDATE_URLS.items():
            jobs[pool.submit(_fetch_feed, url)] = ("trip", agency)

        for agency, url in VEHICLE_URLS.items():
            jobs[pool.submit(_fetch_feed, url)] = ("vehicle", agency)

        jobs[pool.submit(_fetch_feed, ALERTS_URL)] = ("alerts", None)

        for future in as_completed(jobs):
            kind, agency = jobs[future]

            try:
                feed = future.result()
            except Exception:
                feed = None

            if kind == "trip":
                parsed, timestamp = _parse_trip_updates(agency, feed)
                trip_updates.update(parsed)
                if timestamp:
                    trip_feed_timestamps.append(timestamp)
            elif kind == "vehicle":
                vehicles.update(_parse_vehicles(agency, feed))
            else:
                alerts_received = feed is not None
                alerts = _parse_alerts(feed)

    newest_timestamp = max(trip_feed_timestamps) if trip_feed_timestamps else None
    now_epoch = int(time.time())
    fresh = (
        newest_timestamp is not None
        and 0 <= now_epoch - newest_timestamp <= MAX_FRESH_AGE_SECONDS
    )

    return {
        "loaded_at": time.monotonic(),
        "trip_updates": trip_updates,
        "vehicles": vehicles,
        "alerts": alerts,
        "available": bool(trip_updates) and fresh,
        "alerts_available": alerts_received,
        "feed_timestamp": newest_timestamp,
    }


def _refresh_cache():
    global _cache
    refreshed = _refresh_once()
    with _lock:
        _cache = refreshed


def _background_worker():
    while True:
        _refresh_cache()
        time.sleep(REFRESH_SECONDS)


def start_background_refresh():
    global _worker_started

    if gtfs_realtime_pb2 is None:
        return False

    with _worker_lock:
        if _worker_started:
            return True

        thread = threading.Thread(
            target=_background_worker,
            name="grt-realtime-refresh",
            daemon=True,
        )
        thread.start()
        _worker_started = True

    return True


def snapshot():
    with _lock:
        return {
            "loaded_at": _cache["loaded_at"],
            "trip_updates": dict(_cache["trip_updates"]),
            "vehicles": dict(_cache["vehicles"]),
            "alerts": list(_cache["alerts"]),
            "available": bool(_cache["available"]),
            "alerts_available": bool(_cache["alerts_available"]),
            "feed_timestamp": _cache["feed_timestamp"],
        }


def _trip_key(agency, trip_id):
    return str(agency), str(trip_id)


def trip_update(realtime, agency, trip_id):
    if not realtime.get("available"):
        return None
    return realtime.get("trip_updates", {}).get(_trip_key(agency, trip_id))


def _seconds_since_service_midnight(timestamp, scheduled_seconds):
    dt = datetime.fromtimestamp(timestamp, TRANSIT_TIMEZONE)
    seconds = dt.hour * 3600 + dt.minute * 60 + dt.second

    # GTFS allows times after 24:00 for service that continues past midnight.
    if scheduled_seconds >= 24 * 3600 and seconds < 12 * 3600:
        seconds += 24 * 3600

    return seconds


def adjusted_departure(realtime, agency, trip, stop_id):
    scheduled = float(trip.get("departure_time", 0))
    update = trip_update(realtime, agency, trip.get("trip_id"))

    if not update:
        return scheduled, 0.0, False

    if update.get("cancelled"):
        return None, 0.0, True

    stop_info = update.get("stops", {}).get(str(stop_id), {})

    if stop_info.get("departure_time"):
        adjusted = _seconds_since_service_midnight(
            int(stop_info["departure_time"]), scheduled
        )
        return float(adjusted), float(adjusted - scheduled), True

    delay = stop_info.get("departure_delay")
    if delay is None:
        delay = update.get("delay")

    delay = float(delay or 0)
    return scheduled + delay, delay, True


def adjusted_arrival(realtime, agency, trip, stop_id):
    scheduled = trip.get("arrival_time")
    if scheduled is None:
        return None, 0.0, False

    scheduled = float(scheduled)
    update = trip_update(realtime, agency, trip.get("trip_id"))

    if not update:
        return scheduled, 0.0, False

    if update.get("cancelled"):
        return None, 0.0, True

    stop_info = update.get("stops", {}).get(str(stop_id), {})

    if stop_info.get("arrival_time"):
        adjusted = _seconds_since_service_midnight(
            int(stop_info["arrival_time"]), scheduled
        )
        return float(adjusted), float(adjusted - scheduled), True

    delay = stop_info.get("arrival_delay")
    if delay is None:
        delay = update.get("delay")

    delay = float(delay or 0)
    return scheduled + delay, delay, True


def vehicle_for_trip(realtime, agency, trip_id):
    if not realtime.get("available"):
        return None
    return realtime.get("vehicles", {}).get(_trip_key(agency, trip_id))


def matching_alerts(realtime, route_ids, stop_ids=None, limit=5):
    if not realtime.get("alerts_available"):
        return []

    route_ids = {str(route) for route in route_ids if route is not None}
    stop_ids = {str(stop) for stop in (stop_ids or []) if stop is not None}
    matches = []

    for alert in realtime.get("alerts", []):
        alert_routes = set(alert.get("route_ids", []))
        alert_stops = set(alert.get("stop_ids", []))

        if (
            (not alert_routes and not alert_stops)
            or alert_routes & route_ids
            or alert_stops & stop_ids
        ):
            matches.append(alert)

        if len(matches) >= limit:
            break

    return matches
