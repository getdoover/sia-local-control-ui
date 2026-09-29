"""Feature detection for the newer injection-controller features.

The HMI must look and behave exactly as before against a controller without
the Modbus Rev 0.4 tags / RPCs, or with them switched off in config, and only
grow the control-mode switch, VSD card and drive line when the controller
actually publishes them. See the controller's CONTRACT.md.
"""

import types

from pydoover.rpc import RPCError
from pydoover.ui.manager import UI_CMDS_CHANNEL

from sia_local_control_ui.application import SiaLocalControlUiApplication as App

from .test_dashboard_data import _fake_tags, _make_stub, _val

KEY = "ctrl_1"

# What an existing (pre-Rev 0.4) controller publishes.
LEGACY_TAGS = {
    (KEY, "StateString"): "pumping",
    (KEY, "TargetRate"): 12.5,
    (KEY, "FlowRate"): 11.9,
    (KEY, "Total"): 345.6,
    (KEY, "MinRate"): 2.0,
    (KEY, "MaxRate"): 92.16,
    (KEY, "Running"): True,
    (KEY, "Fault"): False,
    (KEY, "FaultReason"): None,
    (KEY, "Warning"): False,
    (KEY, "WarningReason"): None,
    (KEY, "TripPressureHH"): False,
    (KEY, "TripTankLL"): False,
    (KEY, "WarnNoFlow"): False,
    (KEY, "TripCode"): 0,
    (KEY, "WarningCode"): 0,
}

# What a new controller publishes with every new feature off (the defaults).
FEATURES_OFF_TAGS = {
    **LEGACY_TAGS,
    **{
        (KEY, name): value
        for name, value in {
            "TripVsd": False,
            "TripVsdComms": False,
            "TripVsdNoStart": False,
            "TripVsdStoppedExt": False,
            "TripOther": False,
            "WarnStrokeFeedbackLost": False,
            "WarnTrimLimit": False,
            "WarnVsdOverload": False,
            "WarnVsdNotReady": False,
            "WarnVsdNoModbusControl": False,
            "WarnDcsLinkLost": False,
            "WarnPressureStale": False,
            "WarnTankStale": False,
            "WarnOther": False,
            "VsdTripCode": 0,
            "VsdTripDescription": None,
            "MotorOutputHz": None,
            # the existing pulse input is the stroke sensor, so this is live
            "PumpRpm": 57.0,
            "FlowIsEstimate": True,
            "StrokeTrim": 0.0,
            "PumpAvailable": True,
            "CommsHealthy": True,
            "ControlMode": "cloud",
            "ControlModeInt": 2,
            "SetpointPressureH": 0.0,
            "SetpointPressureHH": 0.0,
            "PressureUnits": "psi",
            "ControlAuthorityActive": False,
            "VsdConfigured": False,
        }.items()
    },
}

LEGACY_PUMP_KEYS = {
    "name",
    "target_rate",
    "flow_rate",
    "total",
    "min_rate",
    "max_rate",
    "state",
    "running",
    "fault",
    "fault_reason",
    "warning",
    "warning_reason",
}
LEGACY_DATA_KEYS = {"pumps", "faults", "warnings", "link_ok", "units"}


def _stub(tags):
    return _make_stub([KEY], dict(tags))


def _pre_flag(tags):
    """The same tags from a Rev 0.4 controller that predates the explicit
    ControlAuthorityActive / VsdConfigured tags (heuristic detection)."""
    return {
        k: v
        for k, v in tags.items()
        if k[1] not in ("ControlAuthorityActive", "VsdConfigured")
    }


PRE_FLAG_OFF = _pre_flag(FEATURES_OFF_TAGS)


# ---------------------------------------------------------------------------
# backward compatibility: rendered payload
# ---------------------------------------------------------------------------


async def test_legacy_controller_payload_has_no_new_keys():
    data = await _stub(LEGACY_TAGS)._collect_dashboard_data()
    assert set(data) == LEGACY_DATA_KEYS
    assert set(data["pumps"][0]) == LEGACY_PUMP_KEYS
    assert data["units"] == {"rate": "L/Hr", "pressure": "psi"}


async def test_new_controller_with_features_off_renders_identically():
    legacy = await _stub(LEGACY_TAGS)._collect_dashboard_data()
    for tags in (FEATURES_OFF_TAGS, _pre_flag(FEATURES_OFF_TAGS)):
        features_off = await _stub(tags)._collect_dashboard_data()
        assert features_off == legacy


async def test_legacy_fault_text_unchanged():
    tags = {**LEGACY_TAGS, (KEY, "Fault"): True, (KEY, "FaultReason"): None}
    data = await _stub(tags)._collect_dashboard_data()
    assert data["faults"][0]["reason"] == "Pump tripped"


# ---------------------------------------------------------------------------
# backward compatibility: RPC calls
# ---------------------------------------------------------------------------


def _button_stub(tags, call_impl=None):
    calls = []

    async def record(method, value, **kwargs):
        calls.append((method, value, kwargs))
        if call_impl is not None:
            return await call_impl(method, value, **kwargs)
        return {}

    stub = _make_stub([KEY], tags)  # live view: tests may change tags between presses
    stub.config.rpc_timeout = _val(5.0)
    stub.ui_manager = types.SimpleNamespace(call=record)
    stub.tags = _fake_tags()
    stub._cmd_in_flight = False
    stub.notices = []
    stub.dashboard = types.SimpleNamespace(
        notify=lambda message, level="info": stub.notices.append((message, level))
    )
    for meth in (
        "_handle_button",
        "_dispatch_command",
        "_explain_rpc_error",
        "_primary_fault",
        "_primary_vsd_tripped",
    ):
        setattr(stub, meth, getattr(App, meth).__get__(stub))
    return stub, calls


def _expected(method, value):
    return (
        method,
        value,
        {
            "channel": UI_CMDS_CHANNEL,
            "app_key": KEY,
            "timeout": 5.0,
            "actor": {"name": "Local HMI"},
        },
    )


async def test_buttons_send_unchanged_rpcs_for_old_and_features_off_controllers():
    for tags in (LEGACY_TAGS, FEATURES_OFF_TAGS):
        stub, calls = _button_stub(tags)
        for name in ("start", "stop", "flow_up", "flow_down"):
            await stub._handle_button(name)
        assert calls == [
            _expected("set_pump_state", "start"),
            _expected("set_pump_state", "stop"),
            _expected("nudge_rate", "+1"),
            _expected("nudge_rate", "-1"),
        ]


async def test_start_while_faulted_still_resets_fault_without_a_vsd():
    for tags in (LEGACY_TAGS, FEATURES_OFF_TAGS):
        stub, calls = _button_stub({**tags, (KEY, "Fault"): True})
        await stub._handle_button("start")
        assert calls == [_expected("reset_fault", None)]


# ---------------------------------------------------------------------------
# control mode switch
# ---------------------------------------------------------------------------


async def test_control_mode_tags_are_ignored():
    """Control priority is fixed by the controller: no switch on the HMI,
    whatever ControlMode / ControlAuthorityActive / DCS tags it publishes."""
    legacy = await _stub(LEGACY_TAGS)._collect_dashboard_data()
    for extra in (
        {(KEY, "ControlMode"): "dcs", (KEY, "ControlModeInt"): 1},
        {(KEY, "ControlMode"): "local", (KEY, "ControlAuthorityActive"): True},
        {(KEY, "DcsCmdResult"): 0},
    ):
        for base in (FEATURES_OFF_TAGS, PRE_FLAG_OFF):
            data = await _stub({**base, **extra})._collect_dashboard_data()
            assert "control" not in data
            assert data == legacy


# ---------------------------------------------------------------------------
# VSD
# ---------------------------------------------------------------------------


# Heuristic path (controller without VsdConfigured).
VSD_TAGS = {
    **PRE_FLAG_OFF,
    (KEY, "MotorOutputHz"): 42.5,
    (KEY, "PumpRpm"): 61.0,
}


async def test_vsd_card_and_drive_line_when_motor_configured():
    data = await _stub(VSD_TAGS)._collect_dashboard_data()
    assert data["vsd"] == {
        "tripped": False,
        "trip_code": None,
        "trip_description": None,
        "motor_hz": 42.5,
        "pump_rpm": 61.0,
    }
    # the pump card itself is unchanged
    assert set(data["pumps"][0]) == LEGACY_PUMP_KEYS


async def test_vsd_trip_shows_description_and_code():
    tags = {
        **VSD_TAGS,
        (KEY, "MotorOutputHz"): 0.0,
        (KEY, "Fault"): True,
        (KEY, "FaultReason"): "VSD trip: Over current (code 3)",
        (KEY, "TripVsd"): True,
        (KEY, "VsdTripCode"): 3,
        (KEY, "VsdTripDescription"): "Over current",
    }
    data = await _stub(tags)._collect_dashboard_data()
    assert data["vsd"]["tripped"] is True
    assert data["vsd"]["trip_code"] == 3
    assert data["vsd"]["trip_description"] == "Over current"
    # the controller's own FaultReason text is what the banner shows
    assert data["faults"][0]["reason"] == "VSD trip: Over current (code 3)"


async def test_vsd_detected_from_comms_trip_and_kept_when_hz_goes_null():
    tags = {
        **PRE_FLAG_OFF,
        (KEY, "Fault"): True,
        (KEY, "FaultReason"): None,
        (KEY, "TripVsdComms"): True,
    }
    stub = _stub(tags)
    data = await stub._collect_dashboard_data()
    assert data["vsd"]["motor_hz"] is None
    # per-cause bit fills in a missing FaultReason
    assert data["faults"][0]["reason"] == "VSD communications lost"

    tags[(KEY, "TripVsdComms")] = False
    tags[(KEY, "Fault")] = False
    stub.get_tag = lambda name, key=None, default=None: tags.get((key, name), default)
    assert "vsd" in await stub._collect_dashboard_data()


async def test_start_button_two_step_reset_with_tripped_vsd():
    tags = {
        **VSD_TAGS,
        (KEY, "Fault"): True,
        (KEY, "TripVsd"): True,
        (KEY, "VsdTripCode"): 3,
        (KEY, "VsdTripDescription"): "Over current",
    }
    stub, calls = _button_stub(tags)
    await stub._handle_button("start")
    # drive cleared, pump fault still latched -> second press resets the fault
    tags[(KEY, "VsdTripCode")] = 0
    tags[(KEY, "VsdTripDescription")] = None
    await stub._handle_button("start")
    assert calls == [
        _expected("reset_vsd_fault", None),
        _expected("reset_fault", None),
    ]


async def test_vsd_reset_errors_are_explained():
    async def still(method, value, **kwargs):
        raise RPCError("STILL_TRIPPED", "VSD trip: Over current (code 3)")

    stub, _ = _button_stub(VSD_TAGS, still)
    res = await stub._dispatch_command("reset_vsd_fault", None)
    assert res["code"] == "STILL_TRIPPED"
    assert res["message"].startswith("VSD still tripped after reset")


# ---------------------------------------------------------------------------
# explicit VsdConfigured tag (preferred when present)
# ---------------------------------------------------------------------------


async def test_vsd_configured_true_shows_card_before_any_drive_data():
    tags = {**FEATURES_OFF_TAGS, (KEY, "VsdConfigured"): True}
    data = await _stub(tags)._collect_dashboard_data()
    assert data["vsd"] == {
        "tripped": False,
        "trip_code": None,
        "trip_description": None,
        "motor_hz": None,
        "pump_rpm": 57.0,
    }


async def test_vsd_configured_false_overrides_heuristics():
    tags = {
        **FEATURES_OFF_TAGS,
        (KEY, "MotorOutputHz"): 42.5,
        (KEY, "TripVsdComms"): True,
    }
    assert "vsd" not in await _stub(tags)._collect_dashboard_data()


async def test_vsd_configured_false_start_button_still_resets_fault():
    tags = {**FEATURES_OFF_TAGS, (KEY, "Fault"): True}
    stub, calls = _button_stub(tags)
    await stub._handle_button("start")
    assert calls == [_expected("reset_fault", None)]


# ---------------------------------------------------------------------------
# denials
# ---------------------------------------------------------------------------


async def test_remote_denied_operator_message_and_notice():
    async def denied(method, value, **kwargs):
        raise RPCError("REMOTE_DENIED", "hmi may not start the pump")

    stub, calls = _button_stub(FEATURES_OFF_TAGS, denied)
    await stub._handle_button("start")
    assert calls == [_expected("set_pump_state", "start")]
    assert stub.notices == [
        (
            "Command refused by the pump controller: hmi may not start the pump",
            "error",
        )
    ]

    res = await stub._dispatch_command("nudge_rate", "+1")
    assert res["code"] == "REMOTE_DENIED"
    # generic: the controller's own reason text, no mode switching advice
    assert res["message"] == (
        "Command refused by the pump controller: hmi may not start the pump"
    )
    assert "Switch" not in res["message"]


async def test_other_errors_pass_through_without_notice():
    async def faulted(method, value, **kwargs):
        raise RPCError("FAULTED", "pump tripped")

    stub, _ = _button_stub(LEGACY_TAGS, faulted)
    await stub._handle_button("start")
    assert stub.notices == []
    res = await stub._dispatch_command("set_pump_state", "start")
    assert res == {"ok": False, "code": "FAULTED", "message": "pump tripped"}


# ---------------------------------------------------------------------------
# pressure units
# ---------------------------------------------------------------------------


async def test_pressure_units_from_controller_when_hmi_on_default():
    tags = {**FEATURES_OFF_TAGS, (KEY, "PressureUnits"): "kPa"}
    data = await _stub(tags)._collect_dashboard_data()
    assert data["units"]["pressure"] == "kPa"


async def test_pressure_units_hmi_setting_wins():
    stub = _stub({**FEATURES_OFF_TAGS, (KEY, "PressureUnits"): "kPa"})
    stub.config.pressure_units = _val("bar")
    assert (await stub._collect_dashboard_data())["units"]["pressure"] == "bar"
