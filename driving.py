from functools import lru_cache

import requests

from helpers.geocoding import explain_address_problem, get_coordinates

OSRM_URL = "https://router.project-osrm.org/route/v1/driving"
REQUEST_TIMEOUT = 8

_session = requests.Session()
_session.headers.update({"User-Agent": "map-router/3.0"})


def _resolve_coordinates(address, provided=None):
    if isinstance(provided, (list, tuple)) and len(provided) >= 2:
        try:
            lat = float(provided[0])
            lon = float(provided[1])
            if -90 <= lat <= 90 and -180 <= lon <= 180:
                return lat, lon
        except (TypeError, ValueError):
            pass
    return get_coordinates(address)


@lru_cache(maxsize=192)
def _osrm_route(start_lat, start_lon, end_lat, end_lon, alternatives):
    url = f"{OSRM_URL}/{start_lon},{start_lat};{end_lon},{end_lat}"
    response = _session.get(
        url,
        params={
            "overview": "full",
            "geometries": "geojson",
            "steps": "true",
            "alternatives": int(alternatives),
        },
        timeout=REQUEST_TIMEOUT,
    )
    response.raise_for_status()
    return response.json()


def get_driving_route(
    start_address,
    end_address,
    alternatives=3,
    start_coordinates=None,
    end_coordinates=None,
):
    start = _resolve_coordinates(start_address, start_coordinates)
    end = _resolve_coordinates(end_address, end_coordinates)

    if start is None:
        return {
            "success": False,
            "error": explain_address_problem(
                start_address, "Starting address couldn't be found."
            ),
        }

    if end is None:
        return {
            "success": False,
            "error": explain_address_problem(
                end_address, "Destination couldn't be found."
            ),
        }

    start_lat, start_lon = map(float, start)
    end_lat, end_lon = map(float, end)

    cache_key = (
        round(start_lat, 6),
        round(start_lon, 6),
        round(end_lat, 6),
        round(end_lon, 6),
        max(0, min(int(alternatives), 3)),
    )

    try:
        data = _osrm_route(*cache_key)
    except requests.RequestException as error:
        return {"success": False, "error": f"Driving routing server error: {error}"}
    except ValueError:
        return {
            "success": False,
            "error": "Driving routing server returned invalid data.",
        }

    if data.get("code") != "Ok":
        return {
            "success": False,
            "error": data.get("message", "No driving route could be found."),
        }

    if not data.get("routes"):
        return {"success": False, "error": "No driving routes were found."}

    routes = []
    for index, route_data in enumerate(data["routes"]):
        distance_km = float(route_data.get("distance", 0) or 0) / 1000
        duration_min = float(route_data.get("duration", 0) or 0) / 60
        average_speed = distance_km / (duration_min / 60) if duration_min > 0 else 0

        geometry = route_data.get("geometry", {}).get("coordinates", [])
        route_coordinates = [[lat, lon] for lon, lat in geometry]

        steps = []
        for leg in route_data.get("legs", []):
            for step in leg.get("steps", []):
                maneuver = step.get("maneuver", {})
                location = maneuver.get("location") or []
                step_coordinate = (
                    [float(location[1]), float(location[0])]
                    if len(location) >= 2
                    else None
                )
                steps.append(
                    {
                        "instruction": "",
                        "type": maneuver.get("type", ""),
                        "modifier": maneuver.get("modifier", ""),
                        "road": step.get("name", ""),
                        "name": step.get("name", ""),
                        "distance_m": step.get("distance", 0),
                        "duration_min": float(step.get("duration", 0) or 0) / 60,
                        "coordinates": step_coordinate,
                    }
                )

        routes.append(
            {
                "route_number": index + 1,
                "distance_km": distance_km,
                "duration_min": duration_min,
                "average_speed": average_speed,
                "steps": steps,
                "route_coordinates": route_coordinates,
            }
        )

    fastest_route = min(routes, key=lambda route: route["duration_min"])
    shortest_route = min(routes, key=lambda route: route["distance_km"])

    return {
        "success": True,
        "mode": "driving",
        "start": {"address": start_address, "coordinates": [start_lat, start_lon]},
        "end": {"address": end_address, "coordinates": [end_lat, end_lon]},
        "routes": routes,
        "fastest_route_number": fastest_route["route_number"],
        "shortest_route_number": shortest_route["route_number"],
    }
