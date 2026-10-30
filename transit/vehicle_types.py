from google.transit import gtfs_realtime_pb2

from requests import Session
from urllib3 import PoolManager
from requests.adapters import HTTPAdapter
from urllib3.util import create_urllib3_context

class AddedCipherAdapter(HTTPAdapter):
    def init_poolmanager(self, connections, maxsize, block=False):
        ctx = create_urllib3_context(ciphers=":HIGH:!DH:!aNULL")
        self.poolmanager = PoolManager(
            num_pools=connections,
            maxsize=maxsize,
            block=block,
            ssl_context=ctx
        )

def string_to_year_info(string, year=None, vtype=None):
    numstrs= string.split(", ")

    for numstr in numstrs:
        nums = numstr.split("-")
        if len(nums) == 2:
            first, last = nums
        elif len(nums) == 1:
            nums = nums[0]
            first, last = nums, nums
        else:
            print("UHHHHHHH WHAAAATTT")
        print(
            f"({first}, {last}" +
            (f', "{year}"' if year else "") +
            (f', "{vtype}"' if vtype else "") +
            "),"
        )


grt_years = {
# eg(Start,  End , "YYYY", "Bus name"   ,"Seats")
    (20907, 20907, "2009", "LFS 40102  ", 37    ),
    (20913, 20913, "2009", "LFS 40102  ", 37    ),
    (21003, 21003, "2010", "LFS 40102  ", 37    ),
    (21005, 21006, "2010", "LFS 40102  ", 37    ),
    (21101, 21115, "2011", "LFS 40102  ", 37    ),
    (21201, 21220, "2012", "LFS 40102  ", 35    ),
    (21301, 21333, "2013", "XD40       ", 33    ),
    (21401, 21405, "2014", "XD40       ", 33    ),
    (21501, 21524, "2015", "XD40       ", 33    ),
    (21701, 21718, "2017", "XD40       ", 33    ),
    (21719, 21757, "2017", "XD40       ", 33    ),
    (21901, 21912, "2019", "LFS        ", 35    ),
    (22001, 22031, "2020", "LFS        ", 35    ),
    (22101, 22104, "2021", "LFS HEV    ", 35    ),
    (22105, 22108, "2021", "Classic 30'", 24    ),
    (22201, 22229, "2022", "LFS HEV    ", 35    ),
    (22301, 22311, "2023", "LFSe+      ", 35    ),
    (22312, 22318, "2023", "LFS HEV    ", None  ),
    (22401, 22444, "2024", "LFS HEV    ", None  ),
    (21758, 21766, "2017", "XD40       ", None  ),          # ION BUS
}

grt_years = {k: (y, t, seats) for start, end, y, t, seats in grt_years for k in range(start, end + 1)}

def powertrain(vehicle_type):
    """Collapse a fleet model name into "electric", "hev" or "normal"."""
    name = (vehicle_type or "").strip().upper()
    if name.startswith("LFSE"):
        return "electric"
    if "HEV" in name:
        return "hev"
    return "normal"


def vehicle_type(entity, agency):
    # agency ids are "grt_busses"/"grt_trains" (older code used plain "grt"); only buses are in grt_years
    if agency != "grt_busses":
        return None
    try:
        vehicle_id = int(entity.vehicle.vehicle.id)
    except (ValueError, AttributeError):
        return None
    if vehicle_id in grt_years:
        route_id = entity.vehicle.trip.route_id or "N/A"
        lat = entity.vehicle.position.latitude
        lon = entity.vehicle.position.longitude
        year, vehicle_type, seats = grt_years[vehicle_id]
        return vehicle_id, year, vehicle_type, seats, route_id, lat, lon
    return vehicle_id, "unknown"


def grt_bus_types(feed):
    statuses = []
    vehicle_ids = set()

    for entity in feed.entity:
        hold = vehicle_type(entity, "grt")
        if hold and hold != "unknown":
            vehicle_ids.add(hold[0])
            statuses.append(hold)
        elif "unkown" in hold:
            vehicle_ids.add(hold[0])

    statuses.sort(key=lambda x:int(x[4]))

    return statuses, vehicle_ids


if __name__ == '__main__':
#     string_to_year_info("21101-21115", 2011, "LFS 40102")
#     string_to_year_info("21003, 21005-21006", 2010, "LFS 40102")
#     string_to_year_info("20907, 20913", 2009, "LFS 40102")

#     exit()
    s = Session()
    s.mount("https://", AddedCipherAdapter())

    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(s.get(
        "https://webapps.regionofwaterloo.ca/api/grt-routes/api/vehiclepositions/1"
    ).content)

    statuses, vehicle_ids = grt_bus_types(feed)

    HEV_AMOUNT = len([status for status in statuses if "HEV" in status[2]])
    ELECTRIC_AMOUNT = len([status for status in statuses if status[2] == "LFSe+"])

    print(f"\nTotal vehicles: {len(vehicle_ids)} \t\tHEV: {HEV_AMOUNT}\t\tElectric: {ELECTRIC_AMOUNT}\n")
    print(f"{'Bus':<8}{'Year':<8}{'Type':<12}{'Seats':<7}{'Route':<8}Coordinates")

    for bus_id, year, v_type, seats, route, lat, lon in statuses:
        if not seats:
            seats = ""
        print(f"{str(bus_id):<8}{year:<8}{v_type:<12}{seats:<7}{route:<8}({lat}, {lon})")