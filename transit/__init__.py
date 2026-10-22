"""Transit router package (was the single transit.py).

Every name that used to live in transit.py is re-exported here, so
`from transit import get_transit_route` and `transit.ensure_transit_loaded()` keep working.
`graph`, `stops` and `_data` are rebound at load time, so they are served live from `store`.
"""

from . import agencies

from .config import (
    ORS_API_KEY,
    ORS_WALKING_URL,
    TRANSIT_TIMEZONE,
    MAX_NEARBY_STOPS,
    FASTEST_NEARBY_STOPS,
    TRANSIT_PREFERENCES,
    TRANSFER_BUFFER_MIN,
    HEURISTIC_SPEED_KMH,
    ACCESS_WALK_SPEED_MPS,
    SERVICE_DAY_ROLLOVER_HOUR,
    REALTIME_SCHEDULE_WINDOW_HOURS,
    MAX_SCHEDULED_TRIP_CACHE_ENTRIES,
    TRANSIT_DETAILED_WALKS,
    MAX_TRANSIT_ALTERNATIVES,
    TRANSIT_ALT_BUDGET_SECONDS,
    ALT_MIN_HEADWAY_MIN,
    TRANSIT_GO_BOARD_ENRICHMENT,
    LIVE_VEHICLE_MAX_AGE_SECONDS,
    AGENCY_LINK_RADIUS_M,
    AGENCY_LINK_WALK_M_PER_MIN,
    MAX_WALK_CACHE_ENTRIES,
    MAX_CONCURRENT_WALK_REQUESTS,
    WALK_BATCH_BUDGET_SECONDS,
    WALK_BACKGROUND_SECONDS,
    MAX_SCHEDULE_CACHE_ENTRIES,
)

from .geo import (
    coord,
    stop_coords,
    stop_name,
    stop_agency,
    raw_stop_id,
    access_walk_minutes,
    dist_m,
    polyline_distance_m,
    point_along_polyline,
)

from .timeutil import (
    time_label,
    shifted_time_label,
    normalize_departure_datetime,
    gtfs_service_clock,
)

from .display import (
    route_details,
    display_headsign,
    normalize_color,
    vehicle_label,
    delay_status_label,
)

from .loader import (
    missing_agency_caches,
    _merge_agency,
    ensure_transit_loaded,
)

from .schedule import (
    _SCHEDULE_CACHE,
    schedule_info,
    _active_services,
    warm_schedule_caches,
    trip_active,
)

from .vehicles import (
    live_vehicle_is_usable,
    _scheduled_trip_cache,
    _scheduled_trip_cache_lock,
    _load_scheduled_trip_hops,
    scheduled_vehicle_positions,
    _nearby_vehicle_cache,
    _nearby_vehicle_lock,
    nearby_scheduled_vehicles,
)

from .walks import (
    _WALK_CACHE,
    run_async,
    _walk_client,
    _ors_walk_directions,
    _osrm_walk,
    _fetch_walking_route,
    _straight_walk,
    walking_geometry_async,
    walking_geometry,
    _fetch_walks_async,
    _walk_pool,
    _walk_batches,
    _walk_batch_lock,
    fetch_walks,
    ready_walks,
    _walk_key,
    _walk_id,
)

from .paths import (
    is_transit_edge,
    route_keys_for_path,
    route_signature,
    _namespaced_trip_keys,
    combine_realtime,
    group_path,
    _path_walk_jobs,
    _path_signature,
    _transit_groups,
    _alt_signature,
)

from .search import (
    transit_preference_profile,
    candidate_stops,
    access_walk_cost,
    _candidate_trip_realtime_compact,
    _candidate_trip,
    search_transit,
    generate_alternative_paths,
)

from .stop_queries import (
    nearby_transit_stops,
    stop_departure_board,
)

from .route import (
    _replay_timeline,
    get_transit_route,
)

from . import store


def __getattr__(name):
    # `transit.stops`, `transit.graph` etc. must reflect the loaded data, not a stale import-time copy.
    if name in ("graph", "stops", "_data", "_realtime_started"):
        return getattr(store, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
