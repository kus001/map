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
from datetime import date as _date, datetime, time as _time, timedelta
from zoneinfo import ZoneInfo

from helpers._transit import agencies

TZ = ZoneInfo("America/Toronto")
LATE_SECONDS = 20 * 60    # live time can be this much after the scheduled departure
EARLY_SECONDS = 3 * 60    # ... or this much before it

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
    return db.is_file() and trips.is_file() and db.stat().st_mtime >= trips.stat().st_mtime


def build(agency_id):
    """Create the lookup table from the agency's static GTFS (one-time, SQLite does the sorting)."""
    folder, path = _folder(agency_id), _db_path(agency_id)
    for name in ("trips.txt", "stop_times.txt", "stops.txt"):
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
    db.execute("CREATE TABLE cal (service TEXT, days TEXT, start TEXT, end TEXT)")
    db.execute("CREATE TABLE exc (service TEXT, day TEXT, kind INTEGER)")

    number = {}
    db.executemany("INSERT INTO trips VALUES (?,?,?,?)", (
        (number.setdefault(r["trip_id"], len(number)), r["trip_id"], r.get("route_id", ""), r.get("service_id", ""))
        for r in _rows(folder / "trips.txt") if r.get("trip_id") not in number))
    db.executemany("INSERT INTO stops VALUES (?,?)",
                   ((r["stop_id"], (r.get("stop_code") or "").strip()) for r in _rows(folder / "stops.txt")))
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
    db.commit()
    db.close()
    tmp.replace(path)


class Index:
    def __init__(self, agency_id):
        self.db = sqlite3.connect(str(_db_path(agency_id)), check_same_thread=False)
        self._query_lock = threading.Lock()
        self.stop_ids = {s for (s,) in self.db.execute("SELECT stop_id FROM stops")}
        self.code_to_id = {code: sid for sid, code in self.db.execute("SELECT stop_id, stop_code FROM stops")
                           if code and code not in self.stop_ids}
        self.calendar = {s: (d, a, b) for s, d, a, b in self.db.execute("SELECT * FROM cal")}
        self.exceptions = {(s, d): k for s, d, k in self.db.execute("SELECT * FROM exc")}
        self._active = {}

    def static_stop(self, live_stop):
        live_stop = str(live_stop)
        if live_stop in self.stop_ids:
            return live_stop
        return self.code_to_id.get(live_stop)

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

    def _candidates(self, route, stop, epoch):
        """(cost, delay, static_trip_id) for scheduled trips near ``epoch`` at ``stop`` on ``route``."""
        found = []
        local_day = datetime.fromtimestamp(epoch, TZ).date()
        for offset in (0, -1):          # after-midnight trips belong to the previous service day
            day = local_day + timedelta(days=offset)
            midnight = datetime.combine(day, _time(0), TZ).timestamp()
            seconds = epoch - midnight
            with self._query_lock:
                rows = self.db.execute(
                    "SELECT t.trip_id, t.service, x.dep FROM times x JOIN trips t ON t.id = x.trip "
                    "WHERE x.stop = ? AND t.route = ? AND x.dep BETWEEN ? AND ?",
                    (stop, route, seconds - LATE_SECONDS, seconds + EARLY_SECONDS)).fetchall()
            for trip_id, service, dep in rows:
                if self._service_active(service, day):
                    delay = seconds - dep
                    found.append((abs(delay), delay, trip_id))
        return found

    def match(self, live_trips):
        """live_trips: [(live_id, route_id, [(live_stop_id, epoch), ...])].
        Returns ({live_id: (static_trip_id, delay_seconds)}, stats). Each static trip is used once."""
        stats = {"live": len(live_trips), "matched": 0, "no_route_or_time": 0,
                 "unknown_stop": 0, "no_scheduled_trip": 0}
        options = []
        for live_id, route, stops in live_trips:
            anchor = next(((self.static_stop(s), t) for s, t in stops if t and self.static_stop(s)), None)
            if not route or not stops or not any(t for _, t in stops):
                stats["no_route_or_time"] += 1
            elif anchor is None:
                stats["unknown_stop"] += 1
            else:
                found = self._candidates(str(route), anchor[0], anchor[1])
                if not found:
                    stats["no_scheduled_trip"] += 1
                options.extend((cost, delay, live_id, trip_id) for cost, delay, trip_id in found)

        matched, taken = {}, set()
        for cost, delay, live_id, trip_id in sorted(options):
            if live_id in matched or trip_id in taken:
                continue
            matched[live_id] = (trip_id, delay)
            taken.add(trip_id)
        stats["matched"] = len(matched)
        stats["median_abs_delay_s"] = (int(statistics.median(abs(d) for _, d in matched.values()))
                                       if matched else None)
        return matched, stats


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
