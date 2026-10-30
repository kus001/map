"""HTTP helper for transit feeds.

webapps.regionofwaterloo.ca (GRT static GTFS, GTFS-RT trip updates / vehicle positions / alerts)
still offers weak Diffie-Hellman parameters. OpenSSL 3 (security level 2) refuses that handshake with
`SSLError: [SSL: DH_KEY_TOO_SMALL] dh key too small`. The fix is to stop offering DH key exchange for
that host (same cipher string grt_vehicle_type.py already used), while leaving every other host on
the normal default settings. Certificate verification stays ON.
"""
import requests
from requests.adapters import HTTPAdapter
from urllib3.util import create_urllib3_context

# Hosts that need the no-DH cipher list. Add more here if another agency hits DH_KEY_TOO_SMALL.
LEGACY_TLS_HOSTS = ("https://webapps.regionofwaterloo.ca",)
_CIPHERS = ":HIGH:!DH:!aNULL"


class NoDHAdapter(HTTPAdapter):
    """HTTPAdapter whose TLS context never negotiates DH key exchange."""

    def init_poolmanager(self, *args, **kwargs):
        kwargs["ssl_context"] = create_urllib3_context(ciphers=_CIPHERS)
        super().init_poolmanager(*args, **kwargs)

    def proxy_manager_for(self, *args, **kwargs):
        kwargs["ssl_context"] = create_urllib3_context(ciphers=_CIPHERS)
        return super().proxy_manager_for(*args, **kwargs)


def make_session():
    session = requests.Session()
    adapter = NoDHAdapter()
    for prefix in LEGACY_TLS_HOSTS:
        session.mount(prefix, adapter)
    return session


def get(url, **kwargs):
    """Drop-in for requests.get that works with the Region of Waterloo servers.

    A fresh session per call keeps this safe for the realtime poller's worker threads (requests.Session
    is not guaranteed thread-safe) and for stream=True downloads, at the cost of no connection reuse.
    """
    return make_session().get(url, **kwargs)
