"""Interactive local test: `python -m transit`."""

from datetime import datetime

from helpers.time_management import us

from .config import TRANSIT_PREFERENCES, TRANSIT_TIMEZONE
from .loader import ensure_transit_loaded
from .route import get_transit_route


def _local_test_color_helpers():
    """Load the project's old terminal colors only for standalone testing."""
    try:
        from helpers.print_color import bold, blue, green, magenta, red, yellow
        return bold, blue, green, magenta, red, yellow
    except Exception:


        identity = lambda value, *args, **kwargs: str(value)
        return identity, identity, identity, identity, identity, identity


def _print_local_route_result(result, timing, graph_load_seconds):
    """Pretty-print a transit response for `python transit.py` testing."""
    import json

    bold, blue, green, magenta, red, yellow = _local_test_color_helpers()

    timing_report = {
        "graph_load": f"{graph_load_seconds * 1000:.3f} ms",
    }

    for key, value in timing.items():
        if key == "start":
            continue
        timing_report[key] = f"{value / 1000:.3f} ms"

    print(red(json.dumps(timing_report, indent=4)) + "\n")

    if not result.get("success"):
        print(red(result.get("error", "Transit route failed.")))
        return

    route = result["routes"][0]
    steps = route.get("steps", [])

    print(bold("Directions:"))
    for step in steps:
        instruction = step.get("instruction", "")
        step_type = step.get("type", "")

        if step_type == "walk":
            print(green(instruction))
        elif step_type == "transfer":
            print(magenta(instruction))
        elif step_type == "transit":
            meta = []
            if step.get("departure_time") and step.get("arrival_time"):
                meta.append(f"{step['departure_time']} -> {step['arrival_time']}")
            if step.get("stops"):
                meta.append(f"{step['stops']} stops")
            if step.get("realtime"):
                meta.append("LIVE")

            suffix = f" ({' | '.join(meta)})" if meta else ""
            print(blue(instruction + suffix))
        else:
            print(yellow(instruction))

    print()
    print(
        bold(
            f"Estimated commute time: {route.get('duration_min', 0):.1f} minutes"
        )
    )
    print(f"Distance walked: {route.get('distance_km', 0):.2f} km")
    print(f"Departure: {route.get('departure_datetime', 'now')}")
    print(f"Transit preference: {route.get('transit_preference_label', 'Balanced')}")

    realtime = route.get("realtime", {})
    if realtime.get("available"):
        print(green("Realtime transit feed available."))
    elif realtime.get("feed_connected"):
        print(yellow("Realtime feed connected, but scheduled data was used."))
    else:
        print(yellow("Realtime unavailable; scheduled GTFS data was used."))


def main():
    bold, blue, green, magenta, red, yellow = _local_test_color_helpers()

    print(bold("=" * 64))
    print(bold("Map Router - LOCAL TRANSIT TEST"))
    print(bold("=" * 64))

    graph_load_seconds = ensure_transit_loaded(verbose=True)

    start_address = input(bold("Starting Address: ")).strip()
    end_address = input(bold("End Address: ")).strip()

    departure_text = input(
        bold("Departure date/time [Enter = now, or YYYY-MM-DD HH:MM]: ")
    ).strip()

    departure_datetime = None
    if departure_text:
        try:
            departure_datetime = datetime.fromisoformat(departure_text)
            if departure_datetime.tzinfo is None:
                departure_datetime = departure_datetime.replace(
                    tzinfo=TRANSIT_TIMEZONE
                )
            else:
                departure_datetime = departure_datetime.astimezone(TRANSIT_TIMEZONE)
        except ValueError:
            print(red("Invalid date/time. Using current time instead."))
            departure_datetime = None

    preference_text = input(
        bold("Transit preference [Enter = balanced, less_walking, fastest]: ")
    ).strip().lower()
    if preference_text not in TRANSIT_PREFERENCES:
        preference_text = "balanced"

    print("\nFinding transit route...\n")

    timing = {"start": us()}
    result = get_transit_route(
        start_address,
        end_address,
        departure_datetime=departure_datetime,
        timing=timing,
        transit_preference=preference_text,
    )

    _print_local_route_result(result, timing, graph_load_seconds)
