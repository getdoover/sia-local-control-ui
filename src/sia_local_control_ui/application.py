import logging
import time

from pydoover.docker import Application
from pydoover import ui

from .app_config import SiaLocalControlUiConfig
from .dashboard import SiaDashboard, DashboardInterface

log = logging.getLogger()

class SiaLocalControlUiApplication(Application):
    config: SiaLocalControlUiConfig  # not necessary, but helps your IDE provide autocomplete!

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.started: float = time.time()
        
        # Initialize dashboard
        self.dashboard = SiaDashboard(host="0.0.0.0", port=8091, debug=False)
        self.dashboard_interface = DashboardInterface(self.dashboard)

    async def setup(self):
        self.loop_target_period = 0.2
        
        # Start dashboard
        self.dashboard_interface.start_dashboard()
        log.info("Dashboard started on port 8091")

    async def main_loop(self):
        
        # self.get_tag("flow_rate", self.config.flow_sensor_app.value)
        # self.get_tag("pressure", self.config.pressure_sensor_app.value)
        # self.get_tag("tank_level", self.config.tank_level_app.value)
        # a random value we set inside our simulator. Go check it out in simulators/sample!
        # Update dashboard with example data
        await self.update_dashboard_data()
    
    async def update_dashboard_data(self):
        """Update dashboard with data from various sources."""
        update_data = {}
            # Get pump control data from simulators
        update_data["pump"] = {
            "target_rate": self.get_tag("TargetRate", self.config.pump_controllers.elements[0]) if self.config.pump_controllers else 15.5,
            "flow_rate": self.get_tag("FlowRate", self.config.pump_controllers.elements[0]) if self.config.pump_controllers else 14.2,
            "pump_state": self.get_tag("StateString", self.config.pump_controllers.elements[0]) if self.config.pump_controllers else "auto"
        }
        
        # Get pump 2 control data from simulators
        if len(self.config.pump_controllers.elements) > 1:
            pump2_target_rate = self.get_tag("TargetRate", self.config.pump_controllers.elements[1])
            pump2_flow_rate = self.get_tag("FlowRate", self.config.pump_controllers.elements[1])
            pump2_pump_state = self.get_tag("StateString", self.config.pump_controllers.elements[1])

        
        # Update pump 2 data
        update_data["pump2"] = {
            "target_rate": pump2_target_rate,
            "flow_rate": pump2_flow_rate,
            "pump_state": pump2_pump_state
        }
        
        # Get and aggregate solar control data from all simulators
        if self.config.solar_controllers:
            battery_voltages = []
            battery_percentages = []
            panel_power_values = []
            battery_ah_values = []
            
            # Collect data from all solar controllers
            for solar_controller in self.config.solar_controllers.elements:
                battery_voltages.append(self.get_tag("b_voltage", solar_controller))
                battery_percentages.append(self.get_tag("b_percent", solar_controller))
                panel_power_values.append(self.get_tag("panel_power", solar_controller))
                battery_ah_values.append(self.get_tag("remaining_ah", solar_controller))
            
            # Aggregate data: average voltages/percentages, sum battery_ah
            battery_voltage = sum(battery_voltages) / len(battery_voltages)
            battery_percentage = sum(battery_percentages) / len(battery_percentages)
            panel_power = sum(panel_power_values) / len(panel_power_values)
            battery_ah = sum(battery_ah_values)
        else:
            # Fallback values if no solar controllers configured
            battery_voltage = 24.5
            battery_percentage = 78.0
            panel_power = 150.0
            battery_ah = 120.0
        
        # Update solar data
        update_data["solar"] = {
            "battery_voltage": battery_voltage,
            "battery_percentage": battery_percentage,
            "panel_power": panel_power,
            "battery_ah": battery_ah
        }
        
        # Get tank control data from simulators
        tank_level_mm = self.get_tag("tank_level_mm", self.config.tank_level_app.value) if self.config.tank_apps else 1250.0
        tank_level_percent = self.get_tag("tank_level_percent", self.config.tank_level_app.value) if self.config.tank_apps else 62.5
        
        # Update tank data
        update_data["tank"] = {
            "tank_level_mm": tank_level_mm,
            "tank_level_percent": tank_level_percent
        }

        
        skid_flow = self.get_tag("value", self.config.flow_sensor_app.value) if self.config.skid_apps else "-"
        skid_pressure = self.get_tag("value", self.config.pressure_sensor_app.value) if self.config.skid_apps else "-"
        
        #Update Skid Data
        update_data["skid"] = {
            "skid_flow": skid_flow,
            "skid_pressure": skid_pressure
        }
        
        # pump_state
        # Update system status
        system_status = "running" if self.state.state == "auto" else "standby"
        self.dashboard_interface.update_system_status(system_status)
        
        
        self.dashboard.update_data(update_data)
