"""ttc bus/streetcar stop lookups, separate from the full subway + surface router."""

import csv
import math
import threading
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from .agencies import TRANSIT_DATA

FOLDER = TRANSIT_DATA / "GTFS_Files" / "ttc_surface"
TZ = ZoneInfo("America/Toronto")
_lock = threading.Lock()
_cache = {"mtime": None, "grid": {}, "stops": {}}


def _load_stops():
    file = FOLDER / "stops.txt"
    if not file.is_file():
        return {}, {}
    mtime = file.stat().st_mtime_ns
    with _lock:
        if _cache["mtime"] == mtime:
            return _cache["grid"], _cache["stops"]
        grid, stops = defaultdict(list), {}
        with file.open(encoding="utf-8-sig", newline="", errors="replace") as data:
            for row in csv.DictReader(data):
                try:
                    lat, lon = float(row["stop_lat"]), float(row["stop_lon"])
                except (TypeError, ValueError, KeyError):
                    continue
                sid = str(row.get("stop_id") or "")
                if not sid:
                    continue
                item = (sid, str(row.get("stop_code") or ""), lat, lon, str(row.get("stop_name") or ""))
                stops[sid] = item
                grid[(int(math.floor(lat * 1000)), int(math.floor(lon * 1000)))].append(item)
        _cache.update(mtime=mtime, grid=dict(grid), stops=stops)
        return _cache["grid"], _cache["stops"]


def closest_stop(lat, lon, name="", max_distance=65):
    grid, _ = _load_stops()
    if not grid:
        return None
    lat, lon = float(lat), float(lon)
    x, y = int(math.floor(lat * 1000)), int(math.floor(lon * 1000))
    best, best_score = None, float("inf")
    wanted = " ".join(name.lower().replace("&", "and").split())
    for dx in (-1, 0, 1):
        for dy in (-2, -1, 0, 1, 2):
            for item in grid.get((x + dx, y + dy), ()):
                distance = math.hypot((item[2] - lat) * 111195, (item[3] - lon) * 111195 * math.cos(math.radians(lat)))
                if distance > max_distance:
                    continue
                label = " ".join(item[4].lower().replace("&", "and").split())
                score = distance * (0.8 if wanted and label and (wanted == label or wanted in label or label in wanted) else 1.0)
                if score < best_score:
                    best, best_score = item, score
    return best


def live_departures(lat, lon, name, predictions, limit=12, now=None):
    """use the surface stop's own live predictions, no fake full-gtfs trip id."""
    stop = closest_stop(lat, lon, name)
    if not stop:
        return []
    now = float(now if now is not None else datetime.now(TZ).timestamp())
    found, seen = [], set()
    for sid in (stop[0], stop[1]):
        for item in predictions.get(sid, ()):
            when = item.get("time")
            if when is None or not now - 90 <= when <= now + 5400:
                continue
            key = (item.get("trip_id"), item.get("route"), int(when))
            if key in seen:
                continue
            seen.add(key)
            local = datetime.fromtimestamp(when, TZ)
            found.append({"trip_id": item.get("trip_id"), "route": item.get("route", ""), "direction": "", "scheduled_time": None, "expected_time": local.strftime("%H:%M"), "minutes_until": round((when - now) / 60), "delay_min": None, "realtime": True, "cancelled": bool(item.get("cancelled")), "status": "Live", "_time": when})
    return sorted(found, key=lambda item: item["_time"])[:limit]


def merge_departures(scheduled, live, limit=8, now=None):
    """keep scheduled subway departures and replace only close, same-route surface entries."""
    now = float(now if now is not None else datetime.now(TZ).timestamp())
    results = [dict(item) for item in scheduled]
    used = set()
    for entry in live:
        route = str(entry.get("route") or "").strip().lower()
        match_idx, best_gap = None, 480
        for i, old in enumerate(results):
            if i in used or str(old.get("route") or "").strip().lower() != route:
                continue
            clock = old.get("expected_time")
            if not clock:
                continue
            try:
                h, m = map(int, clock.split(":"))
                live_time = datetime.fromtimestamp(entry["_time"], TZ)
                expected = live_time.replace(hour=h, minute=m, second=0, microsecond=0)
                gap = abs((live_time - expected).total_seconds())
            except (TypeError, ValueError):
                continue
            if gap < best_gap:
                match_idx, best_gap = i, gap
        if match_idx is None:
            results.append({k: v for k, v in entry.items() if k != "_time"})
        else:
            old = results[match_idx]
            used.add(match_idx)
            # keep the live eta but dont claim the surface trip has the full gtfs trip id
            results[match_idx] = {k: v for k, v in entry.items() if k != "_time"}
    def sort_key(item):
        clock = item.get("expected_time") or "99:99"
        try:
            h, m = map(int, clock.split(":"))
            moment = datetime.fromtimestamp(now, TZ).replace(hour=h, minute=m, second=0, microsecond=0).timestamp()
            if moment < now - 3600:
                moment += 86400
            return moment
        except (ValueError, TypeError):
            return float("inf")
    return sorted(results, key=sort_key)[:limit]


def route_vehicles_near_trip(steps, vehicles, already_selected=()):
    # these are gps buses on the right route, not a guaranteed trip-id match
    from .vehicles import live_vehicle_is_usable
    chosen, seen = [], set(already_selected)
    for step in steps:
        if not isinstance(step, dict) or step.get("type") != "transit" or step.get("agency") != "ttc":
            continue
        route = str(step.get("route") or "").strip().lower().lstrip("0")
        route_id = str(step.get("route_id") or "").strip().lower().lstrip("0")
        coords = [step.get("coordinates"), step.get("to_coordinates")]
        coords += [stop.get("coordinates") for stop in (step.get("stop_list") or [])[:5] if isinstance(stop, dict)]
        points = [(float(pos[0]), float(pos[1])) for pos in coords if isinstance(pos, (list, tuple)) and len(pos) >= 2 and pos[0] is not None and pos[1] is not None]
        if not points or not (route or route_id):
            continue
        matches = []
        for (agency, trip_id), vehicle in vehicles.items():
            if agency != "ttc" or (agency, trip_id) in seen or not live_vehicle_is_usable(vehicle):
                continue
            live_route = str(vehicle.get("route_id") or "").strip().lower().lstrip("0")
            if not live_route or live_route not in (route, route_id):
                continue
            try:
                vlat, vlon = float(vehicle["lat"]), float(vehicle["lon"])
            except (ValueError, TypeError, KeyError):
                continue
            dist = min(math.hypot((vlat - lat) * 111195, (vlon - lon) * 111195 * math.cos(math.radians(lat))) for lat, lon in points)
            if dist < 2500:
                matches.append((dist, (agency, trip_id), vehicle))
        for _, key, vehicle in sorted(matches, key=lambda item: item[0])[:3]:
            chosen.append({**vehicle, "route": step.get("route"), "headsign": None, "position_source": "route_live", "route_live": True, "estimated": False})
            seen.add(key)
    return chosen
