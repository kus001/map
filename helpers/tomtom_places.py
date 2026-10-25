from pprint import pprint

import requests
from dotenv import load_dotenv
import os
from json import dumps, loads

load_dotenv()
API_KEY = os.getenv("TOMTOM_API_KEY", None)
testcoords = list(map(float, os.getenv("testcoods", None).split(",")))

PLACES = {
    # "bathroom": "public_bathroom",
    # "bicycle_parking": "bicycle_parking",
    "religious_site": ("church", "gurudwara", "mosque", "pagoda", "synagog", "temple"), 
}

url = "https://api.tomtom.com/maps/orbis/places/suggest"

headers = {
    "accept": "application/json",
    "Attributes": "results(subtitles,distanceInMeters)",
    "TomTom-Api-Version": "3",
    "TomTom-Api-Key": API_KEY,
    "Content-Type": "application/json",
}

data = {
    "query": "restau",
    "origin": {"type": "point", "coordinates": testcoords},
    "maxResults": 5,
    "geopoliticalView": "Unified",
    "filters": {
        "types": [
            "poi",
            "address",
            "street",
            "intersection",
            "area",
            "discoverAction",
        ],
        "countryCodesIso2": ["US", "CA"],
        "poiTypes": ["restaurant", "indian_restaurant"],
        "geometry": {
            "type": "circle",
            "center": testcoords,
            "radiusInMeters": 10000,
        },
    },
    "preferences": {"geometry": {"type": "point", "coordinates": testcoords}},
}


if __name__ == "__main__":
    response = requests.post(url, headers=headers, json=data)
    rdict = response.json()

    print(f"Status Code: {response.status_code}")
    print(f"Response Headers: {response.headers}")
    print(dumps(rdict, indent=4))