# Local, offline address geocoding using a municipal "Address Points" open-data CSV.
#
# To enable this layer, download an address points dataset and save it as
# transit_data/address_points.csv:
#   - Region of Waterloo Open Data:  https://www.regionofwaterloo.ca/opendata
#   - City of Kitchener Open Data:   https://open-kitchenergis.opendata.arcgis.com
#   - City of Waterloo Open Data:    https://opendata.waterloo.ca
#   - City of Cambridge Open Data:   (see cambridge.ca/opendata)
# Any of these work — look for a dataset named something like "Address Points" and
# export/download it as CSV. Column names vary by source, so this loader auto-detects
# common variants (civic number + street name, OR a single full-address column, paired
# with lat/long or UTM-style X/Y coordinate columns) rather than requiring an exact schema.
#
# Without this file present, local_geocode() always returns None and the caller falls
# back to the next layer (e.g. Nominatim) — this is an optional accelerator, not a
# hard requirement.

import csv
import re
from pathlib import Path
from difflib import get_close_matches

ADDRESS_POINTS_CSV = [Path("transit_data") / "address_points.csv"]

_index = None          # normalized_address -> (lat, lon)
_normalized_keys = None  # cached list(_index.keys()) for fuzzy matching

_STREET_SUFFIX_MAP = {
    "street": "st", "drive": "dr", "avenue": "ave", "road": "rd",
    "boulevard": "blvd", "crescent": "cres", "court": "crt", "lane": "ln",
    "place": "pl", "terrace": "terr", "trail": "trl", "way": "way",
    "circle": "cir", "close": "cl", "parkway": "pkwy",
}
_DROP_WORDS = {"kitchener", "waterloo", "cambridge", "ontario", "on", "canada",
               "wellesley", "woolwich", "wilmot", "elmira", "ayr", "baden"}

def _normalize(address):
    text = address.lower().strip()
    text = re.sub(r"[.,#]", " ", text)
    text = re.sub(r"\s+", " ", text)

    words = []
    for word in text.split():
        if word in _DROP_WORDS:
            continue
        words.append(_STREET_SUFFIX_MAP.get(word, word))
    return " ".join(words).strip()

def _pick_field(fieldnames_lower, *candidates):
    for c in candidates:
        if c in fieldnames_lower:
            return fieldnames_lower[c]
    return None

def _load_index():
    global _index, _normalized_keys
    if _index is not None:
        return

    _index = {}
    _normalized_keys = []

    for file in ADDRESS_POINTS_CSV:
        if not file.exists():
            continue

        with open(file, encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            if not reader.fieldnames:
                continue

            fieldnames_lower = {fn.strip().lower(): fn for fn in reader.fieldnames}

            lat_field = _pick_field(fieldnames_lower, "lat", "latitude", "y", "y_coord", "ycoord")
            lon_field = _pick_field(fieldnames_lower, "lon", "lng", "long", "longitude", "x", "x_coord", "xcoord")
            full_field = _pick_field(fieldnames_lower, "full_address", "address", "address_label", "label", "address_full")
            civic_field = _pick_field(fieldnames_lower, "civic_number", "address_number", "house_number", "number", "civic_no")
            street_field = _pick_field(fieldnames_lower, "street", "street_name", "streetname", "full_street_name")

            if not lat_field or not lon_field:
                #borken csv
                continue

            for row in reader:
                lat_raw, lon_raw = row.get(lat_field), row.get(lon_field)
                if not lat_raw or not lon_raw:
                    continue
                try:
                    lat, lon = float(lat_raw), float(lon_raw)
                except ValueError:
                    continue

                if full_field and row.get(full_field):
                    address_text = row[full_field]
                elif civic_field and street_field and row.get(civic_field) and row.get(street_field):
                    address_text = f"{row[civic_field]} {row[street_field]}"
                else:
                    continue

                key = _normalize(address_text)
                if key:
                    _index[key] = (lat, lon)

        _normalized_keys.extend(list(_index.keys()))

def local_geocode(address, fuzzy_cutoff=0.85):
    """Look up an address in the local address-points index. Returns (lat, lon) or None
    if the dataset isn't present, or no close-enough match is found."""
    _load_index()

    if not _index:
        return None

    key = _normalize(address)
    if key in _index:
        return _index[key]

    matches = get_close_matches(key, _normalized_keys, n=1, cutoff=fuzzy_cutoff)
    if matches:
        return _index[matches[0]]

    return None

def is_available():
    """Whether the local address-points dataset is actually loaded and usable."""
    _load_index()
    return bool(_index)