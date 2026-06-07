from threading import Thread
from time import sleep
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from .server import start_api_server


def _is_expected_api(host: str, port: int) -> bool:
    health_url = f"http://{host}:{port}/api/health"
    session_url = f"http://{host}:{port}/api/session"

    try:
        with urlopen(health_url, timeout=1.5) as response:
            if response.status != 200:
                return False
    except Exception:
        return False

    request = Request(session_url, method="GET")
    try:
        with urlopen(request, timeout=1.5) as response:
            return response.status in {200, 401}
    except HTTPError as exc:
        return exc.code == 401
    except Exception:
        return False


def wait_for_api_ready(host: str = "127.0.0.1", port: int = 5000, timeout_seconds: float = 25.0) -> bool:
    deadline = timeout_seconds
    step = 0.25
    elapsed = 0.0

    while elapsed < deadline:
        if _is_expected_api(host, port):
            return True

        sleep(step)
        elapsed += step

    return False


def start_background_api() -> bool:
    if _is_expected_api("127.0.0.1", 5000):
        return True

    thread = Thread(target=start_api_server, kwargs={"host": "127.0.0.1", "port": 5000}, daemon=False)
    thread.start()
    return wait_for_api_ready("127.0.0.1", 5000)
