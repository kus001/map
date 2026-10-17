"""Small cached adapter for the Ontario 511 map feeds."""

import math
import os
import threading
import time

import requests

API = "https://511on.ca/api"
FEEDS = {
    "incidents": ("v2/get/event", 300),
    "construction": ("v2/get/constructionprojects", 900),
    "cameras": ("v2/get/cameras", 900),
    "winter": ("v3/get/roadconditions", 600),
}

_cache = {}
_lock = threading.Lock()


def decode_line(encoded):
    """Decode a GTFS/Google-style polyline into [latitude, longitude] pairs."""
    points = []
    lat = lon = pos = 0
    try:
        while pos < len(encoded) and len(points) < 20000:
            values = []
            for _ in range(2):
                result = 0
                shift = 0
                while True:
                    c = ord(encoded[pos]) - 63
                    pos += 1
                    result |= (c & 31) << shift
                    shift += 5
                    if c < 32:
                        break
                    if shift > 35:
                        return []
                values.append(~(result >> 1) if result & 1 else result >> 1)
            lat += values[0]
            lon += values[1]
            a, b = lat / 1e5, lon / 1e5
            if -90 <= a <= 90 and -180 <= b <= 180:
                points.append([a, b])
    except (IndexError, TypeError, ValueError):
        return []
    return points


def _coords(value):
    try:
        lat = float(value.get("Latitude"))
        lon = float(value.get("Longitude"))
        if math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180:
            return [lat, lon]
    except (ValueError, TypeError, AttributeError):
        pass
    return None


def _lines(value):
    cached = value.get("_511_lines")
    if cached is not None:
        return cached
    encoded = value.get("EncodedPolyline")
    if isinstance(encoded, str):
        encoded = [encoded]
    if not isinstance(encoded, list):
        return []
    lines = [line for part in encoded if isinstance(part, str) and (line := decode_line(part))]
    # Decode a provincial polyline only once per feed refresh, not once per pan.
    value["_511_lines"] = lines
    if lines:
        value["_511_bounds"] = (
            min(p[1] for line in lines for p in line),
            min(p[0] for line in lines for p in line),
            max(p[1] for line in lines for p in line),
            max(p[0] for line in lines for p in line),
        )
    return lines


def _inside(pt, box):
    return box[1] <= pt[0] <= box[3] and box[0] <= pt[1] <= box[2]


def _selected_line(lines, box):
    # The provider often supplies an entire highway as one polyline.
    # Send only portions around the current viewport, without joining distant gaps.
    output = []
    for line in lines:
        if not any(_inside(pt, box) for pt in line):
            continue
        stride = max(1, len(line) // 700)
        selected = line[::stride]
        if selected[-1] != line[-1]:
            selected.append(line[-1])
        output.append(selected)
        if len(output) >= 4:
            break
    return output


def _clean_text(value, max_len=700):
    if isinstance(value, (list, tuple)):
        value = ", ".join(str(x) for x in value if x is not None)
    return str(value or "").strip()[:max_len]


def _normalize(kind, rows, box, limit):
    results = []
    for index, item in enumerate(rows):
        if not isinstance(item, dict):
            continue
        pt = _coords(item)
        lines = []
        if kind == "winter" or (pt is None and item.get("EncodedPolyline")):
            all_lines = _lines(item)
            extent = item.get("_511_bounds")
            if extent and not (extent[2] < box[0] or extent[0] > box[2] or
                               extent[3] < box[1] or extent[1] > box[3]):
                lines = _selected_line(all_lines, box)
        if not (pt and _inside(pt, box)) and not lines:
            continue

        if kind == "incidents" and str(item.get("EventType", "")).lower() == "roadwork":
            continue  # The construction feed has these separately.
        road = _clean_text(item.get("RoadwayName") or item.get("Roadway"), 120)
        location = _clean_text(item.get("Location") or item.get("LocationDescription") or road, 280)
        title = road or location[:90] or kind.title()
        if kind == "winter":
            details = _clean_text(item.get("Condition") or "Road condition reported")
            if item.get("Visibility"):
                details += f" · Visibility: {_clean_text(item['Visibility'], 45)}"
        else:
            details = _clean_text(item.get("Description") or item.get("Comment") or location, 3000)
        # The provider description can be pages long. Use the first useful sentence
        # on the map and keep the full report behind an expandable section.
        first = next((bit.strip() for bit in details.replace("\n", ". ").split(".") if bit.strip()), "")
        summary = first[:145].rstrip(" ,;:")
        if len(first) > 145:
            summary = summary.rsplit(" ", 1)[0] + "…"
        entry = {
            "id": str(item.get("ID") or item.get("Id") or item.get("SourceId") or index),
            "kind": kind,
            "title": title,
            "location": location,
            "road": road,
            "summary": summary,
            "details": details,
            "direction": _clean_text(item.get("DirectionOfTravel") or item.get("Direction"), 80),
            "updated": item.get("LastUpdated"),
            "point": pt or (lines[0][0] if lines else None),
            "lines": lines,
        }
        if kind in ("incidents", "construction"):
            entry["closure"] = bool(item.get("IsFullClosure"))
            entry["type"] = _clean_text(item.get("EventSubType") or item.get("EventType"), 80)
            entry["lanes"] = _clean_text(item.get("LanesAffected"), 80)
            entry["impact"] = _clean_text(item.get("Impact"), 140)
        if kind == "cameras":
            images = []
            seen = set()
            for view in item.get("Views") or []:
                if not isinstance(view, dict):
                    continue
                url = str(view.get("Url") or "").strip()
                if not url.startswith("https://") or url in seen:
                    continue
                if str(view.get("Status", "Enabled")).lower() != "enabled":
                    continue
                seen.add(url)
                images.append({
                    "url": url,
                    "label": _clean_text(view.get("Description"), 110) or f"View {len(images) + 1}",
                })
                if len(images) >= 12:
                    break
            entry["images"] = images
        results.append(entry)
        if len(results) >= limit:
            break
    return results


def _download(kind, now=None):
    key = os.getenv("ONTARIO511_API_KEY", "").strip() or os.getenv("ONTARIO_511_API_KEY", "").strip()
    if not key:
        return None, "Set ONTARIO511_API_KEY on your Flask server to enable Ontario 511 layers."

    now = time.monotonic() if now is None else now
    path, ttl = FEEDS[kind]
    # Locking this one small section also prevents bursts from several visitors
    # hitting the provider at once. Each feed has its own expiry.
    with _lock:
        old = _cache.get(kind)
        if old and old["until"] > now:
            return old["data"], old["error"]
        try:
            response = requests.get(f"{API}/{path}",
                                    params={"key": key, "format": "json", "lang": "en"},
                                    timeout=(3, 7))
            response.raise_for_status()
            data = response.json()
            if isinstance(data, dict):
                data = data.get("items") or data.get("results") or data.get("data") or []
            if not isinstance(data, list):
                raise ValueError("Unexpected Ontario 511 response")
            _cache[kind] = {"data": data, "until": now + ttl, "error": None}
            return data, None
        except (requests.RequestException, ValueError) as exc:
            # Keep old reports rather than dropping the map's entire overlay.
            data = old["data"] if old else []
            message = "Ontario 511 is temporarily unavailable."
            _cache[kind] = {"data": data, "until": now + 60, "error": message}
            return data, message


def get_layer(kind, bounds, limit=150):
    if kind not in FEEDS:
        raise ValueError("Unknown Ontario 511 layer")
    data, error = _download(kind)
    if data is None:
        return {"enabled": False, "items": [], "message": error, "stale": False}
    return {
        "enabled": True,
        "items": _normalize(kind, data, bounds, min(200, max(1, limit))),
        "message": error,
        "stale": bool(error),
        "source": "Ontario 511",
    }
