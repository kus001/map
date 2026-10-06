from flask import Flask, request
import subprocess

app = Flask(__name__)

@app.post("/webhook")
def webhook():
    data = request.get_json(silent=True)

    if not data:
        return "Bad request", 400

    # Only rebuild when the desired branch is updated
    if data.get("ref") != "refs/heads/main":
        return "Ignored", 200

    subprocess.Popen(["./rebuild.sh"])

    return "Rebuilding", 200

app.run(host="0.0.0.0", port=9000)
