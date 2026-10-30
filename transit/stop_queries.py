"""Nearby-stop and stop-departure-board queries."""

from . import agencies, ttc_surface
from .go_realtime import gtfs_snapshot as go_gtfs_snapshot
from .realtime import adjusted_departure, snapshot as realtime_snapshot
from .stop_boards import upcoming_departures
from helpers.coords import nearest_stops

from . import store
from .display import route_details
from .geo import coord, raw_stop_id, stop_agency
from .loader import ensure_transit_loaded
from .paths import combine_realtime
from .schedule import trip_active
from .timeutil import gtfs_service_clock, normalize_departure_datetime


def nearby_transit_stops(lat, lon, radius_m=3000, limit=25):
    """Stops around map center; cached graph and bounded response size."""
    ensure_transit_loaded()
    radius_m = max(300, min(1500, float(radius_m)))
    limit = max(1, min(50, int(limit)))
    nearest = nearest_stops(store.stops, float(lat), float(lon), amount_of_stops=limit * 3)
    answer = []
    for distance, (stop_id, info) in nearest:
        if distance > radius_m:
            continue
        agency = stop_agency(stop_id)
        if not agencies.is_known(agency):
            continue
        if not store.graph.get(stop_id):
            continue
        answer.append({"id": stop_id, "raw_id": raw_stop_id(stop_id),
                       "agency": agency, "agency_label": agencies.label(agency), "name": info[2] or raw_stop_id(stop_id),
                       "coordinates": coord(info), "distance_m": round(distance)})
        if len(answer) >= limit:
            break
    return answer


def stop_departure_board(stop_id, limit=8, now=None):
    ensure_transit_loaded()
    if stop_id not in store.stops:
        return None
    now = normalize_departure_datetime(now)
    service_date, service_seconds = gtfs_service_clock(now)
    grt_live = realtime_snapshot()
    realtime = combine_realtime(grt_live, go_gtfs_snapshot())

    schedule = upcoming_departures(
        stop_id, store.graph, service_date=service_date, service_seconds=service_seconds,
        active_trip=trip_active, realtime=realtime, route_details=route_details,
        raw_stop_id=raw_stop_id, adjusted_departure=adjusted_departure,
        limit=max(1,min(12,int(limit))),
    )

    if not schedule:
        centre = coord(store.stops[stop_id])
        for metres, (other_id, other_info) in nearest_stops(store.stops, *centre, amount_of_stops=16):
            if metres > 90:
                break
            if other_id == stop_id or stop_agency(other_id) != stop_agency(stop_id):
                continue
            nearby = upcoming_departures(
                other_id, store.graph, service_date=service_date, service_seconds=service_seconds,
                active_trip=trip_active, realtime=realtime, route_details=route_details,
                raw_stop_id=raw_stop_id, adjusted_departure=adjusted_departure, limit=8,
            )
            if nearby:
                for item in nearby:
                    item['boarding_stop'] = other_info[2] or raw_stop_id(other_id)
                schedule = nearby
                break

    if stop_agency(stop_id) == "ttc":
        centre = coord(store.stops[stop_id])
        surface = ttc_surface.live_departures(*centre, store.stops[stop_id][2] or "", grt_live.get("surface_predictions", {}), limit=max(1, min(12, int(limit))), now=now.timestamp())
        schedule = ttc_surface.merge_departures(schedule, surface, limit=max(1, min(12, int(limit))), now=now.timestamp())

    return {"stop_id": stop_id, "name": store.stops[stop_id][2] or stop_id,
            "agency": stop_agency(stop_id),
            "agency_label": agencies.label(stop_agency(stop_id)), "departures": schedule,
            "live_count": sum(1 for item in schedule if item['realtime']),
            "source": "GTFS schedule + available realtime updates"}
