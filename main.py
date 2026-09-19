# Main.py

from driving import (
    get_driving_route,
    print_route_options,
    choose_route_cli,
    print_directions
)

start = input("Where are you starting from? ")
destination = input("Where are you going to? ")

result = get_driving_route(
    start,
    destination
)

if not result["success"]:
    print(result["error"])
    exit()

print_route_options(result)

selected_route = choose_route_cli(result)

print("Selected route: ")

print(f"{selected_route['distance_km']:.2f} km")
print(f"{selected_route['duration_min']:.2f} minutes")

print_directions(selected_route)