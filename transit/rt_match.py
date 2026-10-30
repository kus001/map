"""Match live trips that carry no usable static trip_id to the static schedule.

Some GTFS-RT feeds (TTC's) send every trip as ``schedule_relationship: NEW`` with an
internal id such as ``-1186451188`` that appears nowhere in the static feed. All they give
us is the route and an absolute predicted time at each stop. So we find the scheduled trip
that serves the same route and stop at (nearly) that time on a day it runs.

Turn it on with ``match_live_by_time=True`` on the agency's entry in agencies.py. The lookup
table is built once from transit_data/GTFS_Files/<id> (in the background, so the server
starts normally) and saved to transit_data/.rt_match/<id>.sqlite.
"""
import csv
import sqlite3
import statistics
import threading
from collections import Counter
from datetime import datetime, time as _time, timedelta
from zoneinfo import ZoneInfo

from . import agencies

TZ = ZoneInfo("America/Toronto")
LATE_SECONDS = 20 * 60    # live time can be this much after the scheduled departure
EARLY_SECONDS = 3 * 60    # ... or this much before it

SCHEMA_VERSION = 2

_lock = threading.Lock()
_indexes = {}
_building = set()


def _folder(agency_id):
    return agencies.TRANSIT_DATA / "GTFS_Files" / agency_id


def _db_path(agency_id):
    return agencies.TRANSIT_DATA / ".rt_match" / f"{agency_id}.sqlite"


def _rows(path):
    if not path.is_file():
        return
    with path.open(encoding="utf-8-sig", newline="", errors="replace") as file:
        yield from csv.DictReader(file)


def _seconds(text):
    h, m, s = (int(part) for part in text.strip().split(":"))
    return h * 3600 + m * 60 + s


def _fresh(agency_id):
    db, trips = _db_path(agency_id), _folder(agency_id) / "trips.txt"
    if not (db.is_file() and trips.is_file() and db.stat().st_mtime >= trips.stat().st_mtime):
        return False
    try:
        con = sqlite3.connect(str(db))
        version = con.execute("PRAGMA user_version").fetchone()[0]
        con.close()
    except sqlite3.Error:
        return False
    return version == SCHEMA_VERSION


def build(agency_id):
    """Create the lookup table from the agency's static GTFS (one-time, SQLite does the sorting)."""
    folder, path = _folder(agency_id), _db_path(agency_id)
    for name in ("trips.txt", "stop_times.txt", "stops.txt", "routes.txt"):
        if not (folder / name).is_file():
            raise FileNotFoundError(folder / name)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.unlink(missing_ok=True)

    db = sqlite3.connect(str(tmp))
    db.execute("PRAGMA journal_mode=OFF")
    db.execute("PRAGMA synchronous=OFF")
    db.execute("CREATE TABLE trips (id INTEGER PRIMARY KEY, trip_id TEXT, route TEXT, service TEXT)")
    db.execute("CREATE TABLE times (stop TEXT, dep INTEGER, trip INTEGER)")
    db.execute("CREATE TABLE stops (stop_id TEXT, stop_code TEXT)")
    db.execute("CREATE TABLE routes (route_id TEXT, short_name TEXT)")
    db.execute("CREATE TABLE cal (service TEXT, days TEXT, start TEXT, end TEXT)")
    db.execute("CREATE TABLE exc (service TEXT, day TEXT, kind INTEGER)")

    number = {}
    db.executemany("INSERT INTO trips VALUES (?,?,?,?)", (
        (number.setdefault(r["trip_id"], len(number)), r["trip_id"], r.get("route_id", ""), r.get("service_id", ""))
        for r in _rows(folder / "trips.txt") if r.get("trip_id") not in number))
    db.executemany("INSERT INTO stops VALUES (?,?)",
                   ((r["stop_id"], (r.get("stop_code") or "").strip()) for r in _rows(folder / "stops.txt")))
    db.executemany("INSERT INTO routes VALUES (?,?)", ((r["route_id"], (r.get("route_short_name") or "").strip())
                                                       for r in _rows(folder / "routes.txt")))
    db.executemany("INSERT INTO cal VALUES (?,?,?,?)", (
        (r["service_id"], "".join(r.get(d, "0") for d in
                                  "monday tuesday wednesday thursday friday saturday sunday".split()),
         r["start_date"], r["end_date"]) for r in _rows(folder / "calendar.txt")))
    db.executemany("INSERT INTO exc VALUES (?,?,?)", (
        (r["service_id"], r["date"], int(r["exception_type"])) for r in _rows(folder / "calendar_dates.txt")))

    batch = []
    for r in _rows(folder / "stop_times.txt"):
        trip = number.get(r.get("trip_id"))
        text = r.get("departure_time") or r.get("arrival_time")
        if trip is None or not text:
            continue
        try:
            batch.append((r["stop_id"], _seconds(text), trip))
        except (KeyError, ValueError):
            continue
        if len(batch) >= 50000:
            db.executemany("INSERT INTO times VALUES (?,?,?)", batch)
            batch.clear()
    if batch:
        db.executemany("INSERT INTO times VALUES (?,?,?)", batch)
    db.execute("CREATE INDEX times_stop_dep ON times(stop, dep)")
    db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
    db.commit()
    db.close()
    tmp.replace(path)


class Index:
    def __init__(self, agency_id):
        self.db = sqlite3.connect(str(_db_path(agency_id)), check_same_thread=False)
        self._query_lock = threading.Lock()
        self.stop_ids = {s for (s,) in self.db.execute("SELECT stop_id FROM stops")}
        self.code_to_id = {code: sid for sid, code in self.db.execute("SELECT stop_id, stop_code FROM stops") if code}
        self.routes = {}  # what a live feed may call a route -> static route_ids (route_id or short name)
        for route_id, short in self.db.execute("SELECT route_id, short_name FROM routes"):
            self.routes.setdefault(route_id, set()).add(route_id)
            if short:
                self.routes.setdefault(short, set()).add(route_id)
        self.calendar = {s: (d, a, b) for s, d, a, b in self.db.execute("SELECT * FROM cal")}
        self.exceptions = {(s, d): k for s, d, k in self.db.execute("SELECT * FROM exc")}
        self._active = {}

    def route_ids(self, live_route):
        return self.routes.get(str(live_route), set())

    def static_stop(self, live_stop, mode=None):
        """Live feeds may send a stop_id or the public stop_code; mode picks one, None tries id then code."""
        live_stop = str(live_stop)
        if mode in (None, "id") and live_stop in self.stop_ids:
            return live_stop
        if mode in (None, "code"):
            return self.code_to_id.get(live_stop)
        return None

    def _service_active(self, service, day):
        key = (service, day)
        if key not in self._active:
            stamp = day.strftime("%Y%m%d")
            kind = self.exceptions.get((service, stamp))
            if kind is not None:
                active = kind == 1
            else:
                days, start, end = self.calendar.get(service, ("0000000", "99999999", "00000000"))
                active = start <= stamp <= end and days[day.weekday()] == "1"
            self._active[key] = active
        return self._active[key]

    def _scan(self, routes, stops, epoch, before, after):
        """[(delay, service_active, trip_id)] for scheduled trips on ``routes`` at ``stops`` whose
        departure is within [epoch - before, epoch + after]; delay = live time - scheduled time."""
        if not routes or not stops:
            return []
        found = []
        local_day = datetime.fromtimestamp(epoch, TZ).date()
        marks_r, marks_s = ",".join("?" * len(routes)), ",".join("?" * len(stops))
        for offset in (0, -1):          # after-midnight trips belong to the previous service day
            day = local_day + timedelta(days=offset)
            midnight = datetime.combine(day, _time(0), TZ).timestamp()
            seconds = epoch - midnight
            with self._query_lock:
                rows = self.db.execute(
                    "SELECT t.trip_id, t.service, x.dep FROM times x JOIN trips t ON t.id = x.trip "
                    f"WHERE x.stop IN ({marks_s}) AND t.route IN ({marks_r}) AND x.dep BETWEEN ? AND ?",
                    (*stops, *routes, seconds - before, seconds + after)).fetchall()
            for trip_id, service, dep in rows:
                found.append((seconds - dep, self._service_active(service, day), trip_id))
        return found

    def _anchors(self, stops):
        """First few (live_stop, epoch) pairs that have a time and a stop we know (as id or code)."""
        return [(s, t) for s, t in stops if t and self.static_stop(s)][:4]

    def match(self, live_trips):
        """live_trips: [(live_id, route_id, [(live_stop_id, epoch), ...])].
        Returns ({live_id: (static_trip_id, delay_seconds, stop_mode)}, stats). Each static trip is used once."""
        stats = {"live": len(live_trips), "matched": 0, "no_route_or_time": 0,
                 "unknown_stop": 0, "no_scheduled_trip": 0}
        options = []
        for live_id, route, stops in live_trips:
            if not route or not any(t for _, t in stops):
                stats["no_route_or_time"] += 1
                continue
            anchors = self._anchors(stops)
            if not anchors:
                stats["unknown_stop"] += 1
                continue
            routes, found = self.route_ids(route), False
            for stop, epoch in anchors:          # try the next stop if this one has nothing nearby
                for mode in ("id", "code"):
                    sid = self.static_stop(stop, mode)
                    for delay, active, trip_id in self._scan(routes, [sid] if sid else [], epoch,
                                                             LATE_SECONDS, EARLY_SECONDS):
                        if active:
                            options.append((abs(delay), delay, live_id, trip_id, mode))
                            found = True
                if found:
                    break
            if not found:
                stats["no_scheduled_trip"] += 1

        matched, taken = {}, set()
        for cost, delay, live_id, trip_id, mode in sorted(options):
            if live_id in matched or trip_id in taken:
                continue
            matched[live_id] = (trip_id, delay, mode)
            taken.add(trip_id)
        stats["matched"] = len(matched)
        stats["via_stop_code"] = sum(1 for _, _, mode in matched.values() if mode == "code")
        stats["median_abs_delay_s"] = (int(statistics.median(abs(d) for _, d, _ in matched.values()))
                                       if matched else None)
        return matched, stats

    def diagnose(self, live_trips, matched, sample=400):
        """Why did live trips not match? Returns (Counter of reasons, median gap to nearest scheduled
        trip in seconds, a few example lines)."""
        reasons, gaps, examples = Counter(), [], []
        for live_id, route, stops in [t for t in live_trips if t[0] not in matched][:sample]:
            routes = self.route_ids(route)
            anchors = self._anchors(stops)
            if not route or not any(t for _, t in stops):
                reason = "live trip has no route or no times"
            elif not routes:
                reason = "route not in routes.txt (by route_id or short name)"
            elif not anchors:
                reason = "stop id not in stops.txt (by stop_id or stop_code)"
            else:
                stop, epoch = anchors[0]
                sids = [s for s in (self.static_stop(stop, "id"), self.static_stop(stop, "code")) if s]
                near = self._scan(routes, sids, epoch, 3 * 3600, 3 * 3600)
                if not near:
                    with self._query_lock:
                        ever = self.db.execute(
                            "SELECT 1 FROM times x JOIN trips t ON t.id = x.trip WHERE x.stop IN (%s) "
                            "AND t.route IN (%s) LIMIT 1" % (",".join("?" * len(sids)), ",".join("?" * len(routes))),
                            (*sids, *routes)).fetchone()
                    reason = ("no scheduled trip within 3h of that time" if ever
                              else "that route never serves that stop in the schedule")
                elif not any(active for _, active, _ in near):
                    reason = "trips exist but their service isn't running that day (calendar)"
                else:
                    gaps.append(min(abs(d) for d, active, _ in near if active))
                    reason = "scheduled trips exist but none within the time window"
            reasons[reason] += 1
            if len(examples) < 3 and reason != "scheduled trips exist but none within the time window":
                examples.append(f"live route={route!r} first stop={stops[0][0] if stops else None!r}: {reason}")
        return reasons, (int(statistics.median(gaps)) if gaps else None), examples


def get_index(agency_id, block=False):
    """The agency's matcher, or None while its lookup table is still being built."""
    with _lock:
        index = _indexes.get(agency_id)
        if index is not None:
            return index
        if agency_id in _building and not block:
            return None
        if not _fresh(agency_id):
            if block:
                print(f"Building live-match table for {agency_id} (one time, may take a minute)...", flush=True)
                build(agency_id)
            else:
                _building.add(agency_id)

                def work():
                    try:
                        build(agency_id)
                        index = Index(agency_id)
                        with _lock:
                            _indexes[agency_id] = index
                    except Exception as error:
                        print(f"live-match table for {agency_id} failed: {error}", flush=True)
                    finally:
                        with _lock:
                            _building.discard(agency_id)

                threading.Thread(target=work, name=f"rt-match-{agency_id}", daemon=True).start()
                return None
        _indexes[agency_id] = Index(agency_id)
        return _indexes[agency_id]
