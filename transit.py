from helpers.coords import get_coordinates

from heapq import heappop, heappush
from itertools import count
from bisect import bisect_left
from helpers._transit.make_graph import make_graph
from helpers.distance import dist_time
from helpers.print_color import bold, green, red, blue, magenta
from helpers.time_management import time_to_seconds
from datetime import datetime
import time

print("building graph...")

data = make_graph()

print(green("successfully built graph\n"))
print("routing...")

graph = data.graph
stops = data.node_positions

def coordify(stopthingy):
    return stopthingy[0:2]

def transit_a_star(graph, start_id, goal_id, safety_buffer=2, start_time=None):
    """
    safety_buffer: minutes of slack you need between arriving at a stop and a trip's
    departure for that connection to count as catchable at all — this REPLACES the old
    flat transfer_penalty. It's no longer "always add N minutes when switching routes";
    instead the actual cost of a transfer is however long you genuinely have to wait for
    the next trip that respects this buffer, looked up from the real schedule.
    """
    if start_time is None:
        start_time = time_to_seconds(datetime.now().strftime("%H:%M:%S"))  # seconds since midnight

    # Queue stores: (f_score, tie_breaker, current_node, current_trip_id, current_edge_data)
    # The tie_breaker is a unique increasing counter — without it, heapq falls back to
    # comparing trip_id (which mixes None and strings) or edge dicts when priorities tie,
    # and neither of those support '<'.
    tie_breaker = count()
    priority_queue = []
    heappush(priority_queue, (0, next(tie_breaker), start_id, None, None))

    # Track lowest g_score (minutes elapsed since start_time) per state: (node_id, trip_id)
    # trip_id is None when you're not currently riding anything (start, or just walked).
    graph_costs = {(start_id, None): 0}

    # Path reconstructor: (node, trip_id) -> (prev_node, prev_trip_id, edge_data)
    came_from = {}

    while priority_queue:
        current_f, _, current_id, current_trip, info = heappop(priority_queue)

        if current_id == goal_id:
            path = []
            curr_state = (current_id, current_trip)

            while curr_state in came_from:
                prev_node, prev_trip, edge_info = came_from[curr_state]
                path.append((curr_state[0], stops[curr_state[0]], edge_info))
                curr_state = (prev_node, prev_trip)

            path.append((start_id, stops[start_id], None))
            return path[::-1], graph_costs[(current_id, current_trip)]

        current_g = graph_costs.get((current_id, current_trip), float('inf'))
        current_arrival_abs = start_time + current_g * 60  # seconds since midnight, "now" for this state

        for neighbor_id, route_options in graph.get(current_id, {}).items():
            for route_key, trips in route_options.items():
                if route_key == "__walk__":
                    # Walking edges: just one entry, always available immediately
                    edge = trips[0]
                    candidates = [(edge.get("distance", 0), None, edge)]

                else:
                    candidates = []
                    continuing_edge = None
                    if current_trip is not None:
                        continuing_edge = next((t for t in trips if t["trip_id"] == current_trip), None)

                    if continuing_edge is not None:
                        # Still riding the exact same scheduled vehicle — no wait, just ride the hop
                        candidates = [(continuing_edge.get("distance", 0), current_trip, continuing_edge)]
                    else:
                        # Boarding a NEW trip on this route (first ride, transfer, or a later run
                        # of the same route number). trips is sorted by departure_time, so the
                        # earliest catchable one is found in O(log n) instead of trying all of
                        # them — a later trip on the same route can never beat the earliest one
                        # that's actually catchable.
                        earliest_catchable = current_arrival_abs
                        if current_trip is not None:
                            earliest_catchable += safety_buffer * 60

                        dep_times = [t["departure_time"] for t in trips]
                        idx = bisect_left(dep_times, earliest_catchable)
                        if idx < len(trips):
                            edge = trips[idx]
                            wait_minutes = (edge["departure_time"] - current_arrival_abs) / 60.0
                            candidates = [(wait_minutes + edge.get("distance", 0), edge["trip_id"], edge)]
                        # else: nothing on this route is catchable today anymore — no candidate

                for cost, trip_id, edge in candidates:
                    tentative_g = current_g + cost
                    neighbor_state = (neighbor_id, trip_id)

                    if tentative_g < graph_costs.get(neighbor_state, float('inf')):
                        graph_costs[neighbor_state] = tentative_g

                        # Heuristic estimation
                        h = dist_time(coordify(stops[neighbor_id]), coordify(stops[goal_id])) / 60.0
                        priority = tentative_g + h

                        heappush(priority_queue, (priority, next(tie_breaker), neighbor_id, trip_id, edge))
                        came_from[neighbor_state] = (current_id, current_trip, edge)

    return None, float('inf')

st = time.monotonic_ns()
route, total_time = transit_a_star(graph, "grt_busses:2088", "go:UN", safety_buffer=2, start_time=53600)
# print(time.monotonic_ns() - st)

# for item in route:
#     print(item)

if route is None:
    print(red("No route found between the given start and destination."))
    raise SystemExit(1)

i = 1
total = {
    "stops": 1,
    "time": 0
}

while True:
    stop, coords, info = route[i-1]

    stop_agency, stop_id = stop.split(":")
    stop_name = coords[2]
    stop_agency = stop_agency.split("_")

    if i != len(route):
        dnext = route[i]
        ns    = dnext[0]
        nc    = dnext[1]
        ni    = dnext[2]

        ns_agency, ns_id = ns.split(":")
        ns_agency = ns_agency.split("_")
        ns_name = nc[2]

        _ni   = ni   if ni   else {}
        _info = info if info else {}

        if (stop_agency == ns_agency and _ni.get("route", None) == _info.get("route", None)) or ("route" not in ni and "route" not in info):
            total["stops"] += 1
            total["time"]  += ni["distance"]
            if not "first stop" in total:
                total["first stop"] = [stop_agency, stop_id, stop_name, ni["route"] if "route" in ni else None]
            elif not total["first stop"][3]:
                total["first stop"][3] = ni["route"] if "route" in ni else None
        else:
            fs = total['first stop']
            if fs[3]:
                print(blue(
                    f"Ride {total["stops"]} stops ({total["time"]:.1f} minutes) from \"{fs[2]}\" to \"{stop_name}\" via {fs[0][0]}'s route {fs[3]["route"]} towards {fs[3]["headsign"]}"
                ))
            else:
                if total["time"] != 0:
                    print(green(
                        f"Walk {total["time"]:.1f} minutes from \"{fs[2]}\" to \"{stop_name}\""
                    ))
                else:
                    print(magenta(
                        f"Transfer from \"{fs[2]}\" to \"{stop_name}\""
                    ))
                
            total = {
                "stops": 1,
                "time": 0
            }

            total["first stop"] = [stop_agency, stop_id, stop_name, ni["route"] if "route" in ni else None]
            # same here — the trailing i += 1 at the bottom of the loop already advances it

        # if ni:
        #     if "route" in ni:
        #         print(
        #             f"Step {i}: From {stop_name} (run by {stop_agency[0]}, stop id \"{stop_id}\"), "
        #             f"ride route {ni["route"]['route']} towards {ni["route"]['headsign']} "
        #             f"to {ns_name} (run by {ns_agency[0]}, stop id \"{ns_id}\") "
        #             f"in {ni["distance"]} mins. trip id: {ni["trip_id"]}" if ni else ""
        #         )
        #     else:
        #         print(green(
        #             f"Step {i}: From {stop_name} (run by {stop_agency[0]}, stop id \"{stop_id}\"), walk {ni["distance"]:.1f} minutes "
        #             f"to {ns_name} (run by {ns_agency[0]}, stop id \"{ns_id})\" "
        #         ))
        # else:
        #     print(red(f"Step {i}: From {stop_name} (run by {stop_agency[0]}, stop id \"{stop_id}\"), "
        #               f"ride to {ns_name} (run by {ns_agency[0]}, stop id {ns_id}) "
        #               f"in {ni["distance"]} mins. trip id: {ni["trip_id"]}" if ni else ""
        #     ))
    else:
        fs = total['first stop']
        dnext = route[i-1]
        ns    = dnext[0]
        nc    = dnext[1]
        ni    = dnext[2]

        ns_agency, ns_id = ns.split(":")
        ns_agency = ns_agency.split("_")
        ns_name = nc[2]

        _ni   = ni   if ni   else {}
        _info = info if info else {}

        if fs[3]:
            print(blue(
                f"Ride {total["stops"]} stops ({total["time"]:.1f} minutes) from \"{fs[2]}\" to \"{stop_name}\" via {fs[0][0]}'s route {fs[3]["route"]} towards {fs[3]["headsign"]}"
            ))
        else:
            if total["time"] != 0:
                print(green(
                    f"Walk {total["time"]:.1f} minutes from \"{fs[2]}\" to \"{stop_name}\""
                ))
            else:
                print(magenta(
                    f"Transfer from \"{fs[2]}\" to \"{stop_name}\""
                ))
        break
    i+=1

# print(f"\nOptimal Transit Line: {' --> '.join([f'{stop_id} @ ({coords[0]}, {coords[1]})' for stop_id, coords, _ in route])}")
print(f"\nEstimated Commute Time: {total_time:.1f} minutes")
