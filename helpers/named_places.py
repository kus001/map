"""Named places (schools, campuses, ...) that people refer to by initials.

This module keeps a small list of places by their FULL name and generates the short forms
people actually type, so adding a place means adding one line to
`transit_data/named_places.json` in the following format:

    {"name": "Laurel Heights Secondary School", "city": "Waterloo",
     "address": "650 Laurelwood Dr, Waterloo",
     "aliases": ["sjam"]}

Where the place is located is given by whichever of these is present, in order of preference:
  "coordinates": [lat, lon]
  "address":     a civic address, resolved against the local address points
  "query":       text for the network geocoder (default: the name and city)

Example generated aliases for "Laurel Heights Secondary School":
  laurel heights secondary school, lhss, lhs, laurel heights secondary / ss / hs /
  high school.

Please do note that this module only does naming and matching. Locating (local data / network) lives in
helpers/geocoding.py.
"""

import json
import re
from difflib import SequenceMatcher
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
NAMED_PLACES_PATH = PROJECT_ROOT / "transit_data" / "named_places.json"

_STOP_WORDS = {"of", "the", "and", "at", "de", "du"}


_SUFFIX_CODES = (
    (("catholic", "secondary", "school"), "css"),
    (("catholic", "elementary", "school"), "ces"),
    (("district", "secondary", "school"), "dss"),
    (("collegiate", "institute"), "ci"),
    (("secondary", "school"), "ss"),
    (("high", "school"), "hs"),
    (("public", "school"), "ps"),
    (("elementary", "school"), "es"),
    (("middle", "school"), "ms"),
)

_SECONDARY_CODES = {"ss", "hs"}
_SECONDARY_TAILS = ("secondary", "secondary school", "high school", "ss", "hs")
_TRAILING_NOISE = {"on", "ontario", "canada"}
_MIN_ACRONYM = 3

_entries = None
_by_alias = {}
_cities = set()


def normalize(text):
    """Lower-case words only: punctuation and apostrophes removed ("St. David's" ->
    "st davids")."""
    text = str(text).lower().replace("&", " and ")
    text = re.sub(r"['\u2019`]", "", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return text.strip()


def normalize_query(text):
    """normalize(), plus: a run of single letters is one initialism ("l h s s" and
    "L.H.S.S." both become "lhss")."""
    words = normalize(text).split()
    if len(words) > 1 and all(len(word) == 1 and word.isalpha() for word in words):
        return "".join(words)
    return " ".join(words)


def _initials(words):
    return "".join(word[0] for word in words if word not in _STOP_WORDS)


def generate_aliases(name):
    """Every short form worth matching for a full place name."""
    words = normalize(name).split()
    if not words:
        return set()

    aliases = {" ".join(words)}

    full = _initials(words)
    if len(full) >= _MIN_ACRONYM:
        aliases.add(full)

    for suffix, code in _SUFFIX_CODES:
        if len(words) > len(suffix) and tuple(words[-len(suffix):]) == suffix:
            core = words[: -len(suffix)]
            if code in _SECONDARY_CODES:
                short = _initials(core) + "s"
                if len(short) >= _MIN_ACRONYM:
                    aliases.add(short)

                for tail in _SECONDARY_TAILS:
                    aliases.add(" ".join(core + [tail]))
            break

    return aliases


def _coordinates(value):
    try:
        lat, lon = float(value[0]), float(value[1])
    except (TypeError, ValueError, IndexError, KeyError):
        return None
    return (lat, lon) if -90 <= lat <= 90 and -180 <= lon <= 180 else None


def load(path=None):
    """(Re)load the places file. A missing or broken file just means no places."""
    global _entries, _by_alias, _cities

    entries, by_alias, cities = [], {}, set()
    try:
        with Path(path or NAMED_PLACES_PATH).open(encoding="utf-8") as file:
            raw = json.load(file)
        items = raw.get("places", []) if isinstance(raw, dict) else []
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        items = []

    seen_ids = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        place_id = normalize(name)
        if not place_id or place_id in seen_ids:
            continue
        seen_ids.add(place_id)

        city = normalize(item.get("city") or "") or None
        aliases = generate_aliases(name)
        for extra in item.get("aliases") or []:
            alias = normalize_query(extra)
            if alias:
                aliases.add(alias)

        entry = {
            "id": place_id,
            "name": name,
            "city": city,
            "address": str(item.get("address") or "").strip() or None,
            "coordinates": _coordinates(item.get("coordinates")),
            "query": str(item.get("query") or "").strip() or None,
            "aliases": aliases,
        }
        entries.append(entry)
        if city:
            cities.add(city)
        for alias in aliases:
            by_alias.setdefault(alias, []).append(entry)

    _entries, _by_alias, _cities = entries, by_alias, cities
    return len(entries)


def entries():
    if _entries is None:
        load()
    return _entries


def find_exact(text):
    """Places whose name, former name or initialism IS the typed text.

    Several results mean the short form is shared (two schools with the same initials)
    and the caller should ask. A trailing city narrows them: "LHSS Waterloo".
    """
    entries()
    words = normalize_query(text).split()
    while len(words) > 1 and words[-1] in _TRAILING_NOISE:
        words.pop()

    hits = _by_alias.get(normalize_query(" ".join(words)))
    if hits:
        return list(hits)

    if len(words) > 1 and words[-1] in _cities:
        rest = _by_alias.get(normalize_query(" ".join(words[:-1])), [])
        return [e for e in rest if e["city"] in (None, words[-1])]

    return []


def _alias_score(query, alias):
    if alias == query:
        return 3.0
    if alias.startswith(query):
        return 2.5
    if any(word.startswith(query) for word in alias.split()[1:]):
        return 2.0
    if len(query) >= 3 and query in alias:
        return 1.0
    if len(query) >= 4 and query[0] == alias[0] and abs(len(query) - len(alias)) <= 4:
        ratio = SequenceMatcher(None, query, alias).ratio()
        if ratio >= 0.8:
            return ratio
    return 0.0


def search(text, limit=6):
    """Autocomplete: [(score, entry)], best first, for a partly typed name/initials."""
    query = normalize_query(text)
    if len(query) < 2:
        return []

    scored = []
    for entry in entries():
        score = max(_alias_score(query, alias) for alias in entry["aliases"])
        if score > 0:
            scored.append((score, entry))

    scored.sort(key=lambda item: (-item[0], item[1]["name"]))
    return scored[: max(1, int(limit))]
