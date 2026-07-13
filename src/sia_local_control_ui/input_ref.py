"""Flexible input mapping (``InputRef``).

A reusable, dependency-light component that lets any logical input function
(pump pulse, start button, stop button, flow up/down, ...) be assigned to a
digital input pin **or** to an analog input (AI0/AI1) thresholded to a boolean.

This module is split into three layers so the pure logic is unit-testable
without a platform interface:

* :class:`InputSource` / :class:`InputRefConfig` -- the nested config object.
* :func:`evaluate` and :class:`DebouncedBool` -- pure functions/classes with no
  Doover or platform dependency (threshold + debounce on ``time.monotonic``).
* :class:`InputRef` -- the runtime evaluator that binds a config object to a
  platform interface and returns a debounced boolean.

The controller only uses this for the pump pulse input (it resolves the DI pin
for its pulse counter -- see :meth:`InputRef.resolve_di_pin`). The full
threshold+debounce boolean path exists so the HMI app (WP5) can import/mirror
this exact module for its operator pushbuttons (start=DI1, stop=DI2,
flow_up=DI3, flow_down=AI1@9V). WP5 should copy this file verbatim.
"""

from __future__ import annotations

import enum
import time

from pydoover import config


class InputSource(enum.Enum):
    """Where a logical input reads its value from."""

    disabled = "Disabled"
    di = "DI"
    ai0 = "AI0"
    ai1 = "AI1"


def normalise_source(value) -> InputSource:
    """config.Enum returns a member OR a raw string depending on whether a
    deployment config was injected. Normalise either to a member."""
    if isinstance(value, InputSource):
        return value
    if value is None:
        return InputSource.disabled
    try:
        return InputSource(value)
    except ValueError:
        # tolerate the sanitised member name too (e.g. "ai1")
        try:
            return InputSource[str(value).lower()]
        except KeyError:
            return InputSource.disabled


class InputRefConfig(config.Object):
    """Nested config describing where one logical input is wired.

    Reused by both the controller (process inputs) and the HMI (buttons).
    """

    source = config.Enum(
        "Source",
        choices=InputSource,
        default=InputSource.di,
        description="Where this input reads from: Disabled, a digital input (DI), or an analog input (AI0/AI1) thresholded to a boolean.",
    )
    pin = config.Integer(
        "Pin",
        default=0,
        minimum=0,
        description="Digital input pin number (used when Source is DI).",
    )
    threshold_v = config.Number(
        "Threshold Voltage",
        default=9.0,
        minimum=0.0,
        description="For AI sources: voltage above which the input reads True (matches the existing >9V selector idiom).",
    )
    invert = config.Boolean(
        "Invert",
        default=False,
        description="Invert the boolean result (active-low input).",
    )
    debounce_ms = config.Integer(
        "Debounce (ms)",
        default=50,
        minimum=0,
        description="The input must hold its new state this long before the debounced result flips.",
    )


# ---------------------------------------------------------------------------
# Pure logic (no platform / Doover runtime dependency)
# ---------------------------------------------------------------------------


def evaluate(
    source: InputSource,
    *,
    di_value: bool | None = None,
    ai0_value: float | None = None,
    ai1_value: float | None = None,
    threshold_v: float = 9.0,
    invert: bool = False,
) -> bool:
    """Resolve a raw (un-debounced) boolean for *source*.

    ``di_value`` is the level of the configured DI pin; ``ai0_value`` /
    ``ai1_value`` are the AI voltages. Returns False for a Disabled source or
    when the needed reading is missing.
    """
    if source is InputSource.disabled:
        return False

    if source is InputSource.di:
        raw = bool(di_value)
    elif source is InputSource.ai0:
        raw = ai0_value is not None and ai0_value > threshold_v
    elif source is InputSource.ai1:
        raw = ai1_value is not None and ai1_value > threshold_v
    else:
        return False

    return (not raw) if invert else raw


class DebouncedBool:
    """Debounces a boolean stream on a monotonic clock.

    The output only flips once the raw input has held its new value for
    ``debounce_secs``. Feeding the same-as-current value resets any pending
    flip. Pure and clock-injectable so it can be unit-tested.
    """

    def __init__(self, debounce_secs: float = 0.05, initial: bool = False):
        self.debounce_secs = max(0.0, debounce_secs)
        self._state = initial
        self._candidate = initial
        self._since: float | None = None

    @property
    def state(self) -> bool:
        return self._state

    def update(self, raw: bool, now: float | None = None) -> bool:
        """Feed a raw sample; returns the current debounced state."""
        if now is None:
            now = time.monotonic()
        raw = bool(raw)

        if raw == self._state:
            # back in agreement with the settled state -- cancel any pending flip
            self._candidate = raw
            self._since = None
            return self._state

        # raw disagrees with the settled state -- start/continue the timer
        if self._candidate != raw or self._since is None:
            self._candidate = raw
            self._since = now

        if (now - self._since) >= self.debounce_secs:
            self._state = raw
            self._since = None

        return self._state


# ---------------------------------------------------------------------------
# Runtime evaluator (binds config + platform interface)
# ---------------------------------------------------------------------------


class InputRef:
    """Runtime wrapper: config object + platform interface -> debounced bool."""

    def __init__(self, cfg: InputRefConfig, platform_iface):
        self.cfg = cfg
        self.plt = platform_iface
        self._debounce = DebouncedBool(self.debounce_secs)

    @property
    def source(self) -> InputSource:
        return normalise_source(self.cfg.source.value)

    @property
    def pin(self) -> int | None:
        val = self.cfg.pin.value
        return int(val) if val is not None else None

    @property
    def threshold_v(self) -> float:
        val = self.cfg.threshold_v.value
        return float(val) if val is not None else 9.0

    @property
    def invert(self) -> bool:
        return bool(self.cfg.invert.value)

    @property
    def debounce_secs(self) -> float:
        val = self.cfg.debounce_ms.value
        return (float(val) / 1000.0) if val is not None else 0.05

    @property
    def enabled(self) -> bool:
        return self.source is not InputSource.disabled

    def resolve_di_pin(self) -> int | None:
        """The DI pin to attach a pulse counter / listener to, or None.

        Only meaningful when the source is a digital input.
        """
        return self.pin if self.source is InputSource.di else None

    async def read_raw(self) -> bool:
        """Read the platform and evaluate the raw (un-debounced) boolean."""
        source = self.source
        di_value = ai0_value = ai1_value = None
        if source is InputSource.di and self.pin is not None:
            di_value = await self.plt.fetch_di(self.pin)
        elif source is InputSource.ai0:
            ai0_value = await self.plt.fetch_ai(0)
        elif source is InputSource.ai1:
            ai1_value = await self.plt.fetch_ai(1)
        return evaluate(
            source,
            di_value=di_value,
            ai0_value=ai0_value,
            ai1_value=ai1_value,
            threshold_v=self.threshold_v,
            invert=self.invert,
        )

    async def read(self, now: float | None = None) -> bool:
        """Read the platform and return the debounced boolean."""
        return self._debounce.update(await self.read_raw(), now)
