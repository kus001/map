"""Keeps the GTFS timetables from going stale.

A timetable stops working the day after its last scheduled service day: every search then
finds no trips and the router answers "No transit departure found". This module watches
each agency's coverage and, before (or right after) it runs out, re-downloads the feed,
rebuilds that agency's cache and hot-swaps it into the running server.

Coverage = the latest date on which the feed schedules any service. That is the later of
  - the largest calendar.txt end_date of a service that runs on at least one weekday, and
  - the latest calendar_dates.txt date added with exception_type=1
(several feeds, e.g. GRT, GO, MiWay and Brampton, publish only calendar_dates.txt).

Each check:
  * agency "expired"   -> last service day is before today
  * agency "expiring"  -> last service day is fewer than GTFS_REFRESH_AHEAD_DAYS away
  Either way the feed is re-downloaded, but not more often than every
  GTFS_RETRY_EXPIRED_HOURS / GTFS_RETRY_EXPIRING_HOURS, because the publisher may not have
  posted a newer feed yet. The rebuild runs in a child process (python -m
  transit.agency_setup <id> --redownload) so its memory is returned afterwards, and the old
  cache stays in use if the download or build fails.

Environment switches: GTFS_AUTO_REFRESH=0 turns it off; see config.py for the rest.
Run one pass by hand with:  python -m transit.freshness [--status | --force]
"""

import json
import subprocess
import sys
import threading
import time
from datetime import date, datetime

from . import agencies, store
from .config import (
    GTFS_AUTO_REFRESH,
    GTFS_CHECK_INTERVAL_SECONDS,
    GTFS_REBUILD_TIMEOUT_SECONDS,
    GTFS_REFRESH_AHEAD_DAYS,
    GTFS_RETRY_EXPIRED_HOURS,
    GTFS_RETRY_EXPIRING_HOURS,
    TRANSIT_TIMEZONE,
)
from .timeutil import gtfs_service_clock

PROJECT_ROOT = agencies.TRANSIT_DATA.parent
STATE_PATH = agencies.TRANSIT_DATA / ".gtfs_refresh.json"
STARTUP_DELAY_SECONDS = 20

_state_lock = threading.Lock()
_run_lock = threading.Lock()
_worker_lock = threading.Lock()
_worker_started = False


def service_today() -> date:
    """Today's GTFS service date (before 4 am it is still yesterday's service day)."""
    return gtfs_service_clock(datetime.now(TRANSIT_TIMEZONE))[0]


def last_service_date(agency, data=None) -> date | None:
    """Latest day this agency's loaded timetable schedules service, or None if it has no calendar data."""
    data = data if data is not None else store._data
    if data is None:
        return None
    prefix = agency.prefix

    last_end = None
    for service_id, entry in data.calendar.items():
        if service_id.startswith(prefix) and any(entry["days"]):
            if last_end is None or entry["end"] > last_end:
                last_end = entry["end"]

    # "YYYYMMDD" strings sort chronologically, so only the winner needs parsing
    last_added = max(
        (day for (service_id, day), kind in data.calendar_dates.items()
         if kind == 1 and service_id.startswith(prefix)),
        default=None,
    )
    if last_added is not None:
        added = datetime.strptime(last_added, "%Y%m%d").date()
        if last_end is None or added > last_end:
            last_end = added
    return last_end


def agency_status(agency, today=None, data=None) -> dict | None:
    """{agency, label, last_service, days_left, expired, expiring}; None if coverage is unknown."""
    last = last_service_date(agency, data)
    if last is None:
        return None
    today = today or service_today()
    days_left = (last - today).days
    return {
        "agency": agency.id,
        "label": agency.label,
        "last_service": last,
        "days_left": days_left,
        "expired": days_left < 0,
        "expiring": days_left < GTFS_REFRESH_AHEAD_DAYS,
    }


def all_statuses(today=None) -> list[dict]:
    found = []
    for agency in agencies.OWN_CACHE_AGENCIES:
        if not agency.cache_path.exists():
            continue
        status = agency_status(agency, today)
        if status is not None:
            found.append(status)
    return found


def expired_labels() -> list[str]:
    """Names of agencies whose timetable has already run out (for error messages)."""
    if store._data is None:
        return []
    return sorted({s["label"] for s in all_statuses() if s["expired"]})


def expired_note() -> str:
    labels = expired_labels()
    if not labels:
        return ""
    names = ", ".join(labels)
    if GTFS_AUTO_REFRESH:
        return f" The {names} timetable has expired; a fresh copy is being downloaded automatically."
    return f" The {names} timetable has expired; re-download it with python -m transit.agency_setup <id> --redownload."


# ---- attempt bookkeeping (so a publisher that has nothing newer isn't retried constantly) ----

def _read_state() -> dict:
    try:
        return json.loads(STATE_PATH.read_text())
    except (OSError, ValueError):
        return {}


def _write_state(state: dict) -> None:
    try:
        tmp = STATE_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=1, sort_keys=True))
        tmp.replace(STATE_PATH)
    except OSError as error:
        print(f"[gtfs] could not save refresh state: {error}", flush=True)


def _record_attempt(agency_id: str, ok: bool, detail: str = "") -> None:
    with _state_lock:
        state = _read_state()
        state[agency_id] = {"attempted_at": time.time(), "ok": ok, "detail": detail[-300:]}
        _write_state(state)


def _due(status: dict, now: float) -> bool:
    if not status["expiring"]:
        return False
    wait_h = GTFS_RETRY_EXPIRED_HOURS if status["expired"] else GTFS_RETRY_EXPIRING_HOURS
    attempted = _read_state().get(status["agency"], {}).get("attempted_at", 0)
    return now - float(attempted) >= wait_h * 3600


# ---- the refresh itself ----

def _run_rebuild(agency) -> tuple[bool, str]:
    """Download the feed again and rebuild that agency's cache in a child process."""
    command = [sys.executable, "-m", "transit.agency_setup", agency.id, "--redownload"]
    try:
        done = subprocess.run(
            command, cwd=PROJECT_ROOT, capture_output=True, text=True,
            timeout=GTFS_REBUILD_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return False, f"timed out after {GTFS_REBUILD_TIMEOUT_SECONDS}s"
    except OSError as error:
        return False, str(error)
    tail = (done.stderr or done.stdout or "").strip().splitlines()[-1:] or [""]
    return done.returncode == 0, tail[0]


def check_and_refresh(force: bool = False) -> list[str]:
    """One pass: refresh every due agency, hot-reload the graph if any changed.

    Returns the ids of agencies that were rebuilt. Only one pass runs at a time.
    """
    if not _run_lock.acquire(blocking=False):
        return []
    try:
        rebuilt = []
        now = time.time()
        today = service_today()
        for agency in agencies.OWN_CACHE_AGENCIES:
            if not agency.cache_path.exists():
                continue
            status = agency_status(agency, today)
            if status is None:
                continue
            if not (force or _due(status, now)):
                continue

            state = "expired" if status["expired"] else f"{status['days_left']} day(s) of service left"
            print(f"[gtfs] {agency.label} ({agency.id}) timetable {state}; re-downloading...", flush=True)
            started = time.time()
            ok, detail = _run_rebuild(agency)
            _record_attempt(agency.id, ok, detail)
            if not ok:
                print(f"[gtfs] {agency.id}: refresh failed ({detail}); keeping the existing timetable.", flush=True)
                continue
            print(f"[gtfs] {agency.id}: rebuilt in {time.time() - started:.0f}s", flush=True)
            rebuilt.append(agency.id)

            # Swap each agency in as soon as it is ready, so an expired one is fixed without waiting.
            from .loader import reload_transit_data
            reload_transit_data(changed_agencies=[agency.id])
            fresh = agency_status(agency)
            if fresh is not None:
                note = "" if not fresh["expiring"] else " (the publisher has not posted a newer feed yet)"
                print(f"[gtfs] {agency.id}: now covers service until {fresh['last_service']}{note}", flush=True)
        return rebuilt
    finally:
        _run_lock.release()


def _worker():
    time.sleep(STARTUP_DELAY_SECONDS)  # let startup finish first
    while True:
        try:
            check_and_refresh()
        except Exception as error:  # never let the watcher die
            print(f"[gtfs] freshness check failed: {type(error).__name__}: {error}", flush=True)
        time.sleep(max(60, GTFS_CHECK_INTERVAL_SECONDS))


def start_freshness_worker() -> bool:
    """Start the background watcher once. No-op if GTFS_AUTO_REFRESH=0."""
    global _worker_started
    if not GTFS_AUTO_REFRESH:
        return False
    with _worker_lock:
        if _worker_started:
            return False
        threading.Thread(target=_worker, name="gtfs-freshness", daemon=True).start()
        _worker_started = True
    return True


def _main(argv) -> None:
    global _worker_started
    from .loader import ensure_transit_loaded

    _worker_started = True  # a one-off command must not spawn the background watcher
    ensure_transit_loaded()
    today = service_today()
    print(f"service date {today}; refresh when fewer than {GTFS_REFRESH_AHEAD_DAYS} days remain")
    for status in all_statuses(today):
        flag = "EXPIRED" if status["expired"] else ("expiring" if status["expiring"] else "ok")
        print(f"  {status['agency']:11s} service until {status['last_service']}  "
              f"({status['days_left']:4d} days)  {flag}")
    if "--status" not in argv:
        print("rebuilt:", check_and_refresh(force="--force" in argv) or "nothing")


if __name__ == "__main__":
    _main(sys.argv[1:])
