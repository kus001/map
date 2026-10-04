# Main.py
from flask import Flask, request, jsonify

from driving import get_driving_route
from walking import get_walking_route
from helpers.geocoding import remember_place, search_places
from cycling import get_cycling_route
from transit import get_transit_route

app = Flask(__name__)

VALID_CYCLING_TYPES = {"regular", "road", "mountain", "electric"}

@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({
        "success": True,
        "message": "Map routing API is running."
    })

@app.route("/api/search", methods=["GET"])
def search():
    query = request.args.get("q", "").strip()

    try:
        limit = int(request.args.get("limit", 6))
    except ValueError:
        limit = 6

    if len(query) < 2:
        return jsonify({
            "success": True,
            "results": []
        })

    return jsonify({
        "success": True,
        "results": search_places(query, limit=max(1, min(limit, 10)))
    })

@app.route("/api/remember-place", methods=["POST"])
def remember():
    payload = request.get_json() or {}
    label = str(payload.get("label", "").strip())

    try:
        lat = float(payload.get("lat"))
        lon = float(payload.get("lon"))

    except (TypeError, ValueError):
        return jsonify({
            "success": False,
            "error": "Invalid Coordinates."
        }), 400

    if (not label or not (-90 <= lat <= 90) or not (-180 <= lon <= 180)):
        return jsonify({
            "success": False,
            "error": "Invalid place."
        }), 400

    remember_place(label, lat, lon)

    return jsonify({"success": True})

@app.route("/api/routes", methods=["POST"])
def routes():
    data = request.get_json() or {}

    start = data.get("start", "").strip()
    destination = data.get("destination", "").strip()
    mode = data.get("mode", "driving").strip().lower()

    if not start:
        return jsonify({
            "success": False,
            "error": "Starting location is required."
        }), 400

    if not destination:
        return jsonify({
            "success": False,
            "error": "Destination is required."
        }), 400

    if mode == "driving":
        result = get_driving_route(start, destination)

    elif mode == "walking":
        result = get_walking_route(start, destination)

    elif mode == "cycling":
        route_type = data.get("route_type", "regular").strip().lower()
        if route_type not in VALID_CYCLING_TYPES:
            route_type = "regular"
        result = get_cycling_route(start, destination, route_type=route_type)

    elif mode == "transit":
        result = get_transit_route(start, destination)

    else:
        return jsonify({
            "success": False,
            "error": f"Unsupported travel mode: {mode}"
        }), 400

    return jsonify(result), (200 if result.get("success") else 404)

if __name__ == "__main__":
    app.run(
        host="127.0.0.1",
        port=8080,
        debug=True
    )
