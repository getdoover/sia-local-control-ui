"""Tests for the hardware-only local process and physical command path."""

import types

from pydoover.rpc import RPCError
from sia_local_control_ui.application import SiaLocalControlUiApplication as App


def _val(value):
    return types.SimpleNamespace(value=value)


class _AsyncTag:
    def __init__(self):
        self.value = None

    async def set(self, value):
        self.value = value


def _fake_tags():
    return types.SimpleNamespace(
        LinkOk=_AsyncTag(),
        ControllerState=_AsyncTag(),
        TargetRate=_AsyncTag(),
        FlowRate=_AsyncTag(),
        Fault=_AsyncTag(),
        FaultReason=_AsyncTag(),
        Warning=_AsyncTag(),
        WarningReason=_AsyncTag(),
        SelectorState=_AsyncTag(),
        LastCommand=_AsyncTag(),
    )


def _hardware_stub(tag_values, controller_key="ctrl_1", selector=False):
    stub = types.SimpleNamespace()
    stub.config = types.SimpleNamespace(
        primary_controller_key=controller_key,
        tag_state=_val("StateString"),
        tag_target_rate=_val("TargetRate"),
        tag_flow_rate=_val("FlowRate"),
        tag_running=_val("Running"),
        tag_fault=_val("Fault"),
        tag_fault_reason=_val("FaultReason"),
        tag_warning=_val("Warning"),
        tag_warning_reason=_val("WarningReason"),
        run_lamp_pin=_val(3),
        trip_lamp_pin=_val(4),
        selector_enabled=selector,
    )
    stub.tags = _fake_tags()
    stub._lamp_cache = {}
    stub.do_writes = []
    stub.get_tag = lambda name, key=None, default=None: tag_values.get((key, name), default)

    async def set_do(pin, value):
        stub.do_writes.append((int(pin), bool(value)))

    async def read_selector():
        return 3

    stub.set_do = set_do
    stub._read_selector = read_selector
    stub._drive_lamp = App._drive_lamp.__get__(stub)
    stub._refresh_hardware_state = App._refresh_hardware_state.__get__(stub)
    return stub


async def test_refreshes_lamps_and_compatibility_tags():
    key = "ctrl_1"
    stub = _hardware_stub({
        (key, "StateString"): "pumping",
        (key, "TargetRate"): 12.5,
        (key, "FlowRate"): 11.9,
        (key, "Running"): True,
        (key, "Fault"): False,
        (key, "Warning"): True,
        (key, "WarningReason"): "No flow feedback",
    })

    await stub._refresh_hardware_state()

    assert stub.do_writes == [(3, True), (4, False)]
    assert stub.tags.LinkOk.value is True
    assert stub.tags.ControllerState.value == "pumping"
    assert stub.tags.TargetRate.value == 12.5
    assert stub.tags.Warning.value is True
    assert stub.tags.WarningReason.value == "No flow feedback"


async def test_lamp_cache_writes_only_on_change():
    key = "ctrl_1"
    stub = _hardware_stub({
        (key, "StateString"): "pumping",
        (key, "Running"): True,
        (key, "Fault"): False,
    })
    await stub._refresh_hardware_state()
    await stub._refresh_hardware_state()
    assert stub.do_writes == [(3, True), (4, False)]


async def test_no_controller_turns_lamps_off_and_clears_link():
    stub = _hardware_stub({}, controller_key=None)
    await stub._refresh_hardware_state()
    assert stub.do_writes == [(3, False), (4, False)]
    assert stub.tags.LinkOk.value is False
    assert stub.tags.ControllerState.value == "unknown"


async def test_selector_is_published_to_tag_values():
    stub = _hardware_stub({}, controller_key=None, selector=True)
    await stub._refresh_hardware_state()
    assert stub.tags.SelectorState.value == 3


def _cmd_stub(call_impl):
    stub = types.SimpleNamespace()
    stub.config = types.SimpleNamespace(primary_controller_key="ctrl_1", rpc_timeout=_val(5.0))
    stub.ui_manager = types.SimpleNamespace(call=call_impl)
    stub.tags = _fake_tags()
    stub._dispatch_command = App._dispatch_command.__get__(stub)
    return stub


async def test_dispatch_success():
    async def ok(method, value, channel=None, app_key=None, timeout=None):
        assert (method, value, channel, app_key, timeout) == (
            "set_pump_state", "start", "ui_cmds", "ctrl_1", 5.0,
        )
        return {"state": "pumping"}

    stub = _cmd_stub(ok)
    result = await stub._dispatch_command("set_pump_state", "start")
    assert result == {"ok": True, "result": {"state": "pumping"}}
    assert stub.tags.LastCommand.value == "set_pump_state=start"


async def test_dispatch_rpc_error_is_normalised():
    async def fail(*args, **kwargs):
        raise RPCError("FAULTED", "pump tripped")

    result = await _cmd_stub(fail)._dispatch_command("set_pump_state", "start")
    assert result == {"ok": False, "code": "FAULTED", "message": "pump tripped"}


async def test_dispatch_without_controller_is_rejected():
    async def never(*args, **kwargs):
        raise AssertionError("must not dispatch")

    stub = _cmd_stub(never)
    stub.config.primary_controller_key = None
    result = await stub._dispatch_command("set_pump_state", "start")
    assert result["code"] == "NO_CONTROLLER"
