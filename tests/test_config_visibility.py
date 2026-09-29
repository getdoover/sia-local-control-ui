"""Config editor visibility for the physical buttons, and loading existing
(Kuwait) configs unchanged.

The button fields are shown in the editor only when HMI Control Mode is
"Button" (a JSON-schema ``allOf``/``if``/``then`` branch, which the Doover
config editor renders conditionally). That is editor visibility only: the
buttons keep working from their saved values in every mode.
"""

import json
import types
from pathlib import Path

import pytest

from sia_local_control_ui.app_config import (
    BUTTON_MODE_FIELDS,
    ButtonSource,
    HmiControlMode,
    SiaLocalControlUiConfig,
    resolve_pulse,
)
from sia_local_control_ui.application import SiaLocalControlUiApplication as App

from .test_controller_features import _expected

FIXTURE = Path(__file__).parent / "fixtures" / "kuwait_foamer_hmi_config.json"
ROOT = Path(__file__).parents[1]


def _kuwait(**overrides) -> dict:
    data = json.loads(FIXTURE.read_text())
    data.pop("_comment")
    data.update(overrides)
    return data


def _load(data: dict) -> SiaLocalControlUiConfig:
    cfg = SiaLocalControlUiConfig()
    cfg._inject_deployment_config(data)
    return cfg


def _element_values(cfg) -> dict:
    """Every loaded value, keyed as in the saved config."""
    out = {}
    for key, elem in type(cfg)._element_map.items():
        sub = getattr(elem, "_elements", None)
        if sub is not None and not hasattr(elem, "elements"):
            out[key] = {k: _plain(e.value) for k, e in sub.items()}
        elif hasattr(elem, "elements"):
            out[key] = [e.value for e in elem.elements]
        else:
            out[key] = _plain(elem.value)
    return out


def _plain(value):
    return (
        value.value
        if hasattr(value, "value") and not isinstance(value, (int, float, str))
        else value
    )


# ---------------------------------------------------------------------------
# schema: mode first, buttons conditional
# ---------------------------------------------------------------------------


def _schema():
    # doover_config.json no longer carries the schema: publish generates it
    # from the config class, so the tests read it from the same place.
    return SiaLocalControlUiConfig.to_schema()


def test_hmi_control_mode_is_first():
    props = _schema()["properties"]
    first = min(props.values(), key=lambda p: p["x-position"])
    assert first["x-name"] == "hmi_control_mode"


def test_button_fields_only_in_button_mode_branch():
    schema = _schema()
    for name in BUTTON_MODE_FIELDS:
        assert name not in schema["properties"]
        assert name not in schema["required"]
    (branch,) = schema["allOf"]
    assert branch["if"] == {
        "properties": {"hmi_control_mode": {"const": HmiControlMode.button.value}},
        "required": ["hmi_control_mode"],
    }
    assert list(branch["then"]["properties"]) == list(BUTTON_MODE_FIELDS)


def test_lamp_pins_stay_visible_in_every_mode():
    props = _schema()["properties"]
    assert props["run_lamp_pin"]["default"] == 3
    assert props["trip_lamp_pin"]["default"] == 4


def test_config_keys_unchanged_from_the_deployed_schema():
    """Same keys as before: the deployed schema plus the new settings, all
    defaulting to the old behaviour (Read Only, dashboard on, tank mm only,
    no VSD commissioning gear, no cover-plate insets, no alarm settings
    gears)."""
    schema = _schema()
    keys = set(schema["properties"]) | set(schema["allOf"][0]["then"]["properties"])
    deployed = set(_kuwait())
    assert keys - deployed == {
        "hmi_control_mode",
        "local_dashboard_enabled",
        "tank_primary_reading",
        "tank_secondary_reading",
        "vsd_motor_app",
        "vsd_commissioning",
        "kiosk_inset_mm",
        "popover_inset_mm",
        "kiosk_px_per_mm",
        "alarm_settings_access",
    }
    assert deployed - keys == set()


def test_kuwait_config_loads_with_no_insets():
    """An existing config has none of the kiosk display keys: no inset, and
    the J5261 panel's px/mm (widget/src/lib/assembleDashboardData.ts
    DEFAULT_KIOSK_PX_PER_MM)."""
    cfg = _load(_kuwait())
    assert cfg.kiosk_inset_mm.value == 0
    assert cfg.popover_inset_mm.value == 0
    assert cfg.kiosk_px_per_mm.value == 5.8
    adapter = (
        Path(__file__).parents[1]
        / "widget"
        / "src"
        / "lib"
        / "assembleDashboardData.ts"
    ).read_text()
    assert "export const DEFAULT_KIOSK_PX_PER_MM = 5.8;" in adapter


def test_kuwait_config_loads_with_no_vsd_commissioning():
    """An existing config has neither key: no motor app, gear Hidden."""
    cfg = _load(_kuwait())
    assert cfg.vsd_motor_app.value is None
    assert cfg.vsd_commissioning.value == "Hidden"


def _jsonschema_valid(instance) -> bool:
    jsonschema = pytest.importorskip("jsonschema")
    validator = jsonschema.Draft202012Validator(_schema())
    return not list(validator.iter_errors(instance))


def test_schema_validates_kuwait_config_in_read_only():
    # Hidden fields with saved values stay valid (and are kept by the editor).
    assert _jsonschema_valid(_kuwait())


def test_schema_validates_new_install_without_buttons():
    data = _kuwait()
    for name in BUTTON_MODE_FIELDS:
        data.pop(name)
    assert _jsonschema_valid(data)


# ---------------------------------------------------------------------------
# loading existing configs: identical values
# ---------------------------------------------------------------------------


def test_kuwait_config_loads_identical_values():
    saved = _kuwait()
    cfg = _load(saved)
    loaded = _element_values(cfg)
    for key, value in saved.items():
        if isinstance(value, dict):
            for sub, v in value.items():
                assert loaded[key][sub] == v, f"{key}.{sub}"
        else:
            assert loaded[key] == value, key
    # the new setting defaults to Read Only on an existing install
    assert loaded["hmi_control_mode"] == HmiControlMode.read_only.value
    assert cfg.touch_enabled is False


def test_kuwait_buttons_resolve_to_their_wiring_in_read_only():
    cfg = _load(_kuwait())
    got = {
        name: resolve_pulse(
            btn.source.value, btn.pin.value, btn.threshold_v.value, btn.active_low.value
        )
        for name, btn in (
            ("start", cfg.start_button),
            ("stop", cfg.stop_button),
            ("flow_up", cfg.flow_up_button),
            ("flow_down", cfg.flow_down_button),
        )
    }
    assert got == {
        "start": (1, "rising"),
        "stop": (2, "rising"),
        "flow_up": (3, "rising"),
        "flow_down": (0, "VI+9.0"),
    }
    assert cfg.run_lamp_pin.value == 3
    assert cfg.trip_lamp_pin.value == 4


def test_absent_button_loads_disabled_instead_of_failing():
    data = _kuwait()
    data.pop("start_button")
    cfg = _load(data)
    assert resolve_pulse(cfg.start_button.source.value, cfg.start_button.pin.value) == (
        None,
        None,
    )
    assert cfg.start_button.source.value in (ButtonSource.disabled, "Disabled")


# ---------------------------------------------------------------------------
# Read Only + configured pins: the physical buttons still work
# ---------------------------------------------------------------------------


class _FakePlatform:
    def __init__(self):
        self.listeners = {}
        self.di_config = {}

    async def set_di_config(self, pin, debounce_ms=0):
        self.di_config[pin] = debounce_ms

    def get_new_pulse_counter(self, pin, edge, callback):
        self.listeners[pin] = (edge, callback)
        return object()


@pytest.mark.parametrize("mode", ["Read Only", "Touch", "Button"])
async def test_physical_start_stop_work_with_kuwait_pins(mode):
    cfg = _load(_kuwait(hmi_control_mode=mode))
    calls = []

    async def call(method, value, **kwargs):
        calls.append((method, value, kwargs))
        return {}

    app = types.SimpleNamespace(
        config=cfg,
        platform_iface=_FakePlatform(),
        ui_manager=types.SimpleNamespace(call=call),
        tags=types.SimpleNamespace(LastCommand=types.SimpleNamespace(set=_noop)),
        _cmd_in_flight=False,
        get_tag=lambda name, key=None, default=None: None,
        dashboard=types.SimpleNamespace(notify=lambda *a, **k: None),
    )
    for meth in (
        "_setup_buttons",
        "_on_button_pulse",
        "_handle_button",
        "_dispatch_command",
        "_explain_rpc_error",
        "_primary_fault",
        "_primary_vsd_tripped",
    ):
        setattr(app, meth, getattr(App, meth).__get__(app))

    await app._setup_buttons()
    listeners = app.platform_iface.listeners
    assert {pin: edge for pin, (edge, _) in listeners.items()} == {
        1: "rising",
        2: "rising",
        3: "rising",
        0: "VI+9.0",
    }
    assert app.platform_iface.di_config == {1: 50, 2: 50, 3: 50}

    # Press Start (DI1), then Stop (DI2): platform pulse callbacks.
    await listeners[1][1](1, True, 0.1, 1, "rising")
    await listeners[2][1](2, True, 0.1, 1, "rising")
    assert [(m, v) for m, v, _ in calls] == [
        ("set_pump_state", "start"),
        ("set_pump_state", "stop"),
    ]
    for method, value, kwargs in calls:
        assert kwargs["actor"] == {"name": "Local HMI"}
        assert kwargs["app_key"] == "sia_injection_controller_1"
    assert calls[0] == (
        _expected("set_pump_state", "start")[0],
        "start",
        {
            **_expected("set_pump_state", "start")[2],
            "app_key": "sia_injection_controller_1",
            "timeout": 20.0,
        },
    )


async def _noop(*_a, **_k):
    return None
