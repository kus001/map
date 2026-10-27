"""Download and build the compact GTFS caches used by kmaps.

    python -m transit.agency_setup ttc                # automatically download TTC
    python -m transit.agency_setup ttc --redownload   # refresh TTC from its source
    python -m transit.agency_setup ttc --zip feed.zip # local ZIP or extracted folder
    python -m transit.agency_setup all                # set up every configured agency
    python -m transit.agency_setup all --redownload   # refresh every agency
    python -m transit.agency_setup all --skip-installed # leave ready caches alone
    python -m transit.agency_setup ttc --source surface --redownload # TTC BusTime schedules (no subway)
"""
import argparse
import csv
import io
import math
from html.parser import HTMLParser
import pickle
import shutil
import sqlite3
import sys
import tempfile
import zipfile
from urllib.parse import urlparse, urljoin
from array import array
from datetime import datetime, date
from pathlib import Path

import requests

from .agencies import AGENCIES, OWN_CACHE_AGENCIES, Agency
from .compact import CompactTrips, TripPools
from .make_graph import Graph, GTFS_ROOT
from helpers.distance import find_dist
from helpers.time_management import time_to_seconds

TIMETABLE_FILES = ("stops.txt", "routes.txt", "trips.txt", "stop_times.txt")
FIELDS = "monday tuesday wednesday thursday friday saturday sunday".split()


def _agency(agency) -> Agency:
    found = agency if isinstance(agency, Agency) else AGENCIES.get(str(agency))
    if found is None:
        raise ValueError(f"Unknown agency: {agency}")
    if not found.own_cache:
        raise ValueError(f"{found.id} is built into the shared startup graph by "
                         "transit/make_graph.py, not by agency_setup")
    return found


def rows(path):
    with path.open(encoding="utf-8-sig", newline="", errors="replace") as f:
        yield from csv.DictReader(f)


def _grid_key(lat, lon):
    return int(math.floor(lat / .001)), int(math.floor(lon / .001))


def build_agency(agency, folder, target=None):
    """Build from a GTFS folder. SQLite does the large sort, not Python RAM."""
    agency = _agency(agency)
    pre = agency.prefix
    folder, target = Path(folder), Path(target or agency.cache_path)
    for name in ("stops.txt", "routes.txt", "trips.txt", "stop_times.txt"):
        if not (folder / name).exists():
            raise FileNotFoundError(folder / name)

    graph, stops, grid = {}, {}, {}
    for row in rows(folder / "stops.txt"):
        try:
            sid = pre + row["stop_id"]
            pos = (float(row["stop_lat"]), float(row["stop_lon"]))
        except (ValueError, KeyError):
            continue
        stops[sid] = (*pos, row.get("stop_name", ""))
        x, y = _grid_key(*pos)
        close = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                close.extend(grid.get((x + dx, y + dy), ()))

        for other in close[:80]:
            m = find_dist(pos, stops[other][:2])
            if 8 < m <= 110:
                mins = m / 75.0
                graph.setdefault(sid, {}).setdefault(other, {})["__walk__"] = [{"distance": mins}]
                graph.setdefault(other, {}).setdefault(sid, {})["__walk__"] = [{"distance": mins}]
        grid.setdefault((x, y), []).append(sid)

    route_names = {}
    route_colors = {}
    for r in rows(folder / "routes.txt"):
        name = r.get("route_short_name") or r.get("route_long_name") or r["route_id"]
        route_names[r["route_id"]] = name
        route_colors[name] = r.get("route_color", "")

    cal, dates, trip_service = {}, {}, {}
    if (folder / "calendar.txt").exists():
        for r in rows(folder / "calendar.txt"):
            cal[pre + r["service_id"]] = {
                "days": [r.get(day) == "1" for day in FIELDS],
                "start": datetime.strptime(r["start_date"], "%Y%m%d").date(),
                "end": datetime.strptime(r["end_date"], "%Y%m%d").date(),
            }
    if (folder / "calendar_dates.txt").exists():
        for r in rows(folder / "calendar_dates.txt"):
            dates[(pre + r["service_id"], r["date"])] = int(r["exception_type"])


    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f"{agency.id}_build_") as temp:
        db = sqlite3.connect(str(Path(temp) / "gtfs.sqlite"))
        db.execute("PRAGMA journal_mode=OFF")
        db.execute("PRAGMA synchronous=OFF")
        db.execute("CREATE TABLE trips (id TEXT PRIMARY KEY, route TEXT, headsign TEXT)")
        batch = []
        for r in rows(folder / "trips.txt"):
            original_id = r["trip_id"]
            trip_service[pre + original_id] = pre + r["service_id"]
            batch.append((original_id, route_names.get(r["route_id"], r["route_id"]), r.get("trip_headsign", "")))
            if len(batch) == 10000:
                db.executemany("INSERT OR REPLACE INTO trips VALUES (?,?,?)", batch)
                batch.clear()
        if batch:
            db.executemany("INSERT OR REPLACE INTO trips VALUES (?,?,?)", batch)
        db.execute("CREATE TABLE times (trip TEXT, seq INTEGER, stop TEXT, dep INTEGER, arr INTEGER)")
        batch = []
        for r in rows(folder / "stop_times.txt"):
            try:
                batch.append((r["trip_id"], int(r["stop_sequence"]), r["stop_id"],
                              time_to_seconds(r["departure_time"]), time_to_seconds(r["arrival_time"])))
            except (KeyError, ValueError):
                continue
            if len(batch) >= 20000:
                db.executemany("INSERT INTO times VALUES (?,?,?,?,?)", batch)
                batch.clear()
        if batch:
            db.executemany("INSERT INTO times VALUES (?,?,?,?,?)", batch)
        db.commit()
        db.execute("CREATE INDEX times_trip_order ON times(trip,seq)")
        pools = TripPools()
        trip_index, route_index = {}, {}
        current_trip, last = None, None
        query = """SELECT t.trip, t.stop, t.dep, t.arr, p.route, p.headsign
                   FROM times t JOIN trips p ON t.trip=p.id
                   ORDER BY t.trip,t.seq"""
        for trip, stop, dep, arr, route, headsign in db.execute(query):
            if trip != current_trip:
                current_trip, last = trip, None
                tid = len(pools.trip_ids)
                trip_index[trip] = tid
                pools.trip_ids.append(pre + trip)
                rkey = (route, headsign)
                rid = route_index.get(rkey)
                if rid is None:
                    rid = len(pools.routes)
                    route_index[rkey] = rid
                    pools.routes.append({"route": route, "headsign": headsign,
                                         "route_color": route_colors.get(route, "")})
                pools.trip_route.append(rid)
            sid = pre + stop
            if sid not in stops:
                last = None
                continue
            if last is not None and last[0] != sid:
                from_stop, last_dep = last
                edge = graph.setdefault(from_stop, {}).setdefault(sid, {})
                packed = edge.get(route)
                if packed is None:
                    packed = [array("i"), array("i"), array("i"), array("f")]
                    edge[route] = packed
                packed[0].append(last_dep)
                packed[1].append(arr)
                packed[2].append(tid)
                packed[3].append(max(0.0, (arr - last_dep) / 60))
            last = sid, dep
        db.close()


    for neighbors in graph.values():
        for options in neighbors.values():
            for name, packed in list(options.items()):
                if name == "__walk__":
                    continue
                deps, arrs, tids, dists = packed
                order = sorted(range(len(deps)), key=deps.__getitem__)
                options[name] = CompactTrips(
                    array("i", (deps[i] for i in order)),
                    array("i", (arrs[i] for i in order)),
                    array("i", (tids[i] for i in order)),
                    array("f", (dists[i] for i in order)), pools
                )

    destination = target.with_suffix(".tmp")
    with destination.open("wb") as f:
        pickle.dump(Graph(graph, stops, trip_service, cal, dates), f, protocol=pickle.HIGHEST_PROTOCOL)
    destination.replace(target)
    return len(stops), len(trip_service)



# These files are required to build routing and the TTC live-trip matching table.
# Preserve other GTFS .txt files as well (including optional shapes and calendars).
REQUIRED_FILES = frozenset(TIMETABLE_FILES)
MAX_NESTED_ZIP_BYTES = 350 * 1024 * 1024
MAX_TOTAL_EXTRACT_BYTES = 1_000 * 1024 * 1024
TTC_DATASET_ID = "7795b45e-e65a-4465-81fc-c36b9dfff169"
TTC_CKAN_API = "https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show"
TTC_SURFACE_DATASET_ID = "bd4809dd-e289-4de8-bbde-c5c00dafbf4f"
TTC_SURFACE_URL = (
    "https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/"
    "bd4809dd-e289-4de8-bbde-c5c00dafbf4f/resource/"
    "28514055-d011-4ed7-8bb0-97961dfe2b66/download/SurfaceGTFS.zip"
)
TTC_LEGACY_URL = (
    "https://opendata.toronto.ca/toronto.transit.commission/"
    "ttc-routes-and-schedules/OpenData_TTC_Schedules.zip"
)


def _already_downloaded(agency):
    folder = GTFS_ROOT / agency.id
    return all((folder / name).is_file() and (folder / name).stat().st_size > 0
               for name in REQUIRED_FILES)


def _has_required_files(folder):
    return all((folder / name).is_file() and (folder / name).stat().st_size > 0
               for name in REQUIRED_FILES)


def _zip_gtfs_files(archive):
    """Return a single GTFS directory's .txt members, never mixing directories."""
    by_directory = {}
    for info in archive.infolist():
        if info.is_dir():
            continue
        normalized = info.filename.replace("\\", "/")
        parts = normalized.split("/")
        basename = parts[-1].lower()  # GTFS table filenames are case-insensitive in ZIPs
        if (not basename.endswith(".txt") or not basename or
                any(part in ("", ".", "..") for part in parts) or
                parts[0].startswith("__MACOSX")):
            continue
        parent = "/".join(parts[:-1])
        # Never merge similarly named files from different GTFS subfolders.
        by_directory.setdefault(parent, {})[basename] = info

    matches = [files for files in by_directory.values()
               if REQUIRED_FILES.issubset(files)]
    if not matches:
        return None
    # The largest complete collection is preferable when a package contains
    # both an example/partial schedule and its real GTFS directory.
    return max(matches, key=lambda files: (len(files),
                                          sum(i.file_size for i in files.values())))


def _locate_gtfs_zip(archive, depth=0):
    """Find GTFS files in a ZIP, even inside a wrapper ZIP (Toronto sometimes)."""
    files = _zip_gtfs_files(archive)
    if files:
        return archive, files

    if depth >= 2:
        raise ValueError("nested GTFS ZIP depth exceeds the supported limit")

    nested = [info for info in archive.infolist()
              if not info.is_dir() and info.filename.lower().endswith(".zip")]
    errors = []
    for info in nested:
        if info.file_size > MAX_NESTED_ZIP_BYTES:
            errors.append(f"{info.filename} is too large")
            continue
        try:
            with archive.open(info) as entry:
                data = entry.read(MAX_NESTED_ZIP_BYTES + 1)
            if len(data) > MAX_NESTED_ZIP_BYTES:
                raise ValueError("nested ZIP exceeds size limit")
            with zipfile.ZipFile(io.BytesIO(data)) as child:
                result = _locate_gtfs_zip(child, depth + 1)
                # Copy the selected GTFS files into an independent in-memory ZIP;
                # otherwise the nested ZipFile will be closed on return.
                output = io.BytesIO()
                with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as flat:
                    _, selected = result
                    total = 0
                    for name, member in selected.items():
                        total += member.file_size
                        if total > MAX_TOTAL_EXTRACT_BYTES:
                            raise ValueError("GTFS files exceed safety size limit")
                        with result[0].open(member) as infile, flat.open(name, "w") as outfile:
                            shutil.copyfileobj(infile, outfile, length=512 * 1024)
                output.seek(0)
                flattened = zipfile.ZipFile(output)
                return flattened, _zip_gtfs_files(flattened)
        except (OSError, ValueError, RuntimeError, zipfile.BadZipFile) as error:
            errors.append(f"{info.filename}: {error}")

    detail = f" (nested ZIP errors: {'; '.join(errors[:3])})" if errors else ""
    raise ValueError("GTFS feed missing a complete routes.txt, stops.txt, "
                     f"trips.txt and stop_times.txt set{detail}")


def _extract_files(agency, source, target, wanted=None):
    """Safely extract one GTFS dataset to a directory, regardless of ZIP layout."""
    source, target = Path(source), Path(target)
    wanted = set(wanted or REQUIRED_FILES)
    if source.is_dir():
        folders = [source] + [p for p in source.rglob("*")
                              if p.is_dir() and len(p.relative_to(source).parts) <= 3]
        complete = [p for p in folders if all((p / name).is_file() for name in wanted)]
        if not complete:
            raise ValueError(f"{agency.label} feed missing: {', '.join(sorted(wanted))} "
                             f"in {source}")
        feed_folder = min(complete, key=lambda p: len(p.parts))
        target.mkdir(parents=True, exist_ok=True)
        for path in feed_folder.iterdir():
            if path.is_file() and path.name.lower().endswith(".txt"):
                dest = target / path.name
                if path.resolve() != dest.resolve():
                    shutil.copy2(path, dest)
        return

    if not zipfile.is_zipfile(source):
        raise ValueError(f"{agency.label} download is not a valid ZIP: {source}")
    with zipfile.ZipFile(source) as archive:
        selected_archive, selected = _locate_gtfs_zip(archive)
        missing = wanted - selected.keys()
        if missing:
            raise ValueError(f"{agency.label} feed missing: {', '.join(sorted(missing))}")
        target.mkdir(parents=True, exist_ok=True)
        total = 0
        try:
            for name, info in selected.items():
                total += info.file_size
                if total > MAX_TOTAL_EXTRACT_BYTES:
                    raise ValueError(f"{agency.label} GTFS exceeds the size limit")
                with selected_archive.open(info) as src, (target / name).open("wb") as dst:
                    shutil.copyfileobj(src, dst, length=512 * 1024)
        finally:
            if selected_archive is not archive:
                selected_archive.close()


# Public snapshots archived by Mobility Database, independent of Toronto's CKAN
# CDN. TTC's full schedule is mdb-732; BusTime-compatible surface feed mdb-2253.
# These known copies serve as a fallback if the catalogue layout changes.
TTC_GTFS_MIRRORS = {
    "full": (
        "mdb-732",
        ("https://files.mobilitydatabase.org/mdb-732/"
         "mdb-732-202609260010/mdb-732-202609260010.zip"),
    ),
    "surface": (
        "mdb-2253",
        ("https://files.mobilitydatabase.org/mdb-2253/"
         "mdb-2253-202609290048/mdb-2253-202609290048.zip"),
    ),
}


class _GTFSArchiveLinkParser(HTMLParser):
    """Extract ZIP links without needing BeautifulSoup or a MobilityData API key."""
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        if tag != "a":
            return
        href = dict(attrs).get("href", "")
        if href:
            self.urls.append(href)


def _mobility_archive_urls(source_kind):
    """Discover Toronto GTFS snapshots from Mobility Database's public feed page."""
    feed_id, pinned = TTC_GTFS_MIRRORS[source_kind]
    # A previously archived feed is useful while the latest feed covers only
    # FUTURE service dates. It is NOT hardcoded as the permanent source.
    if date.today() <= date(2026, 10, 31):
        yield pinned
    page = f"https://mobilitydatabase.org/feeds/gtfs/{feed_id}"
    try:
        response = requests.get(page, timeout=(10, 20),
                                headers={"User-Agent": "Mozilla/5.0 (compatible; kmaps/1.0)"})
        response.raise_for_status()
        parser = _GTFSArchiveLinkParser()
        parser.feed(response.text)
        seen = set()
        for href in parser.urls:
            url = urljoin(page, href)
            parts = urlparse(url)
            if (parts.scheme == "https" and parts.netloc == "files.mobilitydatabase.org"
                    and parts.path.startswith(f"/{feed_id}/")
                    and parts.path.lower().endswith(".zip") and url not in seen):
                seen.add(url)
                yield url
    except (requests.RequestException, ValueError, TypeError, AttributeError) as error:
        print(f"TTC archive lookup unavailable ({error}).", flush=True)
    # The pinned copy can still rescue a broken installer if the HTML changed.
    if date.today() > date(2026, 10, 31):
        yield pinned


def _covers_current_service(archive, selected):
    """Return False only if a feed clearly excludes today (e.g. a future feed).

    Older TTC data remains useful for offline routing but cannot match today's
    live predictions; therefore try another source first.  An unknown span
    returns None so we don't reject otherwise valid GTFS archives.
    """
    start, end = None, None
    for filename in ("calendar.txt", "calendar_dates.txt", "feed_info.txt"):
        member = selected.get(filename)
        if member is None or member.file_size > 8 * 1024 * 1024:
            continue
        try:
            with archive.open(member) as file:
                records = csv.DictReader(io.TextIOWrapper(file, encoding="utf-8-sig", errors="replace"))
                for row in records:
                    for key in (("start_date", "end_date") if filename == "calendar.txt"
                                else ("date",) if filename == "calendar_dates.txt"
                                else ("feed_start_date", "feed_end_date")):
                        value = row.get(key, "")
                        if value and len(value) == 8 and value.isdigit():
                            d = datetime.strptime(value, "%Y%m%d").date()
                            start = d if start is None else min(start, d)
                            end = d if end is None else max(end, d)
        except (OSError, ValueError, UnicodeError, csv.Error):
            pass
    if start is None or end is None:
        return None
    return start <= date.today() <= end


def _candidate_download_urls(agency, source_kind="full"):
    """Try TTC's independently archived official GTFS before unreliable CKAN URLs."""
    if source_kind == "surface":
        if agency.id != "ttc":
            raise ValueError("Surface GTFS only applies to TTC")
        yield from _mobility_archive_urls("surface")
        yield TTC_SURFACE_URL
        return
    if agency.id == "ttc":
        yield from _mobility_archive_urls("full")
    yield agency.feed_url
    if agency.id != "ttc":
        return
    seen = {agency.feed_url}
    try:
        response = requests.get(TTC_CKAN_API, params={"id": TTC_DATASET_ID}, timeout=(10, 20))
        response.raise_for_status()
        payload = response.json()
        resources = payload.get("result", {}).get("resources", [])
        resources = sorted(resources, key=lambda r: (
            "routes and schedules" not in str(r.get("name", "")).lower(),
            "zip" not in str(r.get("format", "")).lower(),
        ))
        for resource in resources:
            url = resource.get("url")
            if (url and url not in seen and
                    ("zip" in str(resource.get("format", "")).lower() or
                     ".zip" in url.lower())):
                seen.add(url)
                yield url
    except (requests.RequestException, ValueError, TypeError, AttributeError) as error:
        print(f"TTC catalogue lookup unavailable ({error}); trying mirrors.", flush=True)
    if TTC_LEGACY_URL not in seen:
        yield TTC_LEGACY_URL


def _download(agency, source_kind="full"):
    """Download a validated GTFS ZIP; never overwrite a previously usable ZIP."""
    GTFS_ROOT.mkdir(parents=True, exist_ok=True)
    destination = GTFS_ROOT / (f"{agency.id}_surface_download.zip" if source_kind == "surface" else f"{agency.id}_download.zip")
    failures = []
    attempted = set()
    for url in _candidate_download_urls(agency, source_kind=source_kind):
        if url in attempted:
            continue
        attempted.add(url)
        print(f"Downloading {agency.label} GTFS from {urlparse(url).netloc}...", flush=True)
        with tempfile.NamedTemporaryFile(dir=GTFS_ROOT, prefix=f".{agency.id}_download_",
                                         suffix=".zip", delete=False) as output:
            temporary = Path(output.name)
        try:
            with requests.get(url, stream=True, timeout=(15, 120),
                              headers={"User-Agent": "kmaps-gtfs-setup/1.0"}) as response:
                response.raise_for_status()
                with temporary.open("wb") as output:
                    for chunk in response.iter_content(512 * 1024):
                        if chunk:
                            output.write(chunk)
            if not zipfile.is_zipfile(temporary):
                raise ValueError(f"response is not a ZIP ({temporary.stat().st_size:,} bytes; "
                                 f"HTTP Content-Type: {response.headers.get('Content-Type', '?')})")
            # Validate actual feed content, not just the ZIP signature.
            with zipfile.ZipFile(temporary) as archive:
                if not archive.infolist():
                    raise ValueError(f"server returned an EMPTY ZIP "
                                     f"({temporary.stat().st_size:,} bytes; zero entries)")
                found_archive, files = _locate_gtfs_zip(archive)
                try:
                    if not REQUIRED_FILES.issubset(files):
                        raise ValueError("missing core GTFS tables")
                    if agency.id == "ttc" and _covers_current_service(found_archive, files) is False:
                        raise ValueError("GTFS ZIP has no service for today "
                                         "(trying another archived snapshot)")
                finally:
                    if found_archive is not archive:
                        found_archive.close()
            verified_size = temporary.stat().st_size
            temporary.replace(destination)
            print(f"{agency.label}: verified {verified_size:,} byte GTFS ZIP "
                  f"from {urlparse(url).netloc}.", flush=True)
            return destination
        except (requests.RequestException, OSError, ValueError, RuntimeError,
                zipfile.BadZipFile) as error:
            details = ""
            if zipfile.is_zipfile(temporary):
                try:
                    with zipfile.ZipFile(temporary) as archive:
                        members = [item.filename for item in archive.infolist()
                                   if not item.is_dir()][:12]
                    details = f"; first ZIP entries: {members!r}"
                except (OSError, ValueError, zipfile.BadZipFile):
                    pass
            failures.append(f"{urlparse(url).netloc}: {error}{details}")
            print(f"  Source failed: {error}{details}", flush=True)
        finally:
            temporary.unlink(missing_ok=True)

    # The original archive may still be usable when an agency's feed is offline.
    if zipfile.is_zipfile(destination):
        try:
            with zipfile.ZipFile(destination) as archive:
                nested, files = _locate_gtfs_zip(archive)
                if nested is not archive:
                    nested.close()
            if REQUIRED_FILES.issubset(files):
                print(f"WARNING: {agency.label} is using the existing downloaded ZIP "
                      "because its live feed could not be reached.", flush=True)
                return destination
        except (ValueError, OSError, zipfile.BadZipFile):
            pass
    raise RuntimeError(f"Could not download {agency.label} GTFS: {' | '.join(failures)}")


def _install_new_folder(staged, folder):
    """Swap a fully validated feed into place, restoring the old one on failure."""
    backup = folder.with_name(f".{folder.name}_gtfs_previous")
    if backup.exists():
        shutil.rmtree(backup)
    if folder.exists():
        folder.rename(backup)
    try:
        staged.rename(folder)
    except Exception:
        if backup.exists():
            backup.rename(folder)
        raise
    if backup.exists():
        shutil.rmtree(backup)


def install_shapes(agency, source=None):
    """Add route geometry without rebuilding the timetable."""
    from . import shape_index

    agency = _agency(agency)
    folder = GTFS_ROOT / agency.id
    wanted = {"trips.txt", "routes.txt", "shapes.txt"}
    if source is None and not all((folder / name).is_file() for name in wanted):
        source = _download(agency)
    if source is not None:
        _extract_files(agency, source, folder, wanted)
    if not all((folder / name).is_file() for name in wanted):
        raise FileNotFoundError(f"{agency.label} trips.txt, routes.txt and shapes.txt are needed")

    print(f"Building {agency.label} route shapes (one-time, SQLite)...", flush=True)
    path = shape_index.database(agency.id)
    if not path:
        raise RuntimeError(f"{agency.label} shape index could not be built")
    print(f"{agency.label} route shapes ready: {path}", flush=True)
    return path


def install_agency(agency, source=None, redownload=False, source_kind="full"):
    """Download, validate, and build an agency without destroying a good old feed."""
    agency = _agency(agency)
    folder = GTFS_ROOT / agency.id
    GTFS_ROOT.mkdir(parents=True, exist_ok=True)
    if source_kind == "surface" and agency.id != "ttc":
        raise ValueError("--source surface is only valid for TTC")
    if source_kind == "surface":
        print("WARNING: TTC Surface GTFS has buses/streetcars but NO SUBWAY. "
              "Existing TTC full schedule will be backed up before replacement.", flush=True)

    if source is None:
        if source_kind == "full" and not redownload and _already_downloaded(agency):
            print(f"{agency.label}: using existing GTFS (add --redownload for fresh data).",
                  flush=True)
            source = folder
        else:
            source = _download(agency, source_kind=source_kind)
    source = Path(source)

    # Never replace a working full TTC router without preserving a usable backup.
    # A surface-only feed is a deliberately explicit emergency fallback, not the default.
    if source_kind == "surface":
        saved = GTFS_ROOT / "ttc_full_backup"
        if folder.is_dir() and not saved.exists():
            print(f"Backing up full TTC GTFS to {saved}...", flush=True)
            shutil.copytree(folder, saved)
        old_cache = agency.cache_path
        cache_backup = old_cache.with_name(old_cache.stem + "_full_backup" + old_cache.suffix)
        if old_cache.is_file() and not cache_backup.exists():
            print(f"Backing up full TTC routing cache to {cache_backup}...", flush=True)
            shutil.copy2(old_cache, cache_backup)

    if source.resolve() == folder.resolve() and _has_required_files(folder):
        # Avoid copying hundreds of MB of stop_times.txt on repeated builds.
        print(f"Building compact {agency.label} timetable (may take several minutes)...",
              flush=True)
        num_stops, num_trips = build_agency(agency, folder)
    else:
        with tempfile.TemporaryDirectory(prefix=f".{agency.id}_stage_", dir=GTFS_ROOT) as temp:
            staged = Path(temp) / "feed"
            _extract_files(agency, source, staged)
            if not _has_required_files(staged):
                raise ValueError(f"{agency.label} GTFS is incomplete; old feed was preserved")

            print(f"Building compact {agency.label} timetable (may take several minutes)...",
                  flush=True)
            num_stops, num_trips = build_agency(agency, staged)
            _install_new_folder(staged, folder)

    if (folder / "shapes.txt").is_file():
        try:
            install_shapes(agency)
        except (OSError, sqlite3.Error, ValueError, RuntimeError) as error:
            print(f"{agency.label}: timetable ready; optional shapes failed: {error}",
                  flush=True)
    print(f"{agency.label} ready: {num_stops:,} stops, {num_trips:,} trips. Restart kmaps.",
          flush=True)
    return num_stops, num_trips


def install_all(redownload=False, shapes_only=False, skip_installed=False):
    """Set up every configured own-cache agency and keep going after failures."""
    succeeded, skipped, failed = [], [], []
    agencies = list(OWN_CACHE_AGENCIES)
    for index, agency in enumerate(agencies, 1):
        print(f"\n[{index}/{len(agencies)}] {agency.id} — {agency.label}", flush=True)
        if (skip_installed and not redownload and not shapes_only and
                _already_downloaded(agency) and agency.cache_path.is_file()):
            print("  Already installed; skipped.", flush=True)
            skipped.append(agency.id)
            continue
        try:
            if shapes_only:
                install_shapes(agency)
            else:
                install_agency(agency, redownload=redownload)
            succeeded.append(agency.id)
        except Exception as error:
            print(f"  FAILED: {type(error).__name__}: {error}", flush=True)
            failed.append((agency.id, str(error)))

    print("\n========== GTFS SETUP SUMMARY ==========", flush=True)
    print(f"Successful ({len(succeeded)}): {', '.join(succeeded) or 'none'}")
    print(f"Skipped ({len(skipped)}): {', '.join(skipped) or 'none'}")
    print(f"Failed ({len(failed)}): {', '.join(id for id, _ in failed) or 'none'}")
    if failed:
        print("Retry individually: python -m transit.agency_setup <agency> --redownload")
    return not failed


def main(argv=None):
    ids = [agency.id for agency in OWN_CACHE_AGENCIES]
    parser = argparse.ArgumentParser(description="Download and build kmaps GTFS caches")
    parser.add_argument("agency", choices=["all", *ids],
                        help="an agency id from transit/agencies.py, or 'all'")
    parser.add_argument("--zip", help="local GTFS ZIP or extracted GTFS directory (one agency)")
    parser.add_argument("--source", choices=["full", "surface"], default="full",
                        help="TTC: 'full' includes subway; 'surface' uses BusTime-compatible "
                             "bus/streetcar feed, backs up full route data but excludes subway")
    parser.add_argument("--redownload", action="store_true",
                        help="download a fresh feed even when one is already installed")
    parser.add_argument("--shapes-only", action="store_true",
                        help="build geometry only, without rebuilding the timetable")
    parser.add_argument("--skip-installed", action="store_true",
                        help="with all: don't rebuild agencies whose timetable cache already exists")
    args = parser.parse_args(argv)
    if args.agency == "all":
        if args.source != "full":
            parser.error("--source surface can only be used with TTC")
        if args.zip:
            parser.error("--zip can only be used with a single agency, not all")
        return 0 if install_all(args.redownload, args.shapes_only,
                                args.skip_installed) else 1
    try:
        if args.shapes_only:
            install_shapes(args.agency, args.zip)
        else:
            install_agency(args.agency, args.zip, redownload=args.redownload,
                           source_kind=args.source)
    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile, requests.RequestException) as error:
        print(f"{args.agency} setup failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
