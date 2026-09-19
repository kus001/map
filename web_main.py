from flask import Flask, render_template, request, jsonify
from driving import get_driving_route

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

    result = get_driving_route(
        start,
        destination
    )

    return jsonify(result)

if __name__ == "__main__":
    app.run(debug=True)