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
        # print("SETUP TOMTOM API KEY")
        return
    if not lat or not long:
        long, lat = testcoords
        print(f"No lat/long given... using long:{long}, lat:{lat}")

    query = ""
    for word in rawquery.split():
        if not ("near" in word or "close" in word or word == "me"):
            query += word
            query += " "

    headers = {
        'TomTom-Api-Key': _api_key(),
        'TomTom-Api-Version': "3",
        'Attributes': 'results(title,poiTypes,position,subtitles,distanceInMeters,address,contactstimeZones,openingHours)',
        'Content-Type': 'application/json'
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
                "coordinates": [long, lat]
            }
        },
        "maxResults": 10
    }

    rawresults = requests.post(DETAILS_URL, headers=headers, json=body).json()
    results={}

    for rawresult in rawresults["results"]:
        title = rawresult["title"]
        results[title] = {
            "poiTypes": rawresult["poiTypes"],
            "position": rawresult["position"]["coordinates"],
            "address" : rawresult["subtitles"],
            "dist"    : rawresult["distanceInMeters"],
        }

        if "contacts" in rawresult:
            results[title]["contacts"] = rawresult["contacts"]

    return results


if __name__ == "__main__":
    print(dumps(find("indian restaurant nearby"), indent=4))