"""Disk index for GTFS trip metadata and track geometry.

Built once per feed, then SQLite does the lookups instead of rescanning the
entire CSV each time a route is drawn. The index lives outside Git.
"""
import csv
import os
import sqlite3
import threading
from pathlib import Path
from contextlib import closing

from .agencies import AGENCIES

ROOT = Path(__file__).resolve().parents[1] / 'transit_data' / 'GTFS_Files'
CACHE_DIR = ROOT.parent / '.shape_index'
_lock = threading.Lock()
_ready = {}
_failed = {}


def _stamp(path):
    if not path.exists():
        return '-'
    st = path.stat()
    return f'{st.st_size}:{st.st_mtime_ns}'


def _rows(path):
    if not path.exists():
        return
    with path.open('r', encoding='utf-8-sig', newline='', errors='replace') as f:
        yield from csv.DictReader(f)


def _usable(conn):
    try:
        tables = {row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
        if not {'files', 'trips', 'routes', 'shape_points'} <= tables:
            return False
        return (conn.execute('SELECT 1 FROM trips LIMIT 1').fetchone() is not None
                and conn.execute('SELECT 1 FROM shape_points LIMIT 1').fetchone() is not None)
    except sqlite3.Error:
        return False


def _valid(conn, agency):
    if not _usable(conn):
        return False
    try:
        versions = dict(conn.execute('SELECT name, stamp FROM files'))
        return all(versions.get(name) == _stamp(ROOT / agency / name)
                   for name in ('trips.txt', 'routes.txt', 'shapes.txt'))
    except (sqlite3.Error, OSError):
        return False


def _build(agency, path):
    feed = ROOT / agency
    tmp = path.with_suffix('.building')
    tmp.unlink(missing_ok=True)
    conn = sqlite3.connect(tmp)
    try:
        conn.execute('PRAGMA journal_mode=OFF')
        conn.execute('PRAGMA synchronous=OFF')
        conn.executescript('''
            CREATE TABLE files(name TEXT PRIMARY KEY, stamp TEXT);
            CREATE TABLE trips(trip_id TEXT PRIMARY KEY, route_id TEXT, shape_id TEXT, headsign TEXT);
            CREATE TABLE routes(route_id TEXT PRIMARY KEY, short_name TEXT, long_name TEXT, type TEXT, color TEXT);
            CREATE TABLE shape_points(shape_id TEXT, seq INTEGER, lat REAL, lon REAL);
        ''')
        conn.executemany('INSERT INTO routes VALUES(?,?,?,?,?)', (
            (r.get('route_id'), r.get('route_short_name') or '', r.get('route_long_name') or '',
             r.get('route_type') or '', r.get('route_color') or '')
            for r in _rows(feed / 'routes.txt') or () if r.get('route_id')
        ))
        conn.executemany('INSERT OR REPLACE INTO trips VALUES(?,?,?,?)', (
            (r.get('trip_id'), r.get('route_id') or '', r.get('shape_id') or '',
             r.get('trip_headsign') or '')
            for r in _rows(feed / 'trips.txt') or () if r.get('trip_id')
        ))

        batch = []
        for r in _rows(feed / 'shapes.txt') or ():
            try:
                batch.append((r['shape_id'], int(float(r['shape_pt_sequence'])),
                              float(r['shape_pt_lat']), float(r['shape_pt_lon'])))
            except (KeyError, TypeError, ValueError):
                continue
            if len(batch) >= 4096:
                conn.executemany('INSERT INTO shape_points VALUES(?,?,?,?)', batch)
                batch.clear()
        if batch:
            conn.executemany('INSERT INTO shape_points VALUES(?,?,?,?)', batch)
        conn.execute('CREATE INDEX shape_lookup ON shape_points(shape_id, seq)')
        conn.executemany('INSERT INTO files VALUES(?,?)', (
            (name, _stamp(feed / name)) for name in ('trips.txt', 'routes.txt', 'shapes.txt')
        ))
        conn.commit()
    except BaseException:
        conn.close()
        tmp.unlink(missing_ok=True)
        raise
    conn.close()
    os.replace(tmp, path)


def database(agency):
    agency = str(agency)
    if agency not in AGENCIES:
        return None

    feed = ROOT / agency
    path = CACHE_DIR / f'{agency}.sqlite'


    has_source = (feed / 'trips.txt').is_file() and (feed / 'shapes.txt').is_file()
    stamp = (tuple(_stamp(feed / f) for f in ('trips.txt', 'routes.txt', 'shapes.txt'))
             if has_source else ('cached', _stamp(path)))

    with _lock:
        if _failed.get(agency) == stamp:
            return None
        try:
            if _ready.get(agency) != stamp or not path.is_file():
                ok = False
                if path.is_file():
                    try:
                        with closing(sqlite3.connect(f'file:{path}?mode=ro', uri=True)) as conn:
                            ok = _valid(conn, agency) if has_source else _usable(conn)
                    except sqlite3.Error:
                        pass
                if not ok:
                    if not has_source:
                        return None
                    CACHE_DIR.mkdir(parents=True, exist_ok=True)
                    _build(agency, path)
                _ready[agency] = stamp
            _failed.pop(agency, None)
            return path
        except (OSError, sqlite3.Error) as exc:
            print(f'GTFS shape index unavailable for {agency}: {exc}', flush=True)
            _failed[agency] = stamp
            return None


def trip(agency, trip_id):
    path = database(agency)
    if not path:
        return None
    with closing(sqlite3.connect(path)) as conn:
        row = conn.execute('''
            SELECT t.trip_id, t.shape_id, t.headsign, t.route_id,
                   r.short_name, r.long_name, r.type, r.color
            FROM trips t LEFT JOIN routes r ON r.route_id=t.route_id
            WHERE t.trip_id=?
        ''', (str(trip_id),)).fetchone()
    if not row:
        return None
    return {
        'agency': agency, 'feed_dir': str(ROOT / agency), 'trip_id': row[0],
        'shape_id': row[1], 'headsign': row[2], 'route_id': row[3],
        'route_short_name': row[4] or '', 'route_long_name': row[5] or '',
        'route_type': row[6] or '', 'route_color': row[7] or ''
    }


def shape(agency, shape_id):
    path = database(agency)
    if not path or not shape_id:
        return ()
    with closing(sqlite3.connect(path)) as conn:
        rows = conn.execute(
            'SELECT lat, lon FROM shape_points WHERE shape_id=? ORDER BY seq',
            (str(shape_id),)
        ).fetchall()
    return tuple((float(lat), float(lon)) for lat, lon in rows)


def prewarm():

    for agency in AGENCIES:
        database(agency)


if __name__ == "__main__":
    import time
    started = time.perf_counter()
    prewarm()
    print(f"GTFS geometry indexes ready in {time.perf_counter() - started:.2f}s")
