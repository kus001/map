import math
from heapq import heappop, heappush
from helpers.transit import make_graph
from helpers.print_color import red, blue, bold, green

print(bold(green("-------------------- Starting Transit Router --------------------")))

data = make_graph()

graph = data.graph
stations = data.node_positions