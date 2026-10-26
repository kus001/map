from json import dumps

import requests
from tomtom_places import (
    testcoords, available, _api_key
)

DETAILS_URL = "https://api.tomtom.com/maps/orbis/places/discover"

def _isopen():
    pass

def find(rawquery, lat=None, long=None):
    if not available():
        return

    if lat is None or long is None:
        long, lat = testcoords
        print(f"No lat/long given... using long:{long}, lat:{lat}")

    query = " ".join(
        word for word in rawquery.split()
        if not ("near" in word.lower() or "close" in word.lower() or word.lower() == "me")
    ).strip()

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
        "query":  query,
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
        DETAILS_URL, headers=headers, json=body
    )
    response.raise_for_status()
    rawresults = response.json()

    results = {}

    for place in rawresults.get("results", []):
        title = place["title"]
        poi_types = place.get("poiTypes", [])
        contacts = place.get("contacts", [{}])
        contact = contacts[0] if contacts else {}

        result = {
            "type": poi_types[0].get("name") if poi_types else None,
            "position": place.get("position", {}).get("coordinates"),
            "address": ", ".join(place.get("subtitles", [])),
            "distance_km": round(place["distanceInMeters"] / 1000, 2) if place.get("distanceInMeters") is not None else None,
            "phone": next(iter(contact.get("phones", [])), None),
            "website": next(iter(contact.get("websites", [])), None),
        }

        # Preserve opening hours and timezone data when available.
        if place.get("openingHours"):
            result["hours"] = place["openingHours"]

        if place.get("timeZones"):
            result["time_zone"] = place["timeZones"]

        # Omit unavailable fields.
        results[title] = {
            key: value
            for key, value in result.items()
            if value is not None
        }

    return results


if __name__ == "__main__":
    print(dumps(find("indian restaurant nearby"), indent=4))