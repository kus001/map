# Main.py

# DEPRECIATED

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

def create_map(result, selected_route):
    start = result["start"]["coordinates"]
    end = result["end"]["coordinates"]

    route_map = folium.Map(
        location=start,
        zoom_start=13,
        tiles="OpenStreetMap"
    )

    selected_number = selected_route["route_number"]

    for route in result["routes"]:

        is_selected = (
            route["route_number"] == selected_number
        )

        if is_selected:
            weight = 7
            opacity = 1
        else: 
            weight = 4
            opacity = 0.35

        label = (
            f"Route {route['route_number']} | "
            f"{route['distance_km']:.2f} km | "
            f"{format_duration(route['duration_min'])}"
        )

        folium.PolyLine(
            route["route_coordinates"],
            weight=weight,
            opacity=opacity,
            tooltip=label
        ).add_to(route_map)

    folium.Marker(
        start,
        tooltip="Start",
        popup=result["start"]["address"],
        icon=folium.Icon(
            icon="play"
        )
    ).add_to(route_map)

    folium.Marker(
        end,
        tooltip="Destination",
        popup=result["end"]["address"],
        icon=folium.Icon(
            icon="flag"
        )
    ).add_to(route_map)

    route_map.fit_bounds(
        selected_route["route_coordinates"]
    )

    file_path = Path("driving_map.html").resolve()

    route_map.save(file_path)

    return file_path

def open_map(file_path):

    directory = str(file_path.parent)

    handler = partial(
        SimpleHTTPRequestHandler,
        directory=directory
    )

    server = ThreadingHTTPServer(
        ("127.0.0.1", 0),
        handler
    )

    port = server.server_port

    thread = threading.Thread(
        target=server.serve_forever,
        daemon=True
    )

    thread.start()

    url = (
        f"http://127.0.0.1:{port}/"
        f"{file_path.name}"
    )

    webbrowser.open(url)

    return server

def main():
    start = input("Starting location: ").strip()
    destination = input("Destination: ").strip()

    if not start:
        print("Starting location cannot be empty.")
        return

    if not destination:
        print("Destination cannot be empty.")
        return

    result = get_driving_route(
        start, 
        destination
    )

    if not result["success"]:
        print("\nRoute couldn't be calculated.")
        print(result["error"])
        return

    selected_route = choose_route(result)

    map_file = create_map(
        result,
        selected_route
    )

    server = open_map(map_file)

    input()

    server.shutdown()

if __name__ == "__main__":
    main()