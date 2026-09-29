"""``local_dashboard_enabled``: the legacy Flask dashboard is optional, the
physical buttons and lamps are not.

- Default on, so an existing (Kuwait) config with no such key starts the
  dashboard exactly as before.
- Off: no Flask/SocketIO server is constructed or started, and the physical
  pushbuttons still register and send their RPCs in every HMI Control Mode;
  the lamps still follow the controller.
- Off with no buttons and no lamps: the container idles (no tag reads, no
  outputs, a one-minute loop).
"""

import types
from typing import ClassVar

import pytest

from sia_local_control_ui import application as app_module
from sia_local_control_ui.app_config import SiaLocalControlUiConfig
from sia_local_control_ui.app_ui import MIRROR_ELEMENTS, SiaLocalControlUiUI
from sia_local_control_ui.application import IDLE_LOOP_PERIOD
from sia_local_control_ui.application import SiaLocalControlUiApplication as App

from .test_config_visibility import _FakePlatform, _kuwait, _load

KEY = "sia_injection_controller_1"
MODES = ("Read Only", "Touch", "Button")
NO_BUTTONS = {
    name: {"source": "Disabled", "pin": 0}
    for name in ("start_button", "stop_button", "flow_up_button", "flow_down_button")
}

_METHODS = (
    "setup",
    "_setup_buttons",
    "main_loop",
    "_drive_lamps",
    "_drive_lamp",
    "on_shutdown_at",
    "_on_button_pulse",
    "_handle_button",
    "_dispatch_command",
    "_explain_rpc_error",
    "_primary_fault",
    "_primary_vsd_tripped",
    "_run_command_sync",
    "_check_touch_command",
)


class _Recorder:
    """Stands in for SiaDashboard / DashboardInterface and records use."""

    created: ClassVar[list] = []

    def __init__(self, *args, **kwargs):
        type(self).created.append(self)
        self.started = False
        self.stopped = False
        self.updates = []
        self.notices = []

    # DashboardInterface
    def start_dashboard(self):
        self.started = True

    def stop_dashboard(self):
        self.stopped = True

    # SiaDashboard
    def update_data(self, data):
        self.updates.append(data)

    def notify(self, message, level="info"):
        self.notices.append((message, level))


@pytest.fixture
def dashboard(monkeypatch):
    """Replace the Flask server with a recorder, so a test sees whether the
    app would have started one (and never binds a real port)."""
    _Recorder.created = []
    monkeypatch.setattr(app_module, "SiaDashboard", _Recorder)
    monkeypatch.setattr(app_module, "DashboardInterface", _Recorder)
    return _Recorder


def _app(cfg, tags=None, rpc_error=None):
    """The real setup / loop / button methods on a stub app."""
    tags = dict(tags or {})
    calls, outputs, reads = [], [], []

    async def call(method, value, **kwargs):
        calls.append((method, value, kwargs))
        if rpc_error is not None:
            raise rpc_error
        return {}

    async def set_do(pin, value):
        outputs.append((pin, value))

    def get_tag(name, key=None, default=None):
        reads.append((key, name))
        return tags.get((key, name), default)

    async def _noop(*_a, **_k):
        return None

    app = types.SimpleNamespace(
        config=cfg,
        platform_iface=_FakePlatform(),
        ui_manager=types.SimpleNamespace(call=call),
        tags=types.SimpleNamespace(
            LastCommand=types.SimpleNamespace(set=_noop),
        ),
        get_tag=get_tag,
        set_do=set_do,
        calls=calls,
        outputs=outputs,
        reads=reads,
        tag_values=tags,
    )
    for meth in _METHODS:
        setattr(app, meth, getattr(App, meth).__get__(app))
    return app


# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------


def test_setting_defaults_on_and_is_a_boolean():
    prop = SiaLocalControlUiConfig.to_schema()["properties"]["local_dashboard_enabled"]
    assert prop["title"] == "Local Dashboard Enabled"
    assert prop["default"] is True
    assert "boolean" in prop["type"]


def test_kuwait_config_without_the_key_keeps_the_dashboard():
    cfg = _load(_kuwait())
    assert "local_dashboard_enabled" not in _kuwait()
    assert cfg.dashboard_enabled is True
    assert cfg.lamp_pins == [3, 4]


def test_setting_off_loads_off():
    assert _load(_kuwait(local_dashboard_enabled=False)).dashboard_enabled is False


# ---------------------------------------------------------------------------
# dashboard on (default): exactly as before
# ---------------------------------------------------------------------------


async def test_default_starts_the_dashboard_on_8091(dashboard, monkeypatch):
    seen = {}

    def make(*args, **kwargs):
        seen.update(kwargs)
        return dashboard()

    monkeypatch.setattr(app_module, "SiaDashboard", make)
    app = _app(_load(_kuwait()))
    await app.setup()
    assert seen["port"] == 8091
    assert seen["host"] == "0.0.0.0"
    assert app.dashboard_interface.started is True
    assert app.loop_target_period == 0.5
    assert len(app.platform_iface.listeners) == 4


# ---------------------------------------------------------------------------
# dashboard off: no server, buttons still work
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("mode", MODES)
async def test_disabled_starts_no_server_and_buttons_still_work(dashboard, mode):
    app = _app(_load(_kuwait(local_dashboard_enabled=False, hmi_control_mode=mode)))
    await app.setup()

    # No Flask/SocketIO server constructed, let alone started.
    assert dashboard.created == []
    assert app.dashboard is None and app.dashboard_interface is None

    # The Kuwait wiring still registers: DI1/DI2/DI3 + AI0 at 9 V.
    listeners = app.platform_iface.listeners
    assert {pin: edge for pin, (edge, _) in listeners.items()} == {
        1: "rising",
        2: "rising",
        3: "rising",
        0: "VI+9.0",
    }

    # Press Start (DI1), Stop (DI2), Flow Up (DI3), Flow Down (AI0).
    for pin in (1, 2, 3, 0):
        await listeners[pin][1](pin, True, 0.1, 1, listeners[pin][0])
    assert [(m, v) for m, v, _ in app.calls] == [
        ("set_pump_state", "start"),
        ("set_pump_state", "stop"),
        ("nudge_rate", "+1"),
        ("nudge_rate", "-1"),
    ]
    for _m, _v, kwargs in app.calls:
        assert kwargs["actor"] == {"name": "Local HMI"}
        assert kwargs["app_key"] == KEY


async def test_disabled_start_still_resets_a_fault(dashboard):
    app = _app(
        _load(_kuwait(local_dashboard_enabled=False)),
        tags={(KEY, "Fault"): True},
    )
    await app.setup()
    await app.platform_iface.listeners[1][1](1, True, 0.1, 1, "rising")
    assert [(m, v) for m, v, _ in app.calls] == [("reset_fault", None)]


async def test_disabled_button_refusal_does_not_need_a_screen(dashboard):
    from pydoover.rpc import RPCError

    app = _app(
        _load(_kuwait(local_dashboard_enabled=False)),
        rpc_error=RPCError("REMOTE_DENIED", "DCS has control"),
    )
    await app.setup()
    # Would call dashboard.notify() with a dashboard; must not raise without.
    await app.platform_iface.listeners[1][1](1, True, 0.1, 1, "rising")
    assert app.calls and app._cmd_in_flight is False


async def test_disabled_lamps_still_follow_the_controller(dashboard):
    app = _app(_load(_kuwait(local_dashboard_enabled=False)))
    await app.setup()
    assert app.loop_target_period == 0.5  # lamps need the refresh

    app.tag_values.update({(KEY, "Running"): True, (KEY, "Fault"): False})
    await app.main_loop()
    assert app.outputs == [(3, True), (4, False)]

    app.tag_values.update({(KEY, "Running"): False, (KEY, "Fault"): True})
    await app.main_loop()
    assert app.outputs[2:] == [(3, False), (4, True)]

    # Lamps only: no dashboard payload is assembled (no tank / solar / VSD
    # reads), just the primary's Running and Fault.
    assert {name for _key, name in app.reads} == {"Running", "Fault"}


async def test_disabled_touch_bridge_is_never_wired(dashboard):
    """With no dashboard there is no on-screen path into the container at
    all; on-screen control is the widget's, straight to the controller."""
    app = _app(_load(_kuwait(local_dashboard_enabled=False, hmi_control_mode="Touch")))
    await app.setup()
    assert dashboard.created == []
    assert app.calls == []


async def test_disabled_shutdown_is_a_no_op(dashboard):
    app = _app(_load(_kuwait(local_dashboard_enabled=False)))
    await app.setup()
    await app.on_shutdown_at(None)


# ---------------------------------------------------------------------------
# dashboard off, nothing configured: idle
# ---------------------------------------------------------------------------


async def test_nothing_configured_idles_cheaply(dashboard):
    cfg = _load(
        _kuwait(
            local_dashboard_enabled=False,
            run_lamp_pin=None,
            trip_lamp_pin=None,
            **NO_BUTTONS,
        )
    )
    app = _app(cfg, tags={(KEY, "Running"): True})
    await app.setup()
    assert dashboard.created == []
    assert app.platform_iface.listeners == {}
    assert app.loop_target_period == IDLE_LOOP_PERIOD == 60.0
    for _ in range(3):
        await app.main_loop()
    assert app.reads == []
    assert app.outputs == []


async def test_buttons_only_idles_but_buttons_answer(dashboard):
    cfg = _load(
        _kuwait(local_dashboard_enabled=False, run_lamp_pin=None, trip_lamp_pin=None)
    )
    app = _app(cfg)
    await app.setup()
    assert app.loop_target_period == IDLE_LOOP_PERIOD
    await app.main_loop()
    assert app.reads == [] and app.outputs == []
    # Pulse listeners are independent tasks: a press is answered at once.
    await app.platform_iface.listeners[2][1](2, True, 0.1, 1, "rising")
    assert [(m, v) for m, v, _ in app.calls] == [("set_pump_state", "stop")]


# ---------------------------------------------------------------------------
# cloud UI: the legacy mirror hides with the dashboard
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(("enabled", "hidden"), [(True, False), (False, True)])
async def test_mirror_variables_follow_the_dashboard(enabled, hidden):
    cfg = _load(_kuwait(local_dashboard_enabled=enabled))
    ui = SiaLocalControlUiUI(cfg, None, "sia_local_control_ui_1")
    await ui.setup()
    for name in MIRROR_ELEMENTS:
        assert getattr(ui, name).hidden is hidden, name
    assert ui.hmi_widget.hidden is False
