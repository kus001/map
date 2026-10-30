from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
TRANSIT_DATA = PROJECT_ROOT / "transit_data"
GTFS_ROOT = TRANSIT_DATA / "GTFS_Files"


class Graph:
    def __init__(self, graph, node_positions, trip_to_service=None, calendar=None, calendar_dates=None):
        self.graph = graph
        self.node_positions = node_positions
        self.trip_to_service = trip_to_service or {}
        self.calendar = calendar or {}
        self.calendar_dates = calendar_dates or {}

    def get_neighbors(self, stop_id):
        return self.graph.get(stop_id, {})

    def get_position(self, stop_id):
        return self.node_positions.get(stop_id, (None, None))

    def is_service_active(self, service_id, check_date):
        date_str = check_date.strftime("%Y%m%d")
        exception = self.calendar_dates.get((service_id, date_str))

        if exception == 1:
            return True
        if exception == 2:
            return False

        cal = self.calendar.get(service_id)
        if cal is None or not (cal["start"] <= check_date <= cal["end"]):
            return False

        return cal["days"][check_date.weekday()]

    def active_service_ids(self, check_date):
        """Set of service ids running on check_date, or None meaning "no calendar
        data, treat every trip as active" (same rule as is_trip_active)."""
        if not self.trip_to_service and not self.calendar and not self.calendar_dates:
            return None
        return {
            sid
            for sid in set(self.trip_to_service.values())
            if self.is_service_active(sid, check_date)
        }

    def is_trip_active(self, trip_id, check_date):


        if not self.trip_to_service and not self.calendar and not self.calendar_dates:
            return True

        service_id = self.trip_to_service.get(trip_id)
        if service_id is None:
            return True

        return self.is_service_active(service_id, check_date)


def make_graph():
    # No shared agencies any more: every agency lives in its own cache and is merged in by transit.py.
    return Graph({}, {}, {}, {}, {})
