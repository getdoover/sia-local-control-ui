// Render-core tests: ported from sia-local-control-ui tests/js/dashboard.test.mjs
// (Read Only / Touch, the touch bar, keypad, confirmations, VSD card, control
// mode switch, denial toasts), run against hmi-core.js in jsdom.
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TITLE,
  keypadInput,
  keypadStep,
  rateNeedsConfirm,
  rateStep,
  validateKeypadEntry,
} from "../src/core/hmi-core.js";
import {
  flush,
  isHidden,
  LEGACY_PAYLOADS,
  mountHmi,
  NEW_ONLY_IDS,
  touchPayload,
  withFeatures,
} from "./helpers.mjs";

const typeKeys = (m, keys) => {
  for (const k of keys) m.root.querySelector(`.keypad-keys [data-key="${k}"]`).click();
};

// --- backward compatibility ------------------------------------------------

for (const [name, payload] of Object.entries(LEGACY_PAYLOADS)) {
  test(`legacy payload "${name}": new elements hidden, nothing sent`, async () => {
    const m = mountHmi();
    m.render(payload);
    for (const id of NEW_ONLY_IDS) assert.ok(isHidden(m.byId(id)), `${id} should be hidden`);
    for (const id of ["touch-start", "touch-stop", "touch-reset", "reset-vsd-btn"]) m.click(id);
    await flush();
    assert.deepEqual(m.state.sent, []);
  });
}

test("loading overlay hides on the first payload", () => {
  const m = mountHmi();
  assert.ok(!isHidden(m.byId("loading-overlay")));
  m.render(null);
  assert.ok(!isHidden(m.byId("loading-overlay")));
  m.render(LEGACY_PAYLOADS.running);
  assert.ok(isHidden(m.byId("loading-overlay")));
});

test("pump card: target, flow, total, state and flow-range bar", () => {
  const m = mountHmi();
  m.render(LEGACY_PAYLOADS.running);
  assert.equal(m.root.querySelector('[data-id="target-rate"] .value').textContent, "12.50");
  assert.equal(m.root.querySelector('[data-id="flow-rate"] .value').textContent, "11.9");
  assert.equal(m.root.querySelector('[data-id="flow-total"] .secondary-value').textContent, "345.60");
  assert.equal(m.root.querySelector('[data-id="flow-total"] .secondary-unit').textContent, "L");
  const state = m.root.querySelector('[data-id="pump-state"] .state-value');
  assert.equal(state.textContent, "pumping");
  assert.ok(state.classList.contains("pumping"));
  assert.ok(!isHidden(m.byId("flow-range")));
  assert.equal(m.byId("flow-range-min").textContent, "2.00 L/Hr");
});

test("missing target rate shows a dash, never a made-up 0", () => {
  const m = mountHmi();
  m.render({ ...LEGACY_PAYLOADS.running, pumps: [{ ...LEGACY_PAYLOADS.running.pumps[0], target_rate: null }] });
  assert.equal(m.root.querySelector('[data-id="target-rate"] .value').textContent, "--");
  assert.ok(isHidden(m.byId("flow-range")));
});

test("fault and warning banners list their reasons", () => {
  const m = mountHmi();
  m.render(LEGACY_PAYLOADS.faulted);
  assert.ok(!isHidden(m.byId("fault-banner")));
  assert.equal(m.byId("fault-message-list").textContent, "Pump: Tank level low-low");
  m.render(LEGACY_PAYLOADS.warning_with_peripherals);
  assert.ok(isHidden(m.byId("fault-banner")));
  assert.ok(!isHidden(m.byId("warning-banner")));
});

test("connection status: connected, no controller, disconnected", () => {
  const m = mountHmi();
  m.render(LEGACY_PAYLOADS.running, { connected: true });
  assert.equal(m.byId("connection-status").textContent, "● Connected");
  m.render(LEGACY_PAYLOADS.no_controller, { connected: true });
  assert.equal(m.byId("connection-status").textContent, "● No controller");
  m.render(LEGACY_PAYLOADS.running, { connected: false });
  assert.equal(m.byId("connection-status").textContent, "● Disconnected");
});

test("solar card hidden when no solar controllers are configured", () => {
  const m = mountHmi();
  m.render(LEGACY_PAYLOADS.running);
  assert.ok(isHidden(m.byId("solar-section")));
  m.render(LEGACY_PAYLOADS.warning_with_peripherals);
  assert.ok(!isHidden(m.byId("solar-section")));
  assert.equal(m.root.querySelector('[data-id="battery-percentage"] .value').textContent, "81");
  assert.ok(!isHidden(m.byId("tank-section")));
  assert.ok(!isHidden(m.byId("skid-section")));
  assert.equal(m.root.querySelector('[data-id="skid-pressure"] .unit').textContent, "psi");
});

// --- controller features ------------------------------------------------------

test("no control mode card or switch, even if a payload carried one", async () => {
  const m = mountHmi();
  m.render(withFeatures({ control: { mode: "dcs" } }));
  assert.equal(m.root.querySelector('[data-id="mode-section"], [data-id="mode-switch"], .mode-btn'), null);
  assert.ok(![...m.root.querySelectorAll("h2")].some((h) => /Control Mode/.test(h.textContent)));
  for (const b of m.root.querySelectorAll("button")) b.click();
  await flush();
  assert.ok(!m.state.sent.some((c) => c.cmd === "set_control_mode"));
});

test("VSD card, drive line and trip description", () => {
  const m = mountHmi();
  m.render(
    withFeatures({
      vsd: { tripped: true, trip_code: 3, trip_description: "Over current", motor_hz: 0, pump_rpm: 0 },
    }),
  );
  assert.ok(!isHidden(m.byId("vsd-section")));
  assert.ok(!isHidden(m.byId("pump-drive-line")));
  assert.equal(m.byId("vsd-trip").textContent, "Over current (code 3)");
  assert.equal(m.root.querySelector('[data-id="vsd-status"] .state-value').textContent, "Tripped");
  assert.equal(m.byId("motor-hz").textContent, "0.0");
});

test("Reset Fault appears once: VSD card has only Reset VSD, the bar has Reset Fault", async () => {
  const m = mountHmi();
  m.render(withFeatures());
  const inCard = [...m.root.querySelectorAll(".vsd-actions button")].map((b) => b.dataset.id);
  assert.deepEqual(inCard, ["reset-vsd-btn"]);
  const resetFaults = [...m.root.querySelectorAll("button")].filter((b) =>
    /Reset\s+Fault/.test(b.textContent),
  );
  assert.equal(resetFaults.length, 1);
  assert.equal(resetFaults[0].dataset.id, "touch-reset");
  m.click("reset-vsd-btn");
  m.click("touch-reset");
  await flush();
  assert.deepEqual(m.state.sent, [
    { cmd: "reset_vsd_fault", value: null },
    { cmd: "reset_fault", value: null },
  ]);
});

test("features disappear again when the payload stops carrying them", () => {
  const m = mountHmi();
  m.render(withFeatures());
  m.render(LEGACY_PAYLOADS.running);
  for (const id of NEW_ONLY_IDS) assert.ok(isHidden(m.byId(id)), id);
});

// --- HMI Control Mode ------------------------------------------------------------

test("read only: status cards show but no on-screen control sends anything", async () => {
  const m = mountHmi();
  m.render(withFeatures({ touch: undefined, hmi_mode: "read_only" }));
  assert.ok(isHidden(m.byId("touch-bar")));
  assert.ok(m.byId("container").classList.contains("readonly"));
  assert.ok(!isHidden(m.byId("vsd-section")));
  for (const id of ["reset-vsd-btn", "touch-reset", "touch-start", "touch-stop"]) {
    m.click(id);
  }
  m.click("touch-rate");
  m.click("touch-cal");
  await flush();
  assert.deepEqual(m.state.sent, []);
  assert.ok(isHidden(m.byId("keypad")));
  assert.ok(!isHidden(m.byId("footer-logo")));
});

test("button mode is read only (reserved placeholder)", async () => {
  const m = mountHmi();
  m.render(withFeatures({ touch: undefined, hmi_mode: "button" }));
  assert.ok(isHidden(m.byId("touch-bar")));
  m.click("touch-start");
  await flush();
  assert.deepEqual(m.state.sent, []);
  assert.match(m.byId("host-badge").textContent, /Button/);
});

test("touch: bar renders with target, units and calibration factor", () => {
  const m = mountHmi();
  m.render(touchPayload());
  assert.ok(!isHidden(m.byId("touch-bar")));
  assert.equal(m.byId("touch-rate-value").textContent, "12.50");
  assert.equal(m.byId("touch-rate-unit").textContent, "L/Hr");
  assert.equal(m.byId("touch-cal-value").textContent, "1.00");
  assert.equal(m.byId("touch-start").disabled, false);
  assert.ok(m.byId("container").classList.contains("touch-mode"));
});

test("touch: start, stop and reset send the controller commands", async () => {
  const m = mountHmi();
  m.render(touchPayload());
  for (const id of ["touch-start", "touch-stop", "touch-reset"]) {
    m.click(id);
  }
  await flush();
  assert.deepEqual(m.state.sent, [
    { cmd: "set_pump_state", value: "start" },
    { cmd: "set_pump_state", value: "stop" },
    { cmd: "reset_fault", value: null },
  ]);
});

test("touch: the bar has no rate steppers; the rate changes only in its popover", async () => {
  const m = mountHmi();
  m.render(touchPayload());
  assert.equal(m.byId("touch-rate-up"), null);
  assert.equal(m.byId("touch-rate-down"), null);
  m.click("touch-rate");
  assert.ok(!isHidden(m.byId("keypad")));
  assert.ok(!isHidden(m.byId("keypad-step-up")));
  assert.ok(!isHidden(m.byId("keypad-step-down")));
  await flush();
  assert.deepEqual(m.state.sent, []);
});

test("touch: popover +/- step from the current rate, then OK sends set_target_rate", async () => {
  const m = mountHmi();
  m.render(touchPayload());
  m.click("touch-rate");
  // 12.5, max 92.16: each step is 4.608 (the controller's 5% nudge).
  m.click("keypad-step-up");
  assert.equal(m.byId("keypad-entry").textContent, "17.11");
  m.click("keypad-step-down");
  m.click("keypad-step-down");
  assert.equal(m.byId("keypad-entry").textContent, "7.89");
  await flush();
  assert.deepEqual(m.state.sent, [], "nothing is sent until OK");
  m.click("keypad-ok");
  // 12.5 -> 7.89 is over the 20% threshold: confirm first.
  assert.ok(!isHidden(m.byId("confirm")));
  m.click("confirm-ok");
  await flush();
  assert.deepEqual(m.state.sent, [{ cmd: "set_target_rate", value: 7.89 }]);
});

test("touch: popover steps stay inside the rate range and continue from a typed entry", () => {
  const m = mountHmi();
  m.render(touchPayload());
  m.click("touch-rate");
  typeKeys(m, ["9", "0"]);
  m.click("keypad-step-up");
  assert.equal(m.byId("keypad-entry").textContent, "92.16");
  m.click("keypad-cancel");
  m.click("touch-rate");
  typeKeys(m, ["3"]);
  m.click("keypad-step-down");
  assert.equal(m.byId("keypad-entry").textContent, "2.00");
});

test("touch: the calibration keypad has no step buttons", () => {
  const m = mountHmi();
  m.render(touchPayload());
  m.click("touch-cal");
  assert.ok(isHidden(m.byId("keypad-step-up")));
  assert.ok(isHidden(m.byId("keypad-step-down")));
});

test("rate step is the controller's 5% nudge; keypad steps clamp", () => {
  assert.equal(rateStep(92.16), 4.608);
  assert.equal(rateStep(0), 0);
  assert.equal(rateStep(null), 0);
  const range = { step: 4.608, min: 2, max: 92.16, decimals: 2 };
  assert.equal(keypadStep("12.50", 1, range), "17.11");
  assert.equal(keypadStep("12.50", -1, range), "7.89");
  assert.equal(keypadStep("90", 1, range), "92.16");
  assert.equal(keypadStep("3", -1, range), "2.00");
  assert.equal(keypadStep("", 1, range), "6.61");
});

test("header: title defaults, is set later, and falls back when cleared", () => {
  const m = mountHmi();
  assert.equal(m.byId("header-title").textContent, DEFAULT_TITLE);
  m.hmi.setTitle("CI-24101-A");
  assert.equal(m.byId("header-title").textContent, "CI-24101-A");
  m.hmi.setTitle("");
  assert.equal(m.byId("header-title").textContent, DEFAULT_TITLE);
});

test("touch: pending, success and error feedback on the control", async () => {
  const m = mountHmi();
  m.render(touchPayload());
  m.state.deferAcks = true;
  const start = m.byId("touch-start");
  start.click();
  assert.ok(start.classList.contains("pending"));
  start.click(); // ignored while pending
  m.click("touch-stop"); // Stop is still available
  assert.deepEqual(
    m.state.sent.map((c) => c.value),
    ["start", "stop"],
  );
  await m.ackNext({
    ok: false,
    code: "REMOTE_DENIED",
    message: "Control is set to DCS. Switch to Local to start from here.",
  });
  assert.ok(start.classList.contains("error"));
  const toast = m.byId("command-toast");
  assert.ok(!isHidden(toast));
  assert.ok(toast.classList.contains("error"));
  assert.equal(toast.textContent, "Control is set to DCS. Switch to Local to start from here.");
  await m.ackNext({ ok: true });
  assert.ok(m.byId("touch-stop").classList.contains("ok"));
});

test("touch: a success toast names what happened", async () => {
  const m = mountHmi();
  m.render(withFeatures());
  m.click("reset-vsd-btn");
  await flush();
  assert.equal(m.byId("command-toast").textContent, "VSD reset. Now press Reset Fault.");
  assert.ok(m.byId("command-toast").classList.contains("ok"));
});

test("touch: start disabled when faulted, with a hint; stop still enabled", async () => {
  const m = mountHmi();
  m.render({ ...LEGACY_PAYLOADS.faulted, touch: { calibration_factor: 1, calibration_min: 0.3, calibration_max: 1.7 } });
  assert.equal(m.byId("touch-start").disabled, true);
  assert.equal(m.byId("touch-start-hint").textContent, "Reset fault first");
  assert.equal(m.byId("touch-stop").disabled, false);
  assert.ok(m.byId("touch-reset").classList.contains("attention"));
  m.click("touch-start");
  m.click("touch-stop");
  await flush();
  assert.deepEqual(m.state.sent, [{ cmd: "set_pump_state", value: "stop" }]);
});

test("touch: small keypad rate change is sent without confirmation", async () => {
  const m = mountHmi();
  m.render(touchPayload());
  m.click("touch-rate");
  assert.ok(!isHidden(m.byId("keypad")));
  assert.equal(m.byId("keypad-range").textContent, "Range 2.00 to 92.16 L/Hr");
  assert.equal(m.byId("keypad-entry").textContent, "12.50"); // placeholder
  typeKeys(m, ["1", "4"]);
  m.click("keypad-ok");
  await flush();
  assert.ok(isHidden(m.byId("keypad")));
  assert.ok(isHidden(m.byId("confirm")));
  assert.deepEqual(m.state.sent, [{ cmd: "set_target_rate", value: 14 }]);
});

test("touch: rate change over 20% asks first; cancel sends nothing", async () => {
  const m = mountHmi();
  m.render(touchPayload());
  m.click("touch-rate");
  typeKeys(m, ["5", "0"]);
  m.click("keypad-ok");
  assert.ok(!isHidden(m.byId("confirm")));
  assert.equal(m.byId("confirm-message").textContent, "Change target rate from 12.50 to 50.00 L/Hr?");
  m.click("confirm-cancel");
  await flush();
  assert.deepEqual(m.state.sent, []);

  m.click("touch-rate");
  typeKeys(m, ["5", "0"]);
  m.click("keypad-ok");
  m.click("confirm-ok");
  await flush();
  assert.deepEqual(m.state.sent, [{ cmd: "set_target_rate", value: 50 }]);
});

test("touch: out-of-range rate is rejected in the keypad", async () => {
  const m = mountHmi();
  m.render(touchPayload());
  m.click("touch-rate");
  typeKeys(m, ["1", "0", "0"]);
  m.click("keypad-ok");
  assert.ok(!isHidden(m.byId("keypad")));
  assert.match(m.byId("keypad-error").textContent, /Out of range/);
  m.click("keypad-cancel");
  assert.ok(isHidden(m.byId("keypad")));
  await flush();
  assert.deepEqual(m.state.sent, []);
});

test("touch: rate keypad unavailable until the controller publishes min/max", () => {
  const m = mountHmi();
  const p = { ...LEGACY_PAYLOADS.running.pumps[0], min_rate: null, max_rate: null };
  m.render(touchPayload({ pumps: [p] }));
  assert.equal(m.byId("touch-rate").disabled, true);
});

test("touch: calibration factor always confirms and is range-checked", async () => {
  const m = mountHmi();
  m.render(touchPayload());
  m.click("touch-cal");
  assert.equal(m.byId("keypad-range").textContent, "Range 0.30 to 1.70");
  typeKeys(m, ["2"]);
  m.click("keypad-ok");
  assert.match(m.byId("keypad-error").textContent, /Out of range/);
  typeKeys(m, ["clear", "1", ".", "0", "5"]);
  m.click("keypad-ok");
  assert.equal(m.byId("confirm-message").textContent, "Change calibration factor from 1.00 to 1.05?");
  m.click("confirm-ok");
  await flush();
  assert.deepEqual(m.state.sent, [{ cmd: "last_calibration_factor", value: 1.05 }]);
});

test("touch: VSD card has Reset VSD when configured", async () => {
  const m = mountHmi();
  m.render(withFeatures());
  assert.ok(!m.byId("container").classList.contains("readonly"));
  m.click("reset-vsd-btn");
  await flush();
  assert.deepEqual(m.state.sent, [{ cmd: "reset_vsd_fault", value: null }]);
});

test("switching back to read only removes the touch bar and closes dialogs", () => {
  const m = mountHmi();
  m.render(touchPayload());
  assert.ok(isHidden(m.byId("footer-logo")));
  m.click("touch-rate");
  assert.ok(!isHidden(m.byId("keypad")));
  m.render(LEGACY_PAYLOADS.running);
  assert.ok(isHidden(m.byId("touch-bar")));
  assert.ok(isHidden(m.byId("keypad")));
  assert.ok(!isHidden(m.byId("footer-logo")));
});

test("a throwing or rejecting sender still ends in an error toast", async () => {
  const m = mountHmi({
    sendCommand: () => Promise.reject(new Error("boom")),
  });
  m.render(touchPayload());
  m.click("touch-start");
  await flush();
  await flush();
  assert.equal(m.byId("command-toast").textContent, "boom");
  assert.ok(m.byId("touch-start").classList.contains("error"));
});

// --- layout / host --------------------------------------------------------------

test("kiosk and embedded layouts share the markup; only the root class differs", () => {
  const k = mountHmi({ layout: "kiosk", hostLabel: "Local panel" });
  const e = mountHmi({ layout: "embedded", hostLabel: "Cloud" });
  assert.ok(k.root.classList.contains("kiosk"));
  assert.ok(e.root.classList.contains("embedded"));
  const ids = (m) => [...m.root.querySelectorAll("[data-id]")].map((x) => x.dataset.id).join(",");
  assert.equal(ids(k), ids(e));
  k.render(touchPayload());
  e.render(touchPayload());
  assert.equal(k.byId("host-badge").textContent, "Local panel · Touch");
  assert.equal(e.byId("host-badge").textContent, "Cloud · Touch");
});

test("no document-wide ids: two instances on one page do not collide", () => {
  const m = mountHmi();
  assert.equal(m.root.querySelectorAll("[id]").length, 0);
});

test("destroy empties the root and stops timers", async () => {
  const m = mountHmi();
  m.render(touchPayload());
  m.click("touch-start");
  await flush();
  m.hmi.destroy();
  assert.equal(m.root.innerHTML, "");
  assert.ok(!m.root.classList.contains("sia-hmi"));
});

// --- keypad helpers -----------------------------------------------------------------

test("keypad input rules", () => {
  const run = (keys) => keys.reduce((t, k) => keypadInput(t, k), "");
  assert.equal(run(["1", ".", "2", ".", "5"]), "1.25");
  assert.equal(run([".", "5"]), "0.5");
  assert.equal(run(["0", "7"]), "7");
  assert.equal(run(["1", "2", "back"]), "1");
  assert.equal(run(["1", "2", "clear"]), "");
  assert.equal(run(["9", "9", "9", "9", "9", "9", "9", "9", "9"]), "99999999");
});

test("keypad validation", () => {
  const v = (t, min, max) => validateKeypadEntry(t, min, max);
  assert.deepEqual(v("", 0.3, 1.7), { ok: false, error: "Enter a number" });
  assert.deepEqual(v(".", 0.3, 1.7), { ok: false, error: "Enter a number" });
  assert.deepEqual(v("0.2", 0.3, 1.7), { ok: false, error: "Out of range (0.3 to 1.7)" });
  assert.equal(v("1.8", 0.3, 1.7).ok, false);
  assert.deepEqual(v("0.3", 0.3, 1.7), { ok: true, value: 0.3 });
  assert.deepEqual(v("1.7", 0.3, 1.7), { ok: true, value: 1.7 });
});

test("rate confirmation threshold is 20% of the current target", () => {
  assert.equal(rateNeedsConfirm(10, 12), false);
  assert.equal(rateNeedsConfirm(10, 12.5), true);
  assert.equal(rateNeedsConfirm(10, 7.9), true);
  assert.equal(rateNeedsConfirm(null, 5), true);
  assert.equal(rateNeedsConfirm(0, 5), true);
});

test("skid card shows only the readings that have a source", () => {
  const m = mountHmi();
  m.render({ ...LEGACY_PAYLOADS.running, skid: { skid_pressure: 350.2 } });
  assert.ok(!isHidden(m.byId("skid-section")));
  assert.ok(isHidden(m.byId("skid-flow-card")));
  assert.ok(!isHidden(m.byId("skid-pressure-card")));
  m.render(LEGACY_PAYLOADS.warning_with_peripherals);
  assert.ok(!isHidden(m.byId("skid-flow-card")));
});

test("status row: Tank, then VSD to its right, then Solar", () => {
  const m = mountHmi();
  const row = m.byId("status-row");
  const order = [...row.children].map((c) => c.dataset.id);
  assert.deepEqual(order, ["tank-section", "vsd-section", "solar-section"]);
});
