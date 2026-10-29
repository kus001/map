"""Longer walking transfers between nearby stops (ride -> walk -> ride).

The timetable graph only has walk edges for stops a stone's throw apart (about 110 m
inside an agency, 160 m between agencies). Those are built into the agency caches.
This module adds the longer links, once, when the graph is loaded:

    build_walk_links(stops, graph)  ->  {stop_id: ((neighbour_id, minutes), ...)}

They are kept out of the pickled graph on purpose, so the caches don't need
rebuilding and the radius can be tuned from the environment. The search uses them only as
a transfer between two rides (see search.py), and the A* lower bound includes them
(see lower_bound.py) so it stays a true lower bound.

Minutes start as an estimate (straight-line distance x a detour factor at the usual walking
pace). Where the local OSRM covers both stops, real walking times replace them:

    python -m transit.walk_links        # asks OSRM's table service, caches to WALK_LINK_TIMES_PATH

The loader applies that cache with apply_walk_times(), so the search plans with the same
durations that the finished journey shows. Re-run it after a timetable update adds stops
(it only asks about links it hasn't seen).
"""

import json
import math
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from .config import (
    ACCESS_WALK_SPEED_MPS,
    LOCAL_OSRM_BBOX,
    LOCAL_OSRM_WALK_URL,
    TRANSFER_WALK_DETOUR,
    TRANSFER_WALK_MAX_LINKS,
    TRANSFER_WALK_MAX_MIN,
    TRANSFER_WALK_MIN_M,
    TRANSFER_WALK_RADIUS_M,
    WALK_LINK_TIMES_PATH,
)

_METRES_PER_DEGREE = 111_320.0


def transfer_walk_minutes(distance_m: float) -> float:
    """Estimated minutes to walk between two stops `distance_m` apart (as the crow flies)."""
    return float(distance_m) * TRANSFER_WALK_DETOUR / ACCESS_WALK_SPEED_MPS / 60


def build_walk_links(
    stops,
    graph=None,
    radius_m=TRANSFER_WALK_RADIUS_M,
    max_links=TRANSFER_WALK_MAX_LINKS,
):
    """Map each stop to its nearest stops within `radius_m` that aren't already walk-linked.

    `stops` is {stop_id: (lat, lon, name)}. When `graph` is given, a pair that already
    has a `__walk__` edge is skipped (the short link covers it). Each stop keeps at most
    `max_links` neighbours, nearest first.
    """
    if not radius_m or radius_m <= 0 or max_links <= 0 or not stops:
        return {}

    mean_lat = sum(position[0] for position in stops.values()) / len(stops)
    metres_per_lon = _METRES_PER_DEGREE * math.cos(math.radians(mean_lat))
    cell_lat = radius_m / _METRES_PER_DEGREE
    cell_lon = radius_m / metres_per_lon

    grid = defaultdict(list)
    for stop_id, position in stops.items():
        cell = (int(position[0] // cell_lat), int(position[1] // cell_lon))
        grid[cell].append((stop_id, position[0], position[1]))

    graph_get = graph.get if graph is not None else (lambda *_: None)
    radius_sq = float(radius_m) ** 2
    min_sq = float(TRANSFER_WALK_MIN_M) ** 2
    links = {}

    for (cell_y, cell_x), members in grid.items():
        nearby = []
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                nearby.extend(grid.get((cell_y + dy, cell_x + dx), ()))

        for stop_id, lat, lon in members:
            already = graph_get(stop_id) or {}
            found = []
            for other_id, other_lat, other_lon in nearby:
                if other_id == stop_id:
                    continue
                dy_m = (other_lat - lat) * _METRES_PER_DEGREE
                dx_m = (other_lon - lon) * metres_per_lon
                distance_sq = dx_m * dx_m + dy_m * dy_m
                if distance_sq > radius_sq or distance_sq < min_sq:
                    continue
                if "__walk__" in (already.get(other_id) or ()):
                    continue
                found.append((distance_sq, other_id))

            if found:
                found.sort()
                links[stop_id] = tuple(
                    (other_id, transfer_walk_minutes(math.sqrt(distance_sq)))
                    for distance_sq, other_id in found[:max_links]
                )

    return links


# ---------------------------------------------------------------------------
# Real walking times from the local OSRM
# ---------------------------------------------------------------------------

def _pair_key(a, b):
    return f"{a}|{b}"


def _in_coverage(position):
    west, south, east, north = LOCAL_OSRM_BBOX
    return south <= position[0] <= north and west <= position[1] <= east


def load_walk_times(path=WALK_LINK_TIMES_PATH):
    """{"a|b": minutes or None}. None means OSRM found no walking route. Missing file -> {}."""
    try:
        with open(path, "r", encoding="utf-8") as file:
            data = json.load(file)
        times = data.get("minutes", {})
        return times if isinstance(times, dict) else {}
    except (OSError, ValueError):
        return {}


def apply_walk_times(links, stops, times, max_minutes=TRANSFER_WALK_MAX_MIN):
    """Swap estimated minutes for OSRM's real ones, and drop links OSRM says are too far.

    Links OSRM hasn't been asked about, or that aren't inside its coverage, keep their estimate.
    Returns (links, replaced, dropped).
    """
    if not times:
        return links, 0, 0
    out = {}
    replaced = dropped = 0
    for stop_id, neighbours in links.items():
        kept = []
        for other_id, estimate in neighbours:
            key = _pair_key(stop_id, other_id)
            if key not in times:
                kept.append((other_id, estimate))
                continue
            real = times[key]
            if real is None or real > max_minutes:
                dropped += 1
                continue
            replaced += 1
            kept.append((other_id, float(real)))
        if kept:
            out[stop_id] = tuple(kept)
    return out, replaced, dropped


def _table_url(coordinates):
    base = LOCAL_OSRM_WALK_URL
    if "/route/v1/" not in base:
        raise ValueError(f"MAP_LOCAL_OSRM_URL should contain /route/v1/ (got {base!r})")
    path = ";".join(f"{lon:.6f},{lat:.6f}" for lat, lon in coordinates)
    count = len(coordinates)
    destinations = ";".join(str(i) for i in range(1, count))
    return (base.replace("/route/v1/", "/table/v1/", 1)
            + f"/{path}?sources=0&destinations={destinations}&annotations=duration")


def _fetch_row(stop_id, stops, neighbours, timeout=15.0, retries=2):
    """Walking minutes from `stop_id` to each neighbour, in order (None = no route)."""
    coordinates = [stops[stop_id][:2]] + [stops[other][:2] for other, _ in neighbours]
    url = _table_url(coordinates)
    last = None
    for attempt in range(retries + 1):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "map-router walk-links"})
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = json.load(response)
            if body.get("code") != "Ok":
                raise ValueError(f"OSRM said {body.get('code')}")
            row = body["durations"][0]
            if len(row) != len(neighbours):
                raise ValueError("OSRM returned an unexpected number of durations")
            return [None if seconds is None else float(seconds) / 60 for seconds in row]
        except (urllib.error.URLError, OSError, ValueError, KeyError, IndexError) as error:
            last = error
            time.sleep(0.4 * (attempt + 1))
    raise RuntimeError(f"{stop_id}: {last}")


def refine_walk_links(links, stops, path=WALK_LINK_TIMES_PATH, workers=8, limit=None,
                      progress=print, fetch_row=_fetch_row):
    """Ask OSRM for the real walking time of every link not yet in the cache; save the cache.

    Only links with both stops inside OSRM's coverage are asked. Resumable: the cache is saved
    as it goes, and a second run only fetches what is missing. Returns a small summary dict.
    """
    times = load_walk_times(path)
    todo = []
    for stop_id, neighbours in links.items():
        if stop_id not in stops or not _in_coverage(stops[stop_id]):
            continue
        wanted = [(other, minutes) for other, minutes in neighbours
                  if other in stops and _in_coverage(stops[other])
                  and _pair_key(stop_id, other) not in times]
        if wanted:
            todo.append((stop_id, wanted))
    if limit:
        todo = todo[:limit]

    summary = {"requested": len(todo), "fetched": 0, "failed": 0, "unroutable": 0, "cached": len(times)}
    if not todo:
        return summary

    def save():
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + ".tmp")
        with temporary.open("w", encoding="utf-8") as file:
            json.dump({"version": 1, "minutes": times}, file, separators=(",", ":"))
        temporary.replace(target)

    started = time.perf_counter()
    consecutive_failures = 0
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = {pool.submit(fetch_row, stop_id, stops, wanted): (stop_id, wanted)
                   for stop_id, wanted in todo}
        for done, future in enumerate(as_completed(futures), start=1):
            stop_id, wanted = futures[future]
            try:
                row = future.result()
            except Exception as error:
                summary["failed"] += 1
                consecutive_failures += 1
                if consecutive_failures >= 25 and summary["fetched"] == 0:
                    for pending in futures:
                        pending.cancel()
                    save()
                    raise RuntimeError(f"OSRM table requests keep failing ({error}); "
                                       "is MAP_LOCAL_OSRM_URL right and the table service enabled?")
                continue
            consecutive_failures = 0
            summary["fetched"] += 1
            for (other, _), minutes in zip(wanted, row):
                times[_pair_key(stop_id, other)] = minutes
                if minutes is None:
                    summary["unroutable"] += 1
            if progress and done % 2000 == 0:
                progress(f"  {done:,}/{len(todo):,} stops "
                         f"({time.perf_counter() - started:.0f}s)")
                save()
    save()
    summary["cached"] = len(times)
    return summary


def main(argv=None):
    import argparse

    parser = argparse.ArgumentParser(description="Fetch real walking times for transfer links from the local OSRM.")
    parser.add_argument("--workers", type=int, default=8, help="parallel requests (default 8)")
    parser.add_argument("--limit", type=int, default=None, help="only the first N stops (for trying it out)")
    args = parser.parse_args(argv)

    if not LOCAL_OSRM_WALK_URL:
        print("MAP_LOCAL_OSRM_URL is empty; nothing to ask.", file=sys.stderr)
        return 2

    from .loader import _build_transit_data

    print("Loading transit data...", flush=True)
    loaded, _ = _build_transit_data()
    links = loaded.walk_links
    print(f"{sum(len(v) for v in links.values()):,} transfer links; asking OSRM ({LOCAL_OSRM_WALK_URL})...", flush=True)
    summary = refine_walk_links(links, loaded.node_positions, workers=args.workers, limit=args.limit)
    print(f"Done: {summary}. Saved to {WALK_LINK_TIMES_PATH}. Restart the server to use them.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
