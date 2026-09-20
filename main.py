# Main.py

from flask import Flask, request, jsonify

from driving import get_driving_route
from walking import get_walking_route
from cycling import get_cycling_route

app = Flask(__name__)

@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({
        "success": True,
        "message": "Map routing API is running."
    })

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
        result = get_cycling_route(start, destination)

    else:
        return jsonify({
            "success": False,
            "error": f"Unsupported travel mode: {mode}"
        }), 400

    return jsonify(result)

if __name__ == "__main__":
    app.run(
        host="127.0.0.1",
        port=5000,
        debug=True
    )