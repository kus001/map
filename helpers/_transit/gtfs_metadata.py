import csv
import math
from functools import lru_cache
from heapq import nsmallest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
GTFS_ROOT = PROJECT_ROOT / "transit_data" / "GTFS_Files"


def _iter_rows(path):
    if not path.exists():
        return

    try:
        with path.open("r", encoding="utf-8-sig", newline="", errors="replace") as file:
            yield from csv.DictReader(file)
    except Exception:
        return


@lru_cache(maxsize=8)
def _routes_index(agency):
    """Routes are small, so keeping only this lightweight table in RAM is fine."""
    folder = GTFS_ROOT / agency
    return {
        row.get("route_id"): row
        for row in _iter_rows(folder / "routes.txt") or ()
        if row.get("route_id")
    }


def _trip_meta_from_row(agency, folder, trip, routes):
    route_id = trip.get("route_id") or ""
    route = routes.get(route_id, {})

    return {
        "agency": agency,
        "feed_dir": str(folder),
        "trip_id": str(trip.get("trip_id") or ""),
        "shape_id": trip.get("shape_id") or "",
        "headsign": trip.get("trip_headsign") or "",
        "route_id": route_id,
        "route_short_name": route.get("route_short_name") or "",
        "route_long_name": route.get("route_long_name") or "",
        "route_type": route.get("route_type") or "",
        "route_color": route.get("route_color") or "",
    }


def _meta_score(meta, route_hint, headsign_hint):
    points = 0
    names = {
        str(meta.get("route_id") or "").lower(),
        str(meta.get("route_short_name") or "").lower(),
        str(meta.get("route_long_name") or "").lower(),
    }

    if route_hint and route_hint in names:
        points += 6
    elif route_hint and any(
        route_hint in name or name in route_hint for name in names if name
    ):
        points += 3

    headsign = str(meta.get("headsign") or "").lower()
    if headsign_hint and headsign == headsign_hint:
        points += 3
    elif headsign_hint and headsign and (
        headsign_hint in headsign or headsign in headsign_hint
    ):
        points += 1

    if meta.get("shape_id"):
        points += 1

    return points


@lru_cache(maxsize=512)
def get_trip_meta(agency, trip_id, route_hint="", headsign_hint=""):
    """Find one trip without loading every GTFS trip into a giant Python dict."""
    agency = str(agency)
    trip_id = str(trip_id)
    route_hint = str(route_hint or "").strip().lower()
    headsign_hint = str(headsign_hint or "").strip().lower()

    folder = GTFS_ROOT / agency
    trips_path = folder / "trips.txt"
    if not trips_path.exists():
        return None

    routes = _routes_index(agency)
    best = None
    best_score = -1

    for trip in _iter_rows(trips_path) or ():
        meta = _trip_meta_from_row(agency, folder, trip, routes)

        if meta["trip_id"] == trip_id:
            return meta

        if route_hint or headsign_hint:
            score = _meta_score(meta, route_hint, headsign_hint)
            if score > best_score:
                best = meta
                best_score = score

    return best if best is not None and best_score >= 4 else None


@lru_cache(maxsize=64)
def _load_shape(agency, shape_id) -> tuple:
    """Load only the requested shape instead of every shape in an agency feed."""
    path = GTFS_ROOT / agency / "shapes.txt"
    if not path.exists() or not shape_id:
        return ()

    points = []
    for row in _iter_rows(path) or ():
        if row.get("shape_id") != shape_id:
            continue

        try:
            sequence = int(float(row.get("shape_pt_sequence", 0)))
            point = (float(row["shape_pt_lat"]), float(row["shape_pt_lon"]))
        except (KeyError, TypeError, ValueError):
            continue

        points.append((sequence, point))

    points.sort(key=lambda item: item[0])
    return tuple(point for _, point in points)


def _point_score(point, target) -> float:
    scale = math.cos(math.radians((float(point[0]) + float(target[0])) / 2))
    dlat = float(point[0]) - float(target[0])
    dlon = (float(point[1]) - float(target[1])) * scale
    return dlat * dlat + dlon * dlon


def _nearest_indices(shape, target, amount=12) -> list:
    return [
        index
        for _, index in nsmallest(
            min(amount, len(shape)),
            ((_point_score(point, target), index) for index, point in enumerate(shape)),
        )
    ]


def shape_for_trip(
    agency,
    trip_id,
    start,
    end,
    route_hint="",
    headsign_hint="",
):
    meta = get_trip_meta(agency, trip_id, route_hint, headsign_hint)
    if not meta or not meta.get("shape_id"):
        return None, meta

    shape = _load_shape(str(agency), str(meta["shape_id"]))
    if len(shape) < 2:
        return None, meta

    start_candidates = _nearest_indices(shape, start)
    end_candidates = _nearest_indices(shape, end)

    best_pair = None
    best_score = float("inf")

    for start_index in start_candidates:
        for end_index in end_candidates:
            if end_index < start_index:
                continue

            score = _point_score(shape[start_index], start) + _point_score(
                shape[end_index], end
            )
            if score < best_score:
                best_score = score
                best_pair = (start_index, end_index)

    if best_pair is None:
        return None, meta

    geometry = [list(point) for point in shape[best_pair[0] : best_pair[1] + 1]]
    if len(geometry) < 2:
        return None, meta

    geometry[0] = [float(start[0]), float(start[1])]
    geometry[-1] = [float(end[0]), float(end[1])]
    return geometry, meta


def raw_gtfs_available(agency=None):
    if agency:
        folder = GTFS_ROOT / agency
        return (folder / "trips.txt").exists() and (folder / "shapes.txt").exists()

    return any(
        raw_gtfs_available(name) for name in ("grt_busses", "grt_trains", "go")
    )
