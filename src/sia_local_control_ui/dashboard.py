import asyncio
import json
import logging
import threading
import time
from datetime import datetime
from typing import Any, Dict

from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit
import socketio

log = logging.getLogger(__name__)


class DashboardData:
    """Container for dashboard data with validation and default values."""

    def __init__(self):
        # Pump Control Data
        self.target_rate: float = 0.0
        self.flow_rate: float = 0.0
        self.pump_state: str = "standby"

        # Pump 2 Control Data
        self.pump2_target_rate: float = 0.0
        self.pump2_flow_rate: float = 0.0
        self.pump2_pump_state: str = "standby"

        # Solar Control Data
        self.battery_voltage: float = 0.0
        self.battery_percentage: float = 0.0
        self.panel_power: float = 0.0
        self.battery_ah: float = 0.0

        # Tank Control Data
        self.tank_level_mm: float = 0.0
        self.tank_level_percent: float = 0.0

        # Skid Control Data
        self.skid_flow: float = 0.0
        self.skid_pressure: float = 0.0

        # System Data
        self.timestamp: datetime = datetime.now()
        self.system_status: str = "running"

        # Fault Data
        self.faults = {
            "hh_pressure": False,
            "ll_tank_level": False,
        }

    @staticmethod
    def _to_bool(value: Any, default: bool = False) -> bool:
        """Convert a value to boolean with fallback."""
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value != 0
        if isinstance(value, str):
            return value.strip().lower() in {"true", "1", "yes", "on"}
        return default

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "pump": {
                "target_rate": self.target_rate,
                "flow_rate": self.flow_rate,
                "pump_state": self.pump_state,
            },
            "pump2": {
                "target_rate": self.pump2_target_rate,
                "flow_rate": self.pump2_flow_rate,
                "pump_state": self.pump2_pump_state,
            },
            "solar": {
                "battery_voltage": self.battery_voltage,
                "battery_percentage": self.battery_percentage,
                "panel_power": self.panel_power,
                "battery_ah": self.battery_ah,
            },
            "tank": {
                "tank_level_mm": self.tank_level_mm,
                "tank_level_percent": self.tank_level_percent,
            },
            "skid": {
                "skid_flow": self.skid_flow,
                "skid_pressure": self.skid_pressure,
            },
            "system": {
                "timestamp": self.timestamp.isoformat(),
                "status": self.system_status,
            },
            "faults": {
                "hh_pressure": self.faults["hh_pressure"],
                "ll_tank_level": self.faults["ll_tank_level"],
            },
        }

    def update_from_dict(self, data: Dict[str, Any]):
        print(f"Updating dashboard data: {data}")
        """Update from dictionary with validation."""
        if "pump" in data:
            pump = data["pump"]
            self.target_rate = float(pump.get("target_rate", self.target_rate))
            self.flow_rate = float(pump.get("flow_rate", self.flow_rate))
            self.pump_state = str(pump.get("pump_state", self.pump_state))

        if "pump2" in data:
            pump2 = data["pump2"]
            self.pump2_target_rate = float(pump2.get("target_rate", self.pump2_target_rate))
            self.pump2_flow_rate = float(pump2.get("flow_rate", self.pump2_flow_rate))
            self.pump2_pump_state = str(pump2.get("pump_state", self.pump2_pump_state))

        if "solar" in data:
            solar = data["solar"]
            self.battery_voltage = float(solar.get("battery_voltage", self.battery_voltage))
            self.battery_percentage = float(solar.get("battery_percentage", self.battery_percentage))
            self.panel_power = float(solar.get("panel_power", self.panel_power))
            self.battery_ah = float(solar.get("battery_ah", self.battery_ah))

        if "tank" in data:
            tank = data["tank"]
            self.tank_level_mm = float(tank.get("tank_level_mm", self.tank_level_mm))
            self.tank_level_percent = float(tank.get("tank_level_percent", self.tank_level_percent))

        if "skid" in data:
            skid = data["skid"]
            self.skid_flow = float(skid.get("skid_flow", self.skid_flow))
            self.skid_pressure = float(skid.get("skid_pressure", self.skid_pressure))

        if "system" in data:
            system = data["system"]
            self.system_status = str(system.get("status", self.system_status))

        if "faults" in data and isinstance(data["faults"], dict):
            faults = data["faults"]
            if "hh_pressure" in faults:
                self.faults["hh_pressure"] = self._to_bool(faults["hh_pressure"], self.faults["hh_pressure"])
            if "ll_tank_level" in faults:
                self.faults["ll_tank_level"] = self._to_bool(faults["ll_tank_level"], self.faults["ll_tank_level"])

        self.timestamp = datetime.now()


class SiaDashboard:
    """Flask dashboard with WebSocket support for SIA Local Control UI."""
    
    def __init__(self, host: str = "0.0.0.0", port: int = 8091, debug: bool = False):
        self.host = host
        self.port = port
        self.debug = debug
        
        # Create Flask app
        self.app = Flask(__name__, 
                        template_folder='templates',
                        static_folder='static')
        self.app.config['SECRET_KEY'] = 'sia_dashboard_secret_key'
        
        # Create SocketIO instance
        self.socketio = SocketIO(self.app, cors_allowed_origins="*")
        
        # Dashboard data container
        self.data = DashboardData()
        
        # Connection tracking
        self.connected_clients = set()
        
        # Setup routes and event handlers
        self._setup_routes()
        self._setup_socket_events()
        
        # Background thread for data updates
        self._update_thread = None
        self._running = False
    
    def _setup_routes(self):
        """Setup Flask routes."""
        
        @self.app.route('/')
        def index():
            return render_template('dashboard.html')
        
        @self.app.route('/api/data')
        def get_data():
            """REST API endpoint to get current data."""
            return self.data.to_dict()
        
        @self.app.route('/api/health')
        def health():
            """Health check endpoint."""
            return {"status": "healthy", "timestamp": datetime.now().isoformat()}
    
    def _setup_socket_events(self):
        """Setup WebSocket event handlers."""
        
        @self.socketio.on('connect')
        def handle_connect():
            """Handle client connection."""
            self.connected_clients.add(request.sid)
            log.info(f"Client connected: {request.sid}")
            log.info(f"Total connected clients: {len(self.connected_clients)}")
            
            # Send current data to newly connected client
            emit('data_update', self.data.to_dict())
        
        @self.socketio.on('disconnect')
        def handle_disconnect():
            """Handle client disconnection."""
            self.connected_clients.discard(request.sid)
            log.info(f"Client disconnected: {request.sid}")
            log.info(f"Total connected clients: {len(self.connected_clients)}")
        
        @self.socketio.on('request_data')
        def handle_data_request():
            """Handle explicit data request from client."""
            emit('data_update', self.data.to_dict())
        
        @self.socketio.on('set_pump_state')
        def handle_pump_state_change(data):
            """Handle pump state change from client."""
            try:
                if 'state' in data:
                    self.data.pump_state = str(data['state'])
                    self.data.timestamp = datetime.now()
                    log.info(f"Pump state changed to: {self.data.pump_state}")
                    
                    # Broadcast update to all clients
                    self.broadcast_update()
            except Exception as e:
                log.error(f"Error handling pump state change: {e}")
                emit('error', {'message': str(e)})
    
    def broadcast_update(self):
        """Broadcast data update to all connected clients."""
        if self.connected_clients:
            self.socketio.emit('data_update', self.data.to_dict())
    
    def update_data(self, **kwargs):
        """Update dashboard data and broadcast to clients."""
        try:
            # Update data container
            if kwargs:
                self.data.update_from_dict(kwargs)
                self.broadcast_update()
                log.debug(f"Dashboard data updated: {kwargs}")
        except Exception as e:
            log.error(f"Error updating dashboard data: {e}")
    
    def start(self):
        """Start the dashboard server."""
        log.info(f"Starting SIA Dashboard on {self.host}:{self.port}")
        self._running = True
        
        # Start background update thread
        self._update_thread = threading.Thread(target=self._background_updates, daemon=True)
        self._update_thread.start()
        
        # Start Flask-SocketIO server (disable debug mode for threading compatibility)
        self.socketio.run(self.app, host=self.host, port=self.port, debug=False, allow_unsafe_werkzeug=True)
    
    def _background_updates(self):
        """Background thread for periodic updates and health monitoring."""
        while self._running:
            try:
                # Update system timestamp
                self.data.timestamp = datetime.now()
                
                # Send periodic heartbeat to clients
                if self.connected_clients:
                    self.socketio.emit('heartbeat', {'timestamp': self.data.timestamp.isoformat()})
                
                time.sleep(1)  # Update every second
            except Exception as e:
                log.error(f"Error in background updates: {e}")
                time.sleep(5)
    
    def stop(self):
        """Stop the dashboard server."""
        log.info("Stopping SIA Dashboard")
        self._running = False
        if self._update_thread and self._update_thread.is_alive():
            self._update_thread.join(timeout=5)


class DashboardInterface:
    """Interface class to integrate dashboard with Application class."""
    
    def __init__(self, dashboard: SiaDashboard):
        self.dashboard = dashboard
        self._server_thread = None
    
    def start_dashboard(self):
        """Start dashboard in a separate thread."""
        if self._server_thread and self._server_thread.is_alive():
            log.warning("Dashboard is already running")
            return
        
        self._server_thread = threading.Thread(target=self._dashboard_thread_start, daemon=True)
        self._server_thread.start()
        log.info("Dashboard started in background thread")
    
    def _dashboard_thread_start(self):
        """Thread-safe dashboard startup."""
        try:
            self.dashboard.start()
        except Exception as e:
            log.error(f"Dashboard startup failed: {e}")
            # Dashboard will fall back gracefully
    
    def stop_dashboard(self):
        """Stop the dashboard."""
        self.dashboard.stop()
        if self._server_thread and self._server_thread.is_alive():
            self._server_thread.join(timeout=5)
        log.info("Dashboard stopped")
    def update_system_status(self, status: str):
        """Update system status."""
        self.dashboard.update_data(system={'status': status})
