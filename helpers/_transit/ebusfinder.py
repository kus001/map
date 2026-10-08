#code from https://github.com/CyrilSLi/transit-trackers/blob/main/ontario/grt-electric.py

from google.transit import gtfs_realtime_pb2

# From https://stackoverflow.com/a/76217135
from urllib3.util import create_urllib3_context
from urllib3 import PoolManager
from requests.adapters import HTTPAdapter
from requests import Session
class AddedCipherAdapter(HTTPAdapter):
    def init_poolmanager(self, connections, maxsize, block=False):
        ctx = create_urllib3_context(ciphers=":HIGH:!DH:!aNULL")
        self.poolmanager = PoolManager(
            num_pools=connections,
            maxsize=maxsize,
            block=block,
            ssl_context=ctx
        )
s = Session()
s.mount("https://", AddedCipherAdapter())

feed = gtfs_realtime_pb2.FeedMessage()
feed.ParseFromString(s.get(
    "https://webapps.regionofwaterloo.ca/api/grt-routes/api/vehiclepositions"
).content)

years = { # Update from and/or contribute to the CPTDB Wiki
    (22301, 22311, "2023")
}
years = {k: v for start, end, v in years for k in range(start, end + 1)}

statuses = []
vehicle_ids = set()
for entity in feed.entity:
    try:
        vehicle_id = int(entity.vehicle.vehicle.id)
    except ValueError:
        continue
    vehicle_ids.add(vehicle_id)
    if 22301 <= vehicle_id <= 22311: # LFSe+
        statuses.append((entity.vehicle.trip.route_id or "N/A", vehicle_id, entity.vehicle.position.latitude, entity.vehicle.position.longitude, years.get(vehicle_id, "N/A")))

statuses.sort()
print(f"Total vehicles: {len(vehicle_ids)}")
print("Bus     Year    Route   Coordinates\n" + "\n".join(f"{str(i[1]).ljust(8)}{i[4].ljust(8)}{i[0].ljust(8)}({i[2]}, {i[3]})" for i in statuses))