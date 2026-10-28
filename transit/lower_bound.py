"""Graph-based lower bounds used as the A* heuristic in search.py.

The old heuristic was straight-line distance at HEURISTIC_SPEED_KMH. That is a very loose
bound (real transit is far slower than 100 km/h), so on a long trip the search expanded most
of the Golden Horseshoe before it could prove the answer.

Here the bound is the exact shortest time to the destination if every hop could be ridden at
its fastest scheduled speed with zero waiting and zero transfer buffer. That can never be more
than the real cost, so it is still admissible, but it is much tighter.

  build_reverse_min_graph(graph)   once, after every agency is merged (~0.4 s)
  lower_bounds_to_goal(rev, seeds) once per search (~0.1 s, cached by goal set)
"""

import heapq
from collections import OrderedDict
from threading import Lock

INF = float("inf")

# float32 `dists` can round a hair above the true minute value; shave a hair so the bound stays admissible
_EPSILON = 1e-4


def build_reverse_min_graph(graph):
    """{stop: [(previous_stop, fastest minutes for that hop on any trip/route), ...]}
    
    Basically creates a very, very basic graph with just the absolute travel times included and no other funny business"""
    rev = {}
    for stop, neighbors in graph.items():
        for neighbor, route_options in neighbors.items():
            best = INF
            for key, trips in route_options.items():
                if key == "__walk__":
                    minutes = float(trips[0].get("distance", 0)) if trips else INF
                else:
                    dists = getattr(trips, "dists", None)
                    if dists is not None:
                        minutes = float(min(dists)) if len(dists) else INF
                    else:
                        minutes = min((float(t.get("distance", 0)) for t in trips), default=INF)
                if minutes < best:
                    best = minutes
            if best < INF:
                rev.setdefault(neighbor, []).append((stop, max(0.0, best - _EPSILON)))              # Remember heuristic must never overestimate time required time!
    return rev


_cache = OrderedDict()
_cache_lock = Lock()
_CACHE_SIZE = 8


def lower_bounds_to_goal(rev, seeds):
    """Shortest time from every stop to the goal, ignoring waits. Stops that cannot reach the goal are absent.

    `seeds` maps each goal stop to its own cost of finishing from there (the final walk).
    The returned dict is shared between calls and must be treated as read-only.

    THIS is the backwards graph search
    """
    key = (id(rev), tuple(sorted(seeds.items())))
    with _cache_lock:
        cached = _cache.get(key)
        if cached is not None:
            _cache.move_to_end(key)
            return cached

    dist = dict(seeds)
    heap = [(cost, stop) for stop, cost in dist.items()]
    heapq.heapify(heap)
    pop, push, get = heapq.heappop, heapq.heappush, dist.get
    rev_get = rev.get
    while heap:
        cost, stop = pop(heap)
        if cost > dist[stop]:
            continue
        for previous, minutes in rev_get(stop, ()):
            new_cost = cost + minutes
            if new_cost < get(previous, INF):
                dist[previous] = new_cost
                push(heap, (new_cost, previous))

    with _cache_lock:
        _cache[key] = dist
        while len(_cache) > _CACHE_SIZE:
            _cache.popitem(last=False)
    return dist
