// 1min Calibration Sequence wizard in the render core (jsdom): the tile
// switch, every page transition including Back, validation, the start and
// cancel payloads, following the controller's TestRun* tags, reattaching
// after a reload, and Set calibration factor vs Discard.
import assert from "node:assert/strict";
import test from "node:test";

import { CAL_STORE_KEY, CAL_TITLE } from "../src/core/hmi-core.js";
import { flush, isHidden, LEGACY_PAYLOADS, mountHmi, pump, touchPayload } from "./helpers.mjs";

const URL = "http://panel.local/";

const run = (over = {}) => ({
  active: false,
  remaining_s: 0,
  rate: null,
  duration_s: null,
  elapsed_s: null,
  result: null,
  ...over,
});

/** Touch, pump in standby, Calibration Method Manual (HMI). */
const calPayload = (tr = {}, pumpOver = {}) =>
  touchPayload({
    pumps: [pump({ state: "standby", running: false, flow_rate: 0, ...pumpOver })],
    calibration: { method: "Manual (HMI)", test_run: run(tr) },
  });

const typeKeys = (m, keys) => {
  for (const k of keys) m.root.querySelector(`.keypad-keys [data-key="${k}"]`).click();
};

const page = (m) => m.byId("calwiz-body").getAttribute("data-page");
const text = (m, id) => m.byId(id).textContent;
const next = (m) => m.click("calwiz-next");
const back = (m) => m.click("calwiz-back");
const wizardOpen = (m) => !isHidden(m.byId("calwiz"));

/** Enter a value on the open keypad. */
function enter(m, keys) {
  typeKeys(m, ["clear", ...String(keys).split("")]);
  m.click("keypad-ok");
}

/** Pages 1 to 4, ready to Start Test. */
function toSummary(m, { start = "500", rate = null } = {}) {
  m.click("touch-cal");
  next(m); // 1 -> 2
  m.click("calwiz-field-start");
  enter(m, start);
  next(m); // 2 -> 3
  if (rate !== null) {
    m.click("calwiz-field-rate");
    enter(m, rate);
  }
  next(m); // 3 -> 4
}

async function toRunning(m, opts) {
  toSummary(m, opts);
  next(m); // Start Test
  await flush();
  m.render(calPayload({ active: true, remaining_s: 60, rate: 12.5, duration_s: 60 }, { state: "pumping", running: true, flow_rate: 12.1 }));
}

async function toResults(m, { final = "300", elapsed = 60 } = {}) {
  await toRunning(m);
  m.render(calPayload({ active: false, remaining_s: 0, rate: 12.5, duration_s: 60, elapsed_s: elapsed, result: "completed" }));
  m.click("calwiz-field-final");
  enter(m, final);
  next(m); // 6 -> 7
}

// --- the tile ------------------------------------------------------------------

test("tile: CAL FACTOR as today without the calibration payload", async () => {
  const m = mountHmi();
  m.render(touchPayload());
  const tile = m.byId("touch-cal");
  assert.ok(!tile.classList.contains("calibrate"));
  assert.equal(text(m, "touch-cal-caption"), "Cal factor");
  assert.equal(text(m, "touch-cal-value"), "1.00");
  m.click("touch-cal");
  assert.ok(!wizardOpen(m));
  assert.ok(!isHidden(m.byId("keypad")));
  assert.equal(text(m, "keypad-title"), "Calibration factor");
});

test("tile: CALIBRATE with the factor underneath when the method is Manual (HMI)", () => {
  const m = mountHmi();
  m.render(calPayload());
  const tile = m.byId("touch-cal");
  assert.ok(tile.classList.contains("calibrate"));
  assert.equal(text(m, "touch-cal-value"), "Calibrate");
  assert.equal(text(m, "touch-cal-caption"), "Factor 1.00");
  assert.equal(tile.disabled, false);
  m.click("touch-cal");
  assert.ok(wizardOpen(m));
  assert.equal(page(m), "1");
  assert.ok(isHidden(m.byId("keypad")));
});

test("tile: switches back to CAL FACTOR when the method changes", () => {
  const m = mountHmi();
  m.render(calPayload());
  m.render(touchPayload());
  assert.ok(!m.byId("touch-cal").classList.contains("calibrate"));
  assert.equal(text(m, "touch-cal-caption"), "Cal factor");
});

test("tile: disabled with a hint while faulted or running", () => {
  const m = mountHmi();
  m.render(calPayload({}, { state: "fault", fault: true, fault_reason: "Pressure high-high" }));
  assert.equal(m.byId("touch-cal").disabled, true);
  assert.equal(text(m, "touch-cal-hint"), "Reset fault first");
  m.render(calPayload({}, { state: "pumping", running: true }));
  assert.equal(m.byId("touch-cal").disabled, true);
  assert.equal(text(m, "touch-cal-hint"), "Stop pump first");
  m.byId("touch-cal").disabled = false; // even if clicked, nothing opens
  m.click("touch-cal");
  assert.ok(!wizardOpen(m));
});

test("tile: no touch bar at all in Read Only, even with Manual (HMI)", () => {
  const m = mountHmi();
  m.render({ ...LEGACY_PAYLOADS.running, calibration: { method: "Manual (HMI)", test_run: run() } });
  assert.ok(isHidden(m.byId("touch-bar")));
  assert.ok(!wizardOpen(m));
});

// --- pages ----------------------------------------------------------------------

test("every page carries the title; page 1 asks about the valve and site glass", () => {
  const m = mountHmi();
  m.render(calPayload());
  m.click("touch-cal");
  assert.equal(m.root.querySelector(".calwiz-title").textContent, CAL_TITLE);
  assert.equal(CAL_TITLE, "1min Calibration Sequence");
  assert.match(text(m, "calwiz-body"), /Please confirm the tank valve is shut off and the site glass is open/);
  assert.equal(text(m, "calwiz-next"), "Confirm");
  assert.ok(!isHidden(m.byId("calwiz-back")));
  assert.ok(!isHidden(m.byId("calwiz-close")));
});

test("forward through pages 1 to 4, and Back from each", () => {
  const m = mountHmi();
  m.render(calPayload());
  m.click("touch-cal");
  next(m);
  assert.equal(page(m), "2");
  back(m);
  assert.equal(page(m), "1");
  next(m);
  m.click("calwiz-field-start");
  assert.equal(text(m, "keypad-title"), "Site glass mL");
  enter(m, "500");
  assert.match(text(m, "calwiz-body"), /500/);
  next(m);
  assert.equal(page(m), "3");
  back(m);
  assert.equal(page(m), "2");
  assert.match(text(m, "calwiz-body"), /500/); // kept
  next(m);
  // Test rate defaults to the current target.
  assert.match(text(m, "calwiz-body"), /12\.50/);
  assert.match(text(m, "calwiz-body"), /Range 2\.00 to 92\.16 L\/Hr/);
  next(m);
  assert.equal(page(m), "4");
  assert.equal(text(m, "calwiz-next"), "Start Test");
  const body = text(m, "calwiz-body");
  assert.match(body, /Start site glass\s*500\s*mL/);
  assert.match(body, /Test rate\s*12\.50\s*L\/Hr/);
  assert.match(body, /Duration\s*60\s*s/);
  assert.match(body, /The pump will run for 1 minute/);
  back(m);
  assert.equal(page(m), "3");
});

test("Back on page 1 and X close the wizard without sending anything", async () => {
  const m = mountHmi();
  m.render(calPayload());
  m.click("touch-cal");
  back(m);
  assert.ok(!wizardOpen(m));
  m.click("touch-cal");
  next(m);
  m.click("calwiz-close");
  assert.ok(!wizardOpen(m));
  await flush();
  assert.deepEqual(m.state.sent, []);
});

test("validation: start mL must be more than 0 (Confirm disabled until valid)", () => {
  const m = mountHmi();
  m.render(calPayload());
  m.click("touch-cal");
  next(m);
  assert.equal(m.byId("calwiz-next").disabled, true);
  m.click("calwiz-field-start");
  enter(m, "0");
  assert.ok(!isHidden(m.byId("keypad")));
  assert.equal(text(m, "keypad-error"), "Must be more than 0 mL");
  enter(m, "250.5");
  assert.ok(isHidden(m.byId("keypad")));
  assert.equal(m.byId("calwiz-next").disabled, false);
});

test("validation: the test rate stays within the pump range", () => {
  const m = mountHmi();
  m.render(calPayload());
  toSummary(m);
  back(m); // page 3
  m.click("calwiz-field-rate");
  assert.equal(text(m, "keypad-range"), "Range 2.00 to 92.16 L/Hr");
  enter(m, "100");
  assert.match(text(m, "keypad-error"), /Out of range/);
  enter(m, "1");
  assert.match(text(m, "keypad-error"), /Out of range/);
  enter(m, "30");
  next(m);
  assert.match(text(m, "calwiz-body"), /Test rate\s*30\.00/);
});

test("Start Test sends start_test_run {rate, duration_s: 60}, then the countdown", async () => {
  const m = mountHmi();
  m.render(calPayload());
  toSummary(m, { rate: "30" });
  next(m);
  await flush();
  assert.deepEqual(m.state.sent, [{ cmd: "start_test_run", value: { rate: 30, duration_s: 60 } }]);
  assert.equal(page(m), "5");
  // Running: no Back, no X, no Confirm; a Cancel.
  for (const id of ["calwiz-back", "calwiz-close", "calwiz-next"]) assert.ok(isHidden(m.byId(id)), id);
  assert.ok(!isHidden(m.byId("calwiz-cancel")));
  m.render(calPayload({ active: true, remaining_s: 41.2, rate: 30, duration_s: 60 }, { state: "pumping", running: true, flow_rate: 29.4 }));
  assert.equal(text(m, "calwiz-countdown"), "42");
  assert.equal(text(m, "calwiz-flow"), "29.40");
  assert.equal(text(m, "calwiz-run-rate"), "30.00");
  assert.equal(m.byId("calwiz-progress").style.width, `${(1 - 41.2 / 60) * 100}%`);
  // The tile reads Testing and cannot close the wizard.
  assert.equal(text(m, "touch-cal-value"), "Testing");
  m.click("calwiz-close");
  assert.ok(wizardOpen(m));
});

test("a refused start stays on the summary with the controller's reason", async () => {
  const m = mountHmi();
  m.render(calPayload());
  m.state.ackReply = { ok: false, code: "NOT_READY", message: "Refused: the pump is pumping; stop it before a test run" };
  toSummary(m);
  next(m);
  await flush();
  assert.equal(page(m), "4");
  assert.match(text(m, "calwiz-error"), /stop it before a test run/);
});

test("Start Test is disabled while the pump runs or is faulted", () => {
  const m = mountHmi();
  m.render(calPayload());
  toSummary(m);
  m.render(calPayload({}, { state: "pumping", running: true }));
  assert.equal(m.byId("calwiz-next").disabled, true);
  assert.match(text(m, "calwiz-start-note"), /stop it first/);
  m.render(calPayload());
  assert.equal(m.byId("calwiz-next").disabled, false);
});

test("a stale result from an earlier test does not end a new one", async () => {
  const m = mountHmi();
  m.render(calPayload({ result: "completed", elapsed_s: 60 }));
  toSummary(m);
  next(m);
  await flush();
  // The tags have not caught up yet: still the old run's result.
  m.render(calPayload({ result: "completed", elapsed_s: 60 }));
  assert.equal(page(m), "5");
  m.render(calPayload({ active: true, remaining_s: 59, rate: 12.5, duration_s: 60 }, { state: "pumping", running: true }));
  assert.equal(page(m), "5");
});

test("Cancel sends cancel_test_run; cancelled shows why, with Back and Close", async () => {
  const m = mountHmi();
  m.render(calPayload());
  await toRunning(m);
  m.click("calwiz-cancel");
  await flush();
  assert.deepEqual(m.state.sent.at(-1), { cmd: "cancel_test_run", value: null });
  m.render(calPayload({ active: false, result: "cancelled", elapsed_s: 12.5 }));
  assert.equal(page(m), "ended");
  assert.match(text(m, "calwiz-ended"), /cancelled/);
  assert.equal(text(m, "calwiz-next"), "Close");
  assert.ok(!isHidden(m.byId("calwiz-back")));
  back(m);
  assert.equal(page(m), "2"); // read the site glass again
  m.click("calwiz-close");
  assert.ok(!wizardOpen(m));
});

test("a fault mid-test shows the fault reason; Close closes", async () => {
  const m = mountHmi();
  m.render(calPayload());
  await toRunning(m);
  m.render(calPayload({ active: false, result: "faulted", elapsed_s: 30 }, { state: "fault", fault: true, fault_reason: "Pressure high-high" }));
  assert.equal(page(m), "ended");
  assert.match(text(m, "calwiz-ended"), /faulted: Pressure high-high/);
  next(m);
  assert.ok(!wizardOpen(m));
});

test("completed: final mL, which must be less than the start", async () => {
  const m = mountHmi();
  m.render(calPayload());
  await toRunning(m);
  m.render(calPayload({ active: false, rate: 12.5, duration_s: 60, elapsed_s: 60.0, result: "completed" }));
  assert.equal(page(m), "6");
  assert.match(text(m, "calwiz-body"), /Start was 500 mL\. Test ran 60\.0 s\./);
  assert.equal(m.byId("calwiz-next").disabled, true);
  m.click("calwiz-field-final");
  assert.equal(text(m, "keypad-title"), "Final site glass mL");
  enter(m, "500");
  assert.equal(text(m, "keypad-error"), "Must be less than the starting 500 mL");
  enter(m, "600");
  assert.match(text(m, "keypad-error"), /less than/);
  enter(m, "300");
  assert.equal(m.byId("calwiz-next").disabled, false);
  // Back from 6 starts over from the starting reading.
  back(m);
  assert.equal(page(m), "2");
});

test("results: worked numbers (200 mL in 60 s at 12.50 L/Hr, 1.00 -> 1.04)", async () => {
  const m = mountHmi();
  m.render(calPayload());
  await toResults(m);
  assert.equal(page(m), "7");
  assert.match(text(m, "calwiz-delivered"), /200\s*mL/);
  assert.match(text(m, "calwiz-measured"), /12\.00\s*L\/Hr/);
  assert.match(text(m, "calwiz-target"), /12\.50\s*L\/Hr/);
  assert.equal(text(m, "calwiz-new-factor"), "1.04");
  assert.match(text(m, "calwiz-factor"), /1\.00 → 1\.04/);
  assert.equal(m.byId("calwiz-clamped"), null);
  assert.equal(text(m, "calwiz-next"), "Set calibration factor");
  assert.ok(!isHidden(m.byId("calwiz-discard")));
  back(m);
  assert.equal(page(m), "6");
});

test("results: uses the controller's actual run time", async () => {
  const m = mountHmi();
  m.render(calPayload());
  await toResults(m, { elapsed: 60.4 });
  assert.match(text(m, "calwiz-measured"), /11\.92/);
  assert.equal(text(m, "calwiz-new-factor"), "1.05");
});

test("results: a clamped factor says so", async () => {
  const m = mountHmi();
  m.render(calPayload());
  await toResults(m, { final: "450" });
  assert.equal(text(m, "calwiz-new-factor"), "1.70");
  assert.match(text(m, "calwiz-clamped"), /outside 0\.3 to 1\.7, so it is limited to 1\.70/);
});

test("Set calibration factor sends last_calibration_factor and shows success", async () => {
  const m = mountHmi();
  m.render(calPayload());
  await toResults(m);
  next(m);
  await flush();
  assert.deepEqual(m.state.sent.at(-1), { cmd: "last_calibration_factor", value: 1.04 });
  assert.equal(text(m, "calwiz-saved"), "Calibration factor set to 1.04.");
  assert.equal(text(m, "calwiz-next"), "Close");
  assert.ok(isHidden(m.byId("calwiz-discard")));
  assert.equal(text(m, "command-toast"), "Calibration factor updated");
  next(m);
  assert.ok(!wizardOpen(m));
});

test("a refused factor keeps the results with the reason", async () => {
  const m = mountHmi();
  m.render(calPayload());
  await toResults(m);
  m.state.ackReply = { ok: false, message: "Refused: nope" };
  next(m);
  await flush();
  assert.equal(page(m), "7");
  assert.match(text(m, "calwiz-error"), /nope/);
  assert.equal(text(m, "calwiz-next"), "Set calibration factor");
});

test("Discard closes without setting the factor", async () => {
  const m = mountHmi();
  m.render(calPayload());
  await toResults(m);
  const before = m.state.sent.length;
  m.click("calwiz-discard");
  await flush();
  assert.ok(!wizardOpen(m));
  assert.equal(m.state.sent.length, before);
  assert.ok(!m.state.sent.some((c) => c.cmd === "last_calibration_factor"));
});

test("Set factor manually opens the existing keypad (and its confirmation)", async () => {
  const m = mountHmi();
  m.render(calPayload());
  m.click("touch-cal");
  m.click("calwiz-manual");
  assert.ok(!wizardOpen(m));
  assert.equal(text(m, "keypad-title"), "Calibration factor");
  enter(m, "1.05");
  m.click("confirm-ok");
  await flush();
  assert.deepEqual(m.state.sent, [{ cmd: "last_calibration_factor", value: 1.05 }]);
});

// --- reattach -----------------------------------------------------------------------

test("reload mid-test: reattaches to the running test with the saved inputs", async () => {
  const m = mountHmi({ url: URL });
  m.render(calPayload());
  await toRunning(m);
  assert.ok(m.dom.window.localStorage.getItem(CAL_STORE_KEY));
  m.hmi.destroy();

  // The widget reloads in the same page: a fresh render core.
  const again = mountHmi({ dom: m.dom });
  again.render(calPayload({ active: true, remaining_s: 30, rate: 12.5, duration_s: 60 }, { state: "pumping", running: true, flow_rate: 12 }));
  assert.ok(wizardOpen(again));
  assert.equal(page(again), "5");
  assert.equal(text(again, "calwiz-countdown"), "30");
  again.render(calPayload({ active: false, rate: 12.5, duration_s: 60, elapsed_s: 60, result: "completed" }));
  assert.equal(page(again), "6");
  assert.match(text(again, "calwiz-body"), /Start was 500 mL/);
  again.click("calwiz-field-final");
  enter(again, "300");
  next(again);
  assert.equal(text(again, "calwiz-new-factor"), "1.04");
});

test("reattach without saved inputs asks for the starting reading too", async () => {
  const m = mountHmi();
  m.render(calPayload({ active: true, remaining_s: 20, rate: 12.5, duration_s: 60 }, { state: "pumping", running: true }));
  assert.ok(wizardOpen(m));
  assert.equal(page(m), "5");
  m.render(calPayload({ active: false, rate: 12.5, duration_s: 60, elapsed_s: 60, result: "completed" }));
  assert.equal(page(m), "6");
  assert.ok(m.byId("calwiz-field-start"));
  m.click("calwiz-field-start");
  enter(m, "500");
  m.click("calwiz-field-final");
  enter(m, "300");
  next(m);
  assert.equal(text(m, "calwiz-new-factor"), "1.04");
});

test("a test started elsewhere takes over an open wizard", () => {
  const m = mountHmi();
  m.render(calPayload());
  m.click("touch-cal");
  next(m);
  m.render(calPayload({ active: true, remaining_s: 50, rate: 12.5, duration_s: 60 }, { state: "pumping", running: true }));
  assert.equal(page(m), "5");
});

test("leaving Touch (or Manual) closes the wizard", () => {
  const m = mountHmi();
  m.render(calPayload());
  m.click("touch-cal");
  m.render(touchPayload());
  assert.ok(!wizardOpen(m));
  m.render(calPayload());
  m.click("touch-cal");
  m.render(LEGACY_PAYLOADS.running);
  assert.ok(!wizardOpen(m));
});
