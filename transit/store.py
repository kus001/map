"""Shared mutable transit state. Rebound by loader.ensure_transit_loaded, so other modules read it as `store.graph` / `store.stops` / `store._data` at call time rather than importing the names."""

import threading


_data = None
graph = None
stops = None
_transit_load_lock = threading.Lock()
_realtime_started = False
_ACTIVE_SERVICE_CACHE = {}
