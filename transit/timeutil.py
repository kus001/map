"""Departure-time normalisation and GTFS service-day clock helpers."""

from datetime import datetime, timedelta

from helpers.time_management import seconds_to_time

from .config import SERVICE_DAY_ROLLOVER_HOUR, TRANSIT_TIMEZONE


def time_label(value):
    if value is None:
        return None

    try:


        seconds = int(round(float(value))) % (24 * 3600)
        return seconds_to_time(seconds)[:5]
    except Exception:
        return None


def shifted_time_label(value, minutes):
    label = value if isinstance(value, str) else time_label(value)
    if not label:
        return None

    try:
        hour, minute = [int(part) for part in str(label).split(":")[:2]]
        total = (hour * 60 + minute + int(round(float(minutes or 0)))) % (24 * 60)
        return f"{total // 60:02d}:{total % 60:02d}"
    except (TypeError, ValueError):
        return label


def normalize_departure_datetime(value):
    """Return an aware America/Toronto datetime for a requested departure."""
    if value is None:
        return datetime.now(TRANSIT_TIMEZONE) + timedelta(minutes=1)

    if isinstance(value, datetime):
        parsed = value
    else:
        parsed = datetime.fromisoformat(str(value).strip())

    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=TRANSIT_TIMEZONE)

    return parsed.astimezone(TRANSIT_TIMEZONE)


def gtfs_service_clock(departure_datetime):
    """Translate local date/time to GTFS service date + seconds since service midnight."""
    service_date = departure_datetime.date()
    seconds = (
        departure_datetime.hour * 3600
        + departure_datetime.minute * 60
        + departure_datetime.second
    )


    if departure_datetime.hour < SERVICE_DAY_ROLLOVER_HOUR:
        service_date -= timedelta(days=1)
        seconds += 24 * 3600

    return service_date, seconds
