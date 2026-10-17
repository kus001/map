"""Server-side TomTom traffic tiles. Only used when the traffic switch is on."""

from collections import OrderedDict
import os
import threading
import time

import requests

_cache = OrderedDict()
_lock = threading.Lock()
_URL = "https://api.tomtom.com/maps/orbis/traffic/flow/raster/tile/{z}/{x}/{y}"


def available():
    return bool(os.getenv("TOMTOM_API_KEY", "").strip())


def get_tile(z, x, y, style="light"):
    key = os.getenv("TOMTOM_API_KEY", "").strip()
    if not key:
        return None

    style = style if style in ("light", "dark") else "light"
    tile_id = (z, x, y, style)
    with _lock:
        cached = _cache.get(tile_id)
        if cached and cached[0] > time.monotonic():
            _cache.move_to_end(tile_id)
            return cached[1]

    try:
        response = requests.get(
            _URL.format(z=z, x=x, y=y),
            params={"apiVersion": 2, "style": style, "tileSize": 256},
            headers={"TomTom-Api-Key": key, "Accept": "image/png"},
            timeout=(2, 5),
        )
        response.raise_for_status()
        if not response.headers.get("Content-Type", "").startswith("image/png"):
            return None
        png = response.content
        if not png.startswith(b"\x89PNG\r\n\x1a\n") or len(png) > 500_000:
            return None
    except requests.RequestException:
        return None

    with _lock:
        _cache[tile_id] = (time.monotonic() + 90, png)
        _cache.move_to_end(tile_id)
        while len(_cache) > 128:
            _cache.popitem(last=False)
    return png
