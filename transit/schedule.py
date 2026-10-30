"""Schedule lookups and active-service caches."""

from collections import OrderedDict
from datetime import datetime, timedelta

from . import store
from .config import MAX_SCHEDULE_CACHE_ENTRIES, TRANSIT_TIMEZONE
from .store import _ACTIVE_SERVICE_CACHE
from .timeutil import gtfs_service_clock, normalize_departure_datetime


_SCHEDULE_CACHE = OrderedDict()


def schedule_info(trips):
    """Return binary-search helpers without allowing the cache to grow forever."""

    compact_schedule = getattr(trips, "schedule", None)
    if compact_schedule is not None:
        return compact_schedule

    key = id(trips)
    cached = _SCHEDULE_CACHE.get(key)
    if cached is not None:
        _SCHEDULE_CACHE.move_to_end(key)
        return cached



    ordered = trips
    info = {
        "trips": ordered,
        "times": [
            trip.get("departure_time")
            if trip.get("departure_time") is not None
            else float("inf")
            for trip in ordered
        ],
        "by_trip": {
            str(trip.get("trip_id")): trip
            for trip in ordered
            if trip.get("trip_id") is not None
        },
    }

    _SCHEDULE_CACHE[key] = info
    _SCHEDULE_CACHE.move_to_end(key)

    while len(_SCHEDULE_CACHE) > MAX_SCHEDULE_CACHE_ENTRIES:
        _SCHEDULE_CACHE.popitem(last=False)

    return info


def _active_services(date):
    entry = _ACTIVE_SERVICE_CACHE.get(date)
    if entry is None:
        if len(_ACTIVE_SERVICE_CACHE) >= 8:
            _ACTIVE_SERVICE_CACHE.clear()
        entry = (store._data.active_service_ids(date),)
        _ACTIVE_SERVICE_CACHE[date] = entry
    return entry[0]


_MASK_DATES_KEPT = 4


def active_mask(pools, date):
    """bytearray with mask[trip_index] == 1 when that trip runs on `date`.

    Feeds carry every calendar (weekday/Saturday/Sunday/holiday/future), so on any given day
    most trips in an edge's departure list are not running. Checking one byte per trip is much
    cheaper than trip_id -> service_id -> set lookups, and the search does it millions of times.
    Cached on the agency's TripPools object (trip indexes are per agency).
    """
    masks = pools.__dict__.get("_active_masks")
    if masks is None:
        masks = pools.__dict__.setdefault("_active_masks", {})
    mask = masks.get(date)
    if mask is None:
        active = _active_services(date)
        trip_ids = pools.trip_ids
        if active is None:
            mask = bytearray(b"\x01") * len(trip_ids)
        else:
            service_of = store._data.trip_to_service.get
            mask = bytearray(len(trip_ids))
            for index, trip_id in enumerate(trip_ids):
                service_id = service_of(trip_id)
                if service_id is None or service_id in active:
                    mask[index] = 1
        if len(masks) >= _MASK_DATES_KEPT:
            masks.clear()
        masks[date] = mask
    return mask


def warm_schedule_caches(days_ahead: int = 1) -> int:
    """Pre-compute the per-date active-service sets and trip masks (today and the next days).

    IMPORTANT: only run after all agencies are loaded.
    """
    now = normalize_departure_datetime(datetime.now(TRANSIT_TIMEZONE))
    warmed = 0
    for offset in range(max(0, int(days_ahead)) + 1):
        service_date, _seconds = gtfs_service_clock(now + timedelta(days=offset))
        _active_services(service_date)
        for pools in store.trip_pools:
            active_mask(pools, service_date)
        warmed += 1
    return warmed


def trip_active(trip_id, date):
    """Same answer as _data.is_trip_active, but one set lookup per call (the old
    20k-entry LRU thrashed against 124k trips and re-ran strftime each miss)."""
    active = _active_services(date)
    if active is None:
        return True
    service_id = store._data.trip_to_service.get(trip_id)
    if service_id is None:
        return True
    return service_id in active
