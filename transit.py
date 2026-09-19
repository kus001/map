from heapq import heappop, heappush
from helpers._transit.make_graph import make_graph
from helpers.distance import dist_time, find_dist
from helpers.print_color import red, blue, bold, green

print(bold(green("-------------------- Starting Transit Router --------------------")))

data = make_graph()

graph = data.graph
stops = data.node_positions

def transit_a_star(graph, start_id, goal_id):
    priority_queue = []
    heappush(priority_queue, (0, start_id))

    graph_costs = {stop_id: float('inf') for stop_id in stops}
    graph_costs[start_id] = 0

    came_from = {stop_id: None for stop_id in stops}

    while priority_queue:
        current_f, current_id = heappop(priority_queue)

        if current_id == goal_id:
            path = []
            while current_id is not None:
                path.append(current_id)
                current_id = came_from[current_id]
            return path[::-1], graph_costs[goal_id]

        for neighbor_id, travel_time in graph.get(current_id, {}).items():
            try:
                tentative_g = graph_costs[current_id] + travel_time["distance"]
            except TypeError:
                print(travel_time)
                raise
            if tentative_g < graph_costs[neighbor_id]:
                graph_costs[neighbor_id] = tentative_g
                priority = tentative_g + dist_time(stops[neighbor_id], stops[goal_id])
                heappush(priority_queue, (priority, neighbor_id))
                came_from[neighbor_id] = current_id

    return None, float('inf')

route, total_time = transit_a_star(graph, "grt_busses:cens", "grt_busses:cens")
print(f"\nOptimal Transit Line: {' --> '.join(route)}")
print(f"\nEstimated Commute Time: {total_time} minutes")