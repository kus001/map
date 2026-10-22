"""Presentation helpers: route/headsign/colour/vehicle labels and delay text."""

import re

from . import agencies


def route_details(edge) -> tuple[str|None, str|None]:
    route_info = edge.get("route")
    headsign = edge.get("headsign")

    if isinstance(route_info, dict):
        route_name = (
            route_info.get("route")
            or route_info.get("route_short_name")
            or route_info.get("name")
            or route_info.get("route_id")
        )
        headsign = route_info.get("headsign") or headsign
    else:
        route_name = str(route_info) if route_info else None



    if route_name:
        route_name = re.sub(r"^\d{8}-(?=.)", "", str(route_name))

    return route_name, str(headsign) if headsign is not None else None


def display_headsign(route_name, headsign):
    """Headsign for display only: GO headsigns repeat the route ("25 - Square One")."""
    if not headsign:
        return headsign
    text = str(headsign)
    if route_name:
        stripped = re.sub(rf"^{re.escape(str(route_name))}\s*[-–]\s*(?=\S)", "", text, count=1)
        if stripped:
            return stripped
    return text


def normalize_color(value) -> str|None:
    value = str(value or "").strip().lstrip("#")
    if len(value) == 6 and all(c in "0123456789abcdefABCDEF" for c in value):
        return f"#{value}"
    return None


def vehicle_label(agency, route_type=None):
    labels = {
        "0": "tram",
        "1": "subway",
        "2": "train",
        "3": "bus",
        "4": "ferry",
        "5": "tram",
        "6": "gondola",
        "7": "funicular",
        "11": "trolleybus",
        "12": "monorail",
    }

    if route_type is not None and str(route_type) in labels:
        return labels[str(route_type)]
    info = agencies.get(agency)
    return info.fallback_mode if info else "transit"


def delay_status_label(delay_min):
    """'3 min late' / '2 min early' / 'On time' for a live delay in minutes."""
    minutes = round(float(delay_min or 0))
    if minutes >= 1:
        return f"{minutes} min late"
    if minutes <= -1:
        return f"{-minutes} min early"
    return "On time"
