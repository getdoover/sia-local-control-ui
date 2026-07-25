import asyncio
import logging
import time
from datetime import datetime
from functools import partial

from pydoover.docker import Application
from pydoover.rpc import RPCError
from pydoover.ui.manager import UI_CMDS_CHANNEL

from .app_config import SiaLocalControlUiConfig, resolve_pulse
from .app_tags import SiaLocalControlUiTags
from .app_ui import SiaLocalControlUiUI
from .dashboard import SiaDashboard, DashboardInterface

log = logging.getLogger(__name__)


# Logical operator buttons -> (rpc method, value). The Start button is special:
# when the pump is faulted it clears the fault instead of starting.
_BUTTON_COMMANDS = {
    "start": ("set_pump_state", "start"),
    "stop": ("set_pump_state", "stop"),
    "flow_up": ("nudge_rate", "+1"),
    "flow_down": ("nudge_rate", "-1"),
}


class SiaLocalControlUiApplication(Application):
    config: SiaLocalControlUiConfig
    config_cls = SiaLocalControlUiConfig
    tags_cls = SiaLocalControlUiTags
    ui_cls = SiaLocalControlUiUI

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------
    async def setup(self):
        self.started: float = time.time()
        # Buttons are event-driven, so the loop only paces the display refresh.
        self.loop_target_period = float(self.config.display_refresh_period.value or 0.5)

        # Reference to the running event loop so the Flask/SocketIO thread can
        # marshal operator commands back onto the async side.
        self._loop = asyncio.get_running_loop()

        # Dashboard (Flask + SocketIO) in its own daemon thread.
        self.dashboard = SiaDashboard(
            host="0.0.0.0",
            port=int(self.config.dashboard_port.value or 8091),
            secret_key=str(self.config.dashboard_secret_key.value or "sia_local_control_ui"),
            command_handler=self._run_command_sync,
        )
        self.dashboard_interface = DashboardInterface(self.dashboard)
        self.dashboard_interface.start_dashboard()

        # Physical operator pushbuttons -> event-driven platform pulse
        # listeners. DI buttons stream hardware IRQ pulses; AI buttons use the
        # platform's voltage-threshold ("VI+<volts>") events. No polling.
        self._pulse_counters = {}
        button_configs = {
            "start": self.config.start_button,
            "stop": self.config.stop_button,
            "flow_up": self.config.flow_up_button,
            "flow_down": self.config.flow_down_button,
        }
        for name, btn in button_configs.items():
            pin, edge = resolve_pulse(
                btn.source.value,
                btn.pin.value,
                btn.threshold_v.value,
                bool(btn.active_low.value),
            )
            if pin is None:
                continue
            if edge in ("rising", "falling"):
                # DI buttons: debounce is done in hardware -- push the config.
                try:
                    await self.platform_iface.set_di_config(
                        pin, debounce_ms=int(btn.debounce_ms.value or 0)
                    )
                except Exception as e:
                    log.debug("set_di_config(%s) failed: %s", pin, e)
            self._pulse_counters[name] = self.platform_iface.get_new_pulse_counter(
                pin, edge=edge, callback=partial(self._on_button_pulse, name)
            )
            log.info("Button %s -> pulse listener on pin %s (edge=%s)", name, pin, edge)

        # DO cache for the RUN / TRIP lamps -- write only on change.
        self._lamp_cache: dict[int, bool] = {}

        # Guard so a held button / slow controller can't stack RPC calls.
        self._cmd_in_flight = False

        # Latched state for the low-battery warning (see _battery_warnings).
        self._low_battery_active: dict[str, bool] = {}

        if self.config.primary_controller_key is None:
            log.warning(
                "No pump controllers configured -- the HMI will display nothing "
                "and operator commands have no target."
            )

        log.info("Dashboard started on port %s", self.config.dashboard_port.value)

    async def on_shutdown_at(self, dt: datetime) -> None:
        log.info("Shutdown scheduled at %s -- stopping dashboard server.", dt)
        try:
            self.dashboard_interface.stop_dashboard()
        except Exception as e:
            log.warning("Error stopping dashboard: %s", e)

    # ------------------------------------------------------------------
    # Command path (shared by physical buttons and the touchscreen)
    # ------------------------------------------------------------------
    async def _dispatch_command(self, cmd: str, value, app_key: str | None = None) -> dict:
        """Issue a single RPC to the controller. Never raises.

        Returns a normalised dict: ``{"ok": True, "result": {...}}`` or
        ``{"ok": False, "code": ..., "message": ...}``.
        """
        key = app_key or self.config.primary_controller_key
        if key is None:
            return {"ok": False, "code": "NO_CONTROLLER", "message": "no pump controller configured"}

        timeout = float(self.config.rpc_timeout.value or 20.0)
        try:
            result = await self.ui_manager.call(
                cmd, value, channel=UI_CMDS_CHANNEL, app_key=key, timeout=timeout
            )
            await self.tags.LastCommand.set(f"{cmd}={value}")
            return {"ok": True, "result": result or {}}
        except RPCError as e:
            log.info("RPC %s(%r) -> %s: %s", cmd, value, e.code, e.message)
            return {"ok": False, "code": e.code, "message": e.message}
        except Exception as e:
            log.warning("RPC %s(%r) failed: %s", cmd, value, e)
            return {"ok": False, "code": "ERROR", "message": str(e)}

    def _run_command_sync(self, cmd: str, value) -> dict:
        """Blocking entry point for the Flask/SocketIO thread.

        Marshals the coroutine onto the app's event loop and blocks the socket
        handler until the controller has physically acted (or errored), so the
        touchscreen can show a spinner then a success/error toast.
        """
        loop = getattr(self, "_loop", None)
        if loop is None or not loop.is_running():
            return {"ok": False, "code": "NOT_READY", "message": "controller link not ready"}
        try:
            fut = asyncio.run_coroutine_threadsafe(self._dispatch_command(cmd, value), loop)
            # A little headroom over the RPC timeout so the controller's own
            # timeout surfaces as a proper error rather than a bridge timeout.
            return fut.result(timeout=float(self.config.rpc_timeout.value or 20.0) + 10.0)
        except Exception as e:
            return {"ok": False, "code": "TIMEOUT", "message": str(e)}

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------
    async def main_loop(self):
        update = await self._collect_dashboard_data()
        self.dashboard.update_data(update)

    # ------------------------------------------------------------------
    # Physical buttons
    # ------------------------------------------------------------------
    async def _on_button_pulse(self, name, di, di_value, dt_secs, count, edge):
        """Pulse-listener callback: one platform pulse event == one press.

        The listener dispatches callbacks as tasks, so awaiting the RPC here
        doesn't block the pulse stream.
        """
        log.debug("Button %s pulse (pin=%s count=%s edge=%s)", name, di, count, edge)
        await self._handle_button(name)

    async def _handle_button(self, name: str):
        if self._cmd_in_flight:
            log.debug("Ignoring %s button -- a command is already in flight", name)
            return

        cmd, value = _BUTTON_COMMANDS[name]
        # Start doubles as fault-reset when the pump is tripped.
        if name == "start" and self._primary_fault():
            cmd, value = "reset_fault", None

        log.info("Operator button %s -> %s(%r)", name, cmd, value)
        self._cmd_in_flight = True
        try:
            await self._dispatch_command(cmd, value)
        finally:
            self._cmd_in_flight = False

    def _primary_fault(self) -> bool:
        key = self.config.primary_controller_key
        if key is None:
            return False
        return bool(self.get_tag(self.config.tag_fault.value, key))

    # ------------------------------------------------------------------
    # Status readouts + lamps
    # ------------------------------------------------------------------
    async def _collect_dashboard_data(self) -> dict:
        cfg = self.config
        pumps = []
        active_faults = []
        active_warnings = []

        for idx, key in enumerate(cfg.controller_keys):
            state = self.get_tag(cfg.tag_state.value, key)
            fault = bool(self.get_tag(cfg.tag_fault.value, key))
            reason = self.get_tag(cfg.tag_fault_reason.value, key)
            warning = bool(self.get_tag(cfg.tag_warning.value, key))
            warning_reason = self.get_tag(cfg.tag_warning_reason.value, key)
            pump = {
                "name": f"Pump {idx + 1}" if len(cfg.controller_keys) > 1 else "Pump",
                "target_rate": _num(self.get_tag(cfg.tag_target_rate.value, key)),
                "flow_rate": _num(self.get_tag(cfg.tag_flow_rate.value, key)),
                "total": _num(self.get_tag(cfg.tag_total.value, key)),
                # min/max may be absent until the controller publishes them --
                # keep them None (not 0) so the UI can hide the flow-range bar.
                "min_rate": _opt_num(self.get_tag(cfg.tag_min_rate.value, key)),
                "max_rate": _opt_num(self.get_tag(cfg.tag_max_rate.value, key)),
                "state": state if state is not None else "unknown",
                "running": bool(self.get_tag(cfg.tag_running.value, key)),
                "fault": fault,
                "fault_reason": reason,
                "warning": warning,
                "warning_reason": warning_reason,
            }
            pumps.append(pump)
            if fault:
                active_faults.append(
                    {"pump": pump["name"], "reason": reason or "Pump tripped"}
                )
            if warning:
                active_warnings.append(
                    {"pump": pump["name"], "reason": warning_reason or "Warning"}
                )

        # Solar is collected before the banner lists are frozen so a flat
        # battery raises a warning alongside any pump warnings.
        solar = self._collect_solar()
        if solar:
            active_warnings.extend(self._battery_warnings(solar))

        primary = pumps[0] if pumps else None
        link_ok = primary is not None and primary["state"] != "unknown"

        # Drive the operator lamps from the primary controller's status.
        await self._drive_lamp(cfg.run_lamp_pin.value, primary["running"] if primary else False)
        await self._drive_lamp(cfg.trip_lamp_pin.value, primary["fault"] if primary else False)

        # Mirror the primary status onto the HMI's own (cloud-visible) tags.
        if primary is not None:
            await self.tags.LinkOk.set(link_ok)
            await self.tags.ControllerState.set(primary["state"])
            await self.tags.TargetRate.set(primary["target_rate"])
            await self.tags.FlowRate.set(primary["flow_rate"])
            await self.tags.Fault.set(primary["fault"])
            await self.tags.FaultReason.set(primary["fault_reason"])
            await self.tags.Warning.set(primary["warning"])
            await self.tags.WarningReason.set(primary["warning_reason"])

        data = {
            "pumps": pumps,
            "faults": active_faults,
            "warnings": active_warnings,
            "link_ok": link_ok,
            "units": {
                "rate": cfg.rate_units.value or "L/Hr",
                "pressure": cfg.pressure_units.value or "psi",
            },
        }

        if solar is not None:
            data["solar"] = solar
        tank = self._collect_tank()
        if tank:
            data["tank"] = tank
        skid = self._collect_skid()
        if skid:
            data["skid"] = skid
        if cfg.selector_enabled:
            data["selector"] = {"state": await self._read_selector()}
        return data

    async def _drive_lamp(self, pin, value: bool):
        if pin is None:
            return
        pin = int(pin)
        value = bool(value)
        if self._lamp_cache.get(pin) == value:
            return
        try:
            await self.set_do(pin, value)
            self._lamp_cache[pin] = value
        except Exception as e:
            log.warning("Failed to drive lamp on DO%s -> %s: %s", pin, value, e)

    def _collect_solar(self) -> dict | None:
        cfg = self.config
        try:
            controllers = [el.value for el in cfg.solar_controllers.elements if el.value]
        except Exception:
            controllers = []
        if not controllers:
            return None

        voltages, percents, powers, ahs = [], [], [], []
        for key in controllers:
            v = self.get_tag("b_voltage", key)
            if v is not None:
                voltages.append(v)
            p = self.get_tag("b_percent", key)
            if p is not None:
                percents.append(p)
            pw = self.get_tag("panel_power", key)
            if pw is not None:
                powers.append(pw)
            ah = self.get_tag("remaining_ah", key)
            if ah is not None:
                ahs.append(ah)

        out = {}
        if voltages:
            out["battery_voltage"] = sum(voltages) / len(voltages)
        if percents:
            out["battery_percentage"] = sum(percents) / len(percents)
        if powers:
            out["panel_power"] = sum(powers) / len(powers)
        if ahs:
            out["battery_ah"] = sum(ahs)  # capacity sums across controllers
        # Show the Solar System card whenever solar controllers are configured,
        # even before any readings arrive (e.g. controller comms still down) --
        # unpublished fields render as "--" instead of the whole card vanishing.
        # (Returns None only when no solar controllers are configured at all,
        # handled by the early `if not controllers` return above.)
        return out

    def _battery_warnings(self, solar: dict) -> list[dict]:
        """Low-battery warnings for the aggregated solar figures.

        Latching with a clear margin, so a reading sitting right on the
        threshold doesn't flap the banner on and off every refresh. Each check
        is independent and disabled by setting its threshold to 0.
        """
        cfg = self.config
        state = getattr(self, "_low_battery_active", None)
        if state is None:
            state = self._low_battery_active = {}
        margin = _num(cfg.low_battery_clear_margin.value)

        checks = (
            ("percentage", solar.get("battery_percentage"),
             _num(cfg.low_battery_percentage.value), "%"),
            ("voltage", solar.get("battery_voltage"),
             _num(cfg.low_battery_voltage.value), "V"),
        )

        warnings = []
        for name, reading, threshold, unit in checks:
            if threshold <= 0 or reading is None:
                state[name] = False
                continue
            # Already warning -> require recovery past the margin to clear.
            trip_at = threshold + margin if state.get(name) else threshold
            active = float(reading) <= trip_at
            state[name] = active
            if active:
                warnings.append({
                    "pump": "Solar",
                    "reason": (
                        f"Battery low: {float(reading):.1f}{unit} "
                        f"(warn below {threshold:.1f}{unit})"
                    ),
                })
        return warnings

    def _collect_tank(self) -> dict | None:
        cfg = self.config
        if cfg.tank_level_app.value is None:
            return None
        out = {}
        mm = self.get_tag("level_reading", cfg.tank_level_app.value)
        if mm is not None:
            out["tank_level_mm"] = mm * 1000
        pct = self.get_tag("level_filled_percentage", cfg.tank_level_app.value)
        if pct is not None:
            out["tank_level_percent"] = pct
        return out or None

    def _collect_skid(self) -> dict | None:
        cfg = self.config
        out = {}
        if cfg.flow_sensor_app.value is not None:
            f = self.get_tag("value", cfg.flow_sensor_app.value)
            if f is not None:
                out["skid_flow"] = f
        if cfg.pressure_sensor_app.value is not None:
            p = self.get_tag("value", cfg.pressure_sensor_app.value)
            if p is not None:
                out["skid_pressure"] = p
        return out or None

    async def _read_selector(self) -> int:
        cfg = self.config
        thr = float(cfg.selector_threshold_v.value or 5.0)
        p1_pin = cfg.pump_1_selector_pin.value
        p2_pin = cfg.pump_2_selector_pin.value
        if p1_pin is None or p2_pin is None:
            return 0
        try:
            p1 = await self.fetch_ai(int(p1_pin))
            p2 = await self.fetch_ai(int(p2_pin))
        except Exception:
            return 0
        if p1 < thr and p2 < thr:
            return 3  # valve
        if p1 < thr and p2 >= thr:
            return 2
        if p1 >= thr and p2 < thr:
            return 1
        return 0


def _num(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _opt_num(value) -> float | None:
    """Like ``_num`` but preserves absence: returns None (not 0.0) when the tag
    is missing/unpublished, so the dashboard can hide the flow-range bar."""
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
