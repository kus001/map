"""Stop board driven by the same GTFS graph as route search."""
from bisect import bisect_left
from zoneinfo import ZoneInfo

TIMEZONE = ZoneInfo('America/Toronto')


def upcoming_departures(stop_id, graph, *, service_date, service_seconds, active_trip,
                        realtime, route_details, raw_stop_id, adjusted_departure,
                        limit=8, horizon_seconds=5400):
    """Generate mixed realtime/scheduled stop board without remote HTTP calls.

    Parameters are supplied by transit.py so this module is easy to test without
    creating a giant graph. A valid trip ID must match the selected GTFS agency.
    """
    agency, _, raw = str(stop_id).partition(':')
    if not raw or stop_id not in graph:
        return []
    departures = {}
    stop_routes = graph[stop_id]
    for neighbor, routes in stop_routes.items():
        for route_key, edges in routes.items():
            if route_key == '__walk__':
                continue


            compact_times = getattr(edges, 'deps', None)
            if compact_times is not None:

                times, sorted_times = compact_times, True
            else:
                times = [float(edge.get('departure_time') or -1) for edge in edges]
                sorted_times = all(times[i] <= times[i+1] for i in range(len(times)-1))
            selected = edges[max(0, bisect_left(times, service_seconds-3600)-2):] if sorted_times else edges
            for trip in selected:
                trip_id = str(trip.get('trip_id') or '')
                if not trip_id or not active_trip(trip_id, service_date):
                    continue
                update = realtime.get('trip_updates', {}).get((agency, trip_id)) or {}
                if update.get('cancelled'):
                    cancelled = True
                else:
                    cancelled = False
                departure, delay_seconds, is_live = adjusted_departure(
                    realtime, agency, trip, raw_stop_id(stop_id)
                )
                if departure is None and cancelled:
                    departure = trip.get('departure_time')
                    delay_seconds = 0
                if departure is None or not (service_seconds-90 <= departure <= service_seconds+horizon_seconds):
                    continue
                route, direction = route_details(trip)

                key = (agency, trip_id, int(departure))
                if key in departures:
                    continue
                minute = round((departure - service_seconds)/60)
                clock_secs = int(departure) % 86400
                departures[key] = {
                    'trip_id': trip_id,
                    'route': str(route or route_key),
                    'direction': str(direction or ''),
                    'scheduled_time': _clock(trip.get('departure_time')),
                    'expected_time': _clock(departure),
                    'minutes_until': minute,
                    'delay_min': round(float(delay_seconds or 0)/60,1),
                    'realtime': bool(is_live),
                    'cancelled': cancelled,
                    'status': 'Cancelled' if cancelled else ('Live' if is_live else 'Scheduled'),
                    '_time': float(departure),
                }
    return [{k:v for k,v in item.items() if k != '_time'}
            for item in sorted(departures.values(), key=lambda value:value['_time'])[:limit]]


def _clock(seconds):
    try:
        n = int(float(seconds)) % 86400
        return f'{n//3600:02d}:{(n%3600)//60:02d}'
    except (ValueError, TypeError):
        return None
