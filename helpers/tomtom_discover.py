import re
from json import dumps

import requests
from tomtom_places import testcoords, available, _api_key

DETAILS_URL = "https://api.tomtom.com/maps/orbis/places/discover"

# Phrases that express proximity to the user's current location.
_LOCATION_PHRASES = [
    r"\b(?:near|close)\s+to\s+my\s+location\b",
    r"\b(?:near|close)\s+to\s+me\b",
    r"\b(?:near|close)\s+me\b",
    r"\b(?:near|close)\s+my\s+location\b",
    r"\bin\s+my\s+(?:area|vicinity|neighborhood|neighbourhood)\b",
    r"\baround\s+(?:here|me)\b",
    r"\bnearby\b",
    r"\bclosest\b",
    r"\bnearest\b",
]

# Common conversational filler, removed only at the edges.
_PREFIXES = [
    r"^(?:hey\s+)?(?:can\s+you\s+)?",
    r"^(?:please\s+)?",
    r"^(?:(?:find|search\s+for|look\s+for|show\s+me|find\s+me)\s+)+",
]

def _clean_query(rawquery):
    query = rawquery.strip().lower()

    # Remove proximity phrases, longest/more-specific patterns first.
    for pattern in _LOCATION_PHRASES:
        query = re.sub(pattern, " ", query, flags=re.IGNORECASE)

    # Remove common request wording.
    for pattern in _PREFIXES:
        query = re.sub(pattern, "", query, flags=re.IGNORECASE)

    # Handle simple question framing.
    query = re.sub(
        r"^(?:what(?:'s|\s+is)?|where\s+(?:can\s+i\s+)?find)\s+",
        "",
        query,
    )
    query = re.sub(
        r"^(?:are\s+there|is\s+there)\s+",
        "",
        query,
    )

    # Clean punctuation and whitespace.
    query = re.sub(r"[?!,.]+", " ", query)
    query = re.sub(r"\s+", " ", query).strip()

    # Avoid sending an empty query to TomTom.
    return query or "places"


def find(rawquery, lat=None, long=None):
    if not available():
        return

    if lat is None or long is None:
        long, lat = testcoords
        print(f"No lat/long given... using long:{long}, lat:{lat}")

    query = _clean_query(rawquery)

    headers = {
        "TomTom-Api-Key": _api_key(),
        "TomTom-Api-Version": "3",
        "Attributes": (
            "results(title,poiTypes,position,subtitles,"
            "distanceInMeters,address,contacts,timeZones,openingHours)"
        ),
        "Content-Type": "application/json",
    }

    body = {
        "query": query,
        "origin": {
            "type": "point",
            "coordinates": [long, lat],
        },
        "preferences": {
            "geometry": {
                "type": "point",
                "coordinates": [long, lat],
            }
        },
        "maxResults": 10,
    }

    response = requests.post(
        DETAILS_URL,
        headers=headers,
        json=body,
        timeout=15,
    )
    response.raise_for_status()
    rawresults = response.json()

    results = {}

    for place in rawresults.get("results", []):
        title = place["title"]
        poi_types = place.get("poiTypes", [])
        contacts = place.get("contacts") or [{}]
        contact = contacts[0] if contacts else {}

        result = {
            "type": poi_types[0].get("name") if poi_types else None,
            "position": place.get("position", {}).get("coordinates"),
            "address": ", ".join(place.get("subtitles", [])),
            "distance_km": (
                round(place["distanceInMeters"] / 1000, 2)
                if place.get("distanceInMeters") is not None
                else None
            ),
            "phone": next(iter(contact.get("phones", [])), None),
            "website": next(iter(contact.get("websites", [])), None),
        }

        if place.get("openingHours"):
            result["hours"] = place["openingHours"]

        if place.get("timeZones"):
            result["time_zone"] = place["timeZones"]

        results[title] = {
            key: value
            for key, value in result.items()
            if value is not None
        }

    return results


if __name__ == "__main__":
    print(dumps(find("indian restaurants near waterloo"), indent=2))