from heapq import heappop, heappush
from helpers._transit.make_graph import make_graph
from helpers.distance import dist_time
from helpers.print_color import bold, green, red

print("building graph...")

data = make_graph()

print(green("successfully built graph\n"))
print("routing...")

graph = data.graph
stops = data.node_positions

def coordify(stopthingy):
    return stopthingy[0:2]

def transit_a_star(graph, start_id, goal_id, transfer_penalty=0.1):
    # Queue stores: (f_score, current_node, current_route_id, current_edge_data)
    priority_queue = []
    heappush(priority_queue, (0, start_id, None, None))

    # Track lowest g_score per state: (node_id, route_id)
    graph_costs = {(start_id, None): 0}
    
    # Path reconstructor: (node, route) -> (prev_node, prev_route, edge_data)
    came_from = {}

    while priority_queue:
        current_f, current_id, current_route, info = heappop(priority_queue)

        if current_id == goal_id:
            path = []
            curr_state = (current_id, current_route)
            
            while curr_state in came_from:
                prev_node, prev_route, edge_info = came_from[curr_state]
                path.append((curr_state[0], stops[curr_state[0]], edge_info))
                curr_state = (prev_node, prev_route)
            
            path.append((start_id, stops[start_id], None))
            return path[::-1], graph_costs[(current_id, current_route)]

        for neighbor_id, route_options in graph.get(current_id, {}).items():
            for route_key, travel_time in route_options.items():
                # Extract route_id safely from nested dictionary structure
                route_dict = travel_time.get("route")
                next_route = route_dict.get("route") if isinstance(route_dict, dict) else None

                # Base cost for edge
                cost = travel_time.get("distance", 0)

                # Apply penalty if changing from one transit route to another
                if current_route != next_route and current_route is not None:
                    cost += transfer_penalty

                tentative_g = graph_costs.get((current_id, current_route), float('inf')) + cost
                neighbor_state = (neighbor_id, next_route)

                if tentative_g < graph_costs.get(neighbor_state, float('inf')):
                    graph_costs[neighbor_state] = tentative_g

                    # Heuristic estimation
                    h = dist_time(coordify(stops[neighbor_id]), coordify(stops[goal_id])) / 60.0
                    priority = tentative_g + h

                    heappush(priority_queue, (priority, neighbor_id, next_route, travel_time))
                    came_from[neighbor_state] = (current_id, current_route, travel_time)

    return None, float('inf')

route, total_time = transit_a_star(graph, "grt_busses:2088", "go:GL")

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
            i += 1
            continue
            
        else:
            fs = total['first stop']
            if fs[3]:
                print(red(
                    f"Ride {total["stops"]} stops ({total["time"]:.1f} minutes) from \"{fs[2]}\" to \"{stop_name}\" via {fs[0][0]}'s route {fs[3]["route"]} towards {fs[3]["headsign"]}"
                ))
            else:
                print(red(
                    f"Walk {total["time"]:.1f} minutes from \"{fs[2]}\" to \"{stop_name}\""
                ))
                
            total = {
                "stops": 1,
                "time": 0
            }

            total["first stop"] = [stop_agency, stop_id, stop_name, ni["route"] if "route" in ni else None]
            i += 1
            continue

        if ni:
            if "route" in ni:
                print(
                    f"Step {i}: From {stop_name} (run by {stop_agency[0]}, stop id \"{stop_id}\"), "
                    f"ride route {ni["route"]['route']} towards {ni["route"]['headsign']} "
                    f"to {ns_name} (run by {ns_agency[0]}, stop id \"{ns_id}\") "
                    f"in {ni["distance"]} mins. trip id: {ni["trip_id"]}" if ni else ""
                )
            else:
                print(green(
                    f"Step {i}: From {stop_name} (run by {stop_agency[0]}, stop id \"{stop_id}\"), walk {ni["distance"]:.1f} minutes "
                    f"to {ns_name} (run by {ns_agency[0]}, stop id \"{ns_id})\" "
                ))
        else:
            print(red(f"Step {i}: From {stop_name} (run by {stop_agency[0]}, stop id \"{stop_id}\"), "
                      f"ride to {ns_name} (run by {ns_agency[0]}, stop id {ns_id}) "
                      f"in {ni["distance"]} mins. trip id: {ni["trip_id"]}" if ni else ""
            ))
    else:
        break
    i+=1

# print(f"\nOptimal Transit Line: {' --> '.join([f'{stop_id} @ ({coords[0]}, {coords[1]})' for stop_id, coords, _ in route])}")
print(f"\nEstimated Commute Time: {total_time:.1f} minutes")
