from google.transit import gtfs_realtime_pb2

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


years = {
    (22301, 22311, "2023", "Electric"),
    (22312, 22318, "2023", "LFS HEV"),
    (22401, 22444, "2024", "LFS HEV"),
    (22201, 22229, "2022", "LFS HEV"),
    (22105, 22108, "2021", "Classic 30'"),
}

years = {k: (y, t) for start, end, y, t in years for k in range(start, end + 1)}

def main(feed):
    statuses = []
    vehicle_ids = set()

    for entity in feed.entity:
        try:
            vehicle_id = int(entity.vehicle.vehicle.id)
        except (ValueError, AttributeError):
            continue

        vehicle_ids.add(vehicle_id)

        if vehicle_id in years:
            route_id = entity.vehicle.trip.route_id or "N/A"
            lat = entity.vehicle.position.latitude
            lon = entity.vehicle.position.longitude
            year, vehicle_type = years[vehicle_id]

            statuses.append((vehicle_id, year, vehicle_type, route_id, lat, lon))

    statuses.sort()

    print(f"Total vehicles: {len(vehicle_ids)}")
    print(f"{'Bus':<8}{'Year':<8}{'Type':<10}{'Route':<8}Coordinates")

    for bus_id, year, v_type, route, lat, lon in statuses:
        print(f"{str(bus_id):<8}{year:<8}{v_type:<10}{route:<8}({lat}, {lon})")

    return statuses, vehicle_ids

if __name__ == '__main__':
    s = Session()
    s.mount("https://", AddedCipherAdapter())

    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(s.get(
        "https://webapps.regionofwaterloo.ca/api/grt-routes/api/vehiclepositions"
    ).content)

    main(feed)