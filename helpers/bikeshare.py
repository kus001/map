import requests, json, time

names = [
    
]

for name in names:
    time.sleep(1)
    url = f"https://data.lime.bike/api/partners/v1/gbfs/{name}/gbfs.json"

    data = requests.get(url, timeout=15)

    try:
        data=data.json()
        print("\n")
        print(name)
        print("\n")
        print(json.dumps(data, indent=4))
        print("\n")
        continue
    except:
        pass

    print("\n")
    print(name)
    print("\n")
    print(data)
    print("\n")