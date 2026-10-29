import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from zoneinfo import ZoneInfo

from . import agencies, net, rt_match

try:
    from google.transit import gtfs_realtime_pb2
except ImportError:
    gtfs_realtime_pb2 = None

TRANSIT_TIMEZONE = ZoneInfo("America/Toronto")
REFRESH_SECONDS = int(os.getenv("GRT_REALTIME_REFRESH_SECONDS", "30"))
REQUEST_TIMEOUT = 3.0
# Some feed hosts (gtfsrt.ttc.ca) sit behind a firewall that answers 403 to python-requests' default
# User-Agent. Override with the GTFS_RT_USER_AGENT environment variable if a feed still says 403.
REQUEST_HEADERS = {
    "User-Agent": os.getenv("GTFS_RT_USER_AGENT") or (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/126.0.0.0 Safari/537.36"),
    "Accept": "application/x-protobuf, application/octet-stream, */*",
}
MAX_FRESH_AGE_SECONDS = 180

def _declared(attr):
    """GTFS-RT links written on the Agency(...) entries in agencies.py."""
    return {a.id: getattr(a, attr) for a in agencies.AGENCIES.values() if getattr(a, attr)}


TRIP_UPDATE_URLS = {
    **_declared("trip_updates_url"),
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
    **_declared("vehicles_url"),
    "grt_busses": os.getenv(
        "GRT_BUS_VEHICLES_URL",
        "https://webapps.regionofwaterloo.ca/api/grt-routes/api/vehiclepositions/1",
    ),
    "grt_trains": os.getenv(
        "GRT_LRT_VEHICLES_URL",
        "https://webapps.regionofwaterloo.ca/api/grt-routes/api/vehiclepositions/2",
    ),
}

KEYS = {
    **_declared("key")
}

ALERTS_URL = os.getenv(
    "GRT_ALERTS_URL",
    "https://webapps.regionofwaterloo.ca/api/grt-routes/api/alerts",
)

# alert feeds by agency id; the GRT alerts feed covers both GRT agencies
ALERT_URLS = {"grt": ALERTS_URL, **_declared("alerts_url")}
# which agencies an alert feed speaks for (the GRT feed covers both GRT agencies)
ALERT_AGENCIES = {"grt": ("grt_busses", "grt_trains")}

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


def _fetch_feed(url, key=None):
    if not url or gtfs_realtime_pb2 is None:
        return None
    try:
        rheaders = dict(REQUEST_HEADERS)  # copy: never leak one agency's key into the shared headers .. yeah i know dicts are weird
        if key:
            rheaders[key["header"]] = key["key"]
        response = net.get(url, headers=rheaders, timeout=15)
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
            "route_id": str(trip.route_id or ""),
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


def _parse_alerts(feed, agency="grt"):
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
                "id": str(entity.id),
                "agency": agency,
                "agency_ids": list(ALERT_AGENCIES.get(agency, (agency,))),
                "agency_label": agencies.label(agency),
                "header": header or f"{agencies.label(agency)} service alert",
                "description": description,
                "route_ids": route_ids,
                "stop_ids": stop_ids,
                "trip_ids": trip_ids,
            }
        )

    return alerts


def _live_trips(updates):
    return [(live_id, update.get("route_id", ""),
             [(stop, info.get("departure_time") or info.get("arrival_time"))
              for stop, info in update["stops"].items()])
            for (_, live_id), update in updates.items()]


def _translate_by_time(agency, updates):
    """For feeds whose trip ids aren't the static ones: re-key live trips (and their stops) to
    static trips by route + stop + time. Returns (updates, {live_id: static_id}, stats)."""
    index = rt_match.get_index(agency)
    if index is None:  # lookup table still being built in the background
        return {}, {}, None

    matched, stats = index.match(_live_trips(updates))

    translated, mapping = {}, {}
    for live_id, (static_id, delay, stop_mode) in matched.items():
        update = updates[(agency, live_id)]
        stops = {}
        for stop_id, info in update["stops"].items():
            static_stop = index.static_stop(stop_id, stop_mode)
            if static_stop:
                info = dict(info)
                if "arrival_time" in info:
                    info.setdefault("departure_time", info["arrival_time"])
                if "departure_time" in info:
                    info.setdefault("arrival_time", info["departure_time"])
                stops[static_stop] = info
        translated[(agency, static_id)] = {**update, "stops": stops, "delay": float(delay)}
        mapping[live_id] = static_id
    return translated, mapping, stats


def _remap_vehicles(vehicles, mapping):
    if not mapping:
        return vehicles
    return {(agency, mapping.get(trip_id, trip_id)): {**item, "trip_id": mapping.get(trip_id, trip_id)}
            for (agency, trip_id), item in vehicles.items()}


def _refresh_once():
    trip_updates = {}
    vehicles = {}
    alerts = []
    trip_feed_timestamps = []
    fresh_feed_found = False
    alerts_received = False
    jobs = {}
    vehicle_feeds = []
    trip_maps = {}
    now_epoch = int(time.time())

    with ThreadPoolExecutor(max_workers=8) as pool:
        for agency, url in TRIP_UPDATE_URLS.items():
            jobs[pool.submit(_fetch_feed, url, KEYS[agency] if agency in KEYS else None)] = ("trip", agency)

        for agency, url in VEHICLE_URLS.items():
            jobs[pool.submit(_fetch_feed, url, KEYS[agency] if agency in KEYS else None)] = ("vehicle", agency)

        for agency, url in ALERT_URLS.items():
            jobs[pool.submit(_fetch_feed, url, KEYS[agency] if agency in KEYS else None)] = ("alerts", agency)

        for future in as_completed(jobs):
            kind, agency = jobs[future]

            try:
                feed = future.result()
            except Exception:
                feed = None

            if kind == "trip":
                parsed, timestamp = _parse_trip_updates(agency, feed)
                if timestamp:
                    trip_feed_timestamps.append(timestamp)
                # only trust a feed that is itself fresh (each agency publishes on its own clock)
                if timestamp and 0 <= now_epoch - timestamp <= MAX_FRESH_AGE_SECONDS:
                    if agencies.get(agency).match_live_by_time:
                        parsed, trip_maps[agency], _ = _translate_by_time(agency, parsed)
                    trip_updates.update(parsed)
                    fresh_feed_found = True
            elif kind == "vehicle":
                vehicle_feeds.append((agency, feed))
            else:
                alerts_received = alerts_received or feed is not None
                alerts.extend(_parse_alerts(feed, agency))

    for agency, feed in vehicle_feeds:  # after the trip feeds, so live ids can be translated
        vehicles.update(_remap_vehicles(_parse_vehicles(agency, feed), trip_maps.get(agency)))

    newest_timestamp = max(trip_feed_timestamps) if trip_feed_timestamps else None

    return {
        "loaded_at": time.monotonic(),
        "trip_updates": trip_updates,
        "vehicles": vehicles,
        "alerts": alerts,
        "available": bool(trip_updates) and fresh_feed_found,
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


    return realtime.get("vehicles", {}).get(_trip_key(agency, trip_id))


def matching_alerts(realtime, route_ids, stop_ids=None, limit=5, trip_ids=None, agency_ids=None):
    """Alerts relevant to these routes/stops/trips. With ``agency_ids`` (the agencies actually used),
    an alert only counts if it comes from one of them, so TTC's route 11 or a system-wide TTC notice
    never shows up on a GRT trip."""
    if not realtime.get("alerts_available"):
        return []

    route_ids = {str(route) for route in route_ids if route is not None}
    stop_ids = {str(stop) for stop in (stop_ids or []) if stop is not None}
    # router trip ids are "<agency>:<id>"; alerts carry the raw id
    trip_ids = {variant for trip in (trip_ids or []) if trip is not None
                for variant in (str(trip), str(trip).split(":", 1)[-1])}
    agency_ids = {str(agency) for agency in agency_ids} if agency_ids else None
    matches = []

    for alert in realtime.get("alerts", []):
        if agency_ids is not None:
            alert_agencies = set(alert.get("agency_ids") or [alert.get("agency")])
            if not alert_agencies & agency_ids:
                continue
        alert_routes = set(alert.get("route_ids", []))
        alert_stops = set(alert.get("stop_ids", []))
        alert_trips = set(alert.get("trip_ids", []))

        if (
            (not alert_routes and not alert_stops and not alert_trips)
            or alert_routes & route_ids
            or alert_stops & stop_ids
            or alert_trips & trip_ids
        ):
            matches.append({**alert, "agency_label": alert.get("agency_label")
                            or agencies.label(alert.get("agency"))})

        if len(matches) >= limit:
            break

    return matches


def _report_time_match(agency, feed):
    parsed, _ = _parse_trip_updates(agency.id, feed)
    index = rt_match.get_index(agency.id, block=True)
    live = _live_trips(parsed)
    matched, stats = index.match(live)
    share = 100 * stats["matched"] / max(1, stats["live"])
    print(f"  matched {stats['matched']}/{stats['live']} live trips to scheduled trips ({share:.0f}%), "
          f"median gap to schedule {stats['median_abs_delay_s']}s, {stats['via_stop_code']} via stop_code")
    reasons, nearest_gap, examples = index.diagnose(live, matched)
    if reasons:
        print("  why the rest didn't match:")
        for reason, count in reasons.most_common():
            print(f"    {count:5d}  {reason}")
        if nearest_gap is not None:
            print(f"    (where trips exist, the nearest one is a median of {nearest_gap}s away)")
        for line in examples:
            print(f"    e.g. {line}")


def _check(agency_id, trip_updates_url=None):
    """python -m transit.realtime <agency> [trip_updates_url]  - fetch its live feeds and compare trip ids
    with the static GTFS from agency_setup, so you know the live data will actually line up."""
    import csv
    from pathlib import Path

    agency = agencies.get(agency_id)
    if agency is None:
        raise SystemExit(f"Unknown agency {agency_id!r}. Known: {', '.join(agencies.AGENCIES)}")
    if gtfs_realtime_pb2 is None:
        raise SystemExit("Install gtfs-realtime-bindings first (pip install gtfs-realtime-bindings).")

    urls = {"trip updates": trip_updates_url or TRIP_UPDATE_URLS.get(agency.id), "vehicles": VEHICLE_URLS.get(agency.id),
            "alerts": ALERT_URLS.get(agency.id)}
    if not any(urls.values()):
        raise SystemExit(f"{agency.label}: no GTFS-RT links yet. Add trip_updates_url= / vehicles_url= / "
                         f"alerts_url= to its Agency(...) entry in agencies.py.")

    static_trips = set()
    trips_file = agencies.TRANSIT_DATA / "GTFS_Files" / agency.id / "trips.txt"
    if trips_file.is_file():
        with trips_file.open(encoding="utf-8-sig", newline="") as file:
            static_trips = {row.get("trip_id") for row in csv.DictReader(file)}
        days_old = (time.time() - trips_file.stat().st_mtime) / 86400
        print(f"static feed on disk: {len(static_trips)} trips, downloaded {days_old:.0f} days ago "
              f"(agency_setup {agency.id} --redownload fetches a fresh copy)")
    else:
        print(f"(no {trips_file.name} for {agency.id} yet - run agency_setup first to check trip ids)")

    for name, url in urls.items():
        if not url:
            continue
        started, response = time.monotonic(), None
        try:
            rheaders = dict(REQUEST_HEADERS)
            key=KEYS[agency_id]["key"] if agency_id in KEYS else None
            if key:
                rheaders[KEYS[agency_id]["header"]] = key

            response = net.get(url, headers=rheaders, timeout=15)
            response.raise_for_status()
            feed = gtfs_realtime_pb2.FeedMessage()
            feed.ParseFromString(response.content)
        except Exception as error:
            print(f"{name}: FAILED {url}\n  {type(error).__name__}: {error}")
            if response is not None:
                print(f"  HTTP {response.status_code}, {response.headers.get('content-type')}, "
                      f"{len(response.content)} bytes, starts with {response.content[:80]!r}")
                if response.status_code == 403:
                    print(f"  (sent User-Agent: {REQUEST_HEADERS['User-Agent'][:60]}... - if it is still 403, "
                          f"set GTFS_RT_USER_AGENT to your browser's User-Agent string)")
            continue
        fetch_seconds = time.monotonic() - started
        age = int(time.time()) - int(feed.header.timestamp) if feed.header.timestamp else None
        line = (f"{name}: {len(feed.entity)} entities" + (f", {age}s old" if age is not None else "")
                + f", fetched in {fetch_seconds:.1f}s")
        if fetch_seconds > REQUEST_TIMEOUT:
            line += f"  <-- slower than REQUEST_TIMEOUT ({REQUEST_TIMEOUT:g}s): the live poller would drop it"
        if name == "trip updates" and static_trips:
            ids = {e.trip_update.trip.trip_id for e in feed.entity if e.HasField("trip_update")}
            hits = len(ids & static_trips)
            line += f", {hits}/{len(ids)} trip ids match the static feed"
            if agency.match_live_by_time:
                line += " (not needed: matching by route+stop+time)"
            elif ids and hits < len(ids) / 2:
                line += "  <-- most don't match; try match_live_by_time=True on the agency entry"
        print(line)
        if name == "trip updates" and agency.match_live_by_time:
            _report_time_match(agency, feed)
        if name == "trip updates" and static_trips and ids and hits < len(ids) / 2 and not agency.match_live_by_time:
            print(f"  live ids e.g.   {', '.join(sorted(ids)[:4])}")
            print(f"  static ids e.g. {', '.join(sorted(map(str, static_trips))[:4])}")
            from google.protobuf.text_format import MessageToString
            sample = next(e.trip_update for e in feed.entity if e.HasField("trip_update"))
            print(f"  live trip descriptor: {MessageToString(sample.trip, as_one_line=True)}")
            if sample.stop_time_update:
                print(f"  first live stop update: {MessageToString(sample.stop_time_update[0], as_one_line=True)}")
            with trips_file.open(encoding="utf-8-sig", newline="") as file:
                print(f"  first static trips.txt row: {dict(next(csv.DictReader(file)))}")


if __name__ == "__main__":
    import sys

    if len(sys.argv) not in (2, 3):
        raise SystemExit("usage: python -m transit.realtime <agency> [trip_updates_url]")
    _check(sys.argv[1], sys.argv[2] if len(sys.argv) == 3 else None)
