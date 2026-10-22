"""Loads the transit graph and merges per-agency caches into it."""

import time

from . import agencies, store
from .go_realtime import start_gtfs_background_refresh
from .make_graph import make_graph
from .realtime import start_background_refresh
from .config import AGENCY_LINK_RADIUS_M, AGENCY_LINK_WALK_M_PER_MIN
from .geo import dist_m
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


def ensure_transit_loaded(verbose: bool=False) -> float:
    "Load the heavy transit graph only when transit is actually needed."
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
        loaded = make_graph()
        for agency in agencies.OWN_CACHE_AGENCIES:
            if agency.cache_path.exists():
                _merge_agency(agency, loaded)
        _ACTIVE_SERVICE_CACHE.clear()
        load_seconds = time.perf_counter() - load_started

        store._data = loaded
        store.graph = loaded.graph
        store.stops = loaded.node_positions

        if not store._realtime_started:
            start_background_refresh()
            start_gtfs_background_refresh()
            store._realtime_started = True

        if verbose:
            print(f"Transit data loaded in {load_seconds:.3f}s ({len(store.stops):,} stops).")

        return load_seconds
