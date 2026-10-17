import json
import os
import sys
import math
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from flask import Flask, jsonify, request
from dotenv import load_dotenv

# Load root .env before importing providers (their config is read at import time).
load_dotenv()

from cycling import get_cycling_route
from driving import get_driving_route
from helpers.geocoding import (
    address_options,
    explain_address_problem,
    remember_place,
    search_places,
)
from helpers.time_management import us
from walking import get_walking_route

app = Flask(__name__)

VALID_CYCLING_TYPES = {"regular", "road", "mountain", "electric"}
VALID_TRANSIT_PREFERENCES = {"balanced", "less_walking", "fastest"}
APP_TIMEZONE = ZoneInfo("America/Toronto")

# Local-development mode brings back the convenient testing behaviour from the
# older project without forcing the 2 GB production server to run that way.
DEV_MODE = "--dev" in sys.argv or os.getenv("MAP_DEV_MODE", "0") == "1"
PRINT_ROUTE_TIMING = DEV_MODE or os.getenv("MAP_ROUTE_TIMING", "0") == "1"


def parse_departure_datetime(value):
    """Parse a browser datetime-local value as Waterloo/Toronto local time."""
    if value is None or str(value).strip() == "":
        return None

    try:
        parsed = datetime.fromisoformat(str(value).strip())
    except ValueError as error:
        raise ValueError("Invalid departure date or time.") from error

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=APP_TIMEZONE)
    else:
        parsed = parsed.astimezone(APP_TIMEZONE)

    # Small grace window so a route submitted exactly on the minute is not rejected.
    if parsed < datetime.now(APP_TIMEZONE) - timedelta(minutes=2):
        raise ValueError("Scheduled departure must be in the future.")

    return parsed


def parse_coordinates(value):
    if not isinstance(value, (list, tuple)) or len(value) < 2:
        return None
    try:
        lat = float(value[0])
        lon = float(value[1])
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return [lat, lon]


def address_issue_for(start, destination, start_coordinates, destination_coordinates):
    """Describe a typed address that needs the user's choice, in a form the UI can show.

    Only fields the browser did not already pin to coordinates are checked. Returns
    ``{"field", "kind", "message", "options": [{label, lat, lon}]}`` or None. The
    other end of the trip is used as a proximity bias so the nearest option is first.
    """
    for field, text, pinned, other in (
        ("start", start, start_coordinates, destination_coordinates),
        ("destination", destination, destination_coordinates, start_coordinates),
    ):
        if pinned is not None:
            continue
        kind, options = address_options(text, bias=other)
        if options:
            return {
                "field": field,
                "kind": kind,
                "message": explain_address_problem(text),
                "options": options,
            }
    return None


def summarize_route_timing(timing, total_us):
    """Convert cumulative provider checkpoints into exclusive stage durations."""
    if timing is None:
        return {"routing": round(total_us / 1000, 1)}

    stages = {}
    previous = 0
    for stage, timestamp_us in timing.items():
        if stage == "start":
            continue
        elapsed = max(0, int(timestamp_us) - previous)
        stages[stage] = round(elapsed / 1000, 1)
        previous = max(previous, int(timestamp_us))
    remainder = max(0, int(total_us) - previous)
    if remainder >= 1000 or not stages:
        stages["other"] = round(remainder / 1000, 2)
    return stages


def print_timing_report(mode, timing, total_microseconds):
    report = summarize_route_timing(timing, total_microseconds)
    report["total_request"] = round(total_microseconds / 1000, 1)
    print(f"\n[{mode.upper()} ROUTE TIMING] {json.dumps(report, sort_keys=True)}", flush=True)




@app.post("/api/transit/walk-shapes")
def finished_transit_walks():
    """Read already-fetched walking geometry; never makes outbound requests."""
    payload = request.get_json(silent=True) or {}
    pairs = payload.get("pairs", [])
    if not isinstance(pairs, list):
        return jsonify({"success": False, "error": "Expected a list of walking legs."}), 400
    from transit import ready_walks
    return jsonify({"success": True, "shapes": ready_walks(pairs)})


@app.get("/api/layers/ontario511")
def ontario_511_layer():
    from helpers.ontario511 import get_layer

    kind = request.args.get("kind", "").strip().lower()
    try:
        values = [float(x) for x in request.args.get("bbox", "").split(",")]
        if len(values) != 4 or not all(math.isfinite(x) for x in values):
            raise ValueError()
        west, south, east, north = values
        if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
            raise ValueError()
        if kind not in ("incidents", "construction", "cameras", "winter"):
            raise ValueError()
    except ValueError:
        return jsonify({"success": False, "error": "Invalid map layer or bounds."}), 400

    result = get_layer(kind, (west, south, east, north))
    return jsonify({"success": True, **result})


@app.route("/api/health", methods=["GET"])
def health():
    from helpers.warmup import status
    state = status()
    return jsonify({
        "success": True,
        "message": "Map routing API is running.",
        **state,
    })


@app.route("/api/search", methods=["GET"])
def search():
    query = request.args.get("q", "").strip()

    try:
        limit = int(request.args.get("limit", 6))
    except ValueError:
        limit = 6

    if len(query) < 2:
        return jsonify({"success": True, "results": []})
    if len(query) > 200:
        return jsonify({"success": False, "error": "Search is too long."}), 400

    # Optional proximity bias (the user's location / other end of the trip). It only
    # orders equally good matches; a bad value is ignored rather than rejected.
    bias = parse_coordinates([request.args.get("lat"), request.args.get("lon")])

    try:
        results = search_places(query, limit=max(1, min(limit, 10)), bias=bias)
    except Exception:
        app.logger.exception("Local place search failed")
        return jsonify({"success": False, "error": "Place search is temporarily unavailable."}), 503
    return jsonify({"success": True, "results": results})


@app.route("/api/remember-place", methods=["POST"])
def remember():
    payload = request.get_json() or {}
    label = str(payload.get("label", "")).strip()

    try:
        lat = float(payload.get("lat"))
        lon = float(payload.get("lon"))
    except (TypeError, ValueError):
        return jsonify({"success": False, "error": "Invalid coordinates."}), 400

    if not label or not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
        return jsonify({"success": False, "error": "Invalid place."}), 400

    remember_place(label, lat, lon)
    return jsonify({"success": True})


@app.route("/api/transit/live-departures", methods=["GET"])
def live_transit_departures():
    agency = str(request.args.get("agency", "go")).strip().lower()
    stop_id = str(request.args.get("stop_id", "")).strip()

    try:
        limit = max(1, min(int(request.args.get("limit", 6)), 12))
    except (TypeError, ValueError):
        limit = 6

    if agency != "go":
        return jsonify({
            "success": False,
            "error": "Live stop boards are currently available for GO Transit only.",
        }), 400

    if not stop_id:
        return jsonify({"success": False, "error": "stop_id is required."}), 400

    from helpers._transit.go_realtime import live_departures

    result = live_departures(stop_id, limit=limit)
    return jsonify({
        "success": bool(result.get("connected")),
        **result,
    })


@app.route("/api/transit/live-state", methods=["POST"])
def live_transit_state():
    payload = request.get_json() or {}
    raw_steps = payload.get("steps") or []
    if not isinstance(raw_steps, list):
        raw_steps = []
    raw_steps = raw_steps[:16]

    from helpers._transit.go_realtime import gtfs_snapshot as go_gtfs_snapshot
    from helpers._transit.realtime import (
        matching_alerts,
        snapshot as grt_snapshot,
        vehicle_for_trip,
    )
    from transit import (
        combine_realtime,
        live_vehicle_is_usable,
        scheduled_vehicle_positions,
    )

    grt = grt_snapshot()
    go = go_gtfs_snapshot()
    realtime = combine_realtime(grt, go)

    route_ids = set()
    stop_ids = set()
    trip_ids = set()
    trip_states = []
    vehicles = []
    seen_vehicles = set()

    for step in raw_steps:
        if not isinstance(step, dict) or step.get("type") != "transit":
            continue
        agency = str(step.get("agency") or "")
        trip_id = str(step.get("trip_id") or "")
        if not agency or not trip_id:
            continue

        route = step.get("route")
        route_id = step.get("route_id")
        if route is not None:
            route_ids.add(str(route))
        if route_id is not None:
            route_ids.add(str(route_id))
        for key in ("from_stop_id", "to_stop_id"):
            if step.get(key) is not None:
                stop_ids.add(str(step[key]))
        trip_ids.add(trip_id)

        update = realtime.get("trip_updates", {}).get((agency, trip_id))
        delay_seconds = 0.0
        cancelled = False
        if update:
            cancelled = bool(update.get("cancelled"))
            stop_update = update.get("stops", {}).get(str(step.get("from_stop_id") or ""), {})
            delay = stop_update.get("departure_delay")
            if delay is None:
                delay = stop_update.get("arrival_delay")
            if delay is None:
                delay = update.get("delay")
            delay_seconds = float(delay or 0)

        trip_states.append({
            "agency": agency,
            "trip_id": trip_id,
            "delay_seconds": delay_seconds,
            "cancelled": cancelled,
            "realtime": bool(update),
        })

        vehicle = vehicle_for_trip(realtime, agency, trip_id)
        vehicle_key = (agency, trip_id)
        if live_vehicle_is_usable(vehicle) and vehicle_key not in seen_vehicles:
            vehicles.append({
                **vehicle,
                "route": route,
                "headsign": step.get("headsign"),
                "position_source": "live",
                "estimated": False,
            })
            seen_vehicles.add(vehicle_key)

    # If a selected GRT/GO vehicle has no current GPS fix (feed outage, missing
    # entity, or a stale position), keep the map useful by estimating where the
    # scheduled trip should be from static GTFS. TripUpdate delays are still
    # applied when that realtime feed remains available.
    missing_vehicle_steps = [
        step
        for step in raw_steps
        if isinstance(step, dict)
        and step.get("type") == "transit"
        and (str(step.get("agency") or ""), str(step.get("trip_id") or ""))
        not in seen_vehicles
    ]
    scheduled_vehicles = scheduled_vehicle_positions(
        missing_vehicle_steps, realtime=realtime
    )
    for vehicle in scheduled_vehicles:
        vehicle_key = (str(vehicle.get("agency") or ""), str(vehicle.get("trip_id") or ""))
        if vehicle_key in seen_vehicles:
            continue
        vehicles.append(vehicle)
        seen_vehicles.add(vehicle_key)

    alerts = matching_alerts(
        realtime,
        route_ids,
        stop_ids,
        trip_ids=trip_ids,
        limit=8,
    )

    return jsonify({
        "success": True,
        "trip_states": trip_states,
        "live_vehicles": vehicles,
        "alerts": alerts,
        "scheduled_vehicle_fallback": any(
            bool(vehicle.get("estimated")) for vehicle in vehicles
        ),
        "sources": {
            "grt": {
                "trip_updates": bool(grt.get("available")),
                "vehicles": bool(grt.get("vehicles")),
                "alerts": bool(grt.get("alerts_available")),
                "feed_timestamp": grt.get("feed_timestamp"),
            },
            "go": {
                "configured": bool(os.getenv("METROLINX_API_KEY")),
                "trip_updates": bool(go.get("available")),
                "vehicles": bool(go.get("vehicles_available")),
                "alerts": bool(go.get("alerts_available")),
                "feed_timestamp": go.get("feed_timestamp"),
            },
        },
    })



@app.get("/api/transit/vehicles")
def nearby_transit_vehicles():
    """Nearby vehicle layer; does not block /api/routes or require a route."""
    try:
        lat = float(request.args["lat"])
        lon = float(request.args["lon"])
        radius = max(500, min(15000, float(request.args.get("radius", 5000))))
        if not -90 <= lat <= 90 or not -180 <= lon <= 180:
            raise ValueError("Out of range")
    except (KeyError, ValueError, TypeError):
        return jsonify({"success": False, "error": "Invalid map center"}), 400

    from helpers._transit.realtime import snapshot as grt_snapshot
    from helpers._transit.go_realtime import gtfs_snapshot as go_gtfs_snapshot
    from transit import live_vehicle_is_usable, nearby_scheduled_vehicles
    from math import radians, cos

    # Read cached GTFS-RT feeds only; no network request in this handler.
    snapshots = (grt_snapshot(), go_gtfs_snapshot())
    live = {}
    for snapshot in snapshots:
        for key, vehicle in snapshot.get("vehicles", {}).items():
            if not live_vehicle_is_usable(vehicle):
                continue
            vlat, vlon = vehicle.get("lat"), vehicle.get("lon")
            if not isinstance(vlat, (int, float)) or not isinstance(vlon, (int, float)):
                continue
            north_south = (vlat - lat) * 111195
            east_west = (vlon - lon) * 111195 * cos(radians(lat))
            if north_south * north_south + east_west * east_west > radius * radius:
                continue
            live[str(key)] = {**vehicle, "estimated": False, "position_source": "live"}

    # If GPS is missing, provide *nearby current* GTFS estimates, not just the
    # selected route's vehicle (which could be hours from departure).
    estimates = nearby_scheduled_vehicles(lat, lon, radius_m=radius, limit=45)
    unique_live = {
        (str(v.get("agency")), str(v.get("trip_id"))) for v in live.values()
    }
    for estimate in estimates:
        key = (estimate["agency"], estimate["trip_id"])
        if key in unique_live:
            continue
        live["scheduled:" + ":".join(key)] = estimate

    return jsonify({"success": True, "vehicles": list(live.values())[:90],
                    "live_count": len(unique_live),
                    "estimated_count": sum(bool(v.get("estimated")) for v in live.values())})

@app.get("/api/transit/stops")
def transit_stops_nearby():
    try:
        lat = float(request.args['lat'])
        lon = float(request.args['lon'])
        radius = float(request.args.get('radius', 2500))
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise ValueError('Invalid coordinates')
        from transit import nearby_transit_stops
        return jsonify({'success': True, 'stops': nearby_transit_stops(lat, lon, radius)})
    except (ValueError, TypeError, KeyError):
        return jsonify({'success': False, 'error': 'Invalid map center.'}), 400


@app.get("/api/transit/stop-board")
def transit_stop_board():
    stop_id = str(request.args.get('stop_id') or '')
    if not stop_id or len(stop_id) > 160:
        return jsonify({'success': False, 'error': 'stop_id is required.'}), 400
    from transit import stop_departure_board
    result = stop_departure_board(stop_id)
    if result is None:
        return jsonify({'success': False, 'error': 'Unknown transit stop.'}), 404
    return jsonify({'success': True, **result})


@app.post("/api/transit/alternatives")
def transit_alternatives():
    payload = request.get_json(silent=True) or {}
    start = str(payload.get("start") or "").strip()
    end = str(payload.get("destination") or "").strip()
    choice = str(payload.get("priority") or "fastest")
    if not start or not end or choice not in {"fastest", "less_walking"}:
        return jsonify({"success": False, "error": "Invalid alternative request."}), 400
    timing_mode = str(payload.get("timing_mode") or "now")
    if timing_mode not in {"now", "scheduled", "arrive_by"}:
        return jsonify({"success": False, "error": "Invalid timing mode."}), 400
    try:
        departure = parse_departure_datetime(payload.get("departure_datetime"))
    except (ValueError, TypeError) as exc:
        return jsonify({"success": False, "error": str(exc)}), 400

    # Exclude a used service if it keeps giving us exactly the same journey.
    previous = payload.get("existing_routes") or []
    signatures = set()
    possible_exclusions = []
    for past in previous[:3] if isinstance(previous, list) else []:
        if not isinstance(past, dict):
            continue
        steps = [step for step in past.get("steps", []) if isinstance(step, dict) and step.get("type") == "transit"]
        signatures.add(tuple((str(step.get("agency")), str(step.get("trip_id"))) for step in steps))
        for step in steps:
            agency = str(step.get("agency") or "")
            service = str(step.get("route_id") or step.get("route") or "")
            if agency and service:
                possible_exclusions.append({(agency, service)})

    try:
        from transit import get_transit_route
        for excluded in [set(), *possible_exclusions[:3]]:
            result = get_transit_route(
                start, end, departure_datetime=departure,
                transit_preference=choice,
                start_coordinates=parse_coordinates(payload.get("start_coordinates")),
                end_coordinates=parse_coordinates(payload.get("destination_coordinates")),
                arrive_by=departure if timing_mode == "arrive_by" else None,
                include_alternatives=False, excluded_route_keys=excluded,
            )
            if not result.get("success") or not result.get("routes"):
                continue
            route = result["routes"][0]
            legs = [step for step in route.get("steps", []) if step.get("type") == "transit"]
            signature = tuple((str(step.get("agency")), str(step.get("trip_id"))) for step in legs)
            if signature and signature not in signatures:
                route["route_variant"] = choice
                return jsonify({"success": True, "route": route})
    except Exception:
        app.logger.exception("Alternative transit routing failed")
        return jsonify({"success": False, "error": "Could not load route alternative."}), 500

    return jsonify({"success": True, "route": None})


@app.route("/api/routes", methods=["POST"])
def routes():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"success": False, "error": "Expected a JSON object.", "code": "invalid_request"}), 400

    start = payload.get("start")
    destination = payload.get("destination")
    if not isinstance(start, str) or not start.strip() or len(start) > 500:
        return jsonify({"success": False, "error": "Starting location is required (maximum 500 characters).", "code": "invalid_request"}), 400
    if not isinstance(destination, str) or not destination.strip() or len(destination) > 500:
        return jsonify({"success": False, "error": "Destination is required (maximum 500 characters).", "code": "invalid_request"}), 400
    start = start.strip()
    destination = destination.strip()

    for field in ("start_coordinates", "destination_coordinates"):
        if payload.get(field) is not None and parse_coordinates(payload[field]) is None:
            return jsonify({"success": False, "error": f"Invalid {field}.", "code": "invalid_request"}), 400
    start_coordinates = parse_coordinates(payload.get("start_coordinates"))
    destination_coordinates = parse_coordinates(payload.get("destination_coordinates"))
    mode = str(payload.get("mode", "driving")).strip().lower()
    if mode not in {"driving", "walking", "cycling", "transit"}:
        return jsonify({"success": False, "error": f"Unsupported travel mode: {mode}", "code": "invalid_request"}), 400

    transit_preference = str(payload.get("transit_preference") or "balanced").strip().lower()
    if transit_preference not in VALID_TRANSIT_PREFERENCES:
        return jsonify({"success": False, "error": "Invalid transit preference.", "code": "invalid_request"}), 400

    timing_mode = str(payload.get("timing_mode") or "now").lower()
    if timing_mode not in {"now", "scheduled", "arrive_by"}:
        return jsonify({"success": False, "error": "Invalid timing mode.", "code": "invalid_request"}), 400
    if timing_mode == "arrive_by" and mode != "transit":
        return jsonify({"success": False, "error": "Arrive By is supported for transit only."}), 400
    try:
        departure_datetime = parse_departure_datetime(payload.get("departure_datetime")) if mode == "transit" else None
    except (ValueError, TypeError) as error:
        return jsonify({"success": False, "error": str(error), "code": "invalid_request"}), 400

    request_started = us()
    timing = {"start": request_started}
    try:
        if mode == "driving":
            result = get_driving_route(
                start, destination, start_coordinates=start_coordinates,
                end_coordinates=destination_coordinates,
                timing=timing,
            )
        elif mode == "walking":
            result = get_walking_route(
                start, destination, start_coordinates=start_coordinates,
                end_coordinates=destination_coordinates, timing=timing,
            )
        elif mode == "cycling":
            route_type = str(payload.get("route_type", "regular")).strip().lower()
            if route_type not in VALID_CYCLING_TYPES:
                route_type = "regular"
            result = get_cycling_route(
                start, destination, route_type=route_type,
                start_coordinates=start_coordinates,
                end_coordinates=destination_coordinates, timing=timing,
            )
        else:
            from transit import get_transit_route
            result = get_transit_route(
                start, destination, departure_datetime=departure_datetime,
                timing=timing, transit_preference=transit_preference,
                start_coordinates=start_coordinates,
                end_coordinates=destination_coordinates,
                arrive_by=departure_datetime if timing_mode == "arrive_by" else None,
                include_alternatives=False,
                )
        if not isinstance(result, dict):
            raise TypeError("Routing provider did not return a response object")
    except Exception:
        # Avoid exposing tracebacks or API tokens to the browser. Keep full details
        # in the server log for debugging instead.
        app.logger.exception("Unexpected %s route error", mode)
        return jsonify({
            "success": False,
            "error": "Routing encountered an unexpected error. Please retry shortly.",
            "code": "internal_error",
        }), 500

    total_us = max(0, us() - request_started)
    stages = summarize_route_timing(timing, total_us)
    result["server_time_ms"] = round(total_us / 1000, 1)
    result["server_timing_ms"] = stages
    if result.get("success"):
        result["requested_departure_datetime"] = (
            departure_datetime.isoformat() if departure_datetime else None
        )
        result["timing_mode"] = timing_mode if mode == "transit" else "now"

    if PRINT_ROUTE_TIMING:
        print_timing_report(mode, timing, total_us)
    elif total_us >= 3_000_000:
        print(f"[SLOW ROUTE] {mode}: {total_us / 1_000_000:.2f}s; "
              f"stages={json.dumps(stages)}", flush=True)

    # Upstream routing outages and genuinely missing routes are different failures.
    error = str(result.get("error") or "")
    unavailable = any(value in error.lower() for value in (
        "server error", "routing unavailable", "routing server returned invalid",
    ))
    status_code = 200 if result.get("success") else (503 if unavailable else 404)
    if not result.get("success"):
        result["code"] = "provider_unavailable" if unavailable else "route_not_found"
        if not unavailable:
            issue = address_issue_for(
                start, destination, start_coordinates, destination_coordinates
            )
            if issue:
                result["address_issue"] = issue
    response = jsonify(result)
    response.status_code = status_code
    response.headers["Server-Timing"] = ", ".join(
        f"{name.replace('_', '-').replace(' ', '-')};dur={value}"
        for name, value in stages.items()
    )
    return response


def _should_warm_up():
    """Warm up in whichever process actually serves requests.

    With the dev auto-reloader, `python main.py` runs this module in a supervisor
    process and again in the reloaded child (WERKZEUG_RUN_MAIN=true). Only the
    child serves requests, so only the child should pay the loading cost/RAM.
    """
    if DEV_MODE:
        return os.getenv("WERKZEUG_RUN_MAIN") == "true"
    return True


# Load every graph/index/feed *before* the server accepts a request, so queries
# only do lookups. This runs at import time on purpose: it also covers WSGI
# hosts (gunicorn, Vercel) that import `main:app` instead of running this file.
# Set MAP_PRELOAD_TRANSIT=0 to go back to lazy loading.
if _should_warm_up():
    from helpers.warmup import warm_up
    warm_up()


if __name__ == "__main__":
    # Normal `python main.py` is the low-memory server-safe mode.
    # `python main.py --dev` restores the old local testing conveniences:
    # debug mode, automatic reload, detailed route timings, and verbose output.
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "8080"))

    if DEV_MODE:
        print("=" * 64)
        print("kmaps - LOCAL DEVELOPMENT MODE")
        print(f"http://{host}:{port}")
        print("Debug: ON | Auto reload: ON | Route timing: ON")
        print("All routing data is preloaded at startup (MAP_PRELOAD_TRANSIT=0 to disable).")
        print("=" * 64)

        app.run(
            host=host,
            port=port,
            debug=True,
            use_reloader=True,
        )
    else:
        debug = os.getenv("FLASK_DEBUG", "0") == "1"

        print("=" * 64)
        print("kmaps - LOW-MEMORY SERVER MODE")
        print(f"http://{host}:{port}")
        print("Use `python main.py --dev` for local debug/reload/timing mode.")
        print("=" * 64)

        # The Werkzeug reloader starts another Python process. Keep it disabled
        # in server mode so a 2 GB machine does not duplicate memory usage.
        app.run(
            host=host,
            port=port,
            debug=debug,
            use_reloader=False,
        )
