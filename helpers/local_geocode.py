"""Fast, offline geocoding for Waterloo Region municipal address points.

The local CSV is optional. If it is missing, this module simply returns no local
matches and callers can fall back to another geocoder.
"""

import csv
import math
import pickle
import re
import sys
import threading
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

# Street-level index
_streets = None
_streets_by_core = {}
_streets_lock = threading.Lock()

# Street types, mapped to ONE canonical token. The same function is applied to the
# query and to the data, so "Court"/"Crt"/"Ct" or "Parkway"/"Pky" all line up.
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


def preload():
    """Load (or build) the address index now instead of on the first lookup.

    Returns the number of indexed address points.
    """
    _load_index()
    _build_street_index()
    return sum(len(entries) for entries in (_by_civic or {}).values())


def _km(lat1, lon1, lat2, lon2):
    """Great-circle distance in kilometres."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(a))


def _civic_number(civic_raw):
    match = re.match(r"\d+", str(civic_raw))
    return int(match.group()) if match else None


def _build_street_index():
    """Group the address points by street so streets can be searched by name."""
    global _streets, _streets_by_core

    if _streets is not None:
        return

    with _streets_lock:
        if _streets is not None:
            return

        _load_index()
        streets = {}
        for civic_raw, entries in (_by_civic or {}).items():
            number = _civic_number(civic_raw)
            if number is None:
                continue
            for core, direction, lat, lon, label, suffix, settlement in entries:
                key = (core, direction, suffix, settlement)
                bucket = streets.get(key)
                if bucket is None:
                    # "100 King St E, Kitchener" -> "King St E, Kitchener"
                    bucket = streets[key] = [label.split(" ", 1)[-1], []]
                bucket[1].append((number, lat, lon))

        by_core = {}
        for key, bucket in streets.items():
            bucket[1].sort()
            by_core.setdefault(key[0], []).append(key)

        _streets_by_core = by_core
        _streets = streets


# Scores: exact name 2.0 > whole-word prefix 1.5-1.99 > partial-word prefix 1.3-1.49
# (only while the user is still typing) > spelling similarity (0-1).
def _candidate_score(query_street, candidate_street, partial=False):
    """Similarity used for fuzzy matching and autocomplete ranking."""
    if not query_street:
        return 1.0
    if candidate_street == query_street:
        return 2.0
    if candidate_street.startswith(query_street + " "):
        return 1.5 + min(len(query_street) / max(len(candidate_street), 1), 0.49)
    if partial and candidate_street.startswith(query_street):
        return 1.3 + min(len(query_street) / max(len(candidate_street), 1), 0.19)
    return SequenceMatcher(None, query_street, candidate_street).ratio()


# Fuzzy matching is only for typos.
#   >= FUZZY_ACCEPT  a different spelling is auto-corrected (if clearly ahead of the rest)
#   >= FUZZY_CUTOFF  offered as a "did you mean", never silently used
#   <  FUZZY_CUTOFF  not related ("Chesapeake" is not "Chapel")
FUZZY_CUTOFF = 0.72
FUZZY_ACCEPT = 0.85
FUZZY_MARGIN = 0.05

# A civic number missing from the data is placed next to the nearest numbered address
# on the same (unambiguous) street, but only if that neighbour is this close.
APPROX_MAX_GAP = 40


def _distinct(entries):
    """One representative entry per label, sorted by label."""
    seen = {}
    for entry in entries:
        seen.setdefault(entry[4], entry)
    return [seen[label] for label in sorted(seen)]


def _approximate(q):
    """Place a civic number the data lacks beside its nearest neighbour on the street."""
    target = _civic_number(q["civic"])
    if target is None:
        return "none", None

    _build_street_index()
    keys = [
        key for key in _streets_by_core.get(q["core"], [])
        if (q["direction"] is None or key[1] == q["direction"])
        and (q["suffix"] is None or key[2] == q["suffix"])
        and (not q["cities"] or key[3] in q["cities"])
    ]
    if len(keys) != 1:
        return "none", None  # unknown street, or several streets share the name

    label, civics = _streets[keys[0]]
    nearest = min(
        civics,
        key=lambda c: (abs(c[0] - target) + (0 if c[0] % 2 == target % 2 else 3), c[0]),
    )
    if abs(nearest[0] - target) > APPROX_MAX_GAP:
        return "none", None

    return "approximate", (nearest[1], nearest[2], f"{q['civic'].upper()} {label}")


def resolve_detailed(address, fuzzy_cutoff=FUZZY_CUTOFF, fuzzy_accept=FUZZY_ACCEPT):
    """Resolve an address against the local index without guessing.

    Returns (status, payload):
      ("ok", entry)                exactly one street matches; entry is an index tuple
                                   (core, direction, lat, lon, label, suffix, settlement)
      ("approximate", (lat, lon, label))
                                   the street is unambiguous but this civic number is not
                                   in the data; placed beside the nearest numbered address
      ("ambiguous", [entries])     more than one street/town fits; the caller must ask
      ("mismatch", [entries])      the street name exists but not with that type
                                   (e.g. "Chesapeake Court"); do not substitute
      ("none", None)               nothing local; the caller may try another geocoder
    """
    q = _parse_query(address)
    if q["civic"] is None or not q["core"]:
        return "none", None

    _load_index()
    if not _by_civic:
        return "none", None

    candidates = _by_civic.get(q["civic"])
    if candidates and q["direction"] is not None:
        candidates = [c for c in candidates if c[1] == q["direction"]]
    if not candidates:
        return _approximate(q)

    pool = [c for c in candidates if c[0] == q["core"]]

    if not pool:
        scores = {}
        for c in candidates:
            scores[c[0]] = _candidate_score(q["core"], c[0])
        ranked = sorted(scores.items(), key=lambda item: -item[1])
        if not ranked or ranked[0][1] < fuzzy_cutoff:
            return _approximate(q)

        close = [name for name, score in ranked if score >= fuzzy_cutoff][:3]
        if ranked[0][1] < fuzzy_accept or (
            len(ranked) > 1 and ranked[0][1] - ranked[1][1] < FUZZY_MARGIN
        ):
            # Low confidence: offer the closest names instead of choosing one.
            names = close if ranked[0][1] < fuzzy_accept else close[:2]
            return "ambiguous", _distinct(c for c in candidates if c[0] in names)[:6]
        pool = [c for c in candidates if c[0] == ranked[0][0]]

    if q["suffix"] is not None:
        same_type = [c for c in pool if c[5] == q["suffix"]]
        if not same_type:
            return "mismatch", _distinct(pool)[:6]
        pool = same_type

    if q["cities"]:
        in_city = [c for c in pool if c[6] in q["cities"]]
        if in_city:
            pool = in_city

    groups = {(c[0], c[1], c[5], c[6]) for c in pool}
    if len(groups) == 1:
        return "ok", pool[0]

    return "ambiguous", _distinct(pool)[:6]


def local_resolve(address, fuzzy_cutoff=FUZZY_CUTOFF):
    """Label-only view of resolve_detailed() (kept for older callers).

    Statuses are "ok" (lat, lon) / "ambiguous" [labels] / "mismatch" [labels] /
    "none". Approximate placements are reported as "none" here: this API never guesses.
    """
    status, payload = resolve_detailed(address, fuzzy_cutoff)
    if status == "ok":
        return "ok", (payload[2], payload[3])
    if status in ("ambiguous", "mismatch"):
        return status, [entry[4] for entry in payload]
    return "none", None


def local_geocode(address, fuzzy_cutoff=FUZZY_CUTOFF):
    """Look up an address locally and return (lat, lon), or None."""
    status, payload = local_resolve(address, fuzzy_cutoff)
    return payload if status == "ok" else None


def _search_streets(q, limit, bias):
    """Autocomplete for queries without a civic number"""
    core = q["core"]
    if len(core) < 3:
        return []

    _build_street_index()
    scored = []

    for (c_core, direction, suffix, settlement), (label, civics) in _streets.items():
        if c_core == core:
            score = 2.0
        elif c_core.startswith(core + " "):
            score = 1.5 + min(len(core) / len(c_core), 0.49)
        elif c_core.startswith(core):
            score = 1.3 + min(len(core) / len(c_core), 0.19)
        elif any(word.startswith(core) for word in c_core.split()[1:]):
            score = 1.0
        elif (
            len(core) >= 4 and core[0] == c_core[0]
            and abs(len(core) - len(c_core)) <= 3
        ):
            ratio = SequenceMatcher(None, core, c_core).ratio()
            if ratio < 0.8:
                continue
            score = ratio * 0.95  # typo'd names rank below real prefix matches
        else:
            continue

        if q["direction"] is not None and direction != q["direction"]:
            continue
        if q["suffix"] is not None and suffix != q["suffix"]:
            score -= 0.4
        if settlement in q["cities"]:
            score += 0.2

        mid_number, mid_lat, mid_lon = civics[len(civics) // 2]
        dist = _km(bias[0], bias[1], mid_lat, mid_lon) if bias else 0.0
        scored.append((-score, round(dist, 1), -len(civics), label, mid_lat, mid_lon))

    scored.sort()

    results = []
    seen = set()
    for _score, _dist, _size, label, lat, lon in scored:
        if label.lower() in seen:
            continue
        seen.add(label.lower())
        results.append({"label": label, "lat": lat, "lon": lon, "source": "street"})
        if len(results) >= limit:
            break
    return results


def search_local(query, limit=6, bias=None):
    """Fast local autocomplete: civic addresses ("175 univ") or streets ("king st").

    ``bias`` is an optional (lat, lon); it only breaks ties between equally good
    matches, so the "100 King St" nearest the user is listed first.
    """
    q = _parse_query(query)
    limit = max(1, int(limit))

    if q["civic"] is None:
        return _search_streets(q, limit, bias)

    _load_index()
    if not _by_civic:
        return []

    candidates = list(_by_civic.get(q["civic"], []))
    if q["direction"] is not None:
        candidates = [c for c in candidates if c[1] == q["direction"]]

    def rank(c):
        suffix_match = 1 if q["suffix"] and c[5] == q["suffix"] else 0
        city_match = 1 if c[6] in q["cities"] else 0
        dist = _km(bias[0], bias[1], c[2], c[3]) if bias else 0.0
        return (
            -_candidate_score(q["core"], c[0], partial=True),
            -suffix_match, -city_match, round(dist, 1), c[4].lower(),
        )

    results = []
    seen = set()

    for c in sorted(candidates, key=rank):
        if q["core"] and _candidate_score(q["core"], c[0], partial=True) < 0.45:
            continue

        key = c[4].lower()
        if key in seen:
            continue
        seen.add(key)

        results.append({"label": c[4], "lat": c[2], "lon": c[3], "source": "local"})

        if len(results) >= limit:
            break

    return results


def is_available():
    return _resolve_csv_path() is not None
