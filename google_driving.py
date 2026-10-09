"""Traffic-aware Google Routes provider for the Google-only driving map.

Google Maps Platform Routes content must be displayed on a Google basemap;
never overlay these coordinates on MapTiler/Leaflet.
"""
import os
import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import requests

ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
ROUTES_FIELDS = (
    "routes.duration,routes.staticDuration,routes.distanceMeters,"
    "routes.polyline.encodedPolyline,"
    "routes.legs.steps.distanceMeters,routes.legs.steps.staticDuration,"
    "routes.legs.steps.navigationInstruction,routes.legs.steps.startLocation"
)
_session = requests.Session()


def decode_polyline(encoded):
    """Google encoded polyline -> [lat, lng] pairs (precision 5)."""
    result = []
    latitude = longitude = position = 0
    while position < len(encoded):
        increments = []
        for _ in range(2):
            shift = delta = 0
            while True:
                if position >= len(encoded):
                    raise ValueError("Invalid Google route polyline")
                value = ord(encoded[position]) - 63
                position += 1
                delta |= (value & 0x1F) << shift
                shift += 5
                if value < 0x20:
                    break
            increments.append(~(delta >> 1) if delta & 1 else delta >> 1)
        latitude += increments[0]
        longitude += increments[1]
        result.append([latitude / 1e5, longitude / 1e5])
    return result


def seconds(value):
    match = re.match(r"^([\d.]+)s$", str(value or ""))
    return float(match.group(1)) if match else 0.0


def _maneuver(raw):
    name = str(raw or "").lower()
    if "left" in name:
        return "turn", "left"
    if "right" in name:
        return "turn", "right"
    if "roundabout" in name:
        return "roundabout", ""
    if "merge" in name:
        return "merge", ""
    if "depart" in name:
        return "depart", ""
    if "arrive" in name or "destination" in name:
        return "arrive", ""
    return "continue", "straight"


def google_driving_route(start_address, end_address, start, end):
    key = os.getenv("GOOGLE_MAPS_ROUTES_KEY", "").strip()
    if not key:
        raise RuntimeError("Google Routes API key is missing")

    def point(coordinate):
        return {"location": {"latLng": {
            "latitude": float(coordinate[0]),
            "longitude": float(coordinate[1]),
        }}}

    response = _session.post(
        ROUTES_URL,
        headers={
            "Content-Type": "application/json",
            "X-Goog-Api-Key": key,
            "X-Goog-FieldMask": ROUTES_FIELDS,
        },
        json={
            "origin": point(start),
            "destination": point(end),
            "travelMode": "DRIVE",
            "routingPreference": "TRAFFIC_AWARE",
            "computeAlternativeRoutes": True,
            "languageCode": "en-CA",
            "units": "METRIC",
            "polylineQuality": "HIGH_QUALITY",
        },
        timeout=(2.5, 5.0),
    )
    response.raise_for_status()
    payload = response.json()
    if not payload.get("routes"):
        raise ValueError("Google returned no driving routes")

    routes = []
    for i, route in enumerate(payload["routes"]):
        coordinates = decode_polyline(route.get("polyline", {}).get("encodedPolyline", ""))
        if len(coordinates) < 2:
            continue
        distance_km = float(route.get("distanceMeters", 0)) / 1000
        duration_min = seconds(route.get("duration")) / 60
        typical_min = seconds(route.get("staticDuration")) / 60
        steps = []
        for leg in route.get("legs", []):
            for raw_step in leg.get("steps", []):
                instruction = raw_step.get("navigationInstruction", {})
                kind, modifier = _maneuver(instruction.get("maneuver"))
                location = raw_step.get("startLocation", {}).get("latLng", {})
                point_coords = (
                    [location["latitude"], location["longitude"]]
                    if "latitude" in location and "longitude" in location
                    else None
                )
                steps.append({
                    "instruction": instruction.get("instructions", "Continue"),
                    "type": kind,
                    "modifier": modifier,
                    "name": "",
                    "road": "",
                    "distance_m": float(raw_step.get("distanceMeters", 0)),
                    "duration_min": seconds(raw_step.get("staticDuration")) / 60,
                    "coordinates": point_coords,
                })
        routes.append({
            "route_number": i + 1,
            "distance_km": round(distance_km, 2),
            "duration_min": round(duration_min, 2),
            "typical_duration_min": round(typical_min, 2),
            "traffic_delay_min": round(max(0, duration_min - typical_min), 1),
            "average_speed": round(distance_km / (duration_min / 60), 1) if duration_min else 0,
            "steps": steps,
            "route_coordinates": coordinates,
        })
    if not routes:
        raise ValueError("Google returned no valid driving geometry")
    fastest = min(routes, key=lambda route: route["duration_min"])
    shortest = min(routes, key=lambda route: route["distance_km"])
    return {
        "success": True,
        "mode": "driving",
        "routing_provider": "google",
        "traffic_aware": True,
        "start": {"address": start_address, "coordinates": list(start)},
        "end": {"address": end_address, "coordinates": list(end)},
        "routes": routes,
        "fastest_route_number": fastest["route_number"],
        "shortest_route_number": shortest["route_number"],
    }
