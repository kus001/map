import json
import os
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from flask import Flask, jsonify, request

from cycling import get_cycling_route
from driving import get_driving_route
from helpers.geocoding import remember_place, search_places
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


def print_timing_report(mode, timing, total_microseconds):
    """Pretty terminal timing output for local testing."""
    if timing is None:
        return

    report = {}
    for key, value in timing.items():
        if key == "start":
            continue
        report[key] = f"{value / 1000:.3f} ms"

    report["total_request"] = f"{total_microseconds / 1000:.3f} ms"

    print(f"\n[{mode.upper()} ROUTE TIMING]")
    print(json.dumps(report, indent=4))
    print()


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"success": True, "message": "Map routing API is running."})


@app.route("/api/search", methods=["GET"])
def search():
    query = request.args.get("q", "").strip()

    try:
        limit = int(request.args.get("limit", 6))
    except ValueError:
        limit = 6

    if len(query) < 2:
        return jsonify({"success": True, "results": []})

    return jsonify({
        "success": True,
        "results": search_places(query, limit=max(1, min(limit, 10))),
    })


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


@app.route("/api/routes", methods=["POST"])
def routes():
    payload = request.get_json() or {}

    start = str(payload.get("start", "")).strip()
    destination = str(payload.get("destination", "")).strip()
    mode = str(payload.get("mode", "driving")).strip().lower()
    transit_preference = str(
        payload.get("transit_preference", "balanced")
    ).strip().lower()
    if transit_preference not in VALID_TRANSIT_PREFERENCES:
        transit_preference = "balanced"

    if not start:
        return jsonify({"success": False, "error": "Starting location is required."}), 400

    if not destination:
        return jsonify({"success": False, "error": "Destination is required."}), 400

    try:
        departure_datetime = parse_departure_datetime(
            payload.get("departure_datetime")
        )
    except ValueError as error:
        return jsonify({"success": False, "error": str(error)}), 400

    request_started = us()
    timing = {"start": request_started} if PRINT_ROUTE_TIMING and mode == "transit" else None

    if mode == "driving":
        result = get_driving_route(start, destination)

    elif mode == "walking":
        result = get_walking_route(start, destination)

    elif mode == "cycling":
        route_type = str(payload.get("route_type", "regular")).strip().lower()
        if route_type not in VALID_CYCLING_TYPES:
            route_type = "regular"
        result = get_cycling_route(start, destination, route_type=route_type)

    elif mode == "transit":
        # Keep transit lazy in normal/server mode so the large graph is not loaded
        # unless somebody actually asks for a transit route.
        from transit import get_transit_route

        result = get_transit_route(
            start,
            destination,
            departure_datetime=departure_datetime,
            timing=timing,
            transit_preference=transit_preference,
        )

    else:
        return jsonify({
            "success": False,
            "error": f"Unsupported travel mode: {mode}",
        }), 400

    total_microseconds = us() - request_started

    if PRINT_ROUTE_TIMING:
        if timing is not None:
            print_timing_report(mode, timing, total_microseconds)
        else:
            print(f"[{mode.upper()} ROUTE] {total_microseconds / 1000:.3f} ms")

    if result.get("success"):
        result["requested_departure_datetime"] = (
            departure_datetime.isoformat() if departure_datetime else None
        )
        result["timing_mode"] = "scheduled" if departure_datetime else "now"

    return jsonify(result), (200 if result.get("success") else 404)


if __name__ == "__main__":
    # Normal `python main.py` is the low-memory server-safe mode.
    # `python main.py --dev` restores the old local testing conveniences:
    # debug mode, automatic reload, detailed route timings, and verbose output.
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "8080"))

    if DEV_MODE:
        print("=" * 64)
        print("Map Router - LOCAL DEVELOPMENT MODE")
        print(f"http://{host}:{port}")
        print("Debug: ON | Auto reload: ON | Route timing: ON")
        print("Transit graph remains lazy-loaded until transit is first used.")
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
        print("Map Router - LOW-MEMORY SERVER MODE")
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
