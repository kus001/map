"""Eager startup loading for the routing server.

Every step is isolated: if one fails, it is logged and the server still starts;
the original lazy code paths remain as a fallback for that piece.

Environment switches
  MAP_PRELOAD_TRANSIT=0            skip all of this (restores lazy behaviour)
  MAP_PRELOAD_TTC=0                keep TTC lazy (saves RAM on small servers)
  MAP_WARMUP_REALTIME_TIMEOUT=8    seconds to wait for the first GTFS-RT fetch
"""
import os
import time

_warmed = False
_report = {}

def is_warm() -> bool:
    return _warmed

def report() -> dict:
    return dict(_report)

def _flag(name, default="1") -> bool:
    return os.getenv(name, default) == "1"

def _run(name, fn):
    started = time.perf_counter()
    try:
        detail = fn()
    except Exception as error:  # keep the server bootable; lazy paths still exist
        elapsed = time.perf_counter() - started
        _report[name] = {"ok": False, "seconds": round(elapsed, 2), "error": f"{type(error).__name__}: {error}"}
        print(f"[warmup] {name}: FAILED after {elapsed:.2f}s ({type(error).__name__}: {error})", flush=True)
        return False
    elapsed = time.perf_counter() - started
    _report[name] = {"ok": True, "seconds": round(elapsed, 2), "detail": detail}
    suffix = f" - {detail}" if detail else ""
    print(f"[warmup] {name}: {elapsed:.2f}s{suffix}", flush=True)
    return True

def _address_index():
    from helpers import local_geocode
    return f"{local_geocode.preload():,} address points"

def _transit_graph():
    import transit
    transit.ensure_transit_loaded()
    return f"{len(transit.stops):,} stops"

def _ttc() -> str:
    import transit
    if not _flag("MAP_PRELOAD_TTC"):
        return "skipped (MAP_PRELOAD_TTC=0)"
    return "loaded" if transit.load_ttc() else "no TTC cache file"

def _stop_grid():
    import transit
    from helpers.coords import nearest_stops
    # Builds the spatial grid for the final stop set (after TTC has been merged).
    nearest_stops(transit.stops, 43.4723, -80.5449, 1)
    return f"{len(transit.stops):,} stops indexed"

def _gtfs_indexes():
    from helpers._transit import gtfs_metadata
    gtfs_metadata.prewarm()

def _service_calendars() -> str:
    import transit
    return f"{transit.warm_schedule_caches(days_ahead=1)} service dates"

def _realtime_first_fetch():
    """The refresh threads start with the graph; wait (bounded) for the first result."""
    from helpers._transit import go_realtime, realtime

    timeout = float(os.getenv("MAP_WARMUP_REALTIME_TIMEOUT", "8"))
    feeds = {}
    if realtime._worker_started:
        feeds["grt"] = lambda: realtime.snapshot()
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
    global _warmed
    if _warmed:
        return report()
    if not _flag("MAP_PRELOAD_TRANSIT"):
        print("[warmup] disabled (MAP_PRELOAD_TRANSIT=0); data will load lazily.", flush=True)
        return report()

    started = time.perf_counter()
    print("[warmup] loading all routing data before accepting requests...", flush=True)

    _run("address_index", _address_index)
    graph_ok = _run("transit_graph", _transit_graph)
    if graph_ok:
        # Order matters: TTC extends the graph/stops, so build derived indexes after it.
        _run("ttc", _ttc)
        _run("stop_grid", _stop_grid)
        _run("gtfs_indexes", _gtfs_indexes)
        _run("service_calendars", _service_calendars)
        _run("realtime_first_fetch", _realtime_first_fetch)

    _warmed = True
    print(f"[warmup] done in {time.perf_counter() - started:.2f}s", flush=True)
    return report()
