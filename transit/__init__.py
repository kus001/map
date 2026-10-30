"""Transit router package (was the single transit.py).

Only the entry points the rest of the project uses are re-exported here; everything else is imported
from its own module (``from transit.route import ...``). ``graph`` and ``stops`` are rebound at load
time, so they are served live from ``store``.
"""

from . import agencies, store

from .loader import ensure_transit_loaded, missing_agency_caches
from .paths import combine_realtime
from .route import get_transit_route
from .schedule import warm_schedule_caches
from .stop_queries import nearby_transit_stops, stop_departure_board
from .vehicles import (
    live_vehicle_is_usable,
    nearby_scheduled_vehicles,
    scheduled_vehicle_positions,
)
from .walks import ready_walks


def __getattr__(name):
    # `transit.stops`, `transit.graph` must reflect the loaded data, not a stale import-time copy.
    if name in ("graph", "stops"):
        return getattr(store, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
