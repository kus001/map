# Local, offline address geocoding using a municipal "Address Points" open-data CSV.
#
# To enable this layer, download an address points dataset and save it as
# transit_data/addresses.csv (transit_data/address_points.csv also works):
#   - Region of Waterloo Open Data:  https://www.regionofwaterloo.ca/opendata
#   - City of Kitchener Open Data:   https://open-kitchenergis.opendata.arcgis.com
#   - City of Waterloo Open Data:    https://opendata.waterloo.ca
#   - City of Cambridge Open Data:   (see cambridge.ca/opendata)
# Any of these work — look for a dataset named something like "Address Points" and
# export/download it as CSV. Column names vary by source, so this loader auto-detects
# common variants (civic number + street name, OR a single full-address column), and
# auto-detects whether the coordinate columns are plain lat/lon or UTM easting/northing
# (the Region of Waterloo export uses NAD83 UTM Zone 17N, e.g. "VX"/"Y" columns in the
# hundreds-of-thousands / millions range) and converts UTM to lat/lon with pyproj.
#
# Without this file present, local_geocode() always returns None and the caller falls
# back to the next layer (e.g. Nominatim) — this is an optional accelerator, not a
# hard requirement.

import csv
import re
from pathlib import Path
from difflib import get_close_matches
from pyproj import Transformer

_CANDIDATE_PATHS = [
    Path("transit_data") / "addresses.csv",
    Path("transit_data") / "address_points.csv",
]

# UTM Zone 17N (NAD83) -> WGS84 lat/lon. Covers the Waterloo Region open-data exports.
_utm17n_to_latlon = Transformer.from_crs("EPSG:32617", "EPSG:4326", always_xy=True)

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

def _resolve_csv_path():
    for path in _CANDIDATE_PATHS:
        if path.exists():
            return path
    return None

def _load_index():
    global _index, _normalized_keys
    if _index is not None:
        return

    _index = {}

    csv_path = _resolve_csv_path()
    if csv_path is None:
        _normalized_keys = []
        return

    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            _normalized_keys = []
            return

        fieldnames_lower = {fn.strip().lower(): fn for fn in reader.fieldnames}

        # "vx" covers the Region of Waterloo export's own (slightly unusual) column name
        y_field = _pick_field(fieldnames_lower, "lat", "latitude", "y", "y_coord", "ycoord")
        x_field = _pick_field(fieldnames_lower, "lon", "lng", "long", "longitude", "x", "vx", "x_coord", "xcoord")
        full_field = _pick_field(fieldnames_lower, "fulladdress", "full_address", "address",
                                  "address_label", "label", "address_full", "fulladdresswithsettlement")
        civic_field = _pick_field(fieldnames_lower, "addressnumber", "civic_number", "address_number",
                                   "house_number", "number", "civic_no")
        street_field = _pick_field(fieldnames_lower, "fullstreetname", "street", "street_name",
                                    "streetname", "full_street_name")

        if not y_field or not x_field:
            # Can't use this file without coordinate columns — leave the index empty
            # rather than raising, so a malformed CSV just disables this layer.
            _normalized_keys = []
            return

        is_utm = None  # decided from the first valid row, then assumed consistent for the rest

        for row in reader:
            y_raw, x_raw = row.get(y_field), row.get(x_field)
            if not y_raw or not x_raw:
                continue
            try:
                y_val, x_val = float(y_raw), float(x_raw)
            except ValueError:
                continue

            if is_utm is None:
                # Plain lat/lon stays within +/-180; UTM eastings/northings run into the
                # hundreds of thousands to millions — unambiguous at this scale.
                is_utm = abs(x_val) > 180 or abs(y_val) > 90

            if is_utm:
                lon, lat = _utm17n_to_latlon.transform(x_val, y_val)
            else:
                lat, lon = y_val, x_val

            if full_field and row.get(full_field):
                address_text = row[full_field]
            elif civic_field and street_field and row.get(civic_field) and row.get(street_field):
                address_text = f"{row[civic_field]} {row[street_field]}"
            else:
                continue

            key = _normalize(address_text)
            if key:
                _index[key] = (lat, lon)

    _normalized_keys = list(_index.keys())

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