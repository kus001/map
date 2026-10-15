"""Import TTC schedules once; normal route requests only read the compact cache."""
import argparse
import csv
import math
import pickle
import shutil
import sqlite3
import tempfile
import zipfile
from array import array
from datetime import datetime
from pathlib import Path

import requests

from helpers._transit.compact import CompactTrips, TripPools
from helpers._transit.make_graph import Graph, GTFS_ROOT, TRANSIT_DATA
from helpers.distance import find_dist
from helpers.time_management import time_to_seconds

# Toronto Open Data's merged TTC GTFS (subway, streetcars and buses).
TTC_FEED = ("https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/"
            "7795b45e-e65a-4465-81fc-c36b9dfff169/resource/"
            "cfb6b2b8-6191-41e3-bda1-b175c51148cb/download/"
            "TTC%20Routes%20and%20Schedules%20Data.zip")
CACHE = TRANSIT_DATA / "ttc_compact.pkl"
FIELDS = "monday tuesday wednesday thursday friday saturday sunday".split()


def rows(path):
    with path.open(encoding="utf-8-sig", newline="", errors="replace") as f:
        yield from csv.DictReader(f)


def _grid_key(lat, lon):
    return int(math.floor(lat / .001)), int(math.floor(lon / .001))


def build_ttc(folder, target=CACHE):
    """Build from a GTFS folder. SQLite does the large sort, not Python RAM."""
    folder, target = Path(folder), Path(target)
    for name in ("stops.txt", "routes.txt", "trips.txt", "stop_times.txt"):
        if not (folder / name).exists():
            raise FileNotFoundError(folder / name)

    graph, stops, grid = {}, {}, {}
    for row in rows(folder / "stops.txt"):
        try:
            sid = "ttc:" + row["stop_id"]
            pos = (float(row["stop_lat"]), float(row["stop_lon"]))
        except (ValueError, KeyError):
            continue
        stops[sid] = (*pos, row.get("stop_name", ""))
        x, y = _grid_key(*pos)
        close = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                close.extend(grid.get((x + dx, y + dy), ()))
        # Connect nearby TTC platforms/stops without a full all-stops scan.
        for other in close[:80]:
            m = find_dist(pos, stops[other][:2])
            if 8 < m <= 110:
                mins = m / 75.0
                graph.setdefault(sid, {}).setdefault(other, {})["__walk__"] = [{"distance": mins}]
                graph.setdefault(other, {}).setdefault(sid, {})["__walk__"] = [{"distance": mins}]
        grid.setdefault((x, y), []).append(sid)

    route_names = {}
    route_colors = {}
    for r in rows(folder / "routes.txt"):
        name = r.get("route_short_name") or r.get("route_long_name") or r["route_id"]
        route_names[r["route_id"]] = name
        route_colors[name] = r.get("route_color", "")

    cal, dates, trip_service = {}, {}, {}
    if (folder / "calendar.txt").exists():
        for r in rows(folder / "calendar.txt"):
            cal["ttc:" + r["service_id"]] = {
                "days": [r.get(day) == "1" for day in FIELDS],
                "start": datetime.strptime(r["start_date"], "%Y%m%d").date(),
                "end": datetime.strptime(r["end_date"], "%Y%m%d").date(),
            }
    if (folder / "calendar_dates.txt").exists():
        for r in rows(folder / "calendar_dates.txt"):
            dates[("ttc:" + r["service_id"], r["date"])] = int(r["exception_type"])

    # Disk-backed sort avoids creating a 100s-of-MB stop_times dictionary.
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ttc_build_") as temp:
        db = sqlite3.connect(str(Path(temp) / "gtfs.sqlite"))
        db.execute("PRAGMA journal_mode=OFF")
        db.execute("PRAGMA synchronous=OFF")
        db.execute("CREATE TABLE trips (id TEXT PRIMARY KEY, route TEXT, headsign TEXT)")
        batch = []
        for r in rows(folder / "trips.txt"):
            original_id = r["trip_id"]
            trip_service["ttc:" + original_id] = "ttc:" + r["service_id"]
            batch.append((original_id, route_names.get(r["route_id"], r["route_id"]), r.get("trip_headsign", "")))
            if len(batch) == 10000:
                db.executemany("INSERT OR REPLACE INTO trips VALUES (?,?,?)", batch)
                batch.clear()
        if batch:
            db.executemany("INSERT OR REPLACE INTO trips VALUES (?,?,?)", batch)
        db.execute("CREATE TABLE times (trip TEXT, seq INTEGER, stop TEXT, dep INTEGER, arr INTEGER)")
        batch = []
        for r in rows(folder / "stop_times.txt"):
            try:
                batch.append((r["trip_id"], int(r["stop_sequence"]), r["stop_id"],
                              time_to_seconds(r["departure_time"]), time_to_seconds(r["arrival_time"])))
            except (KeyError, ValueError):
                continue
            if len(batch) >= 20000:
                db.executemany("INSERT INTO times VALUES (?,?,?,?,?)", batch)
                batch.clear()
        if batch:
            db.executemany("INSERT INTO times VALUES (?,?,?,?,?)", batch)
        db.commit()
        db.execute("CREATE INDEX times_trip_order ON times(trip,seq)")
        pools = TripPools()
        trip_index, route_index = {}, {}
        current_trip, last = None, None
        query = """SELECT t.trip, t.stop, t.dep, t.arr, p.route, p.headsign
                   FROM times t JOIN trips p ON t.trip=p.id
                   ORDER BY t.trip,t.seq"""
        for trip, stop, dep, arr, route, headsign in db.execute(query):
            if trip != current_trip:
                current_trip, last = trip, None
                tid = len(pools.trip_ids)
                trip_index[trip] = tid
                pools.trip_ids.append("ttc:" + trip)
                rkey = (route, headsign)
                rid = route_index.get(rkey)
                if rid is None:
                    rid = len(pools.routes)
                    route_index[rkey] = rid
                    pools.routes.append({"route": route, "headsign": headsign,
                                         "route_color": route_colors.get(route, "")})
                pools.trip_route.append(rid)
            sid = "ttc:" + stop
            if sid not in stops:
                last = None
                continue
            if last is not None and last[0] != sid:
                from_stop, last_dep = last
                edge = graph.setdefault(from_stop, {}).setdefault(sid, {})
                packed = edge.get(route)
                if packed is None:
                    packed = [array("i"), array("i"), array("i"), array("f")]
                    edge[route] = packed
                packed[0].append(last_dep)
                packed[1].append(arr)
                packed[2].append(tid)
                packed[3].append(max(0.0, (arr - last_dep) / 60))
            last = sid, dep
        db.close()

    # Timetables need departure order for binary-search routing.
    for neighbors in graph.values():
        for options in neighbors.values():
            for name, packed in list(options.items()):
                if name == "__walk__":
                    continue
                deps, arrs, tids, dists = packed
                order = sorted(range(len(deps)), key=deps.__getitem__)
                options[name] = CompactTrips(
                    array("i", (deps[i] for i in order)),
                    array("i", (arrs[i] for i in order)),
                    array("i", (tids[i] for i in order)),
                    array("f", (dists[i] for i in order)), pools
                )

    destination = target.with_suffix(".tmp")
    with destination.open("wb") as f:
        pickle.dump(Graph(graph, stops, trip_service, cal, dates), f, protocol=pickle.HIGHEST_PROTOCOL)
    destination.replace(target)
    return len(stops), len(trip_service)


def install_ttc(source=None):
    """Get TTC GTFS and build cache. Never called automatically by Flask."""
    folder = GTFS_ROOT / "ttc"
    if source is None:
        GTFS_ROOT.mkdir(parents=True, exist_ok=True)
        path = GTFS_ROOT / "ttc_download.zip"
        print("Downloading TTC GTFS (one-time setup, may be ~85 MB)...", flush=True)
        with requests.get(TTC_FEED, stream=True, timeout=(10, 120)) as response:
            response.raise_for_status()
            with path.open("wb") as out:
                for chunk in response.iter_content(512 * 1024):
                    if chunk:
                        out.write(chunk)
        source = path
    source = Path(source)
    if source.is_dir():
        folder = source
    else:
        with zipfile.ZipFile(source) as z:
            # Some TTC exports contain a directory wrapper.
            entries = {Path(name).name: name for name in z.namelist() if Path(name).name.endswith(".txt")}
            required = {"stops.txt", "routes.txt", "trips.txt", "stop_times.txt"}
            if not required.issubset(entries):
                raise ValueError("This ZIP isn't a TTC GTFS timetable.")
            folder.mkdir(parents=True, exist_ok=True)
            for name, member in entries.items():
                with z.open(member) as src, (folder / name).open("wb") as out:
                    shutil.copyfileobj(src, out)
    print("Building compact TTC timetable (this may take several minutes)...", flush=True)
    num_stops, num_trips = build_ttc(folder)
    print(f"TTC ready: {num_stops:,} stops, {num_trips:,} trips. Restart kmaps.")
    return num_stops, num_trips


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--zip", help="Local TTC GTFS ZIP, if you've downloaded it already")
    args = parser.parse_args()
    install_ttc(args.zip)
