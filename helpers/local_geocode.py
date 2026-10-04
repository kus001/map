# Local, offline address geocoding using a municipal "Address Points" open-data CSV.
# To enable this layer, download an address points dataset and save it as transit_data/addresses.csv.

# Column names vary by source, so this loader auto-detects
# common variants (civic number + street name, OR a single full-address column), and
# auto-detects whether the coordinate columns are plain lat/lon or UTM easting/northing

# Matching strategy: the real dataset here is ~263k rows, far too many for a linear
# fuzzy scan per query. Addresses are indexed by civic (house) number first, which is
# highly selective (~45 addresses per civic number on average, a few thousand at worst
# for very common numbers like "10"/"15"/"50")

# Without the CSV present, local_geocode() always returns None and the caller falls
# back to the next layer (e.g. Nominatim) — this is an optional accelerator, not a hard requirement.

import csv
import re
import pickle
from pathlib import Path
from difflib import SequenceMatcher
from pyproj import Transformer

PROJECT_ROOT = (Path(__file__).resolve().parents[1])

_CANDIDATE_PATHS = [PROJECT_ROOT / "transit_data" / "addresses.csv", PROJECT_ROOT / "transit_data" / "address_points.csv"]
_INDEX_CACHE_PATH = (PROJECT_ROOT / "transit_data" / "address_index_cache_v2.pkl")

# UTM Zone 17N (NAD83) -> WGS84 lat/lon. Covers the Waterloo Region open-data exports.
_utm17n_to_latlon = Transformer.from_crs("EPSG:32617", "EPSG:4326", always_xy=True)

# civic_number (str) -> list of (core_street_name, direction_or_None, (lat, lon))
_by_civic = None

_STREET_SUFFIX_MAP = {
    "street": "st", "drive": "dr", "avenue": "ave", "road": "rd",
    "boulevard": "blvd", "crescent": "cres", "court": "crt", "lane": "ln",
    "place": "pl", "terrace": "terr", "trail": "trl", "way": "way",
    "circle": "cir", "close": "cl", "parkway": "pkwy",
}
_SUFFIX_ABBREVIATIONS = set(_STREET_SUFFIX_MAP.values())
_DROP_WORDS = {"kitchener", "waterloo", "cambridge", "ontario", "on", "canada",
               "wellesley", "woolwich", "wilmot", "elmira", "ayr", "baden"}

# Unlike St/Street, which are true synonyms for the same street, a directional suffix
# (King St N vs King St S) can mean a genuinely different street with its own separate
# address range — real civic numbers in this dataset exist on BOTH sides of 1,340+
# streets. So direction is normalized the same way St/Street is, but is tracked
# separately and is NEVER treated as optional/droppable or fuzzy-matchable across
# directions the way the street type suffix is.
_DIRECTION_MAP = {"north": "n", "south": "s", "east": "e", "west": "w"}
_DIRECTION_ABBREVIATIONS = set(_DIRECTION_MAP.values())

def _parse_address(address):
    """Splits an address into (civic_number, core_street_name, direction). core_street_name
    has the street-type suffix (St/Dr/Cres/...) stripped off, so it's optional on input.
    direction (n/s/e/w or None) is kept separate and must be preserved exactly."""
    text = (str(address).lower().strip())
    text = re.sub(r"[.,#]", " ", text)
    words = re.sub(r"\s+", " ", text).strip().split()

    civic_number = None
    if words and words[0].isdigit():
        civic_number = words[0]
        words = words[1:]

    words = [_STREET_SUFFIX_MAP.get(word, word) for word in words if word not in _DROP_WORDS]

    direction = None
    if (words and (words[-1] in _DIRECTION_ABBREVIATIONS or words[-1] in _DIRECTION_MAP)):
        direction = (_DIRECTION_MAP.get(words[-1], words[-1]))
        words = (words[:-1])

    if (words and words[-1] in _SUFFIX_ABBREVIATIONS):
        words = (words[:-1])  # the street TYPE suffix is a true synonym - safe to drop

    return (civic_number, " ".join(words).strip(), direction)

def _pick_field(fieldnames_lower, *candidates):
    for candidate in candidates:
        if candidate in fieldnames_lower:
            return fieldnames_lower[candidate]
    return None

def _resolve_csv_path():
    for path in _CANDIDATE_PATHS:
        if path.exists():
            return path
    return None

def _load_index():
    global _by_civic
    if _by_civic is not None:
        return

    csv_path = _resolve_csv_path()
    if csv_path is None:
        _by_civic = {}
        return

    # Reuse a cached, pre-built index if it's at least as new as the source CSV
    if (_INDEX_CACHE_PATH.exists() and (_INDEX_CACHE_PATH.stat().st_mtime >= csv_path.stat().st_mtime)):
        try:
            with open(_INDEX_CACHE_PATH, "rb") as file:
                _by_civic = pickle.load(file)
            return
        except Exception:
            pass  # corrupt/incompatible cache - fall through and rebuild from the CSV

    _by_civic = {}

    with open(csv_path, encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)
        if not reader.fieldnames:
            return

        fields = {name.strip().lower(): name for name in reader.fieldnames}

        y_field = _pick_field(fields, "lat", "latitude", "y", "y_coord", "ycoord")
        x_field = _pick_field(fields, "lon", "lng", "long", "longitude", "x", "vx", "x_coord", "xcoord")
        full_field = _pick_field(fields, "fulladdress", "full_address", "address", "address_label", "label", "address_full", "fulladdresswithsettlement")
        civic_field = _pick_field(fields, "addressnumber", "civic_number", "address_number", "house_number", "number", "civic_no")
        street_field = _pick_field(fields, "fullstreetname", "street", "street_name", "streetname", "full_street_name")
        settlement_field = _pick_field(fields, "settlement", "municipality", "city")

        if (not y_field or not x_field):
            # Can't use this file without coordinate columns — leave the index empty
            # rather than raising, so a malformed CSV just disables this layer.
            return

        is_utm = None  # decided from the first valid row, then assumed consistent for the rest

        for row in reader:
            x_raw = row.get(x_field)
            y_raw = row.get(y_field)

            if (not y_raw or not x_raw):
                continue
            try:
                x_value = float(x_raw)
                y_value = float(y_raw)
            except ValueError:
                continue

            if is_utm is None:
                # Plain lat/lon stays within +/-180; UTM eastings/northings run into the
                # hundreds of thousands to millions — unambiguous at this scale.
                is_utm = abs(x_value) > 180 or abs(y_value) > 90

            if is_utm:
                lon, lat = _utm17n_to_latlon.transform(x_value, y_value)
            else:
                lat, lon = y_value, x_value

            if (full_field and row.get(full_field)):
                display_label = (row[full_field].strip())
            elif civic_field and street_field and row.get(civic_field) and row.get(street_field):
                display_label = (f"{row[civic_field].strip()} {row[street_field].strip()}")
                if (settlement_field and row.get(settlement_field)):
                    display_label += (f", " f"{row[settlement_field].strip()}")
            else:
                continue

            (civic_number, core_street, direction) = _parse_address(display_label)
            if civic_number is None or not core_street:
                continue

            _by_civic.setdefault(civic_number, []).append((core_street, direction, (float(lat), float(lon)), display_label))

    try:
        _INDEX_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(_INDEX_CACHE_PATH, "wb") as file:
            pickle.dump(_by_civic, file, protocol=pickle.HIGHEST_PROTOCOL)
    except Exception:
        pass  # caching is an optimization, not a requirement - a write failure shouldn't break geocoding

def _candidate_score(query_street, candidate_street):
    if not query_street:
        return 1.0
    if (candidate_street == query_street):
        return 2.0
    if candidate_street.startswith(query_street):
        return (1.5 + min(len(query_street) / max(len(candidate_street), 1), 0.49))
    return SequenceMatcher(None, query_street, candidate_street, candidate_street).ratio()

def local_geocode(address, fuzzy_cutoff=0.6):
    """Look up an address in the local address-points index. Returns (lat, lon) or None
    if the dataset isn't present, the address has no leading civic number, or nothing
    close enough is found. Fuzzy matching is scoped to addresses sharing the same civic
    number, so it stays fast even against a dataset with hundreds of thousands of rows.

    Direction (N/S/E/W) is a hard constraint, not a fuzzy-matchable detail: if the query
    gives a direction, only candidates with that exact direction are considered. If it
    doesn't, and the civic number genuinely exists on more than one direction of that
    street, this refuses to guess and returns None rather than silently picking one."""
    _load_index()

    if not _by_civic:
        return None

    (civic_number, core_street, direction) = _parse_address(address)
    if (civic_number is None or not core_street):
        return None

    candidates = _by_civic.get(civic_number)
    if not candidates:
        return None

    if direction is not None:
        candidates = [candidate for candidate in candidates if (candidate[1] == direction)]
        if not candidates:
            return None

    exact = [candidate for candidate in candidates if candidate[0] == core_street]

    if len(exact) == 1:
        return exact[0][2]
    if len(exact) > 1:
        directions = {candidate[1] for candidate in exact}
        if (len(directions) <= 1):
            return exact[0][2]
        return None
    best = max(candidates, key=lambda candidate: _candidate_score(core_street, candidate[0]))
    score = _candidate_score(core_street, best[0])
    return (best[2] if score >= fuzzy_cutoff else None)

def search_local(query, limit=6):
    _load_index()

    if not _by_civic:
        return []
    (civic_number, core_street, direction) = _parse_address(query)
    candidates = list(_by_civic.get(civic_number, []))
    if direction is not None:
        candidates = [candidate for candidate in candidates if (candidate[1] == direction)]

    ranked = sorted(candidates, key=lambda candidate: (-_candidate_score(core_street, candidate[0]), candidate[3].lower()))
    results = []
    seen = set()

    for (core, _candidate_direction, coordinates, label) in ranked:
        score = _candidate_score(core_street, core)
        if (core_street and score < 0.45):
            continue
        dedupe_key = (label.lower())

        if dedupe_key in seen:
            continue

        seen.add(dedupe_key)

        results.append({
            "label": label,
            "lat": float(coordinates[0]),
            "lon": float(coordinates[1]),
            "source": "local"
        })

        if (len(results) >= max(1, int(limit))):
            break
    return results

def is_avaliable():
    _load_index()
    return bool(_by_civic)

_load_index()
