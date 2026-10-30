"""Report on the GRT buses currently running: fleet number, year, model, seats, route and position.

    python -m scripts.grt_fleet            (from the project root)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from google.transit import gtfs_realtime_pb2

from transit import agencies, net, vehicle_types

AGENCY = "grt_busses"


def _route_sort_key(route):
    return (0, int(route)) if route.isdigit() else (1, route)


def main():
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(net.get(agencies.AGENCIES[AGENCY].vehicles_url, timeout=15).content)

    running, known = set(), []
    for entity in feed.entity:
        if not entity.HasField("vehicle"):
            continue
        vehicle = entity.vehicle
        running.add(vehicle.vehicle.id)
        fleet = vehicle_types.vehicle_type(entity, AGENCY)
        if fleet is None:
            continue
        year, model, seats = fleet
        known.append((vehicle.vehicle.id, year, model, seats, vehicle.trip.route_id or "N/A",
                      vehicle.position.latitude, vehicle.position.longitude))

    known.sort(key=lambda row: _route_sort_key(row[4]))
    hybrids = sum(vehicle_types.powertrain(row[2]) == "hev" for row in known)
    electrics = sum(vehicle_types.powertrain(row[2]) == "electric" for row in known)

    print(f"\nTotal vehicles: {len(running)} \t\tHEV: {hybrids}\t\tElectric: {electrics}\n")
    print(f"{'Bus':<8}{'Year':<8}{'Type':<12}{'Seats':<7}{'Route':<8}Coordinates")
    for bus_id, year, model, seats, route, lat, lon in known:
        print(f"{bus_id:<8}{year:<8}{model:<12}{seats or '':<7}{route:<8}({lat}, {lon})")


if __name__ == "__main__":
    main()
