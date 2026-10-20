"""Every transit agency the map knows about, described in one place.

To add an agency, add one ``Agency(...)`` entry to ``AGENCIES`` below with ``own_cache=True``,
then run ``python -m helpers._transit.agency_setup <id>`` to download and index its GTFS feed.

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
    own_cache: bool = False       # built by agency_setup instead of the shared graph
    cache: str | None = None      # own_cache only; defaults to "<id>_compact.pkl"
    realtime: bool = False        # has a GTFS-RT integration (live delays / vehicles)
    fallback_mode: str = "transit"  # vehicle label when routes.txt has no route_type

    @property
    def prefix(self) -> str:
        return f"{self.id}:"

    @property
    def namespaced_trips(self) -> bool:
        """own_cache builds prefix trip ids with the agency id; the shared graph keeps raw ids."""
        return self.own_cache

    @property
    def cache_path(self) -> Path:
        return TRANSIT_DATA / (self.cache or f"{self.id}_compact.pkl")


AGENCIES = {agency.id: agency for agency in (
    # Order of the shared agencies decides the shared cache's file name; don't reorder.
    Agency("grt_trains", "GRT", "https://webapps.regionofwaterloo.ca/api/grt-routes/api/staticfeeds/2",
           realtime=True, own_cache=True, cache="ion.pkl", fallback_mode="tram"),
    Agency("grt_busses", "GRT", "https://webapps.regionofwaterloo.ca/api/grt-routes/api/staticfeeds/1",
           realtime=True, own_cache=True, cache="grt.pkl", fallback_mode="bus"),
    Agency("go", "GO Transit",
           "https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip",
           realtime=True, own_cache=True, cache="go.pkl", fallback_mode="train/bus"),
    Agency("ttc", "TTC",
           "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/"
           "7795b45e-e65a-4465-81fc-c36b9dfff169/resource/"
           "cfb6b2b8-6191-41e3-bda1-b175c51148cb/download/"
           "TTC%20Routes%20and%20Schedules%20Data.zip",
           own_cache=True, cache="ttc.pkl", fallback_mode="TTC"),
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
