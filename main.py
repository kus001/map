# Main.py

import folium
import webbrowser
import threading

from pathlib import Path
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

from driving import (
    get_driving_route,
    select_route,
    get_route_labels
)

def format_duration(minutes):
    minutes = round(minutes)

    if minutes < 60:
        return f"{minutes} min"

    hours = minutes // 60
    remaining = minutes % 60

    return f"{hours} hr {remaining} min"

def choose_route(result):
    routes = result["routes"]

    print("\nAvaliable routes: \n")

    for route in routes:
        labels = get_route_labels(result, route)

        label_text = ""

        if labels:
            label_text = " [" + ", ".join(labels) +"]"

        print(
            f"{route['route_number']}. "
            f"{route['distance_km']:.2f} km | "
            f"{format_duration(route['duration_min'])}"
            f"{label_text}"
        )

    while True:
        try:
            choice = int(
                input(
                    f"\nChoose route (1-{len(routes)}): "
                )
            )

            selected = select_route(result, choice)

            if selected is not None:
                return selected

            print("Invalid route number.")

        except ValueError: 
            print("Enter a number.")
