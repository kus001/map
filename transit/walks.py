"""Walking geometry and the batched/cached walk-fetching machinery."""

import asyncio
import threading
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from time import monotonic

import httpx

from helpers.fast_osrm import osrm_route

from .config import (
    LOCAL_OSRM_BBOX,
    LOCAL_OSRM_COOLDOWN_SECONDS,
    LOCAL_OSRM_WALK_URL,
    MAX_CONCURRENT_WALK_REQUESTS,
    MAX_WALK_CACHE_ENTRIES,
    ORS_API_KEY,
    ORS_WALKING_URL,
    TRANSIT_DETAILED_WALKS,
    WALK_BACKGROUND_SECONDS,
    WALK_BATCH_BUDGET_SECONDS,
)
from .geo import access_walk_minutes, coord, dist_m


_WALK_CACHE = OrderedDict()


def run_async(coro):
    """Run a coroutine from synchronous code and return its result.

    Normal case: no event loop is running in this thread, so asyncio.run() is used.
    If this is called from inside a running loop (for example an `async def` web
    handler), asyncio.run() would raise, so the coroutine is run on a fresh loop in a
    short-lived helper thread instead.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)

    box = {}

    def runner():
        try:
            box["value"] = asyncio.run(coro)
        except BaseException as exc:
            box["error"] = exc

    worker = threading.Thread(target=runner)
    worker.start()
    worker.join()
    if "error" in box:
        raise box["error"]
    return box["value"]


def _walk_client():
    return httpx.AsyncClient(
        headers={
            "Authorization": ORS_API_KEY or "",
            "Accept": "application/json, application/geo+json",
        },
        timeout=httpx.Timeout(1.3, connect=0.55),
    )


def _ors_walk_directions(feature, coordinates):
    """Turn-by-turn steps from an ORS foot-walking feature."""
    directions = []
    for segment in feature.get("properties", {}).get("segments", []):
        for step in segment.get("steps", []):


            if step.get("type") == 10:
                continue

            point = None
            way_points = step.get("way_points") or []
            if way_points:
                try:
                    index = int(way_points[0])
                    if 0 <= index < len(coordinates):
                        point = list(coordinates[index])
                except (TypeError, ValueError):
                    pass

            directions.append(
                {
                    "instruction": step.get("instruction", ""),
                    "type": "walking",
                    "modifier": "",
                    "road": step.get("name", ""),
                    "name": step.get("name", ""),
                    "distance_m": float(step.get("distance", 0) or 0),
                    "duration_min": float(step.get("duration", 0) or 0) / 60,
                    "coordinates": point,
                }
            )
    return directions


def _osrm_walk(start_lat, start_lon, end_lat, end_lon):
    """Foot-routing fallback (public OSRM) with the same shape as the ORS result."""
    route = osrm_route("walking", start_lat, start_lon, end_lat, end_lon)
    coordinates = [
        [float(lat), float(lon)] for lon, lat in route["geometry"]["coordinates"]
    ]

    directions = []
    for leg in route.get("legs", []):
        for step in leg.get("steps", []):
            maneuver = step.get("maneuver") or {}
            if maneuver.get("type") == "arrive":
                continue
            location = maneuver.get("location") or []
            directions.append(
                {
                    "instruction": "",
                    "type": maneuver.get("type", "continue"),
                    "modifier": maneuver.get("modifier", ""),
                    "road": step.get("name", ""),
                    "name": step.get("name", ""),
                    "distance_m": float(step.get("distance", 0) or 0),
                    "duration_min": float(step.get("duration", 0) or 0) / 60,
                    "coordinates": (
                        [float(location[1]), float(location[0])]
                        if len(location) >= 2
                        else None
                    ),
                }
            )

    return {
        "coordinates": coordinates,
        "distance_m": float(route.get("distance", 0)),
        "duration_min": float(route.get("duration", 0)) / 60,
        "steps": directions,
    }


_local_osrm_down_until = 0.0


def _in_local_osrm_area(lat, lon):
    west, south, east, north = LOCAL_OSRM_BBOX
    return south <= lat <= north and west <= lon <= east


def _local_osrm_usable(start_lat, start_lon, end_lat, end_lon):
    """Local OSRM only knows its extract, so both ends must be inside the box."""
    if not LOCAL_OSRM_WALK_URL or monotonic() < _local_osrm_down_until:
        return False
    return (_in_local_osrm_area(start_lat, start_lon)
            and _in_local_osrm_area(end_lat, end_lon))


def _osrm_body_to_walk(body):
    if body.get("code") != "Ok" or not body.get("routes"):
        return None
    route = body["routes"][0]
    geometry = route.get("geometry", {}).get("coordinates", [])
    points = [[float(lat), float(lon)] for lon, lat in geometry]
    if len(points) < 2:
        return None
    directions = []
    for leg in route.get("legs", []):
        for step in leg.get("steps", []):
            maneuver = step.get("maneuver") or {}
            if maneuver.get("type") == "arrive":
                continue
            location = maneuver.get("location") or []
            directions.append({
                "instruction": "", "type": maneuver.get("type", "continue"),
                "modifier": maneuver.get("modifier", ""),
                "road": step.get("name", ""), "name": step.get("name", ""),
                "distance_m": float(step.get("distance", 0) or 0),
                "duration_min": float(step.get("duration", 0) or 0) / 60,
                "coordinates": [float(location[1]), float(location[0])]
                if len(location) >= 2 else None,
            })
    return {"coordinates": points,
            "geometry_source": "pedestrian_network",
            "distance_m": float(route.get("distance", 0)),
            "duration_min": float(route.get("duration", 0)) / 60,
            "steps": directions}


async def _fetch_osrm_walk(client, base_url, start_lat, start_lon, end_lat, end_lon):
    response = await client.get(
        f"{base_url}/{start_lon},{start_lat};{end_lon},{end_lat}",
        params={"overview": "full", "geometries": "geojson",
                "steps": "true", "alternatives": "false"},
    )
    response.raise_for_status()
    return _osrm_body_to_walk(response.json())


async def _fetch_walking_route(client, start_lat, start_lon, end_lat, end_lon):
    global _local_osrm_down_until
    key = (start_lat, start_lon, end_lat, end_lon)
    cached = _WALK_CACHE.get(key)
    if cached is not None:
        return cached

    result = None

    # 1. self-hosted OSRM (fast, no rate limits) when the walk is inside its extract
    if _local_osrm_usable(start_lat, start_lon, end_lat, end_lon):
        try:
            result = await _fetch_osrm_walk(
                client, LOCAL_OSRM_WALK_URL, start_lat, start_lon, end_lat, end_lon
            )
        except httpx.TransportError:
            # server unreachable or timing out: stop trying it for a bit
            _local_osrm_down_until = monotonic() + LOCAL_OSRM_COOLDOWN_SECONDS
            result = None
        except Exception:
            result = None

    # 2. OpenRouteService
    if result is None and ORS_API_KEY:
        try:
            response = await client.get(
                ORS_WALKING_URL,
                params={
                    "start": f"{start_lon},{start_lat}",
                    "end": f"{end_lon},{end_lat}",
                },
            )
            response.raise_for_status()

            feature = response.json()["features"][0]
            summary = feature.get("properties", {}).get("summary", {})
            coordinates = [
                [float(lat), float(lon)]
                for lon, lat in feature["geometry"]["coordinates"]
            ]

            result = {
                "coordinates": coordinates,
                "geometry_source": "pedestrian_network",
                "distance_m": float(summary.get("distance", 0)),
                "duration_min": float(summary.get("duration", 0)) / 60,
                "steps": _ors_walk_directions(feature, coordinates),
            }
        except Exception:
            result = None

    # 3. public OSRM
    if result is None:
        try:
            from helpers.fast_osrm import WALK_URL
            result = await _fetch_osrm_walk(
                client, WALK_URL, start_lat, start_lon, end_lat, end_lon
            )
        except Exception:
            result = None

    _WALK_CACHE[key] = result
    while len(_WALK_CACHE) > MAX_WALK_CACHE_ENTRIES:
        try:
            _WALK_CACHE.popitem(last=False)
        except KeyError:
            break
    return result


def _straight_walk(start, end, straight_distance, fallback_min):
    return {
        "coordinates": [start, end],
        "distance_m": straight_distance,
        "duration_min": float(fallback_min),
        "geometry_source": "straight_estimate",
    }


async def walking_geometry_async(client, start, end, fallback_min=None) -> dict:
    start = coord(start)
    end = coord(end)
    straight_distance = dist_m(start, end)

    if fallback_min is None:
        fallback_min = access_walk_minutes(straight_distance)

    if straight_distance <= 35 or not TRANSIT_DETAILED_WALKS:
        return _straight_walk(start, end, straight_distance, fallback_min)

    result = await _fetch_walking_route(
        client,
        round(start[0], 6),
        round(start[1], 6),
        round(end[0], 6),
        round(end[1], 6),
    )
    return result or _straight_walk(start, end, straight_distance, fallback_min)


# try the road walking route first, then fall back if the api fails
def walking_geometry(start, end, fallback_min=None) -> dict:
    """Synchronous wrapper kept for existing callers."""
    start = coord(start)
    end = coord(end)
    straight_distance = dist_m(start, end)

    if fallback_min is None:
        fallback_min = access_walk_minutes(straight_distance)

    if straight_distance <= 35 or not TRANSIT_DETAILED_WALKS:
        return _straight_walk(start, end, straight_distance, fallback_min)

    async def one():
        async with _walk_client() as client:
            return await walking_geometry_async(client, start, end, fallback_min)

    return run_async(one())


async def _fetch_walks_async(jobs):
    gate = asyncio.Semaphore(MAX_CONCURRENT_WALK_REQUESTS)
    results = {}

    async with _walk_client() as client:
        async def one(key, start, end, fallback):
            async with gate:
                try:
                    results[key] = await walking_geometry_async(client, start, end, fallback)
                except Exception:
                    pass

        pending = [asyncio.create_task(one(key, *job)) for key, job in jobs.items()]
        done, waiting = await asyncio.wait(pending, timeout=WALK_BACKGROUND_SECONDS)
        for task in waiting:
            task.cancel()
        if waiting:
            await asyncio.gather(*waiting, return_exceptions=True)



    for key, (start, end, fallback) in jobs.items():
        if key not in results:
            length = dist_m(start, end)
            results[key] = _straight_walk(list(start), list(end), length, fallback)
    return results


_walk_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="map-walks")
_walk_batches = {}
_walk_batch_lock = threading.Lock()


def fetch_walks(jobs):
    if not jobs:
        return {}
    if not TRANSIT_DETAILED_WALKS:
        return {key: walking_geometry(start, end, fallback)
                for key, (start, end, fallback) in jobs.items()}



    waiting = {key: job for key, job in jobs.items()
               if _WALK_CACHE.get(_walk_key(job[0], job[1])) is None}
    future = None
    if waiting:
        signature = tuple(sorted(waiting))
        with _walk_batch_lock:
            for old_key, old_future in list(_walk_batches.items()):
                if old_future.done():
                    del _walk_batches[old_key]
            future = _walk_batches.get(signature)
            if future is None and len(_walk_batches) < 3:
                future = _walk_pool.submit(run_async, _fetch_walks_async(waiting))
                _walk_batches[signature] = future
        if future is not None:
            try:
                future.result(timeout=WALK_BATCH_BUDGET_SECONDS)
            except Exception:
                pass

    results = {}
    for key, (start, end, fallback) in jobs.items():
        cached = _WALK_CACHE.get(_walk_key(start, end))
        results[key] = cached or _straight_walk(
            list(start), list(end), dist_m(start, end), fallback
        )
    return results


def ready_walks(pairs):
    """Read completed sidewalk requests. No network work happens here."""
    output = {}
    for item in (pairs or [])[:30]:
        if not isinstance(item, dict):
            continue
        a, b = item.get('start'), item.get('end')
        if not isinstance(a, list) or not isinstance(b, list) or len(a) < 2 or len(b) < 2:
            continue
        try:
            key = _walk_key(a, b)
        except (TypeError, ValueError):
            continue
        route = _WALK_CACHE.get(key)
        if route and route.get('coordinates'):
            output[','.join(f'{v:.6f}' for v in key)] = route
    return output


def _walk_key(start, end):
    return tuple(round(float(v), 6) for v in (*start[:2], *end[:2]))


def _walk_id(start, end):
    return ','.join(f'{v:.6f}' for v in _walk_key(start, end))
