"""Flask + Flask-SocketIO touchscreen server for the SIA local HMI.

The application feeds it a status payload each loop (:meth:`SiaDashboard.update_data`)
which is broadcast to connected touchscreens. Operator actions on the screen
arrive as ``command`` socket events; those are marshalled back onto the app's
asyncio loop via ``command_handler`` (an injected blocking bridge), which issues
the real Doover RPC to the controller and returns an ack/err the JS turns into a
spinner + success/error toast.
"""

import logging
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit

log = logging.getLogger(__name__)


class SiaDashboard:
    def __init__(
        self,
        host: str = "0.0.0.0",
        port: int = 8091,
        secret_key: str = "sia_local_control_ui",
        command_handler: Optional[Callable[[str, Any], dict]] = None,
    ):
        self.host = host
        self.port = port
        # Blocking bridge (cmd, value) -> {"ok": bool, ...}. Injected by the app.
        self.command_handler = command_handler

        self.app = Flask(__name__, template_folder="templates", static_folder="static")
        self.app.config["SECRET_KEY"] = secret_key
        self.socketio = SocketIO(self.app, cors_allowed_origins="*", async_mode="threading")

        # Latest status payload broadcast to clients.
        self.data: dict = {"pumps": [], "faults": [], "link_ok": False}
        self.connected_clients: set = set()

        self._setup_routes()
        self._setup_socket_events()

        self._update_thread: Optional[threading.Thread] = None
        self._running = False

    # -- routes -------------------------------------------------------------
    def _setup_routes(self):
        @self.app.route("/")
        def index():
            return render_template("dashboard.html")

        @self.app.route("/api/data")
        def get_data():
            return self._payload()

        @self.app.route("/api/health")
        def health():
            return {"status": "healthy", "timestamp": _now_iso()}

    def _payload(self) -> dict:
        out = dict(self.data)
        out["timestamp"] = _now_iso()
        return out

    # -- socket events ------------------------------------------------------
    def _setup_socket_events(self):
        @self.socketio.on("connect")
        def handle_connect():
            self.connected_clients.add(request.sid)
            log.info("Client connected: %s (total %d)", request.sid, len(self.connected_clients))
            emit("data_update", self._payload())

        @self.socketio.on("disconnect")
        def handle_disconnect():
            self.connected_clients.discard(request.sid)
            log.info("Client disconnected: %s", request.sid)

        @self.socketio.on("request_data")
        def handle_request_data():
            emit("data_update", self._payload())

        @self.socketio.on("command")
        def handle_command(data):
            """Operator action -> controller RPC. Returns the ack to the client."""
            cmd = (data or {}).get("cmd")
            value = (data or {}).get("value")
            if not cmd:
                return {"ok": False, "code": "INVALID", "message": "missing command"}
            if self.command_handler is None:
                return {"ok": False, "code": "NOT_READY", "message": "command bridge not ready"}
            try:
                log.info("Touchscreen command: %s=%r", cmd, value)
                return self.command_handler(cmd, value)
            except Exception as e:  # pragma: no cover - defensive
                log.error("Error handling command %s: %s", cmd, e)
                return {"ok": False, "code": "ERROR", "message": str(e)}

    # -- broadcast ----------------------------------------------------------
    def broadcast_update(self):
        if self.connected_clients:
            self.socketio.emit("data_update", self._payload())

    def update_data(self, payload: dict):
        try:
            if payload:
                self.data = payload
                self.broadcast_update()
        except Exception as e:
            log.error("Error updating dashboard data: %s", e)

    # -- lifecycle ----------------------------------------------------------
    def start(self):
        log.info("Starting SIA Dashboard on %s:%s", self.host, self.port)
        self._running = True
        self._update_thread = threading.Thread(target=self._background_updates, daemon=True)
        self._update_thread.start()
        self.socketio.run(
            self.app, host=self.host, port=self.port, debug=False, allow_unsafe_werkzeug=True
        )

    def _background_updates(self):
        while self._running:
            try:
                if self.connected_clients:
                    self.socketio.emit("heartbeat", {"timestamp": _now_iso()})
                time.sleep(1)
            except Exception as e:
                log.error("Error in background updates: %s", e)
                time.sleep(5)

    def stop(self):
        log.info("Stopping SIA Dashboard")
        self._running = False
        try:
            self.socketio.stop()
        except Exception as e:
            log.debug("socketio.stop() raised (expected outside server context): %s", e)
        if self._update_thread and self._update_thread.is_alive():
            self._update_thread.join(timeout=5)


class DashboardInterface:
    """Runs the dashboard in a daemon thread and exposes start/stop."""

    def __init__(self, dashboard: SiaDashboard):
        self.dashboard = dashboard
        self._server_thread: Optional[threading.Thread] = None

    def start_dashboard(self):
        if self._server_thread and self._server_thread.is_alive():
            log.warning("Dashboard is already running")
            return
        self._server_thread = threading.Thread(target=self._run, daemon=True)
        self._server_thread.start()
        log.info("Dashboard started in background thread")

    def _run(self):
        try:
            self.dashboard.start()
        except Exception as e:
            log.error("Dashboard startup failed: %s", e)

    def stop_dashboard(self):
        self.dashboard.stop()
        if self._server_thread and self._server_thread.is_alive():
            self._server_thread.join(timeout=5)
        log.info("Dashboard stopped")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
