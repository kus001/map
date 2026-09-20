from flask import Flask, render_template, request, jsonify
from driving import get_driving_route
from walking import get_walking_route
from cycling import get_cycling_route

app = Flask(__name__)

@app.route("/")
def home():
    return render_template(
        "index.html"
    )

@app.route(
    "/api/routes",
    methods=["POST"]
)
def routes():
    data = request.get_json()

    start = data["start"]
    destination = data["destination"]
    mode = data.get("mode", "driving")

    if mode == "walking":
        result = get_walking_route(start, destination)
    elif mode == "cycling":
        result = get_cycling_route(start, destination)
    else:
        result = get_driving_route(start, destination)

    return jsonify(result)

if __name__ == "__main__":
    app.run(debug=True)