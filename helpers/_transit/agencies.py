"""Every transit agency the map knows about, described in one place.

To add an agency, add one ``Agency(...)`` entry to ``AGENCIES`` below with ``own_cache=True``,
then run ``python -m helpers._transit.agency_setup <id>`` to download and index its GTFS feed.

For live delays / vehicles / alerts, add the agency's GTFS-RT links to the same entry:
    trip_updates_url="...", vehicles_url="...", alerts_url="..."   (all optional)
then run ``python -m helpers._transit.realtime <id>`` to check the feed and its trip ids.

Two ways an agency's schedule is stored
  own_cache  - built by agency_setup into ``transit_data/<id>_compact.pkl`` and merged into the
               shared graph at startup. This is the one to use for new agencies.

This module must stay import-light (no project imports) so every other helper can use it.
"""
from dataclasses import dataclass
from pathlib import Path


TRANSIT_DATA = Path(__file__).resolve().parents[2] / "transit_data"

@dataclass(frozen=True)
class Agency:
    id: str                       # stop ids look like "<id>:<raw stop id>"
    label: str                    # name shown in the UI
    feed_url: str                 # direct link to the static GTFS zip
    own_cache: bool = True       # built by agency_setup instead of the shared graph
    cache: str | None = None      # own_cache only; defaults to "d<id>.pkl"
    realtime: bool = False        # has a GTFS-RT integration (set automatically if a *_url below is given)
    trip_updates_url: str | None = None   # GTFS-RT TripUpdates feed (live delays)
    vehicles_url: str | None = None       # GTFS-RT VehiclePositions feed
    alerts_url: str | None = None         # GTFS-RT Alerts feed
    fallback_mode: str = "transit"  # vehicle label when routes.txt has no route_type

    def __post_init__(self):
        if self.trip_updates_url or self.vehicles_url or self.alerts_url:
            object.__setattr__(self, "realtime", True)

    @property
    def prefix(self) -> str:
        return f"{self.id}:"

    @property
    def namespaced_trips(self) -> bool:
        """own_cache builds prefix trip ids with the agency id; the shared graph keeps raw ids."""
        return self.own_cache

    @property
    def cache_path(self) -> Path:
        return TRANSIT_DATA / (self.cache or f"d{self.id}.pkl")


AGENCIES = {agency.id: agency for agency in (
    # Order of the shared agencies decides the shared cache's file name; don't reorder.
    Agency("grt_trains", "GRT", "https://webapps.regionofwaterloo.ca/api/grt-routes/api/staticfeeds/2",
           realtime=True, cache="dion.pkl", fallback_mode="tram"),

    Agency("grt_busses", "GRT", "https://webapps.regionofwaterloo.ca/api/grt-routes/api/staticfeeds/1",
           realtime=True, cache="dgrt.pkl", fallback_mode="bus"),

    Agency("go", "GO Transit",
           "https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip",
           realtime=True, cache="dgo.pkl", fallback_mode="train/bus"),

    Agency("ttc", "TTC",
           "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/7795b45e-e65a-4465-81fc-c36b9dfff169/resource/cfb6b2b8-6191-41e3-bda1-b175c51148cb/download/TTC Routes and Schedules Data.zip",
            trip_updates_url="https://bustime.ttc.ca/gtfsrt/trips",
            vehicles_url="https://bustime.ttc.ca/gtfsrt/vehicles",
            alerts_url="https://bustime.ttc.ca/gtfsrt/alerts",
            cache="dttc.pkl", fallback_mode="TTC"),

    Agency("hsr", "HSR", "https://opendata.hamilton.ca/GTFS-Static/google_transit.zip",                         # https://open.hamilton.ca/documents/6eeccf172c824c2db0484aea54ed7fe4/explore
           cache="dhsr.pkl", fallback_mode="bus"),

    Agency("ltc", "London Transit", "https://www.londontransit.ca/gtfsfeed/google_transit.zip",                 # https://www.londontransit.ca/open-data/
           cache="dltc.pkl", fallback_mode="bus"),

    # Agency("nrt", "Niagara Transit", "http://68.71.24.110/gtfs/GTFSExport.zip",                                 # http://68.71.24.110/gtfs/GTFSExport.zip
    #        realtime=False, cache="dnrt.pkl", fallback_mode="bus"),

    Agency("miway", "MiWay", "https://www.miapp.ca/GTFS/google_transit.zip",                                    # https://www.mississauga.ca/miway-transit/developer-download/
           cache="dmiway.pkl", fallback_mode="bus"),

    Agency("bt", "BT", "https://www.arcgis.com/sharing/rest/content/items/a355aabd5a8c490186bdce559c9c75fb/data",
           cache="dbt.pkl", fallback_mode="bus"),

    Agency("yrt", "YRT", "https://www.yrt.ca/google/google_transit.zip",                                        # https://forms.yrt.ca/YRT-GTFS-Data?Id=db191ee1-cdb9-4909-aa49-b4e96679e142
           cache="dyrt.pkl", fallback_mode="bus")
)}

OWN_CACHE_AGENCIES = tuple(a for a in AGENCIES.values() if a.own_cache)


def get(agency_id) -> Agency | None:
    return AGENCIES.get(str(agency_id))


def label(agency_id) -> str:
    agency = get(agency_id)
    return agency.label if agency else str(agency_id or "").upper()


def is_known(agency_id) -> bool:
    return str(agency_id) in AGENCIES


def has_realtime(agency_id) -> bool:
    agency = get(agency_id)
    return bool(agency and agency.realtime)
