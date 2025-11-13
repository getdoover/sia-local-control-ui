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
        self.loop_target_period = 0.5
        
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
            "target_rate": self.get_tag("TargetRate", self.config.pump_controllers.elements[0].value),
            "flow_rate": self.get_tag("FlowRate", self.config.pump_controllers.elements[0].value),
            "pump_state": self.get_tag("StateString", self.config.pump_controllers.elements[0].value)
        }
        
        # Get pump 2 control data from simulators
        if len(self.config.pump_controllers.elements) > 1:
            pump2_target_rate = self.get_tag("TargetRate", self.config.pump_controllers.elements[1].value)
            pump2_flow_rate = self.get_tag("FlowRate", self.config.pump_controllers.elements[1].value)
            pump2_pump_state = self.get_tag("StateString", self.config.pump_controllers.elements[1].value)

        
        # Update pump 2 data
        update_data["pump2"] = {
            "target_rate": pump2_target_rate,
            "flow_rate": pump2_flow_rate,
            "pump_state": pump2_pump_state
        }
        
        # Get and aggregate solar control data from all simulators
        battery_voltage = None
        battery_percentage = None
        panel_power = None
        battery_ah = None

        if self.config.solar_controllers:
            battery_voltages = []
            battery_percentages = []
            panel_power_values = []
            battery_ah_values = []
            
            # Collect data from all solar controllers
            for solar_controller in self.config.solar_controllers.elements:
                voltage = self.get_tag("b_voltage", solar_controller.value)
                if voltage is not None:
                    battery_voltages.append(voltage)
                percentage = self.get_tag("b_percent", solar_controller)
                if percentage is not None:
                    battery_percentages.append(percentage)
                panel_power = self.get_tag("panel_power", solar_controller.value)
                if panel_power is not None:
                    panel_power_values.append(panel_power)
                battery_ah = self.get_tag("remaining_ah", solar_controller.value)
                if battery_ah is not None:
                    battery_ah_values.append(battery_ah)
            
            # Aggregate data: average voltages/percentages, sum battery_ah
            if len(battery_voltages):
                battery_voltage = sum(battery_voltages) / len(battery_voltages)
            if len(battery_percentages):
                battery_percentage = sum(battery_percentages) / len(battery_percentages)

            if len(panel_power_values):
                panel_power = sum(panel_power_values) / len(panel_power_values)

            if len(battery_ah_values):
                battery_ah = sum(battery_ah_values) / len(battery_ah_values)

        solar_data = {}
        if battery_voltage is not None:
            solar_data["battery_voltage"] = battery_voltage
        if battery_percentage is not None:
            solar_data["battery_percentage"] = battery_percentage
        if panel_power is not None:
            solar_data["panel_power"] = panel_power
        if battery_ah is not None:
            solar_data["battery_ah"] = battery_ah

        if solar_data:
            update_data["solar"] = solar_data
        
        # Get tank control data from simulators
        tank_level_mm = None
        tank_level_percent = None
        if self.config.tank_level_app:
            tank_level_mm = self.get_tag("level_reading", self.config.tank_level_app.value)
            tank_level_percent = self.get_tag("level_filled_percentage", self.config.tank_level_app.value)

        tank_data = {}
        if tank_level_mm is not None:
            tank_data["tank_level_mm"] = tank_level_mm
        if tank_level_percent is not None:
            tank_data["tank_level_percent"] = tank_level_percent

        if tank_data:
            update_data["tank"] = tank_data

        
        skid_flow = None
        skid_pressure = None
        if self.config.flow_sensor_app:
            skid_flow = self.get_tag("value", self.config.flow_sensor_app.value)
        if self.config.pressure_sensor_app:
            skid_pressure = self.get_tag("value", self.config.pressure_sensor_app.value)

        skid_data = {}
        if skid_flow is not None:
            skid_data["skid_flow"] = skid_flow
        if skid_pressure is not None:
            skid_data["skid_pressure"] = skid_pressure

        if skid_data:
            update_data["skid"] = skid_data
        
        # pump_state
        # Update system status
        # system_status = "running" if self.state.state == "auto" else "standby"
        # self.dashboard_interface.update_system_status(system_status)
        
        
        self.dashboard.update_data(**update_data)
