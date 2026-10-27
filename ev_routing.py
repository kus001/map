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


def _points(route):
    seen = []
    for point in route.get("points", []):
        try:
            lat, lon = float(point["latitude"]), float(point["longitude"])
        except (ValueError, TypeError, KeyError):
            continue
        if -90 <= lat <= 90 and -180 <= lon <= 180:
            seen.append([lat, lon])
    return seen


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
        "traffic": "true", "maxAlternatives": 0, "instructionsType": "text",
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
    for index, item in enumerate(data.get("routes", [])[:3]):
        summary = item.get("summary") or {}
        coords = _points(item)
        stops = []
        for leg in item.get("legs", []):
            end_info = (leg.get("summary") or {}).get("chargingInformationAtEndOfLeg")
            if not end_info:
                continue
            park = end_info.get("chargingParkLocation") or {}
            point = park.get("coordinate") or {}
            try:
                loc = [float(point["latitude"]), float(point["longitude"])]
            except (ValueError, TypeError, KeyError):
                continue
            stops.append({"coordinates": loc,
                          "name": end_info.get("chargingParkName") or "EV charging stop",
                          "charging_time_min": round(float(end_info.get("chargingTimeInSeconds") or 0) / 60, 1),
                          "operator": end_info.get("chargingParkOperatorName")})
        routes.append({
            "route_number": index + 1, "route_coordinates": coords,
            "distance_km": float(summary.get("lengthInMeters") or 0) / 1000,
            "duration_min": float(summary.get("travelTimeInSeconds") or 0) / 60,
            "average_speed": 0, "steps": [], "charging_stops": stops,
            "traffic_delay_min": round(float(summary.get("trafficDelayInSeconds") or 0) / 60, 1),
            "total_charging_min": round(float(summary.get("totalChargingTimeInSeconds") or 0) / 60, 1),
            "remaining_charge_kwh": summary.get("remainingChargeAtArrivalInkWh"),
        })
    if not routes:
        return {"success": False, "error": "No EV route found for this battery profile."}
    return {
        "success": True, "mode": "driving", "routing_provider": "tomtom_ev",
        "traffic_aware": True, "ev_profile_estimated": True,
        "start": {"address": start_address, "coordinates": list(start)},
        "end": {"address": end_address, "coordinates": list(end)},
        "routes": routes,
        "fastest_route_number": min(routes, key=lambda r: r["duration_min"])["route_number"],
        "shortest_route_number": min(routes, key=lambda r: r["distance_km"])["route_number"],
    }
