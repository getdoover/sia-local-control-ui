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

        # Suppress platform interface INFO logs
        platform_logger = logging.getLogger("pydoover.docker.platform.platform")
        platform_logger.setLevel(logging.WARNING)

        self.started: float = time.time()
        
        # Initialize dashboard
        self.dashboard = SiaDashboard(host="0.0.0.0", port=8091, debug=False)
        self.dashboard_interface = DashboardInterface(self.dashboard)

    async def setup(self):
        self.loop_target_period = 0.5
        
        # Start dashboard
        self.dashboard_interface.start_dashboard()
        
        await self.setup_selector()
        
        await self.setup_valve_control()
        
        
        log.info("Dashboard started on port 8091")
    async def setup_valve_control(self):
        
        self.start_btn_pin = self._deployment_config[self.config.pump_controllers.elements[0].value]["local_control"][0]["start_button_pin"]
        self.stop_btn_pin = self._deployment_config[self.config.pump_controllers.elements[0].value]["local_control"][0]["stop_button_pin"]
        self.valve_control_pin = self._deployment_config[self.config.pump_controllers.elements[0].value]["calibration_output_pin"]
        
        self.start_btn_lstn = self.platform_iface.start_di_pulse_listener(
            self.start_btn_pin, 
            self.start_btn_callback,
            edge="rising"
        ) 
        
        self.stop_btn_lstn = self.platform_iface.start_di_pulse_listener(
            self.stop_btn_pin, 
            self.stop_btn_callback,
            edge="rising"
        )
        
        self.valve_control_state = await self.get_do(self.valve_control_pin)
        
    async def start_btn_callback(self, di, val, dt_secs, counter, edge):
        logging.info("Start button pressed")
        # open valve
        if self.selector_state == 3:
            p1_state = self.get_tag("AppState", self.config.pump_controllers.elements[0].value)
            p2_state = self.get_tag("AppState", self.config.pump_controllers.elements[1].value)
            if "calibration" not in [p1_state, p2_state]:
                logging.info("Opening valve")
                await self.set_do(self.valve_control_pin, 0)
            else:
                await self.dashboard_interface.valve_control_popup()

    async def stop_btn_callback(self, di, val, dt_secs, counter, edge):
        logging.info("Stop button pressed")
        # close valve
        if self.selector_state == 3:
            p1_state = self.get_tag("AppState", self.config.pump_controllers.elements[0].value)
            p2_state = self.get_tag("AppState", self.config.pump_controllers.elements[1].value)
            if "calibration" not in [p1_state, p2_state]:
                logging.info("Closing valve")
                await self.set_do(self.valve_control_pin, 1)
            else:
                await self.dashboard_interface.valve_control_popup()
        
    async def setup_selector(self):
        self._deployment_config = await self.device_agent.get_channel_aggregate_async("deployment_config")
        self._deployment_config = self._deployment_config["applications"]
        local_control = self._deployment_config[self.config.pump_controllers.elements[0].value]["local_control"]

        self.pump_1_selector = self._deployment_config[self.config.pump_controllers.elements[0].value]["local_control"][0]["pump_selector_pin"]
        self.pump_2_selector = self._deployment_config[self.config.pump_controllers.elements[1].value]["local_control"][0]["pump_selector_pin"]
        
        self.selector_state = None
        p1_sel = await self.get_ai(self.pump_1_selector)
        p2_sel = await self.get_ai(self.pump_2_selector)
        
        if p1_sel < 5 and p2_sel < 5:
            self.selector_state = 3
        elif p1_sel < 5 and p2_sel >= 5:
            self.selector_state = 2
        elif p1_sel >= 5 and p2_sel < 5:
            self.selector_state = 1
        else:
            self.selector_state = 0
        self.dashboard_interface.update_selector_state(self.selector_state)
        
        # self.p1_selector_hi_lstn = self.platform_iface.start_di_pulse_listener(
        #     self.pump_1_selector, 
        #     self.p_selector_hi_callback,
        #     edge="VI+10")
        
        # self.p2_selector_hi_lstn = self.platform_iface.start_di_pulse_listener(
        #     self.pump_2_selector, 
        #     self.p_selector_hi_callback,
        #     edge="VI+10"
        # )
        
        # self.p1_selector_lo_lstn = self.platform_iface.start_di_pulse_listener(
        #     self.pump_1_selector, 
        #     self.p_selector_lo_callback,
        #     edge="VI-10")
        
        # self.p2_selector_lo_lstn = self.platform_iface.start_di_pulse_listener(
        #     self.pump_2_selector, 
        #     self.p_selector_lo_callback,
        #     edge="VI-10"
        # )
        
    async def p_selector_hi_callback(self, di, val, dt_secs, counter, edge):
        if di == self.pump_1_selector:
            self.dashboard_interface.update_selector_state(1)
            self.selector_state = 1
        elif di == self.pump_2_selector:
            self.dashboard_interface.update_selector_state(2)
            self.selector_state  = 2
        log.info(f"Pump {self.selector_state} selector high")
        
    async def p_selector_lo_callback(self, di, val, dt_secs, counter, edge):
        selectors = [self.pump_1_selector, self.pump_2_selector]
        if di in [self.pump_1_selector, self.pump_2_selector]:
            selectors.remove(di)
            if await self.get_ai(selectors[0]) < 5:
                self.dashboard_interface.update_selector_state(3)
                log.info("Valve Selected")
                self.selector_state = 3
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
        
        p1_slt_state = self.get_tag(f"AI{self.pump_1_selector}", "platform")
        p2_slt_state = self.get_tag(f"AI{self.pump_2_selector}", "platform")
        
        if p1_slt_state <= 5 and p2_slt_state <= 5:
            self.selector_state = 3
        elif p1_slt_state < 5 and p2_slt_state >= 5:
            self.selector_state = 2
        elif p1_slt_state >= 5 and p2_slt_state < 5:
            self.selector_state = 1
        else:
            self.selector_state = 0
        # if self.pump_1_selector is not None and self.pump_2_selector is not None:
        update_data["selector"] = { "state": self.selector_state }
        
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
        
        valv_ctrl_state = await self.get_do(self.valve_control_pin)
        if valv_ctrl_state is not None:
            self.valve_control_state = valv_ctrl_state
        update_data["valve"] = { "state": self.valve_control_state }
        
        
        self.pump_1_state = self.get_tag("AppState", self.config.pump_controllers.elements[0].value)
        self.pump_2_state = self.get_tag("AppState", self.config.pump_controllers.elements[1].value)
        
        # Initialize faults dict if not already present
        if "faults" not in update_data:
            update_data["faults"] = {}
        
        # Set or clear low low tank level fault
        if "tank_level_low_low_level" in [self.pump_1_state, self.pump_2_state]:
            update_data["faults"]["ll_tank_level"] = True
        else:
            update_data["faults"]["ll_tank_level"] = False
        
        # Set or clear high high pressure fault
        if "pressure_high_high_level" in [self.pump_1_state, self.pump_2_state]:
            update_data["faults"]["hh_pressure"] = True
        else:
            update_data["faults"]["hh_pressure"] = False
            
        
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
                percentage = self.get_tag("b_percent", solar_controller.value)
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
            tank_data["tank_level_mm"] = tank_level_mm*1000
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
        
        # logging.info(f"Updating dashboard data...")
        self.dashboard.update_data(**update_data)
