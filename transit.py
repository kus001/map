import csv
import math
import os

from bisect import bisect_left
from concurrent.futures import ThreadPoolExecutor, as_completed

from heapq import heappop, heappush
from itertools import count
from bisect import bisect_left
from datetime import datetime

from helpers.geocoding import get_coordinates

from helpers.coords import nearest_stops, get_coordinates
from helpers._transit.make_graph import make_graph
from helpers.distance import dist_time, find_dist
from helpers.print_color import bold, green, red, blue, magenta
from helpers.time_management import time_to_seconds, seconds_to_time

data = make_graph()

graph = data.graph
stops = data.node_positions

legs = []
total_time = float("inf")


def coordify(stop_data):
    return stop_data[0:2]

def transit_a_star(graph, start_id, goal_id, safety_buffer=4, start_time=None, date=None, cutoff=float('inf')):
    if start_time is None:
        start_time = time_to_seconds(datetime.now().strftime("%H:%M:%S"))  # seconds since midnight
    if date is None:
        date = datetime.now().date()

    # Queue stores: (f_score, boardings, tie_breaker, current_node, current_trip_id, current_edge_data)
    # boardings sits right after f_score so that when two entries tie on time, heapq pickes the one with less transfers.
    tie_breaker = count()
    priority_queue = []
    heappush(priority_queue, (0, 0, next(tie_breaker), start_id, None, None))

    # Track lowest (g_score, boardings) per state: (node_id, trip_id). Compared lexicographically —
    graph_costs = {(start_id, None): (0, 0)}

    # Path reconstructor: (node, trip_id) -> (prev_node, prev_trip_id, edge_data)
    came_from = {}

    while priority_queue:
        _, _, _, current_id, current_trip, _ = heappop(priority_queue)

        if current_id == goal_id:
            path = []
            curr_state = (current_id, current_trip)

            while curr_state in came_from:
                prev_node, prev_trip, edge_info = came_from[curr_state]
                path.append((curr_state[0], stops[curr_state[0]], edge_info))
                curr_state = (prev_node, prev_trip)

            path.append((start_id, stops[start_id], None))
            return path[::-1], graph_costs[(current_id, current_trip)][0]

        current_g, current_boardings = graph_costs.get((current_id, current_trip), (float('inf'), float('inf')))

        if current_g > cutoff:
            return None, float("inf")

        current_arrival_abs = start_time + current_g * 60  # seconds since midnight, "now" for this state

        for neighbor_id, route_options in graph.get(current_id, {}).items():
            for route_key, trips in route_options.items():
                if route_key == "__walk__":
                    # Walking edges: just one entry, always available immediately, no new boarding
                    edge = trips[0]
                    candidates = [(edge.get("distance", 0), None, edge, current_boardings)]

                else:
                    candidates = []
                    continuing_edge = None
                    if current_trip is not None:
                        continuing_edge = next((t for t in trips if t["trip_id"] == current_trip), None)

                    if continuing_edge is not None:
                        # Still riding the exact same scheduled vehicle — no wait, no new boarding
                        candidates = [(continuing_edge.get("distance", 0), current_trip, continuing_edge, current_boardings)]
                    else:
                        # Boarding a NEW trip on this route (first ride, transfer, or a later run of the same route number)
                        earliest_catchable = current_arrival_abs
                        if not (current_id == start_id and current_g == 0):
                            earliest_catchable += safety_buffer * 60

                        dep_times = [t["departure_time"] for t in trips]
                        idx = bisect_left(dep_times, earliest_catchable)
                        # Walk forward from the earliest catchable time to the first trip that
                        # ALSO actually runs on the search date
                        edge = None
                        for j in range(idx, len(trips)):
                            candidate = trips[j]
                            if data.is_trip_active(candidate["trip_id"], date):
                                edge = candidate
                                break
                        if edge is not None:
                            wait_minutes = (edge["departure_time"] - current_arrival_abs) / 60.0
                            candidates = [(wait_minutes + edge.get("distance", 0), edge["trip_id"], edge, current_boardings + 1)]
                        # else: nothing on this route is catchable and running today anymore --> no candidate

                for cost, trip_id, edge, tentative_boardings in candidates:
                    tentative_g = current_g + cost
                    neighbor_state = (neighbor_id, trip_id)

                    # Round to kill float noise before comparing
                    tentative_key = (round(tentative_g, 6), tentative_boardings)

                    if tentative_key < graph_costs.get(neighbor_state, (float('inf'), float('inf'))):
                        graph_costs[neighbor_state] = tentative_key

                        # Heuristic estimation
                        h = dist_time(coordify(stops[neighbor_id]), coordify(stops[goal_id])) / 60.0
                        priority = tentative_g + h

                        heappush(priority_queue, (priority, tentative_boardings, next(tie_breaker), neighbor_id, trip_id, edge))
                        came_from[neighbor_state] = (current_id, current_trip, edge)

    return None, float('inf')

def append_leg(total, stop_name, stop_id=None):
    global legs
    """Print the currently accumulated leg."""

    first_stop = total["first stop"]

    if first_stop is None:
        return

    route_info = first_stop[3]

    # Transit
    if route_info:
        departure = (
            seconds_to_time(total["departure_time"])
            if total["departure_time"] is not None
            else "?"
        )

        if total["arrival_time"] is not None:
            arrival = seconds_to_time(total["arrival_time"])
        elif total["departure_time"] is not None:
            # Fall back to departure + accumulated travel time
            arrival = seconds_to_time(
                total["departure_time"] + total["time"] * 60
            )
        else:
            arrival = "?"

        agency = (
            first_stop[0][0]
            if first_stop[0]
            else "Transit"
        )

        route_name = (
            route_info.get("route", "?")
            if isinstance(route_info, dict)
            else route_info
        )

        headsign = (route_info.get("headsign", "")
            if isinstance(route_info, dict)
            else ""
        )

        stop_id_text = (
            f" (Stop id: {stop_id})"
            if stop_id
            else ""
        )

        legs.append(
            (
            f"Ride {total['stops']} stops "
            f"({departure} → {arrival}, "
            f"{total['time']:.1f} minutes) "
            f'from "{first_stop[2]}"'
            f"{stop_id_text} "
            f'to "{stop_name}" '
            f"via {agency}'s route "
            f"{route_name}"
            f"towards {headsign}"
            ).strip()
        )

    # Walking
    else:
        stop_id_text = (
            f" (Stop id: {stop_id})"
            if stop_id
            else ""
        )

        if total["time"] > 0.1:
            legs.append((
                f"Walk {total['time']:.1f} minutes "
                f'from "{first_stop[2]}"'
                f"{stop_id_text} "
                f'to "{stop_name}"'
            ))

        else:
            legs.append((
                f'Transfer from "{first_stop[2]}"'
                f"{stop_id_text} "
                f'to "{stop_name}"'
            ))

def get_transit_route(start_address, end_address):
    global total_time, legs

    legs = []

    transit_route = None
    last_leg = None

    start_coords = get_coordinates(start_address)
    end_coords = get_coordinates(end_address)

    if start_coords is None:
        return {
            "success": False,
            "error": ("starting address couldn't be found.")
        }

    if end_coords is None:
        return {
            "success": False,
            "error": ("Destination couldn't be found.")
        }
    
    start_stops = nearest_stops(stops, *start_coords)
    end_stops   = nearest_stops(stops, *end_coords)

    total_time = float("inf")

    # Rewrite

    for start_index in range(len(start_stops)):
        for end_index in range(len(end_stops)):
            start_stop_id = (start_stops[start_index][1][0])
            end_stop_id = (end_stops[end_index][1][0])
            start_walk_seconds = (start_stops[start_index][0])
            end_walk_seconds = (end_stops[end_index][0])
            temp_time = (start_walk_seconds / 60)
            temp_time += (end_walk_seconds / 60)
            transit_start_time = (time_to_seconds(datetime.now().strftime("%H:%M:%S")) + start_walk_seconds)
            candidate_route, route_time = (
                transit_a_star(
                    graph,
                    start_stop_id,
                    end_stop_id,
                    start_time = transit_start_time,
                    cutoff = total_time - temp_time
                )
            )

            if (candidate_route is None or route_time == float("inf")):
                continue

            temp_time += route_time

            if temp_time < total_time:
                transit_route = (candidate_route)
                total_time = (temp_time)
                first_stop_name = (start_stops[start_index][1][1][2])
                last_stop_name = (end_stops[end_index][1][1][2])

                legs = [(
                    f"Walk "
                    f"{round(start_walk_seconds / 60)} "
                    f"minutes from "
                    f"{start_address} "
                    f"to {first_stop_name} "
                    f"(Stop id: "
                    f"{start_stop_id})"
                )]

                last_leg = (
                    f"Walk "
                    f"{round(end_walk_seconds / 60)} "
                    f"minutes from "
                    f"{last_stop_name} "
                    f"to {end_address} "
                    f"(Stop id: "
                    f"{start_stop_id})"
                )

    if transit_route is None:
        return {
            "success": False,
            "error": "No transit route found."
        }

    transit_stop_coordinates = [
        list(stop[1][:2])
        for stop in transit_route
    ]

    route_coordinates = [
        list(start_coords),
        *transit_stop_coordinates,
        list(end_coords)
    ]

    index = 1

    total = {
        "stops": 1,
        "time": 0,
        "departure_time": None,
        "arrival_time": None,
        "first stop": None
    }

    while index < len(transit_route):
        (stop, coords, info) = transit_route[index - 1]
        stop_agency, stop_id = (stop.split(":"))
        stop_name = coords[2]
        stop_agency = (stop_agency.split("_"))
        next_stop_data = (transit_route[index])
        next_stop = (next_stop_data[0])
        next_info = (next_stop_data[2] or {})
        next_agency, _ = (next_stop.split(":"))
        next_agency = (next_agency.split("_"))
        current_info = (info or {})
        if total["first stop"] is None:
            total["first stop"] = [stop_agency, stop_id, stop_name, next_info.get("route")]
            same_leg = True
        else:
            same_leg = ((
                stop_agency == next_agency and next_info.get("route") == current_info.get("route")
            ) or (
                "route" not in next_info and "route" not in current_info
            ))

        if same_leg:
            total["stops"] += 1
            total["time"] += (next_info.get("distance", 0))
            if ("departure_time" in next_info):
                if (total["departure_time"] is None):
                    total["departure_time"] = (next_info["departure_time"])
                if (next_info.get("arrival_time") is not None):
                    total["arrival_time"] = (next_info["arrival_time"])
            index += 1
            continue

        append_leg(total, stop_name, stop_id)
        total = {
            "stops": 2,
            "time": next_info.get("distance", 0),
            "departure_time": next_info.get("departure_time"),
            "arrival_time": next_info.get("arrival_time"),
            "first stop": [stop_agency, stop_id, stop_name,next_info.get("route")]
        }

        index += 1

    if total["first stop"] is not None:
        (_, final_coords, _) = transit_route[-1]
        final_name = (final_coords[2])
        append_leg(total, final_name)

    if last_leg:
        legs.append(last_leg)

    steps = []

    for leg in legs:
        if leg.startswith("Ride"):
            transit_type = ("ride")
        elif leg.startswith("Walk"):
            transit_type = ("walk")
        elif leg.startswith("Transfer"):
            transit_type = ("transfer")
        else:
            transit_type = ("transit")

        steps.append({
            "instruction": leg,
            "type": "transit",
            "transit_type": transit_type,
            "modifier": "",
            "road": "",
            "name": "",
            "distance_m": 0
        })

    direct_distance_m = (
        find_dist(start_coords, end_coords)
    )
    estimated_distance_km = (
        direct_distance_m * 1.5 / 1000
    )
    if total_time > 0:
        average_speed = (estimated_distance_km / (total_time / 60))
    else:
        average_speed = 0

    route = {
        "route_number": 1,
        "distance_km": estimated_distance_km,
        "duration_min": total_time,
        "average_speed": average_speed,
        "stops": steps,
        "route_coordinates": route_coordinates,
        "transit_stops": transit_stop_coordinates
    }

    return {
        "success": True,
        "mode": "transit",
        "start": {
            "address": start_address,
            "coordinates": list(start_coords)
        },
        "end": {
            "address": end_address,
            "coordinates": list(end_coords)
        },
        "routes":
        [route],
        "fastest_route_number": 1,
        "shortest_route_number": 1
    }
if __name__ == "__main__":
    start_address = input(
        bold("Starting Address: ")
    )
    end_address = input(
        bold("End Address: ")
    )

    result = get_transit_route(
        start_address,
        end_address
    )
    if not result["success"]:
        print(result["error"])
    else:
        for leg in legs:
            if leg.startswith("Walk"):
                print(green(leg))
            elif leg.startswith("Ride"):
                print(blue(leg))
            elif leg.startswith("Transfer"):
                print(magenta(leg))
        print(
            f"\nEstimated Commute Time: "
            f"{total_time:.1f} mintes\n"
        )