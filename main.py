import os
import socket

# Reduce TensorFlow startup noise and avoid oneDNN precision-info logs in app console.
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")

import eel
from app.auth import close_app
from app.server_runner import start_background_api

eel.init("web")


def _pick_free_port(start: int = 8000, attempts: int = 20) -> int:
    for port in range(start, start + attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("No free port found for the GUI webserver.")


@eel.expose
def exit_application():
    close_app()
    return True


if __name__ == "__main__":
    api_ready = start_background_api()
    if not api_ready:
        print("Error: Backend API is not ready or another service is using port 5000.")
        raise SystemExit(1)

    eel_port = _pick_free_port(8000, attempts=30)
    eel.start(
        "index.html",
        port=eel_port,
        size=(1280, 800),
        position=(120, 40),
        disable_cache=True
    )