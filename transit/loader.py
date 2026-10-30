"""Loads the transit graph and merges per-agency caches into it."""

import time

from . import agencies, store
from .go_realtime import start_gtfs_background_refresh
from .make_graph import make_graph
from .realtime import start_background_refresh
from .config import AGENCY_LINK_RADIUS_M, AGENCY_LINK_WALK_M_PER_MIN
from .compact import unique_pools
from .freshness import start_freshness_worker
from .geo import dist_m
from .lower_bound import build_reverse_min_graph
from .walk_links import apply_walk_times, build_walk_links, load_walk_times
from .pickle_compat import load_cache
from .store import _ACTIVE_SERVICE_CACHE, _transit_load_lock


def missing_agency_caches() -> list[str]:
    """Ids of own-cache agencies whose compact cache file hasn't been built yet."""
    return [a.id for a in agencies.OWN_CACHE_AGENCIES if not a.cache_path.exists()]


def _merge_agency(agency, data):
    """Merge one agency's compact schedule into the shared graph (before it is published)."""
    with agency.cache_path.open("rb") as file:
        extra = load_cache(file)

    graph, stops = data.graph, data.node_positions

    # short transfer walks to other agencies' stops (e.g. GO <-> TTC)
    other_index = {}
    for sid, pos in stops.items():
        if sid.startswith(agency.prefix):
            continue
        key = (round(pos[0] * 1000), round(pos[1] * 1000))
        other_index.setdefault(key, []).append((sid, pos))
    for sid, pos in extra.node_positions.items():
        key = (round(pos[0] * 1000), round(pos[1] * 1000))
        for x in range(key[0] - 2, key[0] + 3):
            for y in range(key[1] - 2, key[1] + 3):
                for other_id, other_pos in other_index.get((x, y), []):
                    distance = dist_m(pos, other_pos)
                    if distance <= AGENCY_LINK_RADIUS_M:
                        leg = [{"distance": distance / AGENCY_LINK_WALK_M_PER_MIN}]
                        graph.setdefault(sid, {}).setdefault(other_id, {})["__walk__"] = leg
                        graph.setdefault(other_id, {}).setdefault(sid, {})["__walk__"] = leg
    for sid, neighbors in extra.graph.items():
        old = graph.setdefault(sid, {})
        for neighbor, routes in neighbors.items():
            old.setdefault(neighbor, {}).update(routes)
    stops.update(extra.node_positions)
    data.trip_to_service.update(extra.trip_to_service)
    data.calendar.update(extra.calendar)
    data.calendar_dates.update(extra.calendar_dates)
    print(f"{agency.label} loaded: {len(extra.node_positions):,} stops", flush=True)


def _build_transit_data():
    """Read every agency cache into a fresh graph. Nothing is published yet."""
    loaded = make_graph()
    for agency in agencies.OWN_CACHE_AGENCIES:
        if agency.cache_path.exists():
            _merge_agency(agency, loaded)
    try:
        loaded.walk_links = build_walk_links(loaded.node_positions, loaded.graph)
        times = load_walk_times()
        if times:
            loaded.walk_links, replaced, dropped = apply_walk_times(
                loaded.walk_links, loaded.node_positions, times)
            print(f"Transfer walks: {replaced:,} real OSRM times, {dropped:,} dropped as too far.", flush=True)
        else:
            print("Transfer walks use estimated times; run `python -m transit.walk_links` for real ones.", flush=True)
    except Exception as error:  # no long transfer walks; short ones still work
        print(f"Transfer walk links failed ({error}); using short transfers only.", flush=True)
        loaded.walk_links = {}
    try:
        reverse_min = build_reverse_min_graph(loaded.graph, loaded.walk_links)
    except Exception as error:  # the search falls back to the straight-line heuristic
        print(f"Lower-bound graph failed ({error}); using straight-line heuristic.", flush=True)
        reverse_min = None
    return loaded, reverse_min


def _publish(loaded, reverse_min):
    """Make `loaded` the live graph (a handful of attribute swaps, so requests never see a half-built one)."""
    store._data = loaded
    store.graph = loaded.graph
    store.stops = loaded.node_positions
    store.reverse_min = reverse_min
    store.walk_links = getattr(loaded, "walk_links", {})
    store.trip_pools = unique_pools(loaded.graph)


def invalidate_caches(changed_agencies=None):
    """Forget everything derived from the previous timetable. Each step is independent."""

    def clear_active_services():
        _ACTIVE_SERVICE_CACHE.clear()
        from . import schedule
        schedule._SCHEDULE_CACHE.clear()

    def clear_lower_bounds():
        from . import lower_bound
        with lower_bound._cache_lock:
            lower_bound._cache.clear()

    def clear_stop_grid():
        from helpers import coords
        coords._cached_id = None  # the new stops dict could reuse the old one's id() and length

    def clear_vehicle_caches():
        from . import vehicles
        with vehicles._scheduled_trip_cache_lock:
            vehicles._scheduled_trip_cache.clear()
        with vehicles._nearby_vehicle_lock:
            vehicles._nearby_vehicle_cache.clear()

    def clear_metadata():
        from . import gtfs_metadata
        for cached in (gtfs_metadata.get_trip_meta, gtfs_metadata._load_shape, gtfs_metadata._routes_index):
            cached.cache_clear()

    def clear_live_matching():
        from . import rt_match
        with rt_match._lock:
            for agency_id in (changed_agencies or list(rt_match._indexes)):
                rt_match._indexes.pop(agency_id, None)

    steps = [clear_active_services, clear_lower_bounds, clear_stop_grid,
             clear_vehicle_caches, clear_metadata, clear_live_matching]
    for step in steps:
        try:
            step()
        except Exception as error:
            print(f"cache reset {step.__name__} failed: {type(error).__name__}: {error}", flush=True)


def reload_transit_data(changed_agencies=None) -> float:
    """Re-read every agency cache from disk and swap the result in (used after a timetable refresh).

    The new graph is built completely before it replaces the old one, so searches keep working
    throughout; memory briefly holds both. Returns the seconds spent building.
    """
    with _transit_load_lock:
        started = time.perf_counter()
        loaded, reverse_min = _build_transit_data()
        elapsed = time.perf_counter() - started
        _publish(loaded, reverse_min)
        invalidate_caches(changed_agencies)
        print(f"Transit data reloaded in {elapsed:.1f}s ({len(store.stops):,} stops).", flush=True)
        return elapsed


def ensure_transit_loaded(verbose: bool=False) -> float:
    """Build the transit graph once and start the background workers (realtime, freshness).

    helpers/warmup.py calls this at server startup, and the command-line tools call it themselves.
    Safe to call again: once the data is loaded it returns immediately."""
    if store._data is not None:
        if verbose:
            print(f"Transit data already loaded ({len(store.stops):,} stops).")
        return 0.0

    with _transit_load_lock:
        if store._data is not None:
            if verbose: print(f"Transit data already loaded ({len(store.stops):,} stops).")
            return 0.0

        if verbose: print("Loading transit data...")

        load_started = time.perf_counter()
        loaded, reverse_min = _build_transit_data()
        _ACTIVE_SERVICE_CACHE.clear()
        load_seconds = time.perf_counter() - load_started

        _publish(loaded, reverse_min)

        if not store._realtime_started:
            start_background_refresh()
            start_gtfs_background_refresh()
            start_freshness_worker()
            store._realtime_started = True

        if verbose:
            print(f"Transit data loaded in {load_seconds:.3f}s ({len(store.stops):,} stops).")

        return load_seconds
