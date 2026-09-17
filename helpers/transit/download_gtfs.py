import os
import ssl
import urllib3
import requests
import zipfile
from pathlib import Path
from requests.adapters import HTTPAdapter
from urllib3.util.ssl_ import create_urllib3_context

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


GTFS_LINKS = {
    "grt_busses": "https://webapps.regionofwaterloo.ca/api/grt-routes/api/staticfeeds/1",
    "grt_trains": "https://webapps.regionofwaterloo.ca/api/grt-routes/api/staticfeeds/2",

    "go"        : "https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip"
}

class WeakDHAdapter(HTTPAdapter):
    """HTTPAdapter that lowers OpenSSL's security level and disables
    certificate verification entirely — most permissive TLS possible."""
    def init_poolmanager(self, *args, **kwargs):
        ctx = create_urllib3_context()
        ctx.set_ciphers("DEFAULT@SECLEVEL=1")
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        kwargs["ssl_context"] = ctx
        return super().init_poolmanager(*args, **kwargs)

    def proxy_manager_for(self, *args, **kwargs):
        ctx = create_urllib3_context()
        ctx.set_ciphers("DEFAULT@SECLEVEL=1")
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        kwargs["ssl_context"] = ctx
        return super().proxy_manager_for(*args, **kwargs)


def download_gtfs(agency:str):
    local_path = Path("transit") / "GTFS_Files" / agency
    local_path.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    session.mount("https://", WeakDHAdapter())

    url = GTFS_LINKS.get(agency)
    if not url:
        raise ValueError(f"Invalid agency: {agency}")

    response = session.get(url, verify=False)

    if response.status_code == 200:
        with open(local_path / "data.zip", "wb") as file:
            file.write(response.content)
    else:
        print(f"Failed to download GTFS data for {agency}, from {url}. Status code: {response.status_code}")
        return -1

    with zipfile.ZipFile(local_path / "data.zip", 'r') as zip_ref:
        zip_ref.extractall(local_path)

    os.remove(local_path / "data.zip")

    return 0

def download_multiple_gtfs(*agencies:str):
    for agency in agencies:
        download_gtfs(agency)

if __name__ == "__main__":
    download_multiple_gtfs("grt_trains", "grt_busses", "go")
