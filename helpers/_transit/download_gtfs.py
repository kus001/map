import shutil
import time
import zipfile
from pathlib import Path

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


PROJECT_ROOT = Path(__file__).resolve().parents[2]

GTFS_ROOT = (
    PROJECT_ROOT
    / "transit_data"
    / "GTFS_Files"
)


GTFS_LINKS = {
    "grt_busses":
        "https://webapps.regionofwaterloo.ca/"
        "api/grt-routes/api/staticfeeds/1",

    "grt_trains":
        "https://webapps.regionofwaterloo.ca/"
        "api/grt-routes/api/staticfeeds/2",

    "go":
        "https://assets.metrolinx.com/raw/upload/"
        "Documents/Metrolinx/Open%20Data/GO-GTFS.zip",
}


REQUIRED_FILES = {
    "agency.txt",
    "routes.txt",
    "stops.txt",
    "trips.txt",
    "stop_times.txt",
}


def make_session():
    retry = Retry(
        total=2,
        connect=2,
        read=2,
        backoff_factor=1.5,
        status_forcelist=[
            429,
            500,
            502,
            503,
            504,
        ],
        allowed_methods=[
            "GET"
        ],
    )

    adapter = HTTPAdapter(
        max_retries=retry
    )

    session = requests.Session()

    session.mount(
        "https://",
        adapter
    )

    session.mount(
        "http://",
        adapter
    )

    return session


def feed_exists(folder):
    if not folder.exists():
        return False

    existing = {
        path.name
        for path in folder.iterdir()
        if path.is_file()
    }

    return REQUIRED_FILES.issubset(
        existing
    )


def download_gtfs(
    agency,
    force=False
):
    url = GTFS_LINKS.get(
        agency
    )

    if not url:
        raise ValueError(
            f"Unknown agency: {agency}"
        )

    destination = (
        GTFS_ROOT
        / agency
    )

    if (
        not force
        and feed_exists(
            destination
        )
    ):
        print(
            f"{agency}: GTFS already exists, skipping."
        )

        return True

    GTFS_ROOT.mkdir(
        parents=True,
        exist_ok=True
    )

    temp_zip = (
        GTFS_ROOT
        / f"{agency}.download.zip"
    )

    session = make_session()

    print(
        f"{agency}: downloading GTFS..."
    )

    try:
        with session.get(
            url,
            stream=True,

            # 10 sec to connect,
            # 120 sec to receive data.
            timeout=(
                10,
                120
            ),
        ) as response:

            response.raise_for_status()

            with temp_zip.open(
                "wb"
            ) as file:

                for chunk in response.iter_content(
                    chunk_size=1024 * 256
                ):
                    if chunk:
                        file.write(
                            chunk
                        )

    except requests.RequestException as error:
        temp_zip.unlink(
            missing_ok=True
        )

        print(
            f"{agency}: download failed."
        )

        print(
            f"  {error}"
        )

        print(
            "  Existing transit data was left unchanged."
        )

        return False


    if not zipfile.is_zipfile(
        temp_zip
    ):
        temp_zip.unlink(
            missing_ok=True
        )

        print(
            f"{agency}: server response was not a valid ZIP file."
        )

        return False


    temp_folder = (
        GTFS_ROOT
        / f".{agency}_extracting"
    )

    if temp_folder.exists():
        shutil.rmtree(
            temp_folder
        )

    temp_folder.mkdir(
        parents=True
    )


    try:
        with zipfile.ZipFile(
            temp_zip,
            "r"
        ) as archive:

            archive.extractall(
                temp_folder
            )


        if destination.exists():
            shutil.rmtree(
                destination
            )

        temp_folder.rename(
            destination
        )


        print(
            f"{agency}: download complete."
        )

        if (
            destination
            / "shapes.txt"
        ).exists():

            print(
                f"{agency}: shapes.txt found."
            )

        else:
            print(
                f"{agency}: warning - shapes.txt is not present."
            )


        return True


    except Exception as error:
        print(
            f"{agency}: could not extract GTFS."
        )

        print(
            f"  {error}"
        )

        return False


    finally:
        temp_zip.unlink(
            missing_ok=True
        )

        if temp_folder.exists():
            shutil.rmtree(
                temp_folder,
                ignore_errors=True
            )


def download_multiple_gtfs(
    *agencies,
    force=False
):
    succeeded = []
    failed = []


    for agency in agencies:
        if download_gtfs(
            agency,
            force=force
        ):
            succeeded.append(
                agency
            )

        else:
            failed.append(
                agency
            )

        time.sleep(
            0.5
        )


    print()

    if succeeded:
        print(
            "Downloaded:",
            ", ".join(
                succeeded
            )
        )


    if failed:
        print(
            "Could not download:",
            ", ".join(
                failed
            )
        )

        print(
            "Those feeds can be retried later."
        )


    return (
        len(failed)
        == 0
    )


if __name__ == "__main__":
    download_multiple_gtfs(
        "grt_trains",
        "grt_busses",
        "go"
    )