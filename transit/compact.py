"""Compact, list-compatible storage for the per-edge trip lists in the transit graph.

The old graph kept every (stop -> stop, route) timetable as a Python list of dicts:
about 2.1 million dicts (~330 bytes each, ~700 MB resident). Here each timetable is
four typed arrays (about 16 bytes per trip-hop) and an edge dict is only built when
somebody actually reads that entry.

``CompactTrips`` behaves like the old list for everything the router does:
``len()``, iteration, ``[i]``, ``[a:b]`` slices, and ``bisect`` over ``.deps``.
It also carries its own ``schedule`` view, so ``schedule_info()`` becomes a
constant-time attribute lookup instead of rebuilding a ``times`` list and a
``by_trip`` dict on every edge visit.
"""
from array import array


class TripPools:
    """Interned data shared by every CompactTrips in one graph."""

    def __init__(self, trip_ids=None, routes=None, trip_route=None):
        self.trip_ids = trip_ids if trip_ids is not None else []
        self.routes = routes if routes is not None else []
        self.trip_route = trip_route if trip_route is not None else array("H")
        self._index = None

    @property
    def index(self):
        if self._index is None or len(self._index) != len(self.trip_ids):
            self._index = {t: i for i, t in enumerate(self.trip_ids)}
        return self._index

    def __reduce__(self):
        return (TripPools, (self.trip_ids, self.routes, self.trip_route))


class _Schedule:
    """Dict-like view used by transit.py: schedule["trips" | "times" | "by_trip"]."""

    __slots__ = ("trips",)

    def __init__(self, trips):
        self.trips = trips

    def __getitem__(self, key):
        if key == "trips":
            return self.trips
        if key == "times":
            return self.trips.deps
        if key == "by_trip":
            return self.trips
        raise KeyError(key)


class _Window:
    """Lazy half-open slice of a CompactTrips (so `trips[i:]` never copies the tail)."""

    __slots__ = ("_t", "_a", "_b")

    def __init__(self, trips, start, stop):
        self._t, self._a, self._b = trips, start, max(start, stop)

    def __len__(self):
        return self._b - self._a

    def __iter__(self):
        edge = self._t._edge
        for i in range(self._a, self._b):
            yield edge(i)

    def __getitem__(self, key):
        if isinstance(key, slice):
            start, stop, step = key.indices(len(self))
            if step != 1:
                return [self[i] for i in range(start, stop, step)]
            return _Window(self._t, self._a + start, self._a + stop)
        n = len(self)
        if key < 0:
            key += n
        if not 0 <= key < n:
            raise IndexError(key)
        return self._t._edge(self._a + key)


class CompactTrips:
    __slots__ = ("deps", "arrs", "tids", "dists", "pools", "schedule")

    def __init__(self, deps, arrs, tids, dists, pools):
        self.deps = deps
        self.arrs = arrs
        self.tids = tids
        self.dists = dists
        self.pools = pools
        self.schedule = _Schedule(self)

    def __reduce__(self):
        return (CompactTrips, (self.deps, self.arrs, self.tids, self.dists, self.pools))

    def __len__(self):
        return len(self.deps)

    def _edge(self, i):
        pools = self.pools
        tid = self.tids[i]
        return {
            "distance": self.dists[i],
            "trip_id": pools.trip_ids[tid],
            "departure_time": self.deps[i],
            "arrival_time": self.arrs[i],
            "route": pools.routes[pools.trip_route[tid]],
        }

    def __iter__(self):
        edge = self._edge
        for i in range(len(self.deps)):
            yield edge(i)

    def __getitem__(self, key):
        if isinstance(key, slice):
            start, stop, step = key.indices(len(self.deps))
            if step != 1:
                return [self._edge(i) for i in range(start, stop, step)]
            return _Window(self, start, stop)
        n = len(self.deps)
        if key < 0:
            key += n
        if not 0 <= key < n:
            raise IndexError(key)
        return self._edge(key)


    def get(self, trip_id, default=None):
        tid = self.pools.index.get(trip_id)
        if tid is None:
            return default
        try:
            return self._edge(self.tids.index(tid))
        except ValueError:
            return default

    def edges_for_trips(self, wanted_trip_ids):
        """Yield edge dicts only for the given trip-id strings, without building the rest."""
        index = self.pools.index
        wanted = {index[t] for t in wanted_trip_ids if t in index}
        if not wanted:
            return
        for i, tid in enumerate(self.tids):
            if tid in wanted:
                yield self._edge(i)


def unique_pools(graph):
    """Each distinct TripPools used by a graph's compact edge lists (one per agency)."""
    found = {}
    for neighbors in graph.values():
        for route_options in neighbors.values():
            for key, trips in route_options.items():
                if key != "__walk__":
                    pools = getattr(trips, "pools", None)
                    if pools is not None:
                        found[id(pools)] = pools
    return list(found.values())
