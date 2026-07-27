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
        Warning=_AsyncTag(),
        WarningReason=_AsyncTag(),
        LastCommand=_AsyncTag(),
    )


def _fake_config(controller_keys):
    return types.SimpleNamespace(
        controller_keys=controller_keys,
        tag_state=_val("StateString"),
        tag_target_rate=_val("TargetRate"),
        tag_flow_rate=_val("FlowRate"),
        tag_total=_val("Total"),
        tag_min_rate=_val("MinRate"),
        tag_max_rate=_val("MaxRate"),
        tag_running=_val("Running"),
        tag_fault=_val("Fault"),
        tag_fault_reason=_val("FaultReason"),
        tag_warning=_val("Warning"),
        tag_warning_reason=_val("WarningReason"),
        run_lamp_pin=_val(3),
        trip_lamp_pin=_val(4),
        rate_units=_val("L/Hr"),
        pressure_units=_val("psi"),
        selector_enabled=False,
        valve_enabled=False,
        solar_controllers=types.SimpleNamespace(elements=[]),
        low_battery_percentage=_val(30.0),
        low_battery_voltage=_val(0.0),
        low_battery_clear_margin=_val(5.0),
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
        "_battery_warnings",
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
        (key, "Total"): 345.6,
        (key, "MinRate"): 2.0,
        (key, "MaxRate"): 92.16,
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
    # total delivered volume + flow-range bounds flow through
    assert pump["total"] == 345.6
    assert pump["min_rate"] == 2.0
    assert pump["max_rate"] == 92.16
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


async def test_single_pump_warning_surfaces_without_trip():
    key = "ctrl_1"
    tags = {
        (key, "StateString"): "pumping",
        (key, "TargetRate"): 2.5,
        (key, "FlowRate"): 0.0,
        (key, "Running"): True,
        (key, "Fault"): False,
        (key, "FaultReason"): None,
        (key, "Warning"): True,
        (key, "WarningReason"): "No flow feedback — pump may not be turning",
    }
    stub = _make_stub([key], tags)

    data = await stub._collect_dashboard_data()

    # warning surfaces on its own banner list, NOT as a fault
    assert data["faults"] == []
    assert len(data["warnings"]) == 1
    assert data["warnings"][0]["reason"] == "No flow feedback — pump may not be turning"
    # pump keeps running: RUN lamp on, TRIP lamp off
    assert (3, True) in stub.do_writes
    assert (4, False) in stub.do_writes
    assert stub.tags.Warning.value is True
    assert stub.tags.WarningReason.value == "No flow feedback — pump may not be turning"


async def test_flow_range_bounds_none_when_unpublished():
    # Controller hasn't published min/max yet -> they must pass through as None
    # (NOT 0) so the dashboard can hide the flow-range bar. Total defaults to 0.
    key = "ctrl_1"
    tags = {
        (key, "StateString"): "pumping",
        (key, "TargetRate"): 5.0,
        (key, "FlowRate"): 4.8,
        (key, "Running"): True,
        (key, "Fault"): False,
    }
    stub = _make_stub([key], tags)

    data = await stub._collect_dashboard_data()

    pump = data["pumps"][0]
    assert pump["min_rate"] is None
    assert pump["max_rate"] is None
    assert pump["total"] == 0.0


async def test_missing_target_rate_remains_unset_until_controller_publishes():
    key = "ctrl_1"
    tags = {
        (key, "StateString"): "standby",
        (key, "MinRate"): 3.456,
        (key, "MaxRate"): 17.28,
        (key, "Running"): False,
        (key, "Fault"): False,
    }
    stub = _make_stub([key], tags)

    data = await stub._collect_dashboard_data()

    assert data["pumps"][0]["target_rate"] is None
    assert stub.tags.TargetRate.value is None


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
# low-battery warning
# ---------------------------------------------------------------------------


def _solar_stub(percent=None, voltage=None, **thresholds):
    """Stub with one solar controller publishing the given battery figures."""
    key = "ctrl_1"
    solar_key = "solar_1"
    tags = {
        (key, "StateString"): "pumping",
        (key, "Running"): True,
        (key, "Fault"): False,
    }
    if percent is not None:
        tags[(solar_key, "b_percent")] = percent
    if voltage is not None:
        tags[(solar_key, "b_voltage")] = voltage

    stub = _make_stub([key], tags)
    stub.config.solar_controllers = types.SimpleNamespace(elements=[_val(solar_key)])
    for name, value in thresholds.items():
        setattr(stub.config, name, _val(value))
    return stub


def _battery_warnings(data):
    return [w for w in data["warnings"] if w["pump"] == "Solar"]


async def test_low_battery_percentage_raises_warning():
    stub = _solar_stub(percent=18.0)
    data = await stub._collect_dashboard_data()

    warnings = _battery_warnings(data)
    assert len(warnings) == 1
    assert "18.0%" in warnings[0]["reason"]
    # not a fault -- the pump keeps running
    assert data["faults"] == []
    assert data["solar"]["battery_percentage"] == 18.0


async def test_healthy_battery_no_warning():
    stub = _solar_stub(percent=85.0)
    data = await stub._collect_dashboard_data()
    assert _battery_warnings(data) == []


async def test_low_battery_latches_until_clear_margin_passed():
    # threshold 30%, margin 5 -> once warning, must recover above 35% to clear
    stub = _solar_stub(percent=29.0)
    assert len(_battery_warnings(await stub._collect_dashboard_data())) == 1

    # recovered past the threshold but still inside the margin -> still warning
    stub.get_tag = lambda name, key=None, default=None: {
        ("solar_1", "b_percent"): 32.0,
        ("ctrl_1", "StateString"): "pumping",
        ("ctrl_1", "Running"): True,
        ("ctrl_1", "Fault"): False,
    }.get((key, name), default)
    assert len(_battery_warnings(await stub._collect_dashboard_data())) == 1

    # clear of the margin -> banner clears
    stub.get_tag = lambda name, key=None, default=None: {
        ("solar_1", "b_percent"): 40.0,
        ("ctrl_1", "StateString"): "pumping",
        ("ctrl_1", "Running"): True,
        ("ctrl_1", "Fault"): False,
    }.get((key, name), default)
    assert _battery_warnings(await stub._collect_dashboard_data()) == []


async def test_low_battery_voltage_check_off_by_default():
    # 22.1 V would be low for a 24 V bank, but the voltage threshold is 0
    stub = _solar_stub(percent=90.0, voltage=22.1)
    assert _battery_warnings(await stub._collect_dashboard_data()) == []


async def test_low_battery_voltage_check_when_configured():
    stub = _solar_stub(percent=90.0, voltage=22.1, low_battery_voltage=23.5)
    warnings = _battery_warnings(await stub._collect_dashboard_data())
    assert len(warnings) == 1
    assert "22.1V" in warnings[0]["reason"]


async def test_no_solar_controllers_no_battery_warning():
    stub = _make_stub(["ctrl_1"], {("ctrl_1", "StateString"): "idle"})
    data = await stub._collect_dashboard_data()
    assert _battery_warnings(data) == []
    assert "solar" not in data


async def test_battery_warning_disabled_by_zero_threshold():
    stub = _solar_stub(percent=2.0, low_battery_percentage=0.0)
    assert _battery_warnings(await stub._collect_dashboard_data()) == []


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
    async def ok(method, value, channel=None, app_key=None, timeout=None, **kwargs):
        return {"state": "pumping"}

    stub = _cmd_stub(ok)
    res = await stub._dispatch_command("set_pump_state", "start")
    assert res["ok"] is True
    assert res["result"] == {"state": "pumping"}
    assert stub.tags.LastCommand.value == "set_pump_state=start"


async def test_dispatch_rpc_error():
    async def boom(method, value, channel=None, app_key=None, timeout=None, **kwargs):
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
