"""Headless-Chrome layout probe for the touchscreen (no npm / Playwright).

Serves the real dashboard (Flask/SocketIO) with a given payload, loads it in
headless Chrome at an exact viewport, and returns layout metrics measured in
the page after the payload has rendered.
"""

import json
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path

from flask import render_template

from sia_local_control_ui.dashboard import SiaDashboard

CHROME_CANDIDATES = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
)

MEASURE_JS = (Path(__file__).parent / "measure.js").read_text()


def find_chrome() -> str | None:
    for c in CHROME_CANDIDATES:
        path = shutil.which(c) or (c if Path(c).exists() else None)
        if path:
            return path
    return None


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class LayoutServer:
    """One dashboard server; the payload is swapped per measurement."""

    def __init__(
        self, template_dir: Path | None = None, static_dir: Path | None = None
    ):
        self.port = _free_port()
        self.dash = SiaDashboard(
            port=self.port, command_handler=lambda c, v: {"ok": True}
        )
        # Optionally serve another checkout's page (e.g. main) for comparison.
        if template_dir is not None:
            self.dash.app.template_folder = str(template_dir)
        if static_dir is not None:
            self.dash.app.static_folder = str(static_dir)
        self.dash.app.add_url_rule("/__layout", "layout", self._page)
        self._thread = threading.Thread(target=self.dash.start, daemon=True)
        self._thread.start()
        deadline = time.time() + 10
        while time.time() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.2):
                    return
            except OSError:
                time.sleep(0.1)
        raise RuntimeError("dashboard did not start")

    def _page(self):
        html = render_template("dashboard.html")
        # Measure the settled layout: no entry (slideIn) or pulse animations.
        still = (
            "<style>*,*::before,*::after"
            "{animation:none!important;transition:none!important}</style>"
        )
        # The payload is embedded and rendered directly via the dashboard's own
        # render(), so the measurement doesn't depend on socket.io timing.
        payload = json.dumps(self.dash.data).replace("</", "<\\/")
        script = f"<script>window.__LAYOUT_PAYLOAD__ = {payload};</script>"
        return html.replace("</head>", still + "</head>").replace(
            "</body>", f"{script}<script>{MEASURE_JS}</script></body>"
        )

    def url(self, path="/__layout") -> str:
        return f"http://127.0.0.1:{self.port}{path}"


# headless=new counts browser UI in --window-size; this is the difference.
_CHROME_UI_HEIGHT = None


def _dump(chrome, url, width, height) -> str:
    out = subprocess.run(
        [
            chrome,
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            f"--window-size={width},{height}",
            "--virtual-time-budget=6000",
            "--dump-dom",
            url,
        ],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    return out.stdout


def _parse(dom: str) -> dict | None:
    marker = '<pre id="layout-result">'
    if dom.count(marker) < 2:  # the first is inside the injected script
        return None
    start = dom.rindex(marker) + len(marker)
    end = dom.index("</pre>", start)
    return json.loads(dom[start:end].replace("&quot;", '"').replace("&amp;", "&"))


def _measure_once(chrome, url, width, height, attempts=3) -> dict:
    for _ in range(attempts):
        metrics = _parse(_dump(chrome, url, width, height))
        if metrics is not None:
            return metrics
    raise RuntimeError(f"no layout result from Chrome for {url} at {width}x{height}")


def measure(server: LayoutServer, chrome: str, payload: dict, width: int, height: int):
    """Layout metrics at an exact width x height viewport."""
    global _CHROME_UI_HEIGHT
    server.dash.data = payload
    if _CHROME_UI_HEIGHT is None:
        probe = _measure_once(chrome, server.url(), width, height)
        _CHROME_UI_HEIGHT = height - probe["viewport"]["h"]
    metrics = _measure_once(chrome, server.url(), width, height + _CHROME_UI_HEIGHT)
    assert metrics["viewport"] == {"w": width, "h": height}, metrics["viewport"]
    return metrics
