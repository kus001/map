import os
import threading
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import requests

TRANSIT_TIMEZONE = ZoneInfo("America/Toronto")
BASE_URL = os.getenv(
    "METROLINX_API_BASE_URL",
    "https://api.openmetrolinx.com/OpenDataAPI/api/V1",
).rstrip("/")
REQUEST_TIMEOUT = float(os.getenv("METROLINX_REQUEST_TIMEOUT", "4.0"))
CACHE_SECONDS = int(os.getenv("METROLINX_CACHE_SECONDS", "25"))

_cache_lock = threading.Lock()
_cache = {}


def configured():
    return bool(str(os.getenv("METROLINX_API_KEY", "")).strip())


def _api_key():
    return str(os.getenv("METROLINX_API_KEY", "")).strip()


def _cache_get(key):
    with _cache_lock:
        item = _cache.get(key)
        if not item:
            return None
        if time.monotonic() - item["loaded_at"] > CACHE_SECONDS:
            _cache.pop(key, None)
            return None
        return item["value"]


def _cache_put(key, value):
    with _cache_lock:
        _cache[key] = {
            "loaded_at": time.monotonic(),
            "value": value,
        }


def _request_json(path):
    key = _api_key()
    if not key:
        return None, "missing_api_key"

    cache_key = path
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached, None

    url = f"{BASE_URL}/{path.lstrip('/')}"
    last_error = None

    # Older examples of the OpenMetrolinx API use `key`; some newer examples use
    # `apiKey`. Trying both keeps the integration resilient without exposing the key
    # to the browser.
    for parameter_name in ("key", "apiKey"):
        try:
            response = requests.get(
                url,
                params={parameter_name: key},
                timeout=REQUEST_TIMEOUT,
                headers={"Accept": "application/json"},
            )

            if response.status_code in {401, 403}:
                last_error = "authentication_failed"
                continue

            response.raise_for_status()
            value = response.json()
            _cache_put(cache_key, value)
            return value, None
        except requests.RequestException:
            last_error = "request_failed"
        except ValueError:
            last_error = "invalid_response"

    return None, last_error or "request_failed"


def _ci_get(mapping, *keys, default=None):
    if not isinstance(mapping, dict):
        return default

    lower = {str(key).lower(): value for key, value in mapping.items()}
    for key in keys:
        value = lower.get(str(key).lower())
        if value is not None and value != "":
            return value
    return default


def _as_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    if isinstance(value, dict):
        return [value]
    return []


def _unwrap_line_collection(value):
    if isinstance(value, list):
        return value

    if isinstance(value, dict):
        # OpenMetrolinx responses have appeared both as Lines: [...] and
        # Lines: {Line: [...]}. Support either shape without tying the app to a
        # single serialization version.
        nested = _ci_get(value, "Line", "Service", "Services")
        if nested is not None and nested is not value:
            return _as_list(nested)
        return [value]

    return []


def _extract_lines(payload):
    if not isinstance(payload, dict):
        return []

    next_service = _ci_get(payload, "NextService", "next_service")
    for container in _as_list(next_service):
        if not isinstance(container, dict):
            continue
        lines = _ci_get(container, "Lines", "Line", "Services", "Service")
        if lines is not None:
            extracted = _unwrap_line_collection(lines)
            if extracted:
                return extracted

    lines = _ci_get(payload, "Lines", "Line", "Services", "Service")
    if lines is not None:
        return _unwrap_line_collection(lines)

    return []


def _clean_time(value):
    if value is None:
        return None

    text = str(value).strip()
    if not text:
        return None

    # ISO timestamp from some API variants.
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(TRANSIT_TIMEZONE)
        return parsed.strftime("%H:%M")
    except ValueError:
        pass

    # Common OpenMetrolinx values are HH:MM or HH:MM:SS.
    parts = text.split(":")
    if len(parts) >= 2 and parts[0].lstrip("+-").isdigit() and parts[1].isdigit():
        try:
            hour = int(parts[0]) % 24
            minute = int(parts[1])
            if 0 <= minute <= 59:
                return f"{hour:02d}:{minute:02d}"
        except ValueError:
            pass

    return text


def _minutes_between_clock_times(scheduled, computed):
    if not scheduled or not computed:
        return 0.0

    try:
        sh, sm = [int(part) for part in scheduled.split(":")[:2]]
        ch, cm = [int(part) for part in computed.split(":")[:2]]
    except (ValueError, AttributeError):
        return 0.0

    delta = (ch * 60 + cm) - (sh * 60 + sm)
    if delta > 12 * 60:
        delta -= 24 * 60
    elif delta < -12 * 60:
        delta += 24 * 60
    return float(delta)


def _truthy(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value or "").strip().lower() in {
        "true",
        "yes",
        "y",
        "1",
        "cancelled",
        "canceled",
    }


def _normalize_line(item):
    if not isinstance(item, dict):
        return None

    scheduled = _clean_time(
        _ci_get(
            item,
            "ScheduledDepartureTime",
            "ScheduledTime",
            "DepartureTime",
        )
    )
    computed = _clean_time(
        _ci_get(
            item,
            "ComputedDepartureTime",
            "EstimatedDepartureTime",
            "ExpectedDepartureTime",
            "ActualDepartureTime",
        )
    )
    if not computed:
        computed = scheduled

    cancelled = _truthy(
        _ci_get(
            item,
            "IsCancelled",
            "Cancelled",
            "Canceled",
            "StopIsCancelled",
        )
    )

    raw_status = str(
        _ci_get(item, "DepartureStatus", "Status", default="") or ""
    ).strip()
    if "cancel" in raw_status.lower():
        cancelled = True

    delay = _minutes_between_clock_times(scheduled, computed)
    if cancelled:
        status = "Cancelled"
    elif delay >= 1:
        status = "Delayed"
    elif delay <= -1:
        status = "Early"
    else:
        status = "On time"

    line_code = str(
        _ci_get(item, "LineCode", "RouteCode", "Route", "Line", default="") or ""
    ).strip()
    line_name = str(
        _ci_get(item, "LineName", "RouteName", "ServiceName", default="") or ""
    ).strip()
    direction = str(
        _ci_get(
            item,
            "DirectionName",
            "Destination",
            "TripHeadsign",
            "Headsign",
            default="",
        )
        or ""
    ).strip()

    return {
        "line_code": line_code,
        "line_name": line_name,
        "direction": direction,
        "trip_number": str(
            _ci_get(item, "TripNumber", "TripNo", "TripId", "TripID", default="")
            or ""
        ).strip(),
        "service_type": str(
            _ci_get(item, "ServiceType", "VehicleType", default="") or ""
        ).strip(),
        "scheduled_time": scheduled,
        "computed_time": computed,
        "delay_min": delay,
        "status": status,
        "cancelled": cancelled,
        "scheduled_platform": str(
            _ci_get(item, "ScheduledPlatform", "Platform", default="") or ""
        ).strip(),
        "actual_platform": str(
            _ci_get(item, "ActualPlatform", "ComputedPlatform", default="") or ""
        ).strip(),
        "update_time": _clean_time(
            _ci_get(item, "UpdateTime", "UpdatedAt", "LastUpdated")
        ),
        "raw_status": raw_status,
    }


def live_departures(stop_code, limit=8):
    stop_code = str(stop_code or "").strip()
    if not stop_code:
        return {
            "configured": configured(),
            "connected": False,
            "error": "missing_stop_code",
            "departures": [],
        }

    payload, error = _request_json(f"Stop/NextService/{stop_code}")
    if payload is None:
        return {
            "configured": configured(),
            "connected": False,
            "error": error,
            "departures": [],
        }

    departures = []
    for item in _extract_lines(payload):
        normalized = _normalize_line(item)
        if normalized and (normalized["scheduled_time"] or normalized["computed_time"]):
            departures.append(normalized)

    # NextService is already ordered as an upcoming-departures board. Preserve
    # that ordering instead of sorting HH:MM strings, which would be incorrect
    # across midnight.

    return {
        "configured": True,
        "connected": True,
        "error": None,
        "stop_code": stop_code,
        "departures": departures[: max(1, min(int(limit), 20))],
    }


def _clock_minutes(value):
    if not value:
        return None
    try:
        hour, minute = [int(part) for part in str(value).split(":")[:2]]
        return (hour % 24) * 60 + minute
    except (TypeError, ValueError):
        return None


def _clock_distance(a, b):
    a_min = _clock_minutes(a)
    b_min = _clock_minutes(b)
    if a_min is None or b_min is None:
        return 9999
    diff = abs(a_min - b_min)
    return min(diff, 24 * 60 - diff)


def _normalized_words(value):
    return {
        word
        for word in str(value or "").lower().replace("-", " ").replace("/", " ").split()
        if len(word) >= 2
    }


def match_departure(departures, trip_id=None, route_name=None, scheduled_time=None, headsign=None):
    candidates = list(departures or [])
    if not candidates:
        return None

    trip_id = str(trip_id or "")
    # GO GTFS trip IDs are generally DATE-LINE-TRIPNUMBER, so the final token is
    # useful for matching the OpenMetrolinx TripNumber field.
    trip_number_hint = trip_id.rsplit("-", 1)[-1] if "-" in trip_id else trip_id
    route_hint = str(route_name or "").strip().lower()
    headsign_words = _normalized_words(headsign)

    best = None
    best_score = float("-inf")

    for item in candidates:
        score = 0.0
        item_trip = str(item.get("trip_number") or "")
        line_code = str(item.get("line_code") or "").strip().lower()
        line_name = str(item.get("line_name") or "").strip().lower()

        if trip_number_hint and item_trip == trip_number_hint:
            score += 100
        elif trip_number_hint and trip_number_hint in item_trip:
            score += 45

        if route_hint and route_hint in {line_code, line_name}:
            score += 30
        elif route_hint and (
            route_hint in line_name
            or line_name in route_hint
            or route_hint in line_code
            or line_code in route_hint
        ):
            score += 12

        time_distance = _clock_distance(
            scheduled_time,
            item.get("scheduled_time") or item.get("computed_time"),
        )
        if time_distance <= 1:
            score += 35
        elif time_distance <= 5:
            score += 20
        elif time_distance <= 15:
            score += 8
        elif time_distance > 45:
            score -= 20

        if headsign_words:
            overlap = headsign_words & _normalized_words(item.get("direction"))
            score += min(15, len(overlap) * 5)

        if score > best_score:
            best = item
            best_score = score

    return best if best is not None and best_score >= 12 else None

# ---------------------------------------------------------------------------
# GO GTFS-Realtime feeds
# ---------------------------------------------------------------------------
# OpenMetrolinx exposes GTFS-RT trip updates, vehicle positions and alerts at
# Gtfs/Feed/*.  These feeds are more useful for route-wide live routing than the
# station-specific JSON NextService endpoint above because they contain every
# active trip in one compact protobuf response.

try:
    from google.transit import gtfs_realtime_pb2
except ImportError:  # pragma: no cover - dependency is optional at import time
    gtfs_realtime_pb2 = None

GTFS_REFRESH_SECONDS = int(os.getenv("METROLINX_GTFS_REFRESH_SECONDS", "25"))
GTFS_MAX_FRESH_AGE_SECONDS = int(os.getenv("METROLINX_GTFS_MAX_AGE_SECONDS", "180"))
GTFS_FEED_PATHS = {
    "trip_updates": "Gtfs/Feed/TripUpdates",
    "vehicles": "Gtfs/Feed/VehiclePosition",
    "alerts": "Gtfs/Feed/Alerts",
}

_gtfs_lock = threading.Lock()
_gtfs_worker_lock = threading.Lock()
_gtfs_worker_started = False
_gtfs_cache = {
    "loaded_at": 0.0,
    "trip_updates": {},
    "vehicles": {},
    "alerts": [],
    "available": False,
    "vehicles_available": False,
    "alerts_available": False,
    "feed_timestamp": None,
}


def _request_gtfs_feed(path):
    key = _api_key()
    if not key or gtfs_realtime_pb2 is None:
        return None

    url = f"{BASE_URL}/{path.lstrip('/')}"
    for parameter_name in ("key", "apiKey"):
        try:
            response = requests.get(
                url,
                params={parameter_name: key},
                timeout=REQUEST_TIMEOUT,
                headers={"Accept": "application/x-protobuf"},
            )
            if response.status_code in {401, 403}:
                continue
            response.raise_for_status()
            feed = gtfs_realtime_pb2.FeedMessage()
            feed.ParseFromString(response.content)
            return feed
        except Exception:
            continue
    return None


def _feed_timestamp(feed):
    if feed is None:
        return None
    try:
        return int(feed.header.timestamp)
    except Exception:
        return None


def _parse_gtfs_trip_updates(feed):
    updates = {}
    if feed is None:
        return updates

    for entity in feed.entity:
        if not entity.HasField("trip_update"):
            continue
        trip_update = entity.trip_update
        trip_id = str(trip_update.trip.trip_id or "")
        if not trip_id:
            continue

        cancelled = int(trip_update.trip.schedule_relationship) == 3
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

        updates[("go", trip_id)] = {
            "cancelled": cancelled,
            "delay": default_delay,
            "stops": stop_updates,
        }
    return updates


def _parse_gtfs_vehicles(feed):
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

        lat = float(vehicle.position.latitude)
        lon = float(vehicle.position.longitude)
        # OpenMetrolinx occasionally uses sentinel/empty coordinates while a
        # vehicle has no valid GPS fix. Do not put those on the map.
        if not (-90 <= lat <= 90 and -180 <= lon <= 180) or (lat == -1 and lon == -1):
            continue

        item = {
            "agency": "go",
            "trip_id": trip_id,
            "route_id": str(vehicle.trip.route_id or ""),
            "lat": lat,
            "lon": lon,
            "timestamp": int(vehicle.timestamp) if vehicle.timestamp else None,
            "current_stop_id": str(vehicle.stop_id or ""),
        }
        try:
            if vehicle.position.HasField("bearing"):
                item["bearing"] = float(vehicle.position.bearing)
        except Exception:
            pass
        try:
            if vehicle.position.HasField("speed"):
                item["speed_mps"] = float(vehicle.position.speed)
        except Exception:
            pass
        if vehicle.vehicle.id:
            item["vehicle_id"] = str(vehicle.vehicle.id)
        if vehicle.vehicle.label:
            item["vehicle_label"] = str(vehicle.vehicle.label)

        vehicles[("go", trip_id)] = item
    return vehicles


def _translation_text(value):
    try:
        for translation in value.translation:
            if translation.text:
                return str(translation.text)
    except Exception:
        pass
    return ""


def _parse_gtfs_alerts(feed):
    alerts = []
    if feed is None:
        return alerts

    for entity in feed.entity:
        if not entity.HasField("alert"):
            continue
        alert = entity.alert
        route_ids = []
        stop_ids = []
        trip_ids = []
        for informed in alert.informed_entity:
            if informed.route_id:
                route_ids.append(str(informed.route_id))
            if informed.stop_id:
                stop_ids.append(str(informed.stop_id))
            try:
                if informed.trip.trip_id:
                    trip_ids.append(str(informed.trip.trip_id))
            except Exception:
                pass

        header = _translation_text(alert.header_text)
        description = _translation_text(alert.description_text)
        if not header and not description:
            continue

        alerts.append(
            {
                "id": f"go:{entity.id}",
                "agency": "go",
                "header": header or "GO Transit service alert",
                "description": description,
                "route_ids": route_ids,
                "stop_ids": stop_ids,
                "trip_ids": trip_ids,
            }
        )
    return alerts


def _refresh_gtfs_once():
    from concurrent.futures import ThreadPoolExecutor, as_completed

    feeds = {}
    with ThreadPoolExecutor(max_workers=3) as pool:
        jobs = {
            pool.submit(_request_gtfs_feed, path): kind
            for kind, path in GTFS_FEED_PATHS.items()
        }
        for future in as_completed(jobs):
            kind = jobs[future]
            try:
                feeds[kind] = future.result()
            except Exception:
                feeds[kind] = None

    trip_feed = feeds.get("trip_updates")
    vehicle_feed = feeds.get("vehicles")
    alert_feed = feeds.get("alerts")
    timestamps = [
        value
        for value in (
            _feed_timestamp(trip_feed),
            _feed_timestamp(vehicle_feed),
            _feed_timestamp(alert_feed),
        )
        if value
    ]
    newest_timestamp = max(timestamps) if timestamps else None
    now_epoch = int(time.time())
    fresh = (
        newest_timestamp is not None
        and 0 <= now_epoch - newest_timestamp <= GTFS_MAX_FRESH_AGE_SECONDS
    )

    trip_updates = _parse_gtfs_trip_updates(trip_feed)
    vehicles = _parse_gtfs_vehicles(vehicle_feed)
    alerts = _parse_gtfs_alerts(alert_feed)

    return {
        "loaded_at": time.monotonic(),
        "trip_updates": trip_updates,
        "vehicles": vehicles,
        "alerts": alerts,
        "available": bool(trip_updates) and fresh,
        "vehicles_available": vehicle_feed is not None,
        "alerts_available": alert_feed is not None,
        "feed_timestamp": newest_timestamp,
    }


def refresh_gtfs_now():
    global _gtfs_cache
    refreshed = _refresh_gtfs_once()
    with _gtfs_lock:
        _gtfs_cache = refreshed
    return refreshed


def _gtfs_background_worker():
    while True:
        refresh_gtfs_now()
        time.sleep(GTFS_REFRESH_SECONDS)


def start_gtfs_background_refresh():
    global _gtfs_worker_started
    if not configured() or gtfs_realtime_pb2 is None:
        return False

    with _gtfs_worker_lock:
        if _gtfs_worker_started:
            return True
        thread = threading.Thread(
            target=_gtfs_background_worker,
            name="go-gtfs-realtime-refresh",
            daemon=True,
        )
        thread.start()
        _gtfs_worker_started = True
    return True


def gtfs_snapshot():
    with _gtfs_lock:
        return {
            "loaded_at": _gtfs_cache["loaded_at"],
            "trip_updates": dict(_gtfs_cache["trip_updates"]),
            "vehicles": dict(_gtfs_cache["vehicles"]),
            "alerts": list(_gtfs_cache["alerts"]),
            "available": bool(_gtfs_cache["available"]),
            "vehicles_available": bool(_gtfs_cache["vehicles_available"]),
            "alerts_available": bool(_gtfs_cache["alerts_available"]),
            "feed_timestamp": _gtfs_cache["feed_timestamp"],
        }
