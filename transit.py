from heapq import heappop, heappush
from helpers._transit.make_graph import make_graph
from helpers.distance import dist_time, find_dist
from helpers.print_color import red, blue, bold, green

def coordify(stopthingy):
    return stopthingy[0:2]

print(bold(green("\n\n-------------------- Starting Transit Router --------------------")))

data = make_graph()

graph = data.graph
stops = data.node_positions

def transit_a_star(graph, start_id, goal_id):
    priority_queue = []
    heappush(priority_queue, (0, start_id, None))

    graph_costs = {stop_id: float('inf') for stop_id in stops}
    graph_costs[start_id] = 0

    came_from = {stop_id: None for stop_id in stops}

    while priority_queue:
        current_f, current_id, info = heappop(priority_queue)

        if current_id == goal_id:
            path = []
            next_id = None
            while current_id is not None:
                path.append((current_id, stops[current_id], graph[current_id].get(next_id, None)))

                next_id = current_id
                current_id = came_from[current_id]
            return path[::-1], graph_costs[goal_id]

        for neighbor_id, travel_time in graph.get(current_id, {}).items():
            tentative_g = graph_costs[current_id] + travel_time["distance"]
            if tentative_g < graph_costs[neighbor_id]:
                graph_costs[neighbor_id] = tentative_g
                priority = tentative_g + dist_time(coordify(stops[neighbor_id]), coordify(stops[goal_id]))
                heappush(priority_queue, (priority, neighbor_id, graph[current_id]))
                came_from[neighbor_id] = current_id

    return None, float('inf')

route, total_time = transit_a_star(graph, "grt_busses:2088", "grt_busses:2512")

for item in route:
    print(item)

print(f"\nOptimal Transit Line: {' --> '.join([f'{stop_id} @ ({coords[0]}, {coords[1]})' for stop_id, coords, _ in route])}")
print(f"\nEstimated Commute Time: {total_time} minutes")
