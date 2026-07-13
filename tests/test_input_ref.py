"""Unit tests for the flexible input-mapping component (input_ref.py).

Covers the pure logic — source normalisation, threshold evaluation, and the
monotonic-clock debouncer — with no platform interface or Doover runtime.
This is the machinery behind the "any DI function on any DI pin OR AI0/AI1 as a
thresholded voltage input" requirement (J5246 wires Flow Down to AI1).
"""

from sia_local_control_ui.input_ref import (
    DebouncedBool,
    InputSource,
    evaluate,
    normalise_source,
)


class TestNormaliseSource:
    def test_passthrough_member(self):
        assert normalise_source(InputSource.ai1) is InputSource.ai1

    def test_none_is_disabled(self):
        assert normalise_source(None) is InputSource.disabled

    def test_display_string(self):
        assert normalise_source("AI1") is InputSource.ai1
        assert normalise_source("DI") is InputSource.di

    def test_sanitised_member_name(self):
        # config sometimes hands back the lowercased member name
        assert normalise_source("ai1") is InputSource.ai1

    def test_unknown_falls_back_to_disabled(self):
        assert normalise_source("nonsense") is InputSource.disabled


class TestEvaluate:
    def test_disabled_always_false(self):
        assert evaluate(InputSource.disabled, di_value=True) is False

    def test_di_reads_level(self):
        assert evaluate(InputSource.di, di_value=True) is True
        assert evaluate(InputSource.di, di_value=False) is False

    def test_di_missing_is_false(self):
        assert evaluate(InputSource.di, di_value=None) is False

    def test_ai_threshold(self):
        # default 9 V threshold; AI1 = Flow Down on J5246
        assert evaluate(InputSource.ai1, ai1_value=10.0) is True
        assert evaluate(InputSource.ai1, ai1_value=8.0) is False
        assert evaluate(InputSource.ai1, ai1_value=9.0) is False  # strictly greater

    def test_ai_custom_threshold(self):
        assert evaluate(InputSource.ai0, ai0_value=5.0, threshold_v=4.0) is True
        assert evaluate(InputSource.ai0, ai0_value=3.0, threshold_v=4.0) is False

    def test_ai_missing_is_false(self):
        assert evaluate(InputSource.ai1, ai1_value=None) is False

    def test_invert(self):
        assert evaluate(InputSource.di, di_value=False, invert=True) is True
        assert evaluate(InputSource.di, di_value=True, invert=True) is False
        assert evaluate(InputSource.ai1, ai1_value=10.0, invert=True) is False


class TestDebouncedBool:
    def test_holds_until_debounce_elapses(self):
        d = DebouncedBool(debounce_secs=0.05, initial=False)
        # first True at t=0 starts the timer, state stays False
        assert d.update(True, now=0.0) is False
        # still within the window
        assert d.update(True, now=0.03) is False
        # window elapsed -> flips
        assert d.update(True, now=0.05) is True
        assert d.state is True

    def test_bounce_cancels_pending_flip(self):
        d = DebouncedBool(debounce_secs=0.05, initial=False)
        assert d.update(True, now=0.00) is False
        # input bounces back before the window closes -> timer cancels
        assert d.update(False, now=0.02) is False
        # a fresh sustained True must run the full window again from here (t=0.10)
        assert d.update(True, now=0.10) is False
        assert d.update(True, now=0.13) is False  # only 0.03 into the restarted window
        assert d.update(True, now=0.20) is True  # well past 0.05 since restart -> flips

    def test_zero_debounce_flips_immediately(self):
        d = DebouncedBool(debounce_secs=0.0, initial=False)
        assert d.update(True, now=0.0) is True

    def test_agreement_resets_timer(self):
        d = DebouncedBool(debounce_secs=0.05, initial=True)
        # feeding the settled value keeps it and clears any pending flip
        assert d.update(True, now=0.0) is True
        assert d.update(False, now=0.01) is True  # started falling
        assert d.update(True, now=0.02) is True  # back to settled -> cancelled
        assert d.update(False, now=0.03) is True  # must restart the window
        assert d.update(False, now=0.03 + 0.05) is False
