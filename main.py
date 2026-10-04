from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from flask import Flask, jsonify, request

from cycling import get_cycling_route
from driving import get_driving_route
from helpers.geocoding import remember_place, search_places
from transit import get_transit_route
from walking import get_walking_route

app = Flask(__name__)

VALID_CYCLING_TYPES = {"regular", "road", "mountain", "electric"}
APP_TIMEZONE = ZoneInfo("America/Toronto")


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
        result = get_transit_route(
            start,
            destination,
            departure_datetime=departure_datetime,
        )

    else:
        return jsonify({
            "success": False,
            "error": f"Unsupported travel mode: {mode}",
        }), 400

    if result.get("success"):
        result["requested_departure_datetime"] = (
            departure_datetime.isoformat() if departure_datetime else None
        )
        result["timing_mode"] = "scheduled" if departure_datetime else "now"

    return jsonify(result), (200 if result.get("success") else 404)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8080, debug=True)
