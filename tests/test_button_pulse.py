"""Unit tests for the button -> pulse-listener mapping (app_config.py).

Buttons are event-driven via ``platform_iface.get_new_pulse_counter``. The
resolver turns a button config into the ``(pin, edge)`` pair the platform
pulse listener expects: plain edges for DI buttons, and the platform's
voltage-threshold ("VI+<volts>" / "VI-<volts>") events for AI buttons
(J5246 wires Flow Down to AI1 @ 9V).
"""

from sia_local_control_ui.app_config import (
    ButtonSource,
    normalise_source,
    resolve_pulse,
)


class TestNormaliseSource:
    def test_passthrough_member(self):
        assert normalise_source(ButtonSource.ai) == (ButtonSource.ai, None)

    def test_none_is_disabled(self):
        assert normalise_source(None) == (ButtonSource.disabled, None)

    def test_display_string(self):
        assert normalise_source("DI") == (ButtonSource.di, None)
        assert normalise_source("AI") == (ButtonSource.ai, None)
        assert normalise_source("Disabled") == (ButtonSource.disabled, None)

    def test_sanitised_member_name(self):
        # config sometimes hands back the lowercased member name
        assert normalise_source("di") == (ButtonSource.di, None)
        assert normalise_source("ai") == (ButtonSource.ai, None)

    def test_legacy_ai_sources_force_pin(self):
        # old InputRef configs used AI0/AI1 sources with the pin field unused
        assert normalise_source("AI0") == (ButtonSource.ai, 0)
        assert normalise_source("AI1") == (ButtonSource.ai, 1)
        assert normalise_source("ai1") == (ButtonSource.ai, 1)

    def test_garbage_is_disabled(self):
        assert normalise_source("bogus") == (ButtonSource.disabled, None)


class TestResolvePulse:
    def test_di_rising_default(self):
        assert resolve_pulse("DI", 1) == (1, "rising")

    def test_di_active_low_is_falling(self):
        assert resolve_pulse("DI", 2, active_low=True) == (2, "falling")

    def test_ai_uses_vi_edge(self):
        assert resolve_pulse("AI", 1, threshold_v=9.0) == (1, "VI+9.0")

    def test_ai_active_low_is_negative_edge(self):
        assert resolve_pulse("AI", 0, threshold_v=5.5, active_low=True) == (
            0,
            "VI-5.5",
        )

    def test_ai_threshold_defaults_when_unset(self):
        assert resolve_pulse("AI", 1, threshold_v=None) == (1, "VI+9.0")

    def test_legacy_ai1_overrides_pin(self):
        # legacy AI1 source wins over whatever is in the pin field
        assert resolve_pulse("AI1", 7, threshold_v=9.0) == (1, "VI+9.0")

    def test_disabled(self):
        assert resolve_pulse("Disabled", 1) == (None, None)
        assert resolve_pulse(None, 1) == (None, None)

    def test_no_pin(self):
        assert resolve_pulse("DI", None) == (None, None)

    def test_vi_edge_parses_platform_side(self):
        # the doovit platform parses the threshold as float(edge[2:])
        pin, edge = resolve_pulse("AI", 1, threshold_v=9.0)
        assert float(edge[2:]) == 9.0
        pin, edge = resolve_pulse("AI", 1, threshold_v=9.0, active_low=True)
        assert float(edge[2:]) == -9.0
