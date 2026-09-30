import enum

from pathlib import Path

from pydoover import config


class ButtonSource(enum.Enum):
    """Where a physical pushbutton is wired."""

    disabled = "Disabled"
    di = "DI"
    ai = "AI"


class HmiControlMode(enum.Enum):
    """What the touchscreen lets the operator do.

    Governs ON-SCREEN controls only. The physical pushbuttons and the RUN /
    TRIP lamps work exactly as configured in every mode.
    """

    read_only = "Read Only"
    touch = "Touch"
    # Reserved for a future on-screen mode (placeholder). Behaves exactly like
    # Read Only until it is implemented; see README "HMI Control Mode".
    button = "Button"


# Tank Level readings the widget can show (widget/src/lib/assembleDashboardData.ts
# TANK_READINGS, pinned by tests/test_widget_contract.py).
TANK_READINGS = ("mm", "m", "L", "%")
TANK_NONE = "None"

# VSD commissioning panel access (widget/src/lib/vsdPanel.ts
# VSD_COMMISSIONING_OPTIONS, pinned by tests/test_widget_contract.py). The
# first is the default: no gear.
VSD_COMMISSIONING = ("Hidden", "Local only", "Local and cloud")

# Alarm settings gears on the widget's Tank / Skid / Pump Control tiles: the
# same options (widget/src/lib/alarmSettings.ts). Hidden first = the default:
# no gears.
ALARM_SETTINGS_ACCESS = VSD_COMMISSIONING

# The Sensor tab on the Tank / Skid pressure gears' popovers: a gate of its
# own with the same options (widget/src/lib/sensorSettings.ts). Hidden first
# = the default: no Sensor tab.
SENSOR_SETTINGS_ACCESS = VSD_COMMISSIONING


class ButtonConfig(config.Object):
    """Nested config describing where one operator pushbutton is wired.

    Buttons are event-driven via the platform pulse listener
    (``platform_iface.get_new_pulse_counter``): DI buttons stream hardware IRQ
    pulses, AI buttons use the platform's voltage-threshold ("VI") events.
    ``pin`` is a DI or AI pin number depending on ``source``.
    """

    source = config.Enum(
        "Source",
        choices=ButtonSource,
        default=ButtonSource.di,
        description="Where this button is wired: Disabled, a digital input (DI), or an analog input (AI) thresholded to press events.",
    )
    pin = config.Integer(
        "Pin",
        default=0,
        minimum=0,
        description="DI or AI pin number, per Source.",
    )
    threshold_v = config.Number(
        "Threshold Voltage",
        default=9.0,
        minimum=0.0,
        description="For AI buttons: voltage the input must cross to register a press (matches the existing >9V idiom).",
    )
    active_low = config.Boolean(
        "Active Low",
        default=False,
        description="Register the press on the falling edge (DI) / downward threshold crossing (AI) instead of rising.",
    )
    debounce_ms = config.Integer(
        "Debounce (ms)",
        default=50,
        minimum=0,
        description="Hardware debounce pushed to the DI pin config (not used for AI buttons).",
    )


def normalise_source(value) -> tuple[ButtonSource, int | None]:
    """Normalise a raw config source value to ``(member, forced_pin)``.

    config.Enum hands back a member OR a raw string depending on whether a
    deployment config was injected. Legacy configs also used "AI0"/"AI1"
    sources with the pin field unused -- map those to AI with the pin forced.
    """
    if isinstance(value, ButtonSource):
        return value, None
    if value is None:
        return ButtonSource.disabled, None
    text = str(value)
    if text.upper() in ("AI0", "AI1"):
        return ButtonSource.ai, int(text[-1])
    try:
        return ButtonSource(text), None
    except ValueError:
        # tolerate the sanitised member name too (e.g. "ai")
        try:
            return ButtonSource[text.lower()], None
        except KeyError:
            return ButtonSource.disabled, None


def normalise_hmi_mode(value) -> HmiControlMode:
    """Member from a config value (member, display text or member name)."""
    if isinstance(value, HmiControlMode):
        return value
    text = str(value).strip().lower()
    for member in HmiControlMode:
        if text in (member.value.lower(), member.name):
            return member
    return HmiControlMode.read_only


def resolve_pulse(
    source, pin, threshold_v=9.0, active_low=False
) -> tuple[int, str] | tuple[None, None]:
    """Resolve raw button settings to a ``(pin, edge)`` pair for
    ``platform_iface.get_new_pulse_counter``.

    DI edges are "rising"/"falling"; AI buttons use the platform's voltage
    threshold events with edge "VI+<volts>" / "VI-<volts>". Returns
    ``(None, None)`` when the button is disabled or has no pin.
    """
    src, forced_pin = normalise_source(source)
    if forced_pin is not None:
        pin = forced_pin
    if src is ButtonSource.disabled or pin is None:
        return None, None
    pin = int(pin)
    if src is ButtonSource.di:
        return pin, "falling" if active_low else "rising"
    threshold = float(threshold_v) if threshold_v is not None else 9.0
    return pin, f"VI{'-' if active_low else '+'}{threshold}"


# Config for a physical button that was never saved (its fields are hidden in
# the editor outside Button mode): load it as not fitted. A saved button always
# loads its saved values.
_BUTTON_ABSENT = {"source": ButtonSource.disabled.value}

# Editor-only visibility: these fields appear only when HMI Control Mode is
# "Button". Keys, defaults and runtime behaviour are unchanged.
BUTTON_MODE_FIELDS = (
    "start_button",
    "stop_button",
    "flow_up_button",
    "flow_down_button",
)


class SiaLocalControlUiConfig(config.Schema):
    """Config for the local HMI touchscreen app.

    The HMI owns the operator surface (physical pushbuttons + RUN/TRIP lamps)
    and turns operator actions into Doover 2.0 RPC calls against the injection
    controller. Everything the HMI needs -- the controller app key, button pin
    mappings, lamp pins, display units, the Flask port/secret -- lives HERE, in
    the HMI's own config. It no longer reads the controller's deployment_config.
    """

    # --- On-screen control (first in the editor) ----------------------------
    # Only "Button" reveals the physical-button fields in the config editor
    # (see to_schema). That is editor visibility only: the physical buttons
    # and lamps always run from whatever is configured, in every mode.
    hmi_control_mode = config.Enum(
        "HMI Control Mode",
        choices=HmiControlMode,
        default=HmiControlMode.read_only,
        description=(
            "On-screen controls. Read Only: display only (the physical buttons "
            "still work). Touch: on-screen Start/Stop, rate, resets and "
            "calibration factor. Button: reserved, currently the same as Read "
            "Only. Physical pushbuttons and lamps are never affected."
        ),
    )

    # --- Pump controllers (1..N; single pump is the J5246 default) ----------
    # The FIRST controller is the "primary": physical buttons and the on-screen
    # Start/Stop/rate controls issue RPCs against it. Additional controllers are
    # rendered as extra read-only status cards.
    pump_controllers = config.Array(
        "Pump Controllers",
        element=config.Application(
            "Pump Controller",
            description="A sia_injection_controller application instance.",
        ),
        description="Pump controller apps to display and control. The first is the primary (button/RPC target).",
    )

    # --- Controller status tag names (contract defaults; overridable) -------
    tag_state = config.String(
        "State Tag", default="StateString",
        description="Controller tag holding the machine state string.",
    )
    tag_target_rate = config.String(
        "Target Rate Tag", default="TargetRate",
        description="Controller tag holding the commanded dose rate.",
    )
    tag_flow_rate = config.String(
        "Flow Rate Tag", default="FlowRate",
        description="Controller tag holding the measured flow rate.",
    )
    tag_total = config.String(
        "Total Tag", default="Total",
        description="Controller tag holding the total delivered volume.",
    )
    tag_min_rate = config.String(
        "Min Rate Tag", default="MinRate",
        description="Controller tag holding the pump's minimum deliverable rate (for the flow-range bar).",
    )
    tag_max_rate = config.String(
        "Max Rate Tag", default="MaxRate",
        description="Controller tag holding the pump's maximum deliverable rate (for the flow-range bar).",
    )
    tag_running = config.String(
        "Running Tag", default="Running",
        description="Controller boolean tag: pump output energised.",
    )
    tag_fault = config.String(
        "Fault Tag", default="Fault",
        description="Controller boolean tag: trip active.",
    )
    tag_fault_reason = config.String(
        "Fault Reason Tag", default="FaultReason",
        description="Controller string tag: human-readable trip cause.",
    )
    tag_warning = config.String(
        "Warning Tag", default="Warning",
        description="Controller boolean tag: warning active (non-trip; pump keeps running).",
    )
    tag_warning_reason = config.String(
        "Warning Reason Tag", default="WarningReason",
        description="Controller string tag: human-readable warning cause.",
    )

    # --- Physical operator pushbuttons (event-driven pulse listeners) --------
    # Shown in the config editor only when HMI Control Mode is "Button", but
    # ALWAYS active at runtime from their saved values (Kuwait skids keep their
    # DI1/DI2/DI3/AI wiring in Read Only). A button with no saved config at all
    # loads as Disabled instead of failing the whole config load.
    # J5246 wiring: start=DI1, stop=DI2, flow_up=DI3, flow_down=AI1@9V.
    start_button = ButtonConfig(
        "Start Button",
        default=_BUTTON_ABSENT,
        description="Physical Start pushbutton. J5246: DI1.",
    )
    stop_button = ButtonConfig(
        "Stop Button",
        default=_BUTTON_ABSENT,
        description="Physical Stop pushbutton. J5246: DI2.",
    )
    flow_up_button = ButtonConfig(
        "Flow Up Button",
        default=_BUTTON_ABSENT,
        description="Physical Flow Up pushbutton. J5246: DI3.",
    )
    flow_down_button = ButtonConfig(
        "Flow Down Button",
        default=_BUTTON_ABSENT,
        description="Physical Flow Down pushbutton. J5246: AI1 thresholded at 9V.",
    )

    # --- Operator indicator lamps (driven from controller status tags) ------
    run_lamp_pin = config.Integer(
        "Run Lamp Pin", default=3, minimum=0,
        description="Digital output for the green RUN lamp (J5246 DO3). Unset to disable.",
    )
    trip_lamp_pin = config.Integer(
        "Trip Lamp Pin", default=4, minimum=0,
        description="Digital output for the red TRIP lamp (J5246 DO4). Unset to disable.",
    )

    # --- Optional pump/valve selector (legacy two-pump skids; default off) --
    enable_selector = config.Boolean(
        "Enable Pump/Valve Selector", default=False,
        description="Legacy two-pump selector switch. Off for single-pump J5246 skids.",
    )
    selector_threshold_v = config.Number(
        "Selector Threshold Voltage", default=5.0, minimum=0.0,
        description="AI voltage above which a selector position reads active.",
    )
    pump_1_selector_pin = config.Integer(
        "Pump 1 Selector AI Pin", default=None, minimum=0,
        description="Analog input pin for the pump 1 selector (only used when the selector is enabled).",
    )
    pump_2_selector_pin = config.Integer(
        "Pump 2 Selector AI Pin", default=None, minimum=0,
        description="Analog input pin for the pump 2 selector (only used when the selector is enabled).",
    )
    enable_valve = config.Boolean(
        "Enable Valve Card", default=False,
        description="Show the valve status card (legacy skids with a calibration valve). Off for J5246.",
    )

    # --- Optional peripheral status apps ------------------------------------
    solar_controllers = config.Array(
        "Solar Controllers",
        element=config.Application(
            "Solar Controller",
            description="A morningstar_prostar_app instance.",
        ),
        description="Solar controller apps whose battery/panel figures are aggregated on the dashboard.",
    )
    low_battery_percentage = config.Number(
        "Low Battery Warning (%)", default=30.0, minimum=0.0, maximum=100.0,
        description="Aggregated battery charge at or below which the dashboard shows a low-battery warning. 0 disables the check.",
    )
    low_battery_voltage = config.Number(
        "Low Battery Warning (V)", default=0.0, minimum=0.0,
        description="Aggregated battery voltage at or below which the low-battery warning shows. 0 disables the check (use the percentage instead).",
    )
    low_battery_clear_margin = config.Number(
        "Low Battery Clear Margin", default=5.0, minimum=0.0,
        description="Hysteresis: once warning, the reading must recover this far above the threshold before the banner clears (percentage points / volts).",
    )
    tank_level_app = config.Application(
        "Tank Level App", default=None,
        description="(Optional) tank level app for the tank card.",
    )
    # Widget only (the legacy dashboard is frozen and always shows mm). Each
    # option reads a tag the analog level sensor app publishes: mm / m from
    # level_reading (metres), L from level_volume (computed by the tank app
    # from its Volume Curve or Max Volume, in its Volume Units), % from
    # level_filled_percentage. No gallons: the tank app publishes none.
    tank_primary_reading = config.Enum(
        "Tank Primary Reading",
        choices=list(TANK_READINGS),
        default="mm",
        description=(
            "Large Tank Level reading on the HMI widget: mm or m (level), L "
            "(the tank app's published volume; needs its Volume Curve or Max "
            "Volume set, in litres) or % (filled)."
        ),
    )
    tank_secondary_reading = config.Enum(
        "Tank Secondary Reading",
        choices=[TANK_NONE, *TANK_READINGS],
        default=TANK_NONE,
        description=(
            "Smaller reading shown below the primary on the HMI widget. None "
            "(or a reading the tank app has not published) shows nothing."
        ),
    )
    flow_sensor_app = config.Application(
        "Flow Sensor App", default=None,
        description="(Optional) skid flow sensor app.",
    )
    pressure_sensor_app = config.Application(
        "Pressure Sensor App", default=None,
        description="(Optional) skid pressure sensor app.",
    )

    # --- Display units ------------------------------------------------------
    rate_units = config.String(
        "Rate Units", default="L/Hr",
        description="Units label shown against target/flow rate figures.",
    )
    pressure_units = config.String(
        "Pressure Units", default="psi",
        description="Units label shown against the skid pressure figure.",
    )

    # --- Kiosk display (widget, local panel only) ----------------------------
    # A cover plate over the panel's edges hides the outer few millimetres of
    # the screen. The local (kiosk) layout pads the whole HMI inward by
    # Kiosk Inset, and keeps every popover a further Popover Inset from that.
    # CSS millimetres are not physical on these panels, so the widget converts
    # with Kiosk px per mm. The cloud UI ignores all three. 0 = no inset, so
    # existing installs are unchanged.
    kiosk_inset_mm = config.Number(
        "Kiosk Inset (mm)", default=0.0, minimum=0.0, maximum=30.0,
        description=(
            "Gap on all four sides of the local panel's HMI (header, banners, "
            "tiles and the touch bar all move inward), for a cover plate over "
            "the screen edges. Try 2 for the J5261 plate. 0 = none."
        ),
    )
    popover_inset_mm = config.Number(
        "Popover Inset (mm)", default=0.0, minimum=0.0, maximum=40.0,
        description=(
            "Minimum gap between a popover (VSD commissioning, calibration "
            "wizard, keypad, confirmation) and the screen edge, on top of the "
            "Kiosk Inset. Local panel only. 0 = the normal small margin."
        ),
    )
    kiosk_px_per_mm = config.Number(
        "Kiosk px per mm", default=5.8, minimum=1.0, maximum=20.0,
        description=(
            "Screen pixels per millimetre on the local panel, to turn the insets "
            "into pixels. Default: the J5261 Xenarc 892 (177.6 mm active width "
            "shown at 1024 px = 5.8 px/mm)."
        ),
    )

    # --- Legacy local dashboard (Flask/SocketIO on 8091) ---------------------
    # FROZEN: kept only so existing kiosks (Kuwait, doover-kiosk -> :8091)
    # redeploy unchanged. The screen is the widget (widget/); new features go
    # there only. Off: no web server runs; buttons and lamps still work.
    local_dashboard_enabled = config.Boolean(
        "Local Dashboard Enabled",
        default=True,
        description=(
            "Serve the legacy local touchscreen dashboard on the Dashboard Port "
            "(8091). Leave on for kiosks pointed at :8091. Turn off when the "
            "panel shows this app's widget through the HMI Display Engine: no "
            "web server runs, and the physical buttons and lamps still work."
        ),
    )
    dashboard_port = config.Integer(
        "Dashboard Port", default=8091, minimum=1, maximum=65535,
        description="TCP port the Flask/SocketIO touchscreen server listens on.",
    )
    dashboard_secret_key = config.String(
        "Dashboard Secret Key", default="sia_local_control_ui",
        description="Flask session secret key.",
    )
    display_refresh_period = config.Number(
        "Display Refresh Period (s)", default=0.5, minimum=0.1,
        description="How often the dashboard/status readouts refresh. Buttons are event-driven and unaffected.",
    )
    rpc_timeout = config.Number(
        "RPC Timeout (s)", default=20.0, minimum=1.0,
        description="How long an operator command waits for the controller to physically act.",
    )

    # --- VSD commissioning panel (widget only) --------------------------------
    # The gear on the widget's VSD tile opens live drive diagnostics and the
    # Techtop motor controller's drive parameters. Calls go straight to that
    # app's RPC channel (dv-rpc). Hidden by default, so existing configs show
    # no gear. Reset VSD Fault in the panel still goes through the pump
    # controller (reset_vsd_fault), exactly like the VSD tile's button.
    vsd_motor_app = config.Application(
        "VSD Motor App", default=None,
        description=(
            "(Optional) the Techtop motor controller app driving this pump's VSD, "
            "e.g. techtop_motor_controller_1. The HMI widget's VSD commissioning "
            "panel talks to it; unset hides the panel."
        ),
    )
    vsd_commissioning = config.Enum(
        "VSD Commissioning",
        choices=list(VSD_COMMISSIONING),
        default=VSD_COMMISSIONING[0],
        description=(
            "VSD commissioning panel on the HMI widget (gear on the VSD tile). "
            "Hidden: no gear. Local only: diagnostics everywhere the gear shows, "
            "drive parameter changes only from the local panel. Local and cloud: "
            "parameter changes from the local panel and the cloud UI."
        ),
    )

    # --- Alarm settings (widget only) -----------------------------------------
    # Gears on the Tank, Skid (discharge pressure) and, with a controller flow
    # meter, Pump Control tiles open the pump controller's alarm settings:
    # tank L / LL, pressure H / HH and flow L / LL, each with its own alarm
    # delay, read back from its Setpoint* / Delay* tags and written to its
    # "Alarm Settings" elements over ui_cmds. Hidden by default, so existing
    # configs show no gears. Governed by this setting, not HMI Control Mode.
    alarm_settings_access = config.Enum(
        "Alarm Settings Access",
        choices=list(ALARM_SETTINGS_ACCESS),
        default=ALARM_SETTINGS_ACCESS[0],
        description=(
            "Alarm settings gears on the HMI widget's Tank, Skid pressure and "
            "(with a controller flow meter) Pump Control tiles: tank L / LL, "
            "discharge pressure H / HH and flow L / LL, each with its alarm "
            "delay. "
            "Hidden: no gears. Local only: values shown everywhere, changes "
            "only from the local panel. Local and cloud: changes from the "
            "local panel and the cloud UI."
        ),
    )

    # --- Sensor settings (widget only) ----------------------------------------
    # A Sensor tab beside Alarms in the Tank and Skid pressure gears' popovers:
    # the sensor apps' live loop current and reading, and their operator
    # calibration (pressure range low / high and offset; tank zero / span and
    # fluid density), written to the SENSOR app over ui_cmds and read back
    # from its tags. The sensor app must have its own "Operator Sensor
    # Calibration" on, or the values are locked. Hidden by default, so
    # existing configs are unchanged. Governed by this setting, not HMI
    # Control Mode or Alarm Settings Access.
    sensor_settings_access = config.Enum(
        "Sensor Settings Access",
        choices=list(SENSOR_SETTINGS_ACCESS),
        default=SENSOR_SETTINGS_ACCESS[0],
        description=(
            "Sensor tab in the HMI widget's Tank and Skid pressure settings: "
            "the sensor's live mA and reading, and its operator calibration "
            "(pressure range and offset; tank zero, span and fluid density), "
            "sent to the sensor app, which needs Operator Sensor Calibration "
            "on. Hidden: no Sensor tab. Local only: values shown everywhere, "
            "changes only from the local panel. Local and cloud: changes from "
            "the local panel and the cloud UI."
        ),
    )

    @classmethod
    def to_schema(cls):
        """pydoover's schema, with the physical-button fields made conditional.

        The Doover config editor (doover-admin, rjsf) resolves JSON-schema
        ``allOf`` / ``if`` / ``then`` branches against the form data and
        renders ``then`` fields only while the condition holds; its field
        list, ordering and save filter also read the branch properties, so a
        hidden field keeps its saved value. This is the same shape as its own
        tests (doover-admin 6c2a3c7, "Support conditional config schema
        fields"). ``required`` in the ``if`` keeps an unset mode (the Read
        Only default) from matching vacuously.
        """
        schema = super().to_schema()
        properties = schema["properties"]
        branch = {name: properties.pop(name) for name in BUTTON_MODE_FIELDS}
        schema["required"] = [r for r in schema["required"] if r not in branch]
        schema["allOf"] = [
            {
                "if": {
                    "properties": {
                        "hmi_control_mode": {"const": HmiControlMode.button.value}
                    },
                    "required": ["hmi_control_mode"],
                },
                "then": {"properties": branch},
            }
        ]
        return schema

    # ------------------------------------------------------------------
    # Derived helpers
    # ------------------------------------------------------------------
    @property
    def controller_keys(self) -> list[str]:
        """App keys of all configured pump controllers (order preserved)."""
        keys = []
        try:
            for el in self.pump_controllers.elements:
                if el.value is not None:
                    keys.append(el.value)
        except Exception:
            pass
        return keys

    @property
    def primary_controller_key(self) -> str | None:
        """The controller that physical buttons / on-screen controls drive."""
        keys = self.controller_keys
        return keys[0] if keys else None

    @property
    def touch_enabled(self) -> bool:
        """On-screen controls are on (HMI Control Mode = Touch).

        ``Button`` is reserved and deliberately falls through to read-only.
        """
        try:
            value = self.hmi_control_mode.value
        except AttributeError:
            return False
        return normalise_hmi_mode(value) is HmiControlMode.touch

    @property
    def dashboard_enabled(self) -> bool:
        """Legacy Flask dashboard on (the default, so old configs keep it)."""
        try:
            value = self.local_dashboard_enabled.value
        except AttributeError:
            return True
        return True if value is None else bool(value)

    @property
    def lamp_pins(self) -> list[int]:
        """Configured RUN / TRIP lamp outputs (an unset pin is no lamp)."""
        pins = []
        for elem in (self.run_lamp_pin, self.trip_lamp_pin):
            try:
                if elem.value is not None:
                    pins.append(int(elem.value))
            except (AttributeError, TypeError, ValueError):
                pass
        return pins

    @property
    def selector_enabled(self) -> bool:
        try:
            return bool(self.enable_selector.value)
        except Exception:
            return False

    @property
    def valve_enabled(self) -> bool:
        try:
            return bool(self.enable_valve.value)
        except Exception:
            return False


def export():
    SiaLocalControlUiConfig.export(
        Path(__file__).parents[2] / "doover_config.json", "sia_local_control_ui"
    )


if __name__ == "__main__":
    export()
