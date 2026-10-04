"""Fast, offline geocoding for Waterloo Region municipal address points.

The local CSV is optional. If it is missing, this module simply returns no local
matches and callers can fall back to another geocoder.
"""

import csv
import pickle
import re
from difflib import SequenceMatcher
from pathlib import Path

from pyproj import Transformer

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CANDIDATE_PATHS = [
    PROJECT_ROOT / "transit_data" / "addresses.csv",
    PROJECT_ROOT / "transit_data" / "address_points.csv",
]
INDEX_CACHE_PATH = PROJECT_ROOT / "transit_data" / "address_index_cache_v2.pkl"

UTM17N_TO_LATLON = Transformer.from_crs("EPSG:32617", "EPSG:4326", always_xy=True)

_by_civic = None

STREET_SUFFIX_MAP = {
    "street": "st",
    "drive": "dr",
    "avenue": "ave",
    "road": "rd",
    "boulevard": "blvd",
    "crescent": "cres",
    "court": "crt",
    "lane": "ln",
    "place": "pl",
    "terrace": "terr",
    "trail": "trl",
    "way": "way",
    "circle": "cir",
    "close": "cl",
    "parkway": "pkwy",
}
SUFFIX_ABBREVIATIONS = set(STREET_SUFFIX_MAP.values())

DROP_WORDS = {
    "kitchener",
    "waterloo",
    "cambridge",
    "ontario",
    "on",
    "canada",
    "wellesley",
    "woolwich",
    "wilmot",
    "elmira",
    "ayr",
    "baden",
}

DIRECTION_MAP = {"north": "n", "south": "s", "east": "e", "west": "w"}
DIRECTION_ABBREVIATIONS = set(DIRECTION_MAP.values())


def _parse_address(address):
    """Return (civic_number, core_street_name, direction)."""
    text = str(address).lower().strip()
    text = re.sub(r"[.,#]", " ", text)
    words = re.sub(r"\s+", " ", text).strip().split()

    civic_number = None
    if words and words[0].isdigit():
        civic_number = words[0]
        words = words[1:]

    words = [
        STREET_SUFFIX_MAP.get(word, word)
        for word in words
        if word not in DROP_WORDS
    ]

    direction = None
    if words and (
        words[-1] in DIRECTION_ABBREVIATIONS or words[-1] in DIRECTION_MAP
    ):
        direction = DIRECTION_MAP.get(words[-1], words[-1])
        words = words[:-1]

    if words and words[-1] in SUFFIX_ABBREVIATIONS:
        words = words[:-1]

    return civic_number, " ".join(words).strip(), direction


def _pick_field(fieldnames_lower, *candidates):
    for candidate in candidates:
        if candidate in fieldnames_lower:
            return fieldnames_lower[candidate]
    return None


def _resolve_csv_path():
    for path in CANDIDATE_PATHS:
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

    if (
        INDEX_CACHE_PATH.exists()
        and INDEX_CACHE_PATH.stat().st_mtime >= csv_path.stat().st_mtime
    ):
        try:
            with INDEX_CACHE_PATH.open("rb") as file:
                _by_civic = pickle.load(file)
            return
        except Exception:
            pass

    _by_civic = {}

    with csv_path.open(encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)
        if not reader.fieldnames:
            return

        fields = {name.strip().lower(): name for name in reader.fieldnames}

        y_field = _pick_field(fields, "lat", "latitude", "y", "y_coord", "ycoord")
        x_field = _pick_field(
            fields,
            "lon",
            "lng",
            "long",
            "longitude",
            "x",
            "vx",
            "x_coord",
            "xcoord",
        )
        full_field = _pick_field(
            fields,
            "fulladdress",
            "full_address",
            "address",
            "address_label",
            "label",
            "address_full",
            "fulladdresswithsettlement",
        )
        civic_field = _pick_field(
            fields,
            "addressnumber",
            "civic_number",
            "address_number",
            "house_number",
            "number",
            "civic_no",
        )
        street_field = _pick_field(
            fields,
            "fullstreetname",
            "street",
            "street_name",
            "streetname",
            "full_street_name",
        )
        settlement_field = _pick_field(fields, "settlement", "municipality", "city")

        if not x_field or not y_field:
            return

        is_utm = None

        for row in reader:
            x_raw = row.get(x_field)
            y_raw = row.get(y_field)
            if not x_raw or not y_raw:
                continue

            try:
                x_value = float(x_raw)
                y_value = float(y_raw)
            except ValueError:
                continue

            if is_utm is None:
                is_utm = abs(x_value) > 180 or abs(y_value) > 90

            if is_utm:
                lon, lat = UTM17N_TO_LATLON.transform(x_value, y_value)
            else:
                lat, lon = y_value, x_value

            if full_field and row.get(full_field):
                display_label = row[full_field].strip()
            elif (
                civic_field
                and street_field
                and row.get(civic_field)
                and row.get(street_field)
            ):
                display_label = f"{row[civic_field].strip()} {row[street_field].strip()}"
                if settlement_field and row.get(settlement_field):
                    display_label += f", {row[settlement_field].strip()}"
            else:
                continue

            civic_number, core_street, direction = _parse_address(display_label)
            if civic_number is None or not core_street:
                continue

            _by_civic.setdefault(civic_number, []).append(
                (
                    core_street,
                    direction,
                    (float(lat), float(lon)),
                    display_label,
                )
            )

    try:
        INDEX_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with INDEX_CACHE_PATH.open("wb") as file:
            pickle.dump(_by_civic, file, protocol=pickle.HIGHEST_PROTOCOL)
    except Exception:
        pass


def _candidate_score(query_street, candidate_street):
    if not query_street:
        return 1.0
    if candidate_street == query_street:
        return 2.0
    if candidate_street.startswith(query_street):
        return 1.5 + min(
            len(query_street) / max(len(candidate_street), 1),
            0.49,
        )
    return SequenceMatcher(None, query_street, candidate_street).ratio()


def local_geocode(address, fuzzy_cutoff=0.6):
    """Look up an address locally and return (lat, lon), or None."""
    # Parse first. POI/name searches do not need the 50+ MB civic-address index.
    civic_number, core_street, direction = _parse_address(address)
    if civic_number is None or not core_street:
        return None

    _load_index()
    if not _by_civic:
        return None

    candidates = _by_civic.get(civic_number)
    if not candidates:
        return None

    if direction is not None:
        candidates = [candidate for candidate in candidates if candidate[1] == direction]
        if not candidates:
            return None

    exact = [candidate for candidate in candidates if candidate[0] == core_street]
    if len(exact) == 1:
        return exact[0][2]
    if len(exact) > 1:
        directions = {candidate[1] for candidate in exact}
        return exact[0][2] if len(directions) <= 1 else None

    best = max(
        candidates,
        key=lambda candidate: _candidate_score(core_street, candidate[0]),
    )
    score = _candidate_score(core_street, best[0])
    return best[2] if score >= fuzzy_cutoff else None


def search_local(query, limit=6):
    """Return fast local autocomplete suggestions for civic-number queries."""
    # Avoid loading the large address index for ordinary POI/name searches.
    civic_number, core_street, direction = _parse_address(query)
    if civic_number is None:
        return []

    _load_index()
    if not _by_civic:
        return []

    candidates = list(_by_civic.get(civic_number, []))
    if direction is not None:
        candidates = [candidate for candidate in candidates if candidate[1] == direction]

    ranked = sorted(
        candidates,
        key=lambda candidate: (
            -_candidate_score(core_street, candidate[0]),
            candidate[3].lower(),
        ),
    )

    results = []
    seen = set()

    for core, _, coordinates, label in ranked:
        score = _candidate_score(core_street, core)
        if core_street and score < 0.45:
            continue

        dedupe_key = label.lower()
        if dedupe_key in seen:
            continue

        seen.add(dedupe_key)
        results.append(
            {
                "label": label,
                "lat": float(coordinates[0]),
                "lon": float(coordinates[1]),
                "source": "local",
            }
        )

        if len(results) >= max(1, int(limit)):
            break

    return results


def is_available():
    # Availability only means the source data exists; checking it should not load
    # the entire address index into RAM.
    return _resolve_csv_path() is not None
