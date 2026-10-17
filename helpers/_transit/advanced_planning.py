"""Schedule-based journey planning helpers, independent from Flask/network calls."""
from datetime import timedelta
from math import floor


def latest_departure_before(deadline, probe, *, window_minutes=360, iterations=7, buffer_minutes=4):
    """Find a late feasible starting time via bounded timetable searches.

    `probe(dt)` returns (path, travel_minutes, start_stop, end_stop).  We probe
    fastest travel first to establish feasibility, then the caller can optimize
    the selected departure for its preferred transit profile.  A small buffer
    protects against rounded stop times and walking geometry changes.

    The result is approximate (2-4-minute granularity), NOT a reverse RAPTOR
    timetable guarantee. Never return a candidate that misses the deadline.
    """
    start = deadline - timedelta(minutes=window_minutes)
    cutoff = deadline - timedelta(minutes=buffer_minutes)

    def try_at(at):
        result = probe(at)
        if not result or result[0] is None:
            return None
        duration = float(result[1])
        if duration < 0 or at + timedelta(minutes=duration) > cutoff:
            return None
        return result

    best = try_at(start)
    if best is None:
        return None
    low, high = 0, window_minutes
    # Time-dependent public transport feasibility is monotone: a traveller
    # can always wait if they reach the origin earlier.
    for _ in range(iterations):
        if high - low <= 3:
            break
        mid = (low + high + 1) // 2
        candidate = try_at(start + timedelta(minutes=mid))
        if candidate is not None:
            low, best = mid, candidate
        else:
            high = mid - 1

    return start + timedelta(minutes=low), best


def minutes_from_clock(clock):
    if not clock:
        return None
    try:
        parts = str(clock).split(":")
        if len(parts) < 2:
            return None
        return int(parts[0]) * 60 + int(parts[1])
    except (ValueError, TypeError):
        return None


def connection_reliability(steps, *, minimum_transfer_minutes=4):
    """Transparent transfer-margin labels, not invented on-time probabilities."""
    previous_ride = None
    walking_min = 0.0
    transfers = []
    for step in steps:
        if step.get("type") == "transit":
            if previous_ride is not None:
                arrival = minutes_from_clock(previous_ride.get("arrival_time"))
                departure = minutes_from_clock(step.get("departure_time"))
                if arrival is not None and departure is not None:
                    if arrival >= 18 * 60 and departure <= 6 * 60:
                        departure += 1440
                    margin = floor((departure - arrival - walking_min)*10)/10
                    if margin < minimum_transfer_minutes:
                        status, label = "critical", "Connection at risk"
                    elif margin < 8:
                        status, label = "tight", "Tight transfer"
                    elif margin < 12:
                        status, label = "moderate", "Limited buffer"
                    else:
                        status, label = "comfortable", "Comfortable transfer"
                    transfers.append({
                        "from_route": previous_ride.get("route"),
                        "to_route": step.get("route"),
                        "stop": step.get("from"),
                        "margin_min": margin,
                        "status": status,
                        "label": label,
                        "live_adjusted": bool(previous_ride.get("realtime") or step.get("realtime")),
                    })
            previous_ride = step
            walking_min = 0.0
        elif previous_ride is not None and step.get("type") in ("walk", "transfer"):
            walking_min += float(step.get("duration_min") or 0.0)

    if not transfers:
        return {"status": "direct", "label": "No connections", "transfers": []}
    order = {"critical": 0, "tight": 1, "moderate": 2, "comfortable": 3}
    worst = min(transfers, key=lambda value: order[value["status"]])
    return {"status": worst["status"], "label": worst["label"], "transfers": transfers}
