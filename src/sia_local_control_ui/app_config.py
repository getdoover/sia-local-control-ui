import enum

from pathlib import Path

from pydoover import config


class ButtonSource(enum.Enum):
    """Where a physical pushbutton is wired."""

    disabled = "Disabled"
    di = "DI"
    ai = "AI"


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


class SiaLocalControlUiConfig(config.Schema):
    """Config for the local HMI touchscreen app.

    The HMI owns the operator surface (physical pushbuttons + RUN/TRIP lamps)
    and turns operator actions into Doover 2.0 RPC calls against the injection
    controller. Everything the HMI needs -- the controller app key, button pin
    mappings, lamp pins, display units, the Flask port/secret -- lives HERE, in
    the HMI's own config. It no longer reads the controller's deployment_config.
    """

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
    # J5246 wiring: start=DI1, stop=DI2, flow_up=DI3, flow_down=AI1@9V.
    start_button = ButtonConfig(
        "Start Button",
        description="Physical Start pushbutton. J5246: DI1.",
    )
    stop_button = ButtonConfig(
        "Stop Button",
        description="Physical Stop pushbutton. J5246: DI2.",
    )
    flow_up_button = ButtonConfig(
        "Flow Up Button",
        description="Physical Flow Up pushbutton. J5246: DI3.",
    )
    flow_down_button = ButtonConfig(
        "Flow Down Button",
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
    tank_level_app = config.Application(
        "Tank Level App", default=None,
        description="(Optional) tank level app for the tank card.",
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

    # --- Dashboard server ---------------------------------------------------
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
