import os
import requests

from json import dumps
from dotenv import load_dotenv

load_dotenv()
API_KEY = os.getenv("TOMTOM_API_KEY", None)
testcoords = list(map(float, os.getenv("testcoords", "43.65373,-79.38403").split(",")))

PLACES = {
    # "bathroom": "public_bathroom",
    # "bicycle_parking": "bicycle_parking",
    # "religious_site": ("church", "gurudwara", "mosque", "pagoda", "synagog", "temple"), 
}

TOMTOM_URL = "https://api.tomtom.com/maps/orbis/places/suggest"

def resolve_place(place_info, bias=None):
    bias = bias if bias else testcoords

    data = {
        "query": "",
        "origin": {"type": "point", "coordinates": testcoords},
        "maxResults": 5,
        "geopoliticalView": "Unified",
        "filters": {
            "types": [
                "poi",
                # "address",
                # "street",
                # "intersection",
                # "area",
                # "discoverAction",
            ],
            # "poiTypes": [
            #     "restaurant",
            #     # "public_bathroom"
            # ],
            "geometry": {
                "type": "circle",
                "center": testcoords,
                "radiusInMeters": 10000,
            },
        },
        "preferences": {"geometry": {"type": "point", "coordinates": testcoords}},
    }
    headers = {
        "accept": "application/json",
        "Attributes": "results(subtitles,distanceInMeters,type,title,poiTypes,more)",
        "TomTom-Api-Version": "3",
        "TomTom-Api-Key": API_KEY,
        "Content-Type": "application/json",
    }

    raw_response = requests.post(TOMTOM_URL, headers=headers, json=data)

    response_status = raw_response.status_code
    response_headers = raw_response.headers
    response = raw_response.json()

    


if __name__ == "__main__":
    headers = {
        "accept": "application/json",
        "Attributes": "results(subtitles,distanceInMeters,type,title,poiTypes,more)",
        "TomTom-Api-Version": "3",
        "TomTom-Api-Key": API_KEY,
        "Content-Type": "application/json",
    }

    data = {
        "query": "",
        "origin": {"type": "point", "coordinates": testcoords},
        "maxResults": 5,
        "geopoliticalView": "Unified",
        "filters": {
            "types": [
                "poi",
                # "address",
                # "street",
                # "intersection",
                # "area",
                # "discoverAction",
            ],
            # "poiTypes": [
            #     "restaurant",
            #     # "public_bathroom"
            # ],
            "geometry": {
                "type": "circle",
                "center": testcoords,
                "radiusInMeters": 10000,
            },
        },
        "preferences": {"geometry": {"type": "point", "coordinates": testcoords}},
    }

    response = requests.post(TOMTOM_URL, headers=headers, json=data)
    rdict = response.json()

    print(f"Status Code: {response.status_code}")
    print(f"Response Headers: {response.headers}")
    print(dumps(rdict, indent=4))