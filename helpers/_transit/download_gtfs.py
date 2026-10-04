import os
import ssl
import zipfile
from pathlib import Path

import requests
import urllib3
from requests.adapters import HTTPAdapter
from urllib3.util.ssl_ import create_urllib3_context

PROJECT_ROOT = Path(__file__).resolve().parents[2]
GTFS_ROOT = PROJECT_ROOT / "transit_data" / "GTFS_Files"

GTFS_LINKS = {
    "grt_busses": "https://webapps.regionofwaterloo.ca/api/grt-routes/api/staticfeeds/1",
    "grt_trains": "https://webapps.regionofwaterloo.ca/api/grt-routes/api/staticfeeds/2",
    "go": "https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip",
}

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


class WeakDHAdapter(HTTPAdapter):
    """Compatibility adapter for feeds served with older TLS settings."""

    def init_poolmanager(self, *args, **kwargs):
        context = create_urllib3_context()
        context.set_ciphers("DEFAULT@SECLEVEL=1")
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        kwargs["ssl_context"] = context
        return super().init_poolmanager(*args, **kwargs)

    def proxy_manager_for(self, *args, **kwargs):
        context = create_urllib3_context()
        context.set_ciphers("DEFAULT@SECLEVEL=1")
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        kwargs["ssl_context"] = context
        return super().proxy_manager_for(*args, **kwargs)


def download_gtfs(agency):
    url = GTFS_LINKS.get(agency)
    if not url:
        raise ValueError(f"Invalid agency: {agency}")

    local_path = GTFS_ROOT / agency
    local_path.mkdir(parents=True, exist_ok=True)
    zip_path = local_path / "data.zip"

    session = requests.Session()
    session.mount("https://", WeakDHAdapter())

    response = session.get(url, verify=False, timeout=90)
    response.raise_for_status()
    zip_path.write_bytes(response.content)

    with zipfile.ZipFile(zip_path, "r") as archive:
        archive.extractall(local_path)

    os.remove(zip_path)
    return 0


def download_multiple_gtfs(*agencies):
    for agency in agencies:
        print(f"Downloading {agency} GTFS...")
        download_gtfs(agency)
    print("GTFS downloads complete.")


if __name__ == "__main__":
    download_multiple_gtfs("grt_trains", "grt_busses", "go")
