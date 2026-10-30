"""GRT bus fleet lookup: fleet number -> (year, model, seats).

realtime.py uses this to attach bus details to live GRT vehicle positions;
``python -m scripts.grt_fleet`` prints a report of the buses currently running.
"""

_FLEET_RANGES = {
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


GRT_FLEET = {k: (year, model.strip(), seats)
             for start, end, year, model, seats in _FLEET_RANGES
             for k in range(start, end + 1)}


def powertrain(vehicle_type):
    """Collapse a fleet model name into "electric", "hev" or "normal"."""
    name = (vehicle_type or "").strip().upper()
    if name.startswith("LFSE"):
        return "electric"
    if "HEV" in name:
        return "hev"
    return "normal"


def vehicle_type(entity, agency):
    """(year, model, seats) for a live GRT bus whose fleet number is known, else None.

    Only ``grt_busses`` is covered; ION trains and other agencies have no fleet table.
    """
    if agency != "grt_busses":
        return None
    try:
        return GRT_FLEET[int(entity.vehicle.vehicle.id)]
    except (ValueError, KeyError):
        return None
