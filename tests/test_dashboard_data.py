"""Unit tests for the HMI's status data path and the RPC command bridge.

These use the "StubApp" pattern (borrowing unbound Application methods onto a
lightweight stub) so no device agent / platform interface is needed. They cover
the single-pump data collection (the deployment J5246 actually runs), lamp
caching, and the command dispatch translation to a normalised ack/error dict.
"""

import types

from pydoover.rpc import RPCError
from sia_local_control_ui.application import SiaLocalControlUiApplication as App


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _val(v):
    return types.SimpleNamespace(value=v)


class _AsyncTag:
    def __init__(self):
        self.value = None

    async def set(self, v):
        self.value = v


def _fake_tags():
    return types.SimpleNamespace(
        LinkOk=_AsyncTag(),
        ControllerState=_AsyncTag(),
        TargetRate=_AsyncTag(),
        FlowRate=_AsyncTag(),
        Fault=_AsyncTag(),
        FaultReason=_AsyncTag(),
        LastCommand=_AsyncTag(),
    )


def _fake_config(controller_keys):
    return types.SimpleNamespace(
        controller_keys=controller_keys,
        tag_state=_val("StateString"),
        tag_target_rate=_val("TargetRate"),
        tag_flow_rate=_val("FlowRate"),
        tag_running=_val("Running"),
        tag_fault=_val("Fault"),
        tag_fault_reason=_val("FaultReason"),
        run_lamp_pin=_val(3),
        trip_lamp_pin=_val(4),
        rate_units=_val("L/Hr"),
        pressure_units=_val("psi"),
        selector_enabled=False,
        valve_enabled=False,
        solar_controllers=types.SimpleNamespace(elements=[]),
        tank_level_app=_val(None),
        flow_sensor_app=_val(None),
        pressure_sensor_app=_val(None),
    )


def _make_stub(controller_keys, tag_values):
    stub = types.SimpleNamespace()
    stub.config = _fake_config(controller_keys)
    stub.tags = _fake_tags()
    stub._lamp_cache = {}
    stub.do_writes = []

    def get_tag(name, key=None, default=None):
        return tag_values.get((key, name), default)

    async def set_do(pin, value):
        stub.do_writes.append((int(pin), bool(value)))

    stub.get_tag = get_tag
    stub.set_do = set_do

    # borrow the real (unbound) methods
    for meth in (
        "_collect_dashboard_data",
        "_drive_lamp",
        "_collect_solar",
        "_collect_tank",
        "_collect_skid",
    ):
        setattr(stub, meth, getattr(App, meth).__get__(stub))
    return stub


# ---------------------------------------------------------------------------
# single-pump data path
# ---------------------------------------------------------------------------


async def test_single_pump_running_no_crash():
    key = "ctrl_1"
    tags = {
        (key, "StateString"): "pumping",
        (key, "TargetRate"): 12.5,
        (key, "FlowRate"): 11.9,
        (key, "Running"): True,
        (key, "Fault"): False,
        (key, "FaultReason"): None,
    }
    stub = _make_stub([key], tags)

    data = await stub._collect_dashboard_data()

    assert len(data["pumps"]) == 1
    pump = data["pumps"][0]
    assert pump["name"] == "Pump"  # single pump -> no numeric suffix
    assert pump["running"] is True
    assert pump["target_rate"] == 12.5
    assert data["link_ok"] is True
    assert data["faults"] == []
    # RUN lamp (DO3) driven true, TRIP lamp (DO4) driven false
    assert (3, True) in stub.do_writes
    assert (4, False) in stub.do_writes
    # mirrored tags
    assert stub.tags.ControllerState.value == "pumping"
    assert stub.tags.LinkOk.value is True


async def test_single_pump_fault_surfaces_reason_and_trip_lamp():
    key = "ctrl_1"
    tags = {
        (key, "StateString"): "fault",
        (key, "TargetRate"): 0.0,
        (key, "FlowRate"): 0.0,
        (key, "Running"): False,
        (key, "Fault"): True,
        (key, "FaultReason"): "Tank level low-low",
    }
    stub = _make_stub([key], tags)

    data = await stub._collect_dashboard_data()

    assert len(data["faults"]) == 1
    assert data["faults"][0]["reason"] == "Tank level low-low"
    assert (4, True) in stub.do_writes  # TRIP lamp lit
    assert stub.tags.FaultReason.value == "Tank level low-low"


async def test_no_controllers_does_not_crash():
    stub = _make_stub([], {})
    data = await stub._collect_dashboard_data()
    assert data["pumps"] == []
    assert data["link_ok"] is False


async def test_lamp_cache_writes_only_on_change():
    key = "ctrl_1"
    tags = {
        (key, "StateString"): "pumping",
        (key, "Running"): True,
        (key, "Fault"): False,
    }
    stub = _make_stub([key], tags)
    await stub._collect_dashboard_data()
    first = list(stub.do_writes)
    await stub._collect_dashboard_data()  # nothing changed
    assert stub.do_writes == first  # no extra writes second pass


# ---------------------------------------------------------------------------
# command dispatch translation
# ---------------------------------------------------------------------------


def _cmd_stub(call_impl):
    stub = types.SimpleNamespace()
    stub.config = types.SimpleNamespace(
        primary_controller_key="ctrl_1",
        rpc_timeout=_val(5.0),
    )
    stub.ui_manager = types.SimpleNamespace(call=call_impl)
    stub.tags = _fake_tags()
    stub._dispatch_command = App._dispatch_command.__get__(stub)
    return stub


async def test_dispatch_success():
    async def ok(method, value, channel=None, app_key=None, timeout=None):
        return {"state": "pumping"}

    stub = _cmd_stub(ok)
    res = await stub._dispatch_command("set_pump_state", "start")
    assert res["ok"] is True
    assert res["result"] == {"state": "pumping"}
    assert stub.tags.LastCommand.value == "set_pump_state=start"


async def test_dispatch_rpc_error():
    async def boom(method, value, channel=None, app_key=None, timeout=None):
        raise RPCError("FAULTED", "pump tripped")

    stub = _cmd_stub(boom)
    res = await stub._dispatch_command("set_pump_state", "start")
    assert res["ok"] is False
    assert res["code"] == "FAULTED"
    assert "tripped" in res["message"]


async def test_dispatch_no_controller():
    async def never(*a, **k):  # pragma: no cover
        raise AssertionError("should not be called")

    stub = _cmd_stub(never)
    stub.config.primary_controller_key = None
    res = await stub._dispatch_command("set_pump_state", "start")
    assert res["ok"] is False
    assert res["code"] == "NO_CONTROLLER"


def test_run_command_sync_not_ready():
    stub = types.SimpleNamespace(_loop=None)
    stub._run_command_sync = App._run_command_sync.__get__(stub)
    res = stub._run_command_sync("set_pump_state", "start")
    assert res["ok"] is False
    assert res["code"] == "NOT_READY"
