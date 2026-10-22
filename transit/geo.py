"""Stop-id helpers and small geometry utilities."""

import math

from .config import ACCESS_WALK_SPEED_MPS


def coord(value) -> list[float, float]:
    return [float(value[0]), float(value[1])]


def stop_coords(entry) -> list[float, float]:
    return coord(entry[1])


def stop_name(entry) -> str:
    info = entry[1]
    return str(info[2]) if len(info) > 2 and info[2] else str(entry[0])


def stop_agency(stop_id) -> str:
    return str(stop_id).split(":", 1)[0]


def raw_stop_id(stop_id) -> str:
    text = str(stop_id)
    return text.split(":", 1)[1] if ":" in text else text


def access_walk_minutes(distance_m) -> float:
    """Walk time between two points"""
    return float(distance_m) / ACCESS_WALK_SPEED_MPS / 60


def dist_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Approximate distance between two points in metres."""
    lat1, lon1 = map(float, a[:2])
    lat2, lon2 = map(float, b[:2])

    avg_lat = math.radians((lat1 + lat2) / 2)

    dx = math.radians(lon2 - lon1) * 6_371_000 * math.cos(avg_lat)
    dy = math.radians(lat2 - lat1) * 6_371_000

    return math.hypot(dx, dy)


def polyline_distance_m(points) -> float:
    if not points or len(points) < 2:
        return 0.0
    return sum(dist_m(points[i - 1], points[i]) for i in range(1, len(points)))


def point_along_polyline(points, fraction):
    """Return a distance-weighted point along a polyline."""
    if not points:
        return None
    if len(points) == 1:
        return [float(points[0][0]), float(points[0][1])]

    fraction = max(0.0, min(1.0, float(fraction)))
    lengths = [
        dist_m(points[index - 1], points[index])
        for index in range(1, len(points))
    ]
    total = sum(lengths)
    if total <= 0:
        return [float(points[0][0]), float(points[0][1])]

    target = total * fraction
    travelled = 0.0
    for index, segment_length in enumerate(lengths, start=1):
        if travelled + segment_length >= target:
            local = 0.0 if segment_length <= 0 else (target - travelled) / segment_length
            start = points[index - 1]
            end = points[index]
            return [
                float(start[0]) + (float(end[0]) - float(start[0])) * local,
                float(start[1]) + (float(end[1]) - float(start[1])) * local,
            ]
        travelled += segment_length

    return [float(points[-1][0]), float(points[-1][1])]
