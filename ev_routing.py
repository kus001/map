"""Opt-in TomTom EV trip planning. Ordinary OSRM driving never calls this service.

All TomTom credentials stay on the Flask server. Charging/battery specifications
are editable and are estimates rather than vehicle-manufacturer guarantees.
"""
import os
import math
import requests

from driving import _resolve_coordinates

_URL = "https://api.tomtom.com/routing/1/calculateLongDistanceEVRoute"
_ALLOWED_PLUGS = {
    "ccs1": "Combo_to_IEC_62196_Type_1_Base",
    "ccs2": "Combo_to_IEC_62196_Type_2_Base",
    "chademo": "CHAdeMO",
    "tesla": "Tesla_Connector",
}
_session = requests.Session()


def _number(value, low, high, name):
    try:
        number = float(value)
    except (ValueError, TypeError):
        raise ValueError(f"{name} must be a number.") from None
    if not math.isfinite(number) or not low <= number <= high:
        raise ValueError(f"{name} must be between {low} and {high}.")
    return number


def validate_ev_options(options):
    if not isinstance(options, dict):
        raise ValueError("EV battery and charging details are required.")
    cap = _number(options.get("battery_kwh"), 10, 200, "Battery capacity")
    soc = _number(options.get("charge_percent"), 1, 100, "Current battery charge")
    reserve = _number(options.get("reserve_percent"), 0, 40, "Minimum reserve")
    consumption = _number(options.get("consumption_kwh_100km"), 8, 50, "Energy consumption")
    kw = _number(options.get("max_charge_kw"), 10, 350, "Maximum charging power")
    plug = str(options.get("plug") or "ccs1").lower()
    if plug not in _ALLOWED_PLUGS:
        raise ValueError("Unsupported charging connector.")
    if reserve >= soc:
        raise ValueError("Current charge must be greater than your arrival reserve.")
    return dict(capacity=cap, charge=cap * soc / 100, reserve=cap * reserve / 100,
                consumption=consumption, charging_kw=kw, plug=plug)


def _coordinate(point):
    """Convert a TomTom GeoJSON-like point to kmaps' [lat, lon] order."""
    if not isinstance(point, dict):
        return None
    try:
        lat = float(point["latitude"])
        lon = float(point["longitude"])
    except (TypeError, ValueError, KeyError):
        return None
    if math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180:
        return [lat, lon]
    return None


def _route_coordinates(route):
    """TomTom places its road polyline in *each leg*, not in route.points.

    Long-distance EV trips can have several legs separated by automatic charge
    stops. Stitch their road geometry together without duplicating junctions.
    """
    legs = route.get("legs") or [route]
    coordinates = []
    for leg in legs:
        if not isinstance(leg, dict):
            continue
        for point in leg.get("points") or []:
            pair = _coordinate(point)
            if pair and (not coordinates or pair != coordinates[-1]):
                coordinates.append(pair)
    return coordinates


def _maneuver_type(instruction):
    maneuver = str(instruction.get("maneuver") or "").upper()
    kind = str(instruction.get("instructionType") or "").upper()
    if "DEPART" in maneuver or kind == "LOCATION_DEPARTURE":
        return "depart"
    if "ARRIVE" in maneuver or kind == "LOCATION_ARRIVAL":
        return "arrive"
    if "ROUNDABOUT" in maneuver:
        return "roundabout"
    if "U_TURN" in maneuver:
        return "u_turn"
    if "KEEP" in maneuver or "FORK" in maneuver:
        return "fork"
    if "TURN" in maneuver or kind == "TURN":
        return "turn"
    return "continue"


def _guidance_steps(route, coordinates, distance_m, duration_seconds):
    """Translate TomTom v1 guidance to the existing driving directions schema."""
    guidance = route.get("guidance") or {}
    instructions = guidance.get("instructions") or []
    if not instructions:
        # Be tolerant of variants that attach guidance to individual legs.
        for leg in route.get("legs") or []:
            instructions.extend((leg.get("guidance") or {}).get("instructions") or [])

    steps = []
    for index, item in enumerate(instructions):
        if not isinstance(item, dict):
            continue
        here = _coordinate(item.get("point"))
        # TomTom's pointIndex refers to the route polyline when specified.
        if here is None:
            try:
                at = int(item["pointIndex"])
                if 0 <= at < len(coordinates):
                    here = coordinates[at]
            except (ValueError, TypeError, KeyError):
                pass
        try:
            this_distance = max(0.0, float(item.get("routeOffsetInMeters") or 0))
            this_time = max(0.0, float(item.get("travelTimeInSeconds") or 0))
        except (TypeError, ValueError):
            this_distance, this_time = 0.0, 0.0
        next_item = instructions[index + 1] if index + 1 < len(instructions) else {}
        try:
            next_distance = float(next_item.get("routeOffsetInMeters", distance_m))
            next_time = float(next_item.get("travelTimeInSeconds", duration_seconds))
        except (ValueError, TypeError):
            next_distance, next_time = distance_m, duration_seconds
        steps.append({
            "instruction": str(item.get("message") or item.get("combinedMessage") or "").strip(),
            "type": _maneuver_type(item),
            "modifier": str(item.get("maneuver") or "").lower().replace("_", " "),
            "road": str(item.get("street") or ""),
            "name": str(item.get("street") or ""),
            "coordinates": here,
            "distance_m": max(0.0, next_distance - this_distance),
            "duration_min": max(0.0, next_time - this_time) / 60,
            "_route_offset_m": this_distance,
        })
    return steps


def _stops_and_steps(route):
    stops = []
    steps = []
    traveled_m = 0.0
    for leg in route.get("legs") or []:
        if not isinstance(leg, dict):
            continue
        leg_summary = leg.get("summary") or {}
        try:
            traveled_m += max(0.0, float(leg_summary.get("lengthInMeters") or 0))
        except (ValueError, TypeError):
            pass
        charge = leg_summary.get("chargingInformationAtEndOfLeg")
        if not isinstance(charge, dict):
            continue
        location = (charge.get("chargingParkLocation") or {}).get("coordinate")
        point = _coordinate(location)
        if point is None:
            # A leg's final road vertex is its end location, even if the charging
            # park's more precise coordinates aren't supplied.
            points = leg.get("points") or []
            point = _coordinate(points[-1]) if points else None
        if point is None:
            continue
        try:
            minutes = max(0.0, float(charge.get("chargingTimeInSeconds") or 0) / 60)
        except (TypeError, ValueError):
            minutes = 0.0
        name = str(charge.get("chargingParkName") or "EV charging stop")
        stops.append({
            "coordinates": point,
            "name": name,
            "charging_time_min": round(minutes, 1),
            "operator": charge.get("chargingParkOperatorName"),
        })
        steps.append({
            "instruction": f"Charge at {name} ({round(minutes)} min estimated)",
            "type": "charge",
            "modifier": "",
            "road": "",
            "name": name,
            "coordinates": point,
            "distance_m": 0,
            "duration_min": minutes,
            "_route_offset_m": traveled_m,
        })
    return stops, steps


def get_ev_route(start_address, end_address, start_coordinates=None,
                 end_coordinates=None, options=None, bias=None, timing=None):
    key = os.getenv("TOMTOM_API_KEY", "").strip()
    if not key:
        return {"success": False, "error": "EV routing needs TOMTOM_API_KEY in the backend .env."}
    try:
        profile = validate_ev_options(options)
    except ValueError as exc:
        return {"success": False, "error": str(exc)}
    start = _resolve_coordinates(start_address, start_coordinates, bias=end_coordinates or bias)
    end = _resolve_coordinates(end_address, end_coordinates, bias=start or bias)
    if not start or not end:
        return {"success": False, "error": "Could not locate the EV start or destination."}

    cap, charging_kw = profile["capacity"], profile["charging_kw"]
    # A minimal generic speed-dependent profile. Vehicle-specific curves should
    # replace this approximation for accurate estimates.
    curve = f"50,{profile['consumption'] * 0.84:.3f}:120,{profile['consumption'] * 1.28:.3f}"
    params = {
        "key": key,
        "vehicleEngineType": "electric",
        "currentChargeInkWh": f"{profile['charge']:.3f}",
        "maxChargeInkWh": f"{cap:.3f}",
        "minChargeAtDestinationInkWh": f"{profile['reserve']:.3f}",
        "minChargeAtChargingStopsInkWh": f"{profile['reserve']:.3f}",
        "constantSpeedConsumptionInkWhPerHundredkm": curve,
        "chargingStopsStrategy": "automaticFastest",
        "traffic": "true", "maxAlternatives": 0,
        "routeRepresentation": "polyline", "instructionsType": "text",
    }
    post_data = {
        "chargingParameters": {
            "batteryCurveInterpolation": "piecewiseLinear",
            "batteryCurve": [
                {"stateOfChargeInkWh": 0, "maxPowerInkW": charging_kw},
                {"stateOfChargeInkWh": round(cap * 0.72, 3), "maxPowerInkW": charging_kw},
                {"stateOfChargeInkWh": round(cap, 3), "maxPowerInkW": max(6, charging_kw * .25)},
            ],
            "chargingConnectors": [{
                "currentType": "DC", "plugTypes": [_ALLOWED_PLUGS[profile["plug"]]],
                "efficiency": 0.92, "baseLoadInkW": 0.25, "maxPowerInkW": charging_kw,
            }],
            "chargingTimeOffsetInSec": 90,
        }
    }
    location_path = f"{start[0]:.6f},{start[1]:.6f}:{end[0]:.6f},{end[1]:.6f}"
    try:
        response = _session.post(f"{_URL}/{location_path}/json", params=params,
                                 json=post_data, timeout=(3, 14))
        if not response.ok:
            try:
                message = response.json().get("detailedError", {}).get("message")
            except (ValueError, TypeError, AttributeError):
                message = None
            return {"success": False, "error": f"TomTom EV routing: {message or 'HTTP ' + str(response.status_code)}"}
        data = response.json()
    except (requests.RequestException, ValueError) as exc:
        return {"success": False, "error": f"EV routing unavailable: {exc}"}

    routes = []
    for item in data.get("routes", [])[:3]:
        if not isinstance(item, dict):
            continue
        summary = item.get("summary") or {}
        # A route-level 'points' lookup will always miss a valid multi-leg EV
        # response; TomTom's points belong to each leg.
        coords = _route_coordinates(item)
        if len(coords) < 2:
            continue  # Never claim success with a blank map or invented straight line.
        distance_m = float(summary.get("lengthInMeters") or 0)
        duration_seconds = float(summary.get("travelTimeInSeconds") or 0)
        distance_km = distance_m / 1000
        duration_min = duration_seconds / 60
        stops, charge_steps = _stops_and_steps(item)
        steps = _guidance_steps(item, coords, distance_m, duration_seconds)
        if not steps:
            # Explicitly limited directions are better than an empty panel. Do
            # not fabricate turns if the provider omitted detailed guidance.
            steps = [{
                "instruction": "Depart toward your destination",
                "type": "depart", "modifier": "", "road": "", "name": "",
                "coordinates": coords[0], "distance_m": distance_m,
                "duration_min": duration_min, "_route_offset_m": 0,
            }, {
                "instruction": "Arrive at your destination",
                "type": "arrive", "modifier": "", "road": "", "name": "",
                "coordinates": coords[-1], "distance_m": 0,
                "duration_min": 0, "_route_offset_m": distance_m,
            }]
        steps.extend(charge_steps)
        steps.sort(key=lambda step: step.get("_route_offset_m", 0))
        for step in steps:
            step.pop("_route_offset_m", None)
        routes.append({
            "route_number": len(routes) + 1, "route_coordinates": coords,
            "distance_km": distance_km,
            "duration_min": duration_min,
            "average_speed": distance_km / (duration_min / 60) if duration_min > 0 else 0,
            "steps": steps, "charging_stops": stops,
            "traffic_delay_min": round(float(summary.get("trafficDelayInSeconds") or 0) / 60, 1),
            "total_charging_min": round(float(summary.get("totalChargingTimeInSeconds") or 0) / 60, 1),
            "remaining_charge_kwh": summary.get("remainingChargeAtArrivalInkWh"),
        })
    if not routes:
        return {"success": False, "error": (
            "TomTom did not return usable route geometry. Please retry your EV route."
            if data.get("routes") else "No EV route found for this battery profile."
        )}
    return {
        "success": True, "mode": "driving", "routing_provider": "tomtom_ev",
        "traffic_aware": True, "ev_profile_estimated": True,
        "start": {"address": start_address, "coordinates": list(start)},
        "end": {"address": end_address, "coordinates": list(end)},
        "routes": routes,
        "fastest_route_number": min(routes, key=lambda r: r["duration_min"])["route_number"],
        "shortest_route_number": min(routes, key=lambda r: r["distance_km"])["route_number"],
    }
