"""Import an own-cache agency's schedule once; normal route requests only read the compact cache.

    python -m helpers._transit.agency_setup ttc                 # download + build
    python -m helpers._transit.agency_setup ttc --zip feed.zip  # use a local zip or folder
    python -m helpers._transit.agency_setup ttc --shapes-only   # add route geometry only
"""
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

from helpers._transit.agencies import AGENCIES, OWN_CACHE_AGENCIES, Agency
from helpers._transit.compact import CompactTrips, TripPools
from helpers._transit.make_graph import Graph, GTFS_ROOT
from helpers.distance import find_dist
from helpers.time_management import time_to_seconds

FIELDS = "monday tuesday wednesday thursday friday saturday sunday".split()


def _agency(agency) -> Agency:
    found = agency if isinstance(agency, Agency) else AGENCIES.get(str(agency))
    if found is None:
        raise ValueError(f"Unknown agency: {agency}")
    if not found.own_cache:
        raise ValueError(f"{found.id} is built into the shared startup graph by "
                         "helpers/_transit/make_graph.py, not by agency_setup")
    return found


def rows(path):
    with path.open(encoding="utf-8-sig", newline="", errors="replace") as f:
        yield from csv.DictReader(f)


def _grid_key(lat, lon):
    return int(math.floor(lat / .001)), int(math.floor(lon / .001))


def build_agency(agency, folder, target=None):
    """Build from a GTFS folder. SQLite does the large sort, not Python RAM."""
    agency = _agency(agency)
    pre = agency.prefix
    folder, target = Path(folder), Path(target or agency.cache_path)
    for name in ("stops.txt", "routes.txt", "trips.txt", "stop_times.txt"):
        if not (folder / name).exists():
            raise FileNotFoundError(folder / name)

    graph, stops, grid = {}, {}, {}
    for row in rows(folder / "stops.txt"):
        try:
            sid = pre + row["stop_id"]
            pos = (float(row["stop_lat"]), float(row["stop_lon"]))
        except (ValueError, KeyError):
            continue
        stops[sid] = (*pos, row.get("stop_name", ""))
        x, y = _grid_key(*pos)
        close = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                close.extend(grid.get((x + dx, y + dy), ()))

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
            cal[pre + r["service_id"]] = {
                "days": [r.get(day) == "1" for day in FIELDS],
                "start": datetime.strptime(r["start_date"], "%Y%m%d").date(),
                "end": datetime.strptime(r["end_date"], "%Y%m%d").date(),
            }
    if (folder / "calendar_dates.txt").exists():
        for r in rows(folder / "calendar_dates.txt"):
            dates[(pre + r["service_id"], r["date"])] = int(r["exception_type"])


    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f"{agency.id}_build_") as temp:
        db = sqlite3.connect(str(Path(temp) / "gtfs.sqlite"))
        db.execute("PRAGMA journal_mode=OFF")
        db.execute("PRAGMA synchronous=OFF")
        db.execute("CREATE TABLE trips (id TEXT PRIMARY KEY, route TEXT, headsign TEXT)")
        batch = []
        for r in rows(folder / "trips.txt"):
            original_id = r["trip_id"]
            trip_service[pre + original_id] = pre + r["service_id"]
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
                pools.trip_ids.append(pre + trip)
                rkey = (route, headsign)
                rid = route_index.get(rkey)
                if rid is None:
                    rid = len(pools.routes)
                    route_index[rkey] = rid
                    pools.routes.append({"route": route, "headsign": headsign,
                                         "route_color": route_colors.get(route, "")})
                pools.trip_route.append(rid)
            sid = pre + stop
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


def _download(agency):
    GTFS_ROOT.mkdir(parents=True, exist_ok=True)
    path = GTFS_ROOT / f"{agency.id}_download.zip"
    print(f"Downloading {agency.label} GTFS...", flush=True)
    with requests.get(agency.feed_url, stream=True, timeout=(10, 120)) as response:
        response.raise_for_status()
        with path.open("wb") as out:
            for chunk in response.iter_content(512 * 1024):
                if chunk:
                    out.write(chunk)
    return path


def _extract_files(agency, source, target, wanted):
    source, target = Path(source), Path(target)
    target.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        for name in wanted:
            origin = source / name
            if not origin.exists():
                raise FileNotFoundError(origin)
            if origin.resolve() != (target / name).resolve():
                shutil.copy2(origin, target / name)
        return

    with zipfile.ZipFile(source) as archive:
        entries = {Path(name).name: name for name in archive.namelist()
                   if Path(name).name in wanted}
        if not wanted.issubset(entries):
            raise ValueError(f"{agency.label} feed missing: {', '.join(sorted(wanted - entries.keys()))}")
        for name in wanted:
            with archive.open(entries[name]) as src, (target / name).open("wb") as dst:
                shutil.copyfileobj(src, dst)


def install_shapes(agency, source=None):
    """Add route geometry to an existing compact install, without rebuilding it."""
    from helpers._transit import shape_index

    agency = _agency(agency)
    folder = GTFS_ROOT / agency.id
    wanted = {"trips.txt", "routes.txt", "shapes.txt"}
    if source is None and not all((folder / name).is_file() for name in wanted):
        source = _download(agency)
    if source is not None:
        _extract_files(agency, source, folder, wanted)
    if not all((folder / name).is_file() for name in wanted):
        raise FileNotFoundError(f"{agency.label} trips.txt, routes.txt and shapes.txt are needed")

    print(f"Building {agency.label} route shapes (one-time, SQLite; no timetable rebuild)...", flush=True)
    path = shape_index.database(agency.id)
    if not path:
        raise RuntimeError(f"{agency.label} shape index could not be built")
    print(f"{agency.label} route shapes ready: {path}", flush=True)
    return path


def install_agency(agency, source=None):
    """Get the agency's GTFS and build its compact schedule and shape index."""
    agency = _agency(agency)
    folder = GTFS_ROOT / agency.id
    if source is None:
        source = _download(agency)
    source = Path(source)
    if source.is_dir():
        timetable_folder = source
    else:
        wanted = {"stops.txt", "routes.txt", "trips.txt", "stop_times.txt"}

        with zipfile.ZipFile(source) as archive:
            available = {Path(name).name for name in archive.namelist()}
        wanted |= {"shapes.txt", "calendar.txt", "calendar_dates.txt"} & available
        _extract_files(agency, source, folder, wanted)
        timetable_folder = folder

    print(f"Building compact {agency.label} timetable (this may take several minutes)...", flush=True)
    num_stops, num_trips = build_agency(agency, timetable_folder)
    if (timetable_folder / "shapes.txt").exists():
        try:
            install_shapes(agency, timetable_folder)
        except (OSError, sqlite3.Error, ValueError, RuntimeError) as error:
            print(f"{agency.label} timetable is ready, but shape import failed: {error}", flush=True)
    print(f"{agency.label} ready: {num_stops:,} stops, {num_trips:,} trips. Restart kmaps.")
    return num_stops, num_trips


if __name__ == "__main__":
    ids = [a.id for a in OWN_CACHE_AGENCIES]
    parser = argparse.ArgumentParser(description="Build an on-demand transit agency cache.")
    parser.add_argument("agency", choices=ids, help="agency id from helpers/_transit/agencies.py")
    parser.add_argument("--zip", help="Local GTFS ZIP or extracted folder")
    parser.add_argument("--shapes-only", action="store_true",
                        help="Add track/road shapes without rebuilding the timetable")
    args = parser.parse_args()
    if args.shapes_only:
        install_shapes(args.agency, args.zip)
    else:
        install_agency(args.agency, args.zip)
