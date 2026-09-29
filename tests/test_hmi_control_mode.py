"""HMI Control Mode (Read Only / Touch / Button).

The setting governs ON-SCREEN controls only: the physical pushbuttons and the
RUN / TRIP lamps behave identically in every mode.
"""

import types

import pytest

from sia_local_control_ui.app_config import (
    HmiControlMode,
    SiaLocalControlUiConfig,
    normalise_hmi_mode,
)
from sia_local_control_ui.application import SiaLocalControlUiApplication as App

from .test_controller_features import (
    FEATURES_OFF_TAGS,
    KEY,
    LEGACY_TAGS,
    _button_stub,
    _expected,
    _stub,
)

MODES = ("Read Only", "Touch", "Button")


# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------


def test_config_key_default_and_options():
    schema = SiaLocalControlUiConfig.to_schema()
    field = schema["properties"]["hmi_control_mode"]
    assert field["title"] == "HMI Control Mode"
    assert field["enum"] == ["Read Only", "Touch", "Button"]
    assert field["default"] == "Read Only"


def test_config_field_is_first():
    props = SiaLocalControlUiConfig.to_schema()["properties"]
    first = min(props.values(), key=lambda f: f["x-position"])
    assert first["x-name"] == "hmi_control_mode"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (HmiControlMode.touch, HmiControlMode.touch),
        ("Touch", HmiControlMode.touch),
        ("touch", HmiControlMode.touch),
        ("Button", HmiControlMode.button),
        ("Read Only", HmiControlMode.read_only),
        (None, HmiControlMode.read_only),
        ("bogus", HmiControlMode.read_only),
    ],
)
def test_normalise_hmi_mode(raw, expected):
    assert normalise_hmi_mode(raw) is expected


def _touch_enabled(mode) -> bool:
    cfg = types.SimpleNamespace(hmi_control_mode=types.SimpleNamespace(value=mode))
    return SiaLocalControlUiConfig.touch_enabled.fget(cfg)


def test_only_touch_enables_on_screen_control():
    assert _touch_enabled("Touch") is True
    assert _touch_enabled("Read Only") is False
    assert _touch_enabled("Button") is False  # reserved: same as Read Only


# ---------------------------------------------------------------------------
# payload
# ---------------------------------------------------------------------------


async def test_read_only_payload_has_no_touch_key():
    for tags in (LEGACY_TAGS, FEATURES_OFF_TAGS):
        data = await _stub(tags)._collect_dashboard_data()
        assert "touch" not in data


async def test_touch_payload_carries_calibration_factor_and_range():
    tags = {**FEATURES_OFF_TAGS, (KEY, "CorrectionFactor"): 1.12}
    stub = _stub(tags)
    stub.config.touch_enabled = True
    data = await stub._collect_dashboard_data()
    assert data["touch"] == {
        "calibration_factor": 1.12,
        "calibration_min": 0.3,
        "calibration_max": 1.7,
    }


async def test_touch_payload_otherwise_matches_read_only():
    ro = await _stub(FEATURES_OFF_TAGS)._collect_dashboard_data()
    stub = _stub(FEATURES_OFF_TAGS)
    stub.config.touch_enabled = True
    touch = await stub._collect_dashboard_data()
    touch.pop("touch")
    assert touch == ro


# ---------------------------------------------------------------------------
# on-screen command gate
# ---------------------------------------------------------------------------


def _gate(touch):
    stub = types.SimpleNamespace(
        _loop=None, config=types.SimpleNamespace(touch_enabled=touch)
    )
    stub._check_touch_command = App._check_touch_command.__get__(stub)
    stub._run_command_sync = App._run_command_sync.__get__(stub)
    return stub


@pytest.mark.parametrize(
    ("cmd", "value"),
    [
        ("set_pump_state", "start"),
        ("set_pump_state", "stop"),
        ("reset_fault", None),
        ("set_target_rate", 10.0),
    ],
)
def test_read_only_refuses_every_on_screen_command(cmd, value):
    res = _gate(touch=False)._run_command_sync(cmd, value)
    assert res["ok"] is False
    assert res["code"] == "READ_ONLY"


@pytest.mark.parametrize(
    ("cmd", "value"),
    [
        ("set_pump_state", "start"),
        ("set_pump_state", "stop"),
        ("nudge_rate", "+1"),
        ("nudge_rate", "-1"),
        ("set_target_rate", 12.5),
        ("reset_fault", None),
        ("reset_vsd_fault", None),
        ("last_calibration_factor", 1.05),
    ],
)
def test_touch_allows_controller_commands(cmd, value):
    assert _gate(touch=True)._check_touch_command(cmd, value) is None


@pytest.mark.parametrize(
    ("cmd", "value"),
    [
        ("last_calibration_factor", 0.29),
        ("last_calibration_factor", 1.71),
        ("last_calibration_factor", "abc"),
        ("set_target_rate", None),
        ("set_target_rate", "fast"),
        ("start_calibration", None),  # not an on-screen control
        ("set_control_mode", "local"),  # priority is fixed by the controller
        ("anything_else", 1),
    ],
)
def test_touch_rejects_bad_values_and_unknown_commands(cmd, value):
    res = _gate(touch=True)._check_touch_command(cmd, value)
    assert res["ok"] is False
    assert res["code"] == "INVALID"


async def test_touch_rpc_payloads_keep_the_hmi_actor():
    stub, calls = _button_stub(FEATURES_OFF_TAGS)
    await stub._dispatch_command("set_target_rate", 14.0)
    await stub._dispatch_command("last_calibration_factor", 1.05)
    assert calls == [
        _expected("set_target_rate", 14.0),
        _expected("last_calibration_factor", 1.05),
    ]


# ---------------------------------------------------------------------------
# physical pushbuttons: identical in every mode
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("mode", MODES)
async def test_physical_buttons_work_in_every_mode(mode):
    stub, calls = _button_stub(FEATURES_OFF_TAGS)
    stub.config.touch_enabled = _touch_enabled(mode)
    for name in ("start", "stop", "flow_up", "flow_down"):
        await stub._handle_button(name)
    assert calls == [
        _expected("set_pump_state", "start"),
        _expected("set_pump_state", "stop"),
        _expected("nudge_rate", "+1"),
        _expected("nudge_rate", "-1"),
    ]


@pytest.mark.parametrize("mode", MODES)
async def test_lamps_driven_in_every_mode(mode):
    tags = {**LEGACY_TAGS, (KEY, "Running"): False, (KEY, "Fault"): True}
    stub = _stub(tags)
    stub.config.touch_enabled = _touch_enabled(mode)
    await stub._collect_dashboard_data()
    assert (3, False) in stub.do_writes  # RUN lamp
    assert (4, True) in stub.do_writes  # TRIP lamp


# ---------------------------------------------------------------------------
# solar card: hidden with no solar controllers, unchanged with them
# ---------------------------------------------------------------------------


async def test_no_solar_key_when_no_solar_controllers():
    data = await _stub(LEGACY_TAGS)._collect_dashboard_data()
    assert "solar" not in data


async def test_solar_card_data_unchanged_when_configured():
    tags = {
        **LEGACY_TAGS,
        ("prostar_1", "b_voltage"): 25.4,
        ("prostar_1", "b_percent"): 81.0,
    }
    stub = _stub(tags)
    stub.config.solar_controllers = types.SimpleNamespace(
        elements=[types.SimpleNamespace(value="prostar_1")]
    )
    data = await stub._collect_dashboard_data()
    assert data["solar"] == {"battery_voltage": 25.4, "battery_percentage": 81.0}
