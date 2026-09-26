from helpers.coords import nearest_stop, get_coordinates
from heapq import heappop, heappush
from itertools import count
from bisect import bisect_left
from helpers._transit.make_graph import make_graph
from helpers.distance import dist_time, find_dist
from helpers.print_color import bold, green, red, blue, magenta
from helpers.time_management import time_to_seconds, seconds_to_time
from datetime import datetime

data = make_graph()
legs = []

graph = data.graph
stops = data.node_positions

def coordify(stopthingy):
    return stopthingy[0:2]

def transit_a_star(graph, start_id, goal_id, safety_buffer=4, start_time=None):
    if start_time is None:
        start_time = time_to_seconds(datetime.now().strftime("%H:%M:%S"))  # seconds since midnight

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
                        if idx < len(trips):
                            edge = trips[idx]
                            wait_minutes = (edge["departure_time"] - current_arrival_abs) / 60.0
                            candidates = [(wait_minutes + edge.get("distance", 0), edge["trip_id"], edge, current_boardings + 1)]
                        # else: nothing on this route is catchable today anymore — no candidate

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

def print_leg(total, stop_name):
    global legs
    """Print the currently accumulated leg."""

    fs = total["first stop"]

    if fs is None:
        return

    # Transit
    if fs[3]:
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

        legs.append((
            f"Ride {total['stops']} stops "
            f"({departure} → {arrival}, "
            f"{total['time']:.1f} minutes) "
            f'from "{fs[2]}" to "{stop_name}" '
            f"via {fs[0][0]}'s route {fs[3]['route']} "
            f"towards {fs[3]['headsign']}"
        ))

    # Walking
    else:
        if total["time"] > 0.1:
            legs.append((
                f"Walk {total['time']:.1f} minutes "
                f'from "{fs[2]}" to "{stop_name}"'
            ))
        else:
            legs.append((
                f'Transfer from "{fs[2]}" to "{stop_name}"'
            ))
    # print(legs[-1])

def get_transit_route(start_address, end_address):
    global total_time

    try:
        start_coords = get_coordinates(start_address)
        end_coords   = get_coordinates(end_address)
    except TypeError:
        return {
            "success": False,
            "error"  : "Invalid Address"
        }
    
    start_stop = nearest_stop(stops, *start_coords)
    end_stop   = nearest_stop(stops, *end_coords)

    sid = start_stop[1][0]
    eid = end_stop  [1][0]
    
    transit_route, total_time = transit_a_star(graph, sid, eid)

    if transit_route is None:
        return {
            "success": False,
            "error"  : "No route found"
        }

    route_coordinates = []

    for stop in transit_route:
        route_coordinates.append(stop[1][:2])

    print("\n\n")

    if transit_route is None:
        print(red("No route found between the given start and destination."))
        raise SystemExit(1)

    i = 1

    total = {
        "stops": 1,
        "time": 0,
        "departure_time": None,
        "arrival_time": None,
        "first stop": None
    }


    while i < len(transit_route):
        stop, coords, info = transit_route[i - 1]

        stop_agency, stop_id = stop.split(":")
        stop_name = coords[2]
        stop_agency = stop_agency.split("_")

        dnext = transit_route[i]
        ns = dnext[0]
        nc = dnext[1]
        ni = dnext[2] or {}

        ns_agency, ns_id = ns.split(":")
        ns_agency = ns_agency.split("_")

        _info = info or {}

        if total["first stop"] is None:
            # True start of the journey — this edge always belongs to the
            # leg we're about to open; there's no prior route to compare against.
            total["first stop"] = [stop_agency, stop_id, stop_name, ni.get("route")]
            same_leg = True
        else:
            same_leg = (
                stop_agency == ns_agency
                and ni.get("route") == _info.get("route")
            ) or (
                "route" not in ni
                and "route" not in _info
            )

        if same_leg:
            total["stops"] += 1
            total["time"] += ni.get("distance", 0)

            if "departure_time" in ni:
                if total["departure_time"] is None:
                    total["departure_time"] = ni["departure_time"]
                if ni.get("arrival_time") is not None:
                    total["arrival_time"] = ni["arrival_time"]

            i += 1
            continue

        print_leg(total, stop_name)

        total = {
            "stops": 2,
            "time": ni.get("distance", 0),
            "departure_time": ni.get("departure_time"),
            "arrival_time": ni.get("arrival_time"),
            "first stop": [stop_agency, stop_id, stop_name, ni.get("route")]
        }
        i += 1

    if total["first stop"] is not None:
        final_stop, final_coords, final_info = transit_route[-1]
        final_name = final_coords[2]

        print_leg(total, final_name)

    steps = []

    for leg in legs:
        temp = leg.split(" ")
        steps.append({
            "instruction": temp[0],
            "type": "transit",
            "modifier": " ".join(temp[1:]),
        })

    distm = find_dist(start_coords, end_coords)

    route = {
        "route_number": 1,
        "distance_km": distm*1.5//1000,
        "duration_min": total_time,
        "average_speed": distm/total_time,
        "steps": steps,
        "route_coordinates": route_coordinates
    }

    return {
        "success" : True,
        "mode": "transit",
        "start": {"address": start_address, "coordinates": start_coords},
        "end": {"address": end_address, "coordinates": end_coords},
        "routes": [route],
        "fastest_route_number": 1,
        "shortest_route_number": 1
    }

if __name__ == '__main__':
    a1 = input(bold("Start Address: "))
    a2 = input(bold("End Address: "))
    froute = get_transit_route(a1, a2)

    for leg in legs:
        if leg[0] == "W":
            print(green(leg))
        elif leg[0] == "R":
            print(blue(leg))
        elif leg[0] == "T":
            print(magenta(leg))

    print(f"\nEstimated Commute Time: {total_time:.1f} minutes\n\n")
