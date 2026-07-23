import logging
import time
from functools import partial

from pydoover.docker import Application
from pydoover.rpc import RPCError
from pydoover.ui.manager import UI_CMDS_CHANNEL

from .app_config import SiaLocalControlUiConfig, resolve_pulse
from .app_tags import SiaLocalControlUiTags
from .app_ui import SiaLocalControlUiUI

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
        # Buttons are event-driven, so the loop only refreshes lamps and the
        # selector tag consumed by the channel-native widget.
        self.loop_target_period = float(self.config.display_refresh_period.value or 0.5)

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

        if self.config.primary_controller_key is None:
            log.warning(
                "No pump controllers configured -- the HMI will display nothing "
                "and operator commands have no target."
            )

        log.info("Physical operator-panel adapter ready")

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

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------
    async def main_loop(self):
        # The widget reads controller/sensor tags directly from `tag_values`.
        # This loop only maintains physical outputs, backwards-compatible
        # mirror tags, and the selector value which originates as local AI.
        await self._refresh_hardware_state()

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
    # Hardware outputs + compatibility tags
    # ------------------------------------------------------------------
    async def _refresh_hardware_state(self) -> None:
        """Refresh state that genuinely requires the device-local process.

        Controller and sensor display data is intentionally not assembled
        here: the widget consumes those app blocks directly from
        ``tag_values``. This method only drives local DOs, maintains the
        historical mirror tags, and publishes the physical selector input.
        """
        cfg = self.config
        key = cfg.primary_controller_key
        if key is None:
            state = "unknown"
            target_rate = flow_rate = 0.0
            running = fault = warning = False
            fault_reason = warning_reason = None
        else:
            state = self.get_tag(cfg.tag_state.value, key) or "unknown"
            target_rate = _num(self.get_tag(cfg.tag_target_rate.value, key))
            flow_rate = _num(self.get_tag(cfg.tag_flow_rate.value, key))
            running = bool(self.get_tag(cfg.tag_running.value, key))
            fault = bool(self.get_tag(cfg.tag_fault.value, key))
            fault_reason = self.get_tag(cfg.tag_fault_reason.value, key)
            warning = bool(self.get_tag(cfg.tag_warning.value, key))
            warning_reason = self.get_tag(cfg.tag_warning_reason.value, key)

        link_ok = key is not None and state != "unknown"
        await self._drive_lamp(cfg.run_lamp_pin.value, running)
        await self._drive_lamp(cfg.trip_lamp_pin.value, fault)

        await self.tags.LinkOk.set(link_ok)
        await self.tags.ControllerState.set(state)
        await self.tags.TargetRate.set(target_rate)
        await self.tags.FlowRate.set(flow_rate)
        await self.tags.Fault.set(fault)
        await self.tags.FaultReason.set(fault_reason)
        await self.tags.Warning.set(warning)
        await self.tags.WarningReason.set(warning_reason)

        if cfg.selector_enabled:
            selector_state = await self._read_selector()
            await self.tags.SelectorState.set(selector_state)

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
