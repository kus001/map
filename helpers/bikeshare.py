import requests

names = [
    'regionofwaterloo', 'mississauga', 'region-of-waterloo', 'region_of_waterloo', 'region.waterloo', 'waterlooregion', 'waterloo-region', 'waterloo_region', 'row', 'r-o-w', 'rowontario', 'rowon', 'rowca', 'regionwaterloo', 'thewaterlooregion', 'the-region-of-waterloo', 'theregionofwaterloo',
    'waterlooontario', 'waterloo-on', 'waterloo-on-ca', 'waterloo-canada', 'waterlooregionontario', 'waterlooregionon', 'wr', 'wrontario', 'wr-on', 'wrregion', 'regionalmunicipalityofwaterloo', 'regional-municipality-of-waterloo', 'regionalmunicipalitywaterloo', 'rmwaterloo', 'rm-of-waterloo',
    'kitchenerwaterloocambridge', 'kitchener-waterloo-cambridge', 'kwc', 'kw', 'kwregion', 'kw-region', 'kwontario', 'kitchenerwaterloo', 'kitchener-waterloo', 'tri-cities', 'tricity', 'tri-cities-ontario', 'waterloo-kitchener-cambridge', 'cambridgekitchenerwaterloo',
    'regionofwaterloo-ca', 'regionofwaterloo-on', 'row-ca', 'row-on', 'row-gov', 'waterloo-region-ca', 'waterloo-region-on', 'grt', 'grandrivertransit', 'grtwaterloo', 'grt-region', 'waterloo-transit',
]

for name in names:
    url = f"https://data.lime.bike/api/partners/v1/gbfs/{name}/gbfs.json"

    data = requests.get(url, timeout=15)

    try:
        data=data.json()
    except:
        pass

    print("\n")
    print(data)
    print("\n")