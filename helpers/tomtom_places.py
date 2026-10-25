import requests
from dotenv import load_dotenv
import os

load_dotenv()
API_KEY = os.getenv("TOMTOM_API_KEY", None)

PLACES = {
    # "bathroom": "public_bathroom",
    # "bicycle_parking": "bicycle_parking",
    "religious_site": ("church", "gurudwara", "mosque", "pagoda", "synagog", "temple"), 
}

if __name__ == "__main__":
    pass