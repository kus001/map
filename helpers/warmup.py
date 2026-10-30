"""Eager startup loading for the routing server.

Every step is isolated: if one fails, it is logged and the server still starts;
/api/health then reports the state as "degraded" and names the failed stages.

Environment switch
  MAP_WARMUP_REALTIME_TIMEOUT=8    seconds to wait for the first GTFS-RT fetch
"""
import os
import time

_warmed = False
_finished = False
_report = {}

def report() -> dict:
    return {name: dict(value) for name, value in _report.items()}


def status() -> dict:
    stages = report()

    for item in stages.values():
        if item.get("error"):
            item["error"] = item["error"].split(":", 1)[0]
    bad = [name for name, item in stages.items() if not item.get("ok")]
    if not _finished:
        state = "not_started"
    else:
        state = "degraded" if bad else "ready"
    return {
        "state": state,
        "warmed_up": _warmed,
        "stages": stages,
        "failed": bad,
    }

def _run(name, fn):
    started = time.perf_counter()
    try:
        detail = fn()
    except Exception as error:
        elapsed = time.perf_counter() - started
        _report[name] = {"ok": False, "seconds": round(elapsed, 2), "error": f"{type(error).__name__}: {error}"}
        print(f"[warmup] {name}: FAILED after {elapsed:.2f}s ({type(error).__name__}: {error})", flush=True)
        return False
    elapsed = time.perf_counter() - started
    skipped = isinstance(detail, str) and detail.startswith("skipped")
    missing = isinstance(detail, str) and detail.startswith("no cache file")
    _report[name] = {"ok": not missing, "seconds": round(elapsed, 2),
                     "detail": detail, "skipped": skipped}
    suffix = f" - {detail}" if detail else ""
    tag = "MISSING" if missing else "OK"
    print(f"[warmup] {name}: {tag} in {elapsed:.2f}s{suffix}", flush=True)
    return not missing

def _address_index():
    from helpers import local_geocode
    points = local_geocode.preload()
    files = local_geocode.loaded_files()
    return f"{points:,} address points from {len(files)} file{'s' if len(files) != 1 else ''}"

def _named_places():
    from helpers import geocoding
    return geocoding.prime_named_places()

def _transit_graph():
    import transit
    transit.ensure_transit_loaded()
    return f"{len(transit.stops):,} stops"

def _agencies() -> str:
    import transit
    missing = transit.missing_agency_caches()
    if missing:
        return "no cache file for " + ", ".join(missing)
    return "loaded " + ", ".join(a.id for a in transit.agencies.OWN_CACHE_AGENCIES)

def _stop_grid():
    import transit
    from helpers.coords import nearest_stops

    nearest_stops(transit.stops, 43.4723, -80.5449, 1)
    return f"{len(transit.stops):,} stops indexed"

def _gtfs_indexes():
    from transit import gtfs_metadata
    gtfs_metadata.prewarm()

def _service_calendars() -> str:
    import transit
    return f"{transit.warm_schedule_caches(days_ahead=1)} service dates"

def _realtime_first_fetch():
    """The refresh threads start with the graph; wait (bounded) for the first result."""
    from transit import go_realtime, realtime

    timeout = float(os.getenv("MAP_WARMUP_REALTIME_TIMEOUT", "8"))
    feeds = {}
    if realtime._worker_started:
        feeds["gtfs-rt"] = lambda: realtime.snapshot()
    if go_realtime._gtfs_worker_started:
        feeds["go"] = lambda: go_realtime.gtfs_snapshot()
    if not feeds:
        return "no realtime workers running"

    deadline = time.monotonic() + timeout
    pending = set(feeds)
    while pending and time.monotonic() < deadline:
        pending = {name for name in pending if not feeds[name]()["loaded_at"] > 0}
        if pending:
            time.sleep(0.1)

    parts = []
    for name, get in feeds.items():
        if name in pending:
            parts.append(f"{name}: timed out")
        else:
            parts.append(f"{name}: {'live data' if get()['available'] else 'no live data (feed unavailable or stale)'}")
    return "; ".join(parts)


def warm_up() -> dict:
    """Load everything. Safe to call more than once; later calls are no-ops."""
    global _warmed, _finished
    if _finished:
        return report()
    started = time.perf_counter()
    print("[warmup] loading all routing data before accepting requests...", flush=True)

    _run("address_index", _address_index)
    _run("named_places", _named_places)
    graph_ok = _run("transit_graph", _transit_graph)
    if graph_ok:

        _run("agencies", _agencies)
        _run("stop_grid", _stop_grid)
        _run("gtfs_indexes", _gtfs_indexes)
        _run("service_calendars", _service_calendars)
        _run("realtime_first_fetch", _realtime_first_fetch)

    _finished = True
    _warmed = all(item.get("ok") for item in _report.values())
    print(f"[warmup] done in {time.perf_counter() - started:.2f}s", flush=True)
    return report()
