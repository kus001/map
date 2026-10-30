"""Tunable constants and environment-driven settings for the transit router."""

import os
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv


load_dotenv()

ORS_API_KEY = os.getenv("API")
ORS_WALKING_URL = (
    "https://api.heigit.org/openrouteservice/v2/directions/foot-walking"
)
# Set MAP_LOCAL_OSRM_URL to an empty string to turn it off.
LOCAL_OSRM_WALK_URL = os.getenv(
    "MAP_LOCAL_OSRM_URL", "https://host-transit-page.hackclub.app/route/v1/foot/"
).strip().rstrip("/")
# The local extract only covers this box: (west, south, east, north).
LOCAL_OSRM_BBOX = (-82.3694723, 42.7787658, -76.1642432, 44.461654)

# After a connection failure, skip the local server for this many seconds.
LOCAL_OSRM_COOLDOWN_SECONDS = 30.0
# Walking transfers between rides (ride -> walk -> ride). Ordinary stops within this many
# metres (straight line) get a transfer link; see transit/walk_links.py. Walking between two
# separate bus stops is rarely worth it, so this is small; stations, terminals and GO stops
# reach much further (INTERCHANGE_WALK_* below). 0 turns the ordinary links off.
TRANSFER_WALK_RADIUS_M = max(0.0, float(os.getenv("TRANSIT_TRANSFER_WALK_M", "250")))
# Each stop keeps its nearest few candidates only, which bounds memory and search work.
TRANSFER_WALK_MAX_LINKS = max(0, int(os.getenv("TRANSIT_TRANSFER_WALK_LINKS", "12")))
# Streets rarely run straight, so estimated walking distance = straight line x this.
TRANSFER_WALK_DETOUR = float(os.getenv("TRANSIT_TRANSFER_WALK_DETOUR", "1.3"))
# Closer pairs than this are the same stop for practical purposes.
TRANSFER_WALK_MIN_M = 1.0
# Real walking times from the local OSRM (python -m transit.walk_links) replace the straight-line
# estimate. A transfer that really takes longer than this many minutes (a highway or river in
# the way) is dropped.
TRANSFER_WALK_MAX_MIN = float(os.getenv("TRANSIT_TRANSFER_WALK_MAX_MIN", "10"))
# Stations, terminals and GO stops are worth a longer walk they get their own link slots, a wider radius and a
# higher time cap, so busy bus stops nearby can't crowd them out. Radius 0 turns this off.
INTERCHANGE_WALK_RADIUS_M = max(0.0, float(os.getenv("TRANSIT_INTERCHANGE_WALK_M", "1000")))
INTERCHANGE_WALK_MAX_LINKS = max(0, int(os.getenv("TRANSIT_INTERCHANGE_WALK_LINKS", "6")))
INTERCHANGE_WALK_MAX_MIN = float(os.getenv("TRANSIT_INTERCHANGE_WALK_MAX_MIN", "15"))
# A stop counts as an interchange if its agency is listed or its name has one of these words.
INTERCHANGE_AGENCIES = frozenset({"go", "grt_trains"})
INTERCHANGE_NAME_WORDS = ("station", "terminal", "go", "union")
WALK_LINK_TIMES_PATH = os.getenv("TRANSIT_WALK_LINK_TIMES") or str(
    Path(__file__).resolve().parents[1] / "transit_data" / "walk_link_times.json"
)
TRANSIT_TIMEZONE = ZoneInfo("America/Toronto")
MAX_NEARBY_STOPS = 32
FASTEST_NEARBY_STOPS = 64
TRANSIT_PREFERENCES = {
    "balanced": {
        "label": "Balanced",
        "soft_walk_m": 300,
        "walk_penalty": 1.0,
        "max_nearby_stops": MAX_NEARBY_STOPS,
    },
    "less_walking": {
        "label": "Less walking",
        "soft_walk_m": 0,
        "walk_penalty": 3.0,
        "max_nearby_stops": MAX_NEARBY_STOPS,
    },
    "fastest": {
        "label": "Fastest",
        "soft_walk_m": 0,
        "walk_penalty": 0.0,
        "max_nearby_stops": FASTEST_NEARBY_STOPS,
    },
}
TRANSFER_BUFFER_MIN = 4
HEURISTIC_SPEED_KMH = 100.0
# A* heuristic: 1 = graph lower bound (tight, fast), 0 = old straight-line distance at HEURISTIC_SPEED_KMH
TRANSIT_GRAPH_HEURISTIC = os.getenv("TRANSIT_GRAPH_HEURISTIC", "1") == "1"
ACCESS_WALK_SPEED_MPS = 1.1
SERVICE_DAY_ROLLOVER_HOUR = 4
REALTIME_SCHEDULE_WINDOW_HOURS = 3
MAX_SCHEDULED_TRIP_CACHE_ENTRIES = 256
TRANSIT_DETAILED_WALKS = os.getenv("TRANSIT_DETAILED_WALKS", "1") == "1"
MAX_TRANSIT_ALTERNATIVES = max(1, min(int(os.getenv("TRANSIT_ALTERNATIVES", "6")), 10))
TRANSIT_ALT_BUDGET_SECONDS = float(os.getenv("TRANSIT_ALT_BUDGET_SECONDS", "9.0"))
ALT_MIN_HEADWAY_MIN = 5
TRANSIT_GO_BOARD_ENRICHMENT = os.getenv("TRANSIT_GO_BOARD_ENRICHMENT", "0") == "1"
LIVE_VEHICLE_MAX_AGE_SECONDS = max(30, int(os.getenv("LIVE_VEHICLE_MAX_AGE_SECONDS", "120")))
# Walking links added between a newly merged agency and other agencies' stops.
AGENCY_LINK_RADIUS_M = 160
AGENCY_LINK_WALK_M_PER_MIN = 75
MAX_WALK_CACHE_ENTRIES = 512
MAX_CONCURRENT_WALK_REQUESTS = 6
WALK_BATCH_BUDGET_SECONDS = max(0.0, min(0.5, float(os.getenv("TRANSIT_WALK_BUDGET_SECONDS", "0.05"))))
WALK_BACKGROUND_SECONDS = 7.0
MAX_SCHEDULE_CACHE_ENTRIES = 256

# Keeping the GTFS timetables fresh (see freshness.py)
GTFS_AUTO_REFRESH = os.getenv("GTFS_AUTO_REFRESH", "1") == "1"
# re-download a feed once its last scheduled service day is fewer than this many days away
GTFS_REFRESH_AHEAD_DAYS = int(os.getenv("GTFS_REFRESH_AHEAD_DAYS", "5"))
GTFS_CHECK_INTERVAL_SECONDS = int(os.getenv("GTFS_CHECK_INTERVAL_SECONDS", "3600"))
# don't hammer a publisher that hasn't posted a newer feed yet
GTFS_RETRY_EXPIRED_HOURS = float(os.getenv("GTFS_RETRY_EXPIRED_HOURS", "3"))
GTFS_RETRY_EXPIRING_HOURS = float(os.getenv("GTFS_RETRY_EXPIRING_HOURS", "24"))
GTFS_REBUILD_TIMEOUT_SECONDS = int(os.getenv("GTFS_REBUILD_TIMEOUT_SECONDS", "3600"))
