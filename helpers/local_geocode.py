"""Fast, offline geocoding for Waterloo Region municipal address points.

The local CSV is optional. If it is missing, this module simply returns no local
matches and callers can fall back to another geocoder.
"""

import csv
import pickle
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path

from pyproj import Transformer

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CANDIDATE_PATHS = [
    PROJECT_ROOT / "transit_data" / "addresses.csv",
    PROJECT_ROOT / "transit_data" / "address_points.csv",
]
INDEX_CACHE_PATH = PROJECT_ROOT / "transit_data" / "address_index_cache_v3.pkl"

UTM17N_TO_LATLON = Transformer.from_crs("EPSG:32617", "EPSG:4326", always_xy=True)

_by_civic = None
_settlements = set()  # lowercase settlement names found in the data

# Street types, mapped to ONE canonical token. The same function is applied to the
# query and to the data, so "Court"/"Crt"/"Ct" or "Parkway"/"Pky" all line up.
# The suffix is kept (not thrown away) because "Chesapeake Dr" and "Chesapeake Cres"
# are different streets that share a name and civic numbers.
SUFFIX_CANON = {
    "street": "st", "st": "st", "drive": "dr", "dr": "dr",
    "avenue": "ave", "ave": "ave", "av": "ave", "road": "rd", "rd": "rd",
    "boulevard": "blvd", "blvd": "blvd", "crescent": "cres", "cres": "cres",
    "court": "crt", "crt": "crt", "ct": "crt", "lane": "lane", "ln": "lane",
    "place": "pl", "pl": "pl", "terrace": "terr", "terr": "terr", "ter": "terr",
    "trail": "trail", "trl": "trail", "way": "way", "circle": "cir", "cir": "cir",
    "close": "close", "cl": "close", "parkway": "pky", "pkwy": "pky", "pky": "pky",
    "highway": "hwy", "hwy": "hwy", "square": "sq", "sq": "sq", "heights": "hts",
    "hts": "hts", "line": "line", "walk": "walk", "gate": "gate",
    "common": "common", "greenway": "greenway", "path": "path", "mews": "mews",
    "ridge": "ridge", "cove": "cove", "view": "view", "hollow": "hollow",
    "grove": "grove", "green": "green", "hill": "hill", "run": "run",
}

# Words that name the place, not the street. They are only treated as a city hint
# when they TRAIL the address, so "175 Waterloo St" keeps its street name.
PLACE_WORDS = {
    "kitchener", "waterloo", "cambridge", "ontario", "on", "canada", "wellesley",
    "woolwich", "wilmot", "elmira", "ayr", "baden", "breslau", "dumfries",
    "north", "hamburg", "new", "heidelberg", "st.", "jacobs",
}
CITY_HINTS = {
    "kitchener", "waterloo", "cambridge", "wellesley", "woolwich", "wilmot",
    "elmira", "ayr", "baden", "breslau", "heidelberg", "dumfries", "hamburg",
}

DIRECTION_MAP = {"north": "n", "south": "s", "east": "e", "west": "w"}
DIRECTION_ABBREVIATIONS = set(DIRECTION_MAP.values())

_POSTAL_RE = re.compile(r"^[a-z]\d[a-z]$|^\d[a-z]\d$")
_CIVIC_RE = re.compile(r"^\d+[a-z]?$")


def _tokens(text):
    text = re.sub(r"[.,#]", " ", str(text).lower())
    return re.sub(r"\s+", " ", text).strip().split()


def _parse_street(words):
    """Return (core_street, direction, suffix) from street-name tokens only."""
    words = list(words)

    direction = None
    if len(words) > 1 and (
        words[-1] in DIRECTION_ABBREVIATIONS or words[-1] in DIRECTION_MAP
    ):
        direction = DIRECTION_MAP.get(words[-1], words[-1])
        words = words[:-1]

    suffix = None
    if len(words) > 1 and words[-1] in SUFFIX_CANON:
        suffix = SUFFIX_CANON[words[-1]]
        words = words[:-1]

    return " ".join(words).strip(), direction, suffix


def _parse_query(address):
    """Return dict(civic, core, direction, suffix, cities) for a typed address."""
    if not _settlements and _by_civic is None:
        _load_index()

    words = _tokens(address)

    # "1310-4286 King St E" / "2-41 Brewster Pl": the civic number follows the unit.
    civic = None
    if words:
        match = re.match(r"^(?:\d+[a-z]?-)?(\d+[a-z]?)$", words[0])
        if match:
            civic = match.group(1)
            words = words[1:]

    # Everything after the first comma is place information ("..., Waterloo, ON").
    # Without a comma, peel trailing place names / postal codes, but never consume
    # the whole street ("100 Woolwich" stays a street name).
    cities = set()
    text_after_comma = str(address).lower().split(",", 1)[1] if "," in str(address) else ""
    if text_after_comma:
        place_text = " " + re.sub(r"[.,\s]+", " ", text_after_comma).strip() + " "
        for name in _settlements:
            if f" {name} " in place_text:
                cities.add(name)
        # Re-tokenise only the part before the comma for the street.
        words = _tokens(str(address).split(",", 1)[0])
        if words:
            match = re.match(r"^(?:\d+[a-z]?-)?(\d+[a-z]?)$", words[0])
            if match:
                words = words[1:]
    else:
        while len(words) > 1 and (
            words[-1] in PLACE_WORDS or _POSTAL_RE.match(words[-1])
        ):
            word = words.pop()
            if word in CITY_HINTS:
                cities.add(word)

    core, direction, suffix = _parse_street(words)
    return {
        "civic": civic, "core": core, "direction": direction,
        "suffix": suffix, "cities": cities,
    }


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


def _collect_settlements():
    _settlements.clear()
    for entries in _by_civic.values():
        for entry in entries:
            if entry[6]:
                _settlements.add(entry[6])


def _load_index():
    """Index layout: {civic: [(core, direction, lat, lon, label, suffix, settlement)]}."""
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
            _collect_settlements()
            return
        except Exception:
            pass

    built = {}  # dedupe key -> entry; prefers the IsPrimary point of a building

    with csv_path.open(encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)
        if not reader.fieldnames:
            _by_civic = {}
            return

        fields = {name.strip().lower(): name for name in reader.fieldnames}

        y_field = _pick_field(fields, "lat", "latitude", "y", "y_coord", "ycoord")
        x_field = _pick_field(
            fields, "lon", "lng", "long", "longitude", "x", "vx", "x_coord", "xcoord"
        )
        full_field = _pick_field(
            fields, "fulladdress", "full_address", "address", "address_label",
            "label", "address_full",
        )
        civic_field = _pick_field(
            fields, "addressnumber", "civic_number", "address_number",
            "house_number", "number", "civic_no",
        )
        street_field = _pick_field(
            fields, "fullstreetname", "street", "street_name", "streetname",
            "full_street_name",
        )
        settlement_field = _pick_field(fields, "settlement", "municipality", "city")
        primary_field = _pick_field(fields, "isprimary")

        if not x_field or not y_field:
            _by_civic = {}
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

            # Prefer the dedicated number/street columns: they are not polluted by
            # unit prefixes ("1310-4286 King St E") or settlement suffixes.
            if civic_field and street_field and row.get(civic_field) and row.get(street_field):
                civic_raw = row[civic_field].strip().lower()
                street_raw = row[street_field].strip()
            elif full_field and row.get(full_field):
                parsed = _parse_query(row[full_field])
                if parsed["civic"] is None:
                    continue
                civic_raw = parsed["civic"]
                street_raw = row[full_field].strip().split(None, 1)[-1]
            else:
                continue

            if not _CIVIC_RE.match(civic_raw):
                continue

            core, direction, suffix = _parse_street(_tokens(street_raw))
            if not core:
                continue
            core = sys.intern(core)
            if direction is not None:
                direction = sys.intern(direction)
            if suffix is not None:
                suffix = sys.intern(suffix)

            settlement = (
                row.get(settlement_field, "").strip() if settlement_field else ""
            )
            settlement_key = sys.intern(settlement.lower())
            label = f"{civic_raw.upper()} {street_raw}"
            if settlement:
                label += f", {settlement}"

            entry = (
                core, direction, float(lat), float(lon), label, suffix,
                settlement_key,
            )
            key = (civic_raw, core, direction, suffix, settlement_key)
            is_primary = (
                primary_field is None
                or str(row.get(primary_field, "")).strip().lower() == "yes"
            )
            if key not in built or is_primary and not built[key][1]:
                built[key] = (entry, is_primary)

    result = {}
    for (civic_raw, *_), (entry, _primary) in built.items():
        result.setdefault(civic_raw, []).append(entry)
    built.clear()  # done with the dedup scratch structure - free it before pickling

    _by_civic = result
    _collect_settlements()

    try:
        INDEX_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with INDEX_CACHE_PATH.open("wb") as file:
            pickle.dump(_by_civic, file, protocol=pickle.HIGHEST_PROTOCOL)
    except Exception:
        pass


def _candidate_score(query_street, candidate_street):
    """Similarity used for fuzzy matching and autocomplete ranking."""
    if not query_street:
        return 1.0
    if candidate_street == query_street:
        return 2.0
    if candidate_street.startswith(query_street + " "):
        return 1.5 + min(len(query_street) / max(len(candidate_street), 1), 0.49)
    return SequenceMatcher(None, query_street, candidate_street).ratio()


# Fuzzy matching is only for typos. 0.6 was loose enough to turn one street into a
# different, similarly spelled one; 0.85 only forgives a letter or two.
FUZZY_CUTOFF = 0.85
FUZZY_MARGIN = 0.05


def local_resolve(address, fuzzy_cutoff=FUZZY_CUTOFF):
    """Resolve an address against the local index without guessing.

    Returns (status, payload):
      ("ok", (lat, lon))          exactly one street matches
      ("ambiguous", [labels])     more than one street/town fits; the caller must ask
      ("mismatch", [labels])      the street name exists but not with that type
                                  (e.g. "Chesapeake Court"); do not substitute
      ("none", None)              nothing local; the caller may try another geocoder
    """
    q = _parse_query(address)
    if q["civic"] is None or not q["core"]:
        return "none", None

    _load_index()
    if not _by_civic:
        return "none", None

    candidates = _by_civic.get(q["civic"])
    if not candidates:
        return "none", None

    if q["direction"] is not None:
        candidates = [c for c in candidates if c[1] == q["direction"]]
        if not candidates:
            return "none", None

    pool = [c for c in candidates if c[0] == q["core"]]

    if not pool:
        scores = {}
        for c in candidates:
            scores[c[0]] = _candidate_score(q["core"], c[0])
        ranked = sorted(scores.items(), key=lambda item: -item[1])
        if not ranked or ranked[0][1] < fuzzy_cutoff:
            return "none", None
        if len(ranked) > 1 and ranked[0][1] - ranked[1][1] < FUZZY_MARGIN:
            return "ambiguous", sorted({c[4] for c in candidates if c[0] in (ranked[0][0], ranked[1][0])})
        pool = [c for c in candidates if c[0] == ranked[0][0]]

    if q["suffix"] is not None:
        same_type = [c for c in pool if c[5] == q["suffix"]]
        if not same_type:
            return "mismatch", sorted({c[4] for c in pool})[:6]
        pool = same_type

    if q["cities"]:
        in_city = [c for c in pool if c[6] in q["cities"]]
        if in_city:
            pool = in_city

    groups = {(c[0], c[1], c[5], c[6]) for c in pool}
    if len(groups) == 1:
        return "ok", (pool[0][2], pool[0][3])

    return "ambiguous", sorted({c[4] for c in pool})[:6]


def local_geocode(address, fuzzy_cutoff=FUZZY_CUTOFF):
    """Look up an address locally and return (lat, lon), or None."""
    status, payload = local_resolve(address, fuzzy_cutoff)
    return payload if status == "ok" else None


def search_local(query, limit=6):
    """Return fast local autocomplete suggestions for civic-number queries."""
    q = _parse_query(query)
    if q["civic"] is None:
        return []

    _load_index()
    if not _by_civic:
        return []

    candidates = list(_by_civic.get(q["civic"], []))
    if q["direction"] is not None:
        candidates = [c for c in candidates if c[1] == q["direction"]]

    def rank(c):
        suffix_match = 1 if q["suffix"] and c[5] == q["suffix"] else 0
        city_match = 1 if c[6] in q["cities"] else 0
        return (-_candidate_score(q["core"], c[0]), -suffix_match, -city_match, c[4].lower())

    results = []
    seen = set()

    for c in sorted(candidates, key=rank):
        if q["core"] and _candidate_score(q["core"], c[0]) < 0.45:
            continue

        key = c[4].lower()
        if key in seen:
            continue
        seen.add(key)

        results.append({"label": c[4], "lat": c[2], "lon": c[3], "source": "local"})

        if len(results) >= max(1, int(limit)):
            break

    return results


def is_available():
    return _resolve_csv_path() is not None
