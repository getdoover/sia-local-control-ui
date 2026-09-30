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
/** Looks disabled (a blocked key still takes the tap, to say why). */
const blocked = (m, id) => m.byId(id).getAttribute("aria-disabled") === "true" && m.byId(id).classList.contains("blocked");
const toast = (m) => (isHidden(m.byId("command-toast")) ? "" : m.byId("command-toast").textContent);

/** Enter a value on the open keypad. */
function enter(m, keys) {
  typeKeys(m, ["clear", ...String(keys).split("")]);
  m.click("keypad-ok");
}

/** Pages 1 to 4, ready to Start Test. */
function toSummary(m, { start = "50", rate = null } = {}) {
  m.click("touch-cal");
  m.click("calwiz-run"); // start -> 1
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

async function toResults(m, { final = "250", elapsed = 60 } = {}) {
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
  assert.equal(page(m), "start");
  assert.ok(isHidden(m.byId("keypad")));
});

test("tile: switches back to CAL FACTOR when the method changes", () => {
  const m = mountHmi();
  m.render(calPayload());
  m.render(touchPayload());
  assert.ok(!m.byId("touch-cal").classList.contains("calibrate"));
  assert.equal(text(m, "touch-cal-caption"), "Cal factor");
});

test("tile: blocked with a hint while faulted or running; a tap says why", () => {
  const m = mountHmi();
  m.render(calPayload({}, { state: "fault", fault: true, fault_reason: "Pressure high-high" }));
  // Not `disabled`: a disabled button would swallow the tap silently.
  assert.equal(m.byId("touch-cal").disabled, false);
  assert.ok(blocked(m, "touch-cal"));
  assert.equal(text(m, "touch-cal-hint"), "Reset fault first");
  m.click("touch-cal");
  assert.ok(!wizardOpen(m));
  assert.equal(toast(m), "Reset the fault first");
  m.render(calPayload({}, { state: "pumping", running: true }));
  assert.ok(blocked(m, "touch-cal"));
  assert.equal(text(m, "touch-cal-hint"), "Stop pump first");
  m.click("touch-cal");
  assert.ok(!wizardOpen(m));
  assert.equal(toast(m), "Stop the pump before calibrating");
  m.render(calPayload());
  assert.ok(!blocked(m, "touch-cal"));
  assert.equal(m.byId("touch-cal").getAttribute("aria-disabled"), "false");
});

test("tile: no touch bar at all in Read Only, even with Manual (HMI)", () => {
  const m = mountHmi();
  m.render({ ...LEGACY_PAYLOADS.running, calibration: { method: "Manual (HMI)", test_run: run() } });
  assert.ok(isHidden(m.byId("touch-bar")));
  assert.ok(!wizardOpen(m));
});

// --- help -----------------------------------------------------------------------

test("the ? opens the calibration factor help over the wizard; its X closes only the help", () => {
  const m = mountHmi();
  m.render(calPayload());
  m.click("touch-cal");
  const help = m.byId("cal-help");
  assert.ok(isHidden(help));
  // Top left: the first thing in the wizard's header.
  assert.equal(m.root.querySelector(".calwiz-head").firstElementChild, m.byId("calwiz-help"));
  m.click("calwiz-help");
  assert.ok(!isHidden(help));
  assert.match(help.textContent, /real flow matches the target rate/);
  assert.match(help.textContent, /less than the target: raise the factor/);
  assert.match(help.textContent, /more than the target: lower the factor/);
  m.click("cal-help-close");
  assert.ok(isHidden(help));
  assert.ok(wizardOpen(m));
  assert.equal(page(m), "start");
});

test("the ? is on the calibration factor keypad only", () => {
  const m = mountHmi();
  m.render(calPayload());
  m.click("touch-cal");
  m.click("calwiz-run");
  next(m);
  m.click("calwiz-field-start"); // Site glass mL keypad: no ?
  assert.ok(isHidden(m.byId("keypad-help")));
  m.click("keypad-cancel");
  back(m);
  back(m);
  m.click("calwiz-manual"); // Calibration factor keypad
  assert.equal(text(m, "keypad-title"), "Calibration factor");
  assert.ok(!isHidden(m.byId("keypad-help")));
  m.click("keypad-help");
  assert.ok(!isHidden(m.byId("cal-help")));
  m.click("cal-help-close");
  assert.ok(isHidden(m.byId("cal-help")));
  assert.equal(text(m, "keypad-title"), "Calibration factor"); // keypad still open
});

// --- pages ----------------------------------------------------------------------

test("the first page is the choice: Run calibration, or enter the factor manually", () => {
  const m = mountHmi();
  m.render(calPayload());
  m.click("touch-cal");
  assert.equal(m.root.querySelector(".calwiz-title").textContent, CAL_TITLE);
  assert.equal(CAL_TITLE, "1min Calibration Sequence");
  assert.equal(page(m), "start");
  assert.equal(m.byId("calwiz-box").getAttribute("data-page"), "start");
  assert.equal(text(m, "calwiz-step"), "", "no step number until the sequence starts");
  const run = m.byId("calwiz-run");
  const manual = m.byId("calwiz-manual");
  assert.equal(text(m, "calwiz-run"), "Run calibration");
  assert.equal(text(m, "calwiz-manual"), "Enter calibration factor manually");
  // Both in the body, Run first; no Back and no Confirm: the X closes.
  assert.ok(m.byId("calwiz-body").contains(run) && m.byId("calwiz-body").contains(manual));
  assert.ok(run.compareDocumentPosition(manual) & 4);
  assert.ok(isHidden(m.byId("calwiz-back")));
  assert.ok(isHidden(m.byId("calwiz-next")));
  assert.ok(!isHidden(m.byId("calwiz-close")));
  m.click("calwiz-run");
  assert.equal(page(m), "1");
  assert.equal(text(m, "calwiz-step"), "Step 1 of 7");
});

test("page 1: the valve is shut and the level is visible; Back returns to the choice", () => {
  const m = mountHmi();
  m.render(calPayload());
  m.click("touch-cal");
  m.click("calwiz-run");
  const body = text(m, "calwiz-body");
  assert.match(body, /Make sure the tank valve is shut, AND make sure you can see the fluid level in the site glass\./);
  assert.match(body, /You may need to manually start the pump to bring the level down if the tank is over half full\./);
  assert.equal(text(m, "calwiz-next"), "Confirm");
  assert.ok(!isHidden(m.byId("calwiz-back")));
  assert.ok(!isHidden(m.byId("calwiz-close")));
  assert.equal(m.byId("calwiz-box").getAttribute("data-page"), "1");
  next(m);
  assert.equal(page(m), "2");
  back(m);
  assert.equal(page(m), "1");
  back(m);
  assert.equal(page(m), "start");
  assert.ok(wizardOpen(m));
});

test("forward through pages 1 to 4, and Back from each", () => {
  const m = mountHmi();
  m.render(calPayload());
  m.click("touch-cal");
  m.click("calwiz-run");
  next(m);
  assert.equal(page(m), "2");
  back(m);
  assert.equal(page(m), "1");
  next(m);
  m.click("calwiz-field-start");
  assert.equal(text(m, "keypad-title"), "Site glass mL");
  enter(m, "50");
  assert.match(text(m, "calwiz-body"), /50/);
  next(m);
  assert.equal(page(m), "3");
  back(m);
  assert.equal(page(m), "2");
  assert.match(text(m, "calwiz-body"), /50/); // kept
  next(m);
  // Test rate defaults to the current target; the range is capped by the
  // glass (218 mL of room over 60 s is 13.08 L/Hr).
  assert.match(text(m, "calwiz-body"), /12\.50/);
  assert.match(text(m, "calwiz-body"), /Range 2\.00 to 13\.08 L\/Hr/);
  next(m);
  assert.equal(page(m), "4");
  assert.equal(text(m, "calwiz-next"), "Start Test");
  const body = text(m, "calwiz-body");
  assert.match(body, /Start site glass\s*50\s*mL/);
  assert.match(body, /Test rate\s*12\.50\s*L\/Hr/);
  assert.match(body, /Duration\s*60\s*s/);
  assert.match(body, /The pump will run for 1 minute/);
  back(m);
  assert.equal(page(m), "3");
});

test("X closes the wizard from the choice and from a page without sending anything", async () => {
  const m = mountHmi();
  m.render(calPayload());
  m.click("touch-cal");
  m.click("calwiz-close");
  assert.ok(!wizardOpen(m));
  m.click("touch-cal");
  m.click("calwiz-run");
  next(m);
  m.click("calwiz-close");
  assert.ok(!wizardOpen(m));
  await flush();
  assert.deepEqual(m.state.sent, []);
});

test("validation: start mL entered (0 allowed; Confirm disabled until valid)", () => {
  const m = mountHmi();
  m.render(calPayload());
  m.click("touch-cal");
  m.click("calwiz-run");
  next(m);
  assert.ok(blocked(m, "calwiz-next"));
  next(m); // a tap while blocked stays and says why
  assert.equal(page(m), "2");
  assert.equal(text(m, "calwiz-error"), "Enter the site glass reading in mL");
  m.click("calwiz-field-start");
  enter(m, "0"); // an empty-looking site glass is a valid starting reading
  assert.ok(isHidden(m.byId("keypad")));
  m.click("calwiz-field-start");
  enter(m, "268"); // the bottom of the scale: no room for a test
  assert.match(text(m, "keypad-error"), /less than 268 mL/);
  enter(m, "250.5");
  assert.ok(isHidden(m.byId("keypad")));
  assert.ok(!blocked(m, "calwiz-next"));
});

test("validation: the test rate stays within the pump range and the glass's room", () => {
  const m = mountHmi();
  m.render(calPayload());
  toSummary(m); // start 50: 218 mL of room, 13.08 L/Hr
  back(m); // page 3
  m.click("calwiz-field-rate");
  assert.equal(text(m, "keypad-range"), "Range 2.00 to 13.08 L/Hr (site glass limit)");
  enter(m, "100");
  assert.match(text(m, "keypad-error"), /Above 13\.08 the site glass would run past 268 mL in 60 s/);
  enter(m, "1");
  assert.match(text(m, "keypad-error"), /Out of range \(2\.00 to 13\.08\)/);
  enter(m, "13.08");
  next(m);
  assert.match(text(m, "calwiz-body"), /Test rate\s*13\.08/);
});

test("the rate page says what the glass allows: 180 mL start, 88 mL of room, 5.28 L/Hr", () => {
  const m = mountHmi();
  m.render(calPayload());
  toSummary(m, { start: "180" });
  back(m); // page 3
  const note = text(m, "calwiz-glass-note");
  assert.match(note, /Site glass: 180 mL now, 268 mL at the bottom of the scale, so 88 mL of room\./);
  assert.match(note, /Over the 60 s test the rate is limited to 5\.28 L\/Hr: any faster and the level would drop below what the glass can measure\./);
  assert.ok(m.byId("calwiz-glass-note").classList.contains("calwiz-warn"));
  assert.match(text(m, "calwiz-body"), /Range 2\.00 to 5\.28 L\/Hr/);
  // The default rate (the 12.50 target) was brought down to the limit.
  assert.match(text(m, "calwiz-body"), /Test rate\s*5\.28/);
  assert.ok(!blocked(m, "calwiz-next"));
  next(m);
  assert.match(text(m, "calwiz-body"), /Test rate\s*5\.28\s*L\/Hr/);
});

test("a start reading with room for the whole pump range says so, without a limit", () => {
  const m = mountHmi();
  m.render(calPayload({}, { min_rate: 2, max_rate: 4 }));
  toSummary(m, { start: "180", rate: "3" });
  back(m);
  const note = text(m, "calwiz-glass-note");
  assert.match(note, /88 mL of room\. That is enough for the pump's full range over the 60 s test\./);
  assert.ok(!m.byId("calwiz-glass-note").classList.contains("calwiz-warn"));
  assert.match(text(m, "calwiz-body"), /Range 2\.00 to 4\.00 L\/Hr/);
  m.click("calwiz-field-rate");
  assert.equal(text(m, "keypad-range"), "Range 2.00 to 4.00 L/Hr");
  m.click("keypad-cancel");
});

test("a change of start reading brings an entered rate back under the new limit", () => {
  const m = mountHmi();
  m.render(calPayload());
  toSummary(m, { start: "50", rate: "13" });
  back(m); // 3
  back(m); // 2
  m.click("calwiz-field-start");
  enter(m, "180");
  next(m); // 3
  assert.match(text(m, "calwiz-body"), /Test rate\s*5\.28/);
  assert.ok(!blocked(m, "calwiz-next"));
});

test("too little room for even the pump's minimum rate: Confirm is blocked and says to go back", () => {
  const m = mountHmi();
  m.render(calPayload());
  m.click("touch-cal");
  m.click("calwiz-run");
  next(m);
  m.click("calwiz-field-start");
  enter(m, "260"); // 8 mL of room: 0.48 L/Hr, under the 2.00 minimum
  next(m);
  assert.equal(page(m), "3");
  assert.ok(blocked(m, "calwiz-next"));
  next(m);
  assert.equal(page(m), "3");
  assert.match(text(m, "calwiz-error"), /Only 8 mL of room in the site glass/);
  assert.match(text(m, "calwiz-error"), /Go back and start with a lower reading/);
});

test("Start Test sends start_test_run {rate, duration_s: 60}, then the countdown", async () => {
  const m = mountHmi();
  m.render(calPayload());
  toSummary(m, { rate: "13" });
  next(m);
  await flush();
  assert.deepEqual(m.state.sent, [{ cmd: "start_test_run", value: { rate: 13, duration_s: 60 } }]);
  assert.equal(page(m), "5");
  // Running: no Back, no X, no Confirm; a Cancel.
  for (const id of ["calwiz-back", "calwiz-close", "calwiz-next"]) assert.ok(isHidden(m.byId(id)), id);
  assert.ok(!isHidden(m.byId("calwiz-cancel")));
  m.render(calPayload({ active: true, remaining_s: 41.2, rate: 13, duration_s: 60 }, { state: "pumping", running: true, flow_rate: 12.9 }));
  assert.equal(text(m, "calwiz-countdown"), "42");
  assert.equal(text(m, "calwiz-flow"), "12.90");
  assert.equal(text(m, "calwiz-run-rate"), "13.00");
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

test("Start Test is blocked while the pump runs or is faulted, and a tap says why", async () => {
  const m = mountHmi();
  m.render(calPayload());
  toSummary(m);
  m.render(calPayload({}, { state: "pumping", running: true }));
  assert.ok(blocked(m, "calwiz-next"));
  assert.match(text(m, "calwiz-start-note"), /stop it first/);
  next(m);
  await flush();
  assert.equal(page(m), "4");
  assert.deepEqual(m.state.sent, []);
  assert.equal(text(m, "calwiz-error"), "Stop the pump before calibrating");
  assert.equal(toast(m), "Stop the pump before calibrating");
  m.render(calPayload({}, { state: "fault", fault: true }));
  next(m);
  assert.equal(text(m, "calwiz-error"), "Reset the fault first");
  m.render(calPayload());
  assert.ok(!blocked(m, "calwiz-next"));
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

test("completed: final mL, which must be more than the start", async () => {
  const m = mountHmi();
  m.render(calPayload());
  await toRunning(m);
  m.render(calPayload({ active: false, rate: 12.5, duration_s: 60, elapsed_s: 60.0, result: "completed" }));
  assert.equal(page(m), "6");
  assert.match(text(m, "calwiz-body"), /Start was 50 mL\. Test ran 60\.0 s\./);
  assert.ok(blocked(m, "calwiz-next"));
  m.click("calwiz-field-final");
  assert.equal(text(m, "keypad-title"), "Final site glass mL");
  enter(m, "50");
  assert.equal(text(m, "keypad-error"), "Must be more than the starting 50 mL");
  enter(m, "300");
  assert.equal(text(m, "keypad-error"), "The site glass reads at most 268 mL");
  enter(m, "250");
  assert.ok(!blocked(m, "calwiz-next"));
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
  // Only Set calibration factor or Discard from here: no Back, no X.
  assert.ok(isHidden(m.byId("calwiz-back")));
  assert.ok(isHidden(m.byId("calwiz-close")));
  back(m);
  assert.equal(page(m), "7");
  m.click("calwiz-discard");
  assert.ok(!wizardOpen(m));
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
  await toResults(m, { final: "100" }); // 50 mL in 60 s: 3 L/Hr against 12.5
  assert.equal(text(m, "calwiz-new-factor"), "1.70");
  assert.match(text(m, "calwiz-clamped"), /outside 0\.3 to 1\.7, so it is limited to 1\.70/);
});

test("Set calibration factor sends last_calibration_factor and closes the wizard", async () => {
  const m = mountHmi();
  m.render(calPayload());
  await toResults(m);
  next(m);
  await flush();
  assert.deepEqual(m.state.sent.at(-1), { cmd: "last_calibration_factor", value: 1.04 });
  assert.ok(!wizardOpen(m));
  assert.equal(text(m, "command-toast"), "Calibration factor updated");
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
  assert.match(text(again, "calwiz-body"), /Start was 50 mL/);
  again.click("calwiz-field-final");
  enter(again, "250");
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
  enter(m, "50");
  m.click("calwiz-field-final");
  enter(m, "250");
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

// --- stale sessions (kiosk field bug: CALIBRATE did nothing until a reload) --------

test("stale session: a wizard state without its popover never blocks CALIBRATE", () => {
  const m = mountHmi();
  m.render(calPayload());
  m.click("touch-cal");
  next(m); // page 2
  // The popover went away without the close path (the kiosk bug's state).
  m.byId("calwiz").classList.add("hidden");
  assert.ok(m.hmi._hmi.cal, "stale state set up");
  m.click("touch-cal");
  assert.ok(wizardOpen(m));
  assert.equal(page(m), "start", "a fresh session, not the stale page 2");
  assert.equal(m.hmi._hmi.cal.startMl, null);
});

test("stale session: the next update drops it too (self-heal)", () => {
  const m = mountHmi();
  m.render(calPayload());
  m.click("touch-cal");
  m.byId("calwiz").classList.add("hidden");
  m.render(calPayload());
  assert.equal(m.hmi._hmi.cal, null);
  m.click("touch-cal");
  assert.ok(wizardOpen(m));
  assert.equal(page(m), "start");
});

test("stale page 5: CALIBRATE reattaches to the running test from its tags, with the saved inputs", async () => {
  const m = mountHmi({ url: URL });
  m.render(calPayload());
  await toRunning(m);
  m.byId("calwiz").classList.add("hidden");
  // Escape never closes page 5, even when stale.
  m.document.dispatchEvent(new m.dom.window.KeyboardEvent("keydown", { key: "Escape" }));
  m.click("touch-cal");
  assert.ok(wizardOpen(m));
  assert.equal(page(m), "5", "reattached to the countdown, not page 1");
  assert.ok(m.hmi._hmi.cal.reattached);
  m.render(calPayload({ active: false, rate: 12.5, duration_s: 60, elapsed_s: 60, result: "completed" }));
  assert.equal(page(m), "6");
  assert.match(text(m, "calwiz-body"), /Start was 50 mL/, "saved inputs kept across the stale drop");
});

test("stale page 5: an update reattaches the countdown on its own", async () => {
  const m = mountHmi({ url: URL });
  m.render(calPayload());
  await toRunning(m);
  m.byId("calwiz").classList.add("hidden");
  m.render(calPayload({ active: true, remaining_s: 25, rate: 12.5, duration_s: 60 }, { state: "pumping", running: true }));
  assert.ok(wizardOpen(m));
  assert.equal(page(m), "5");
  assert.equal(text(m, "calwiz-countdown"), "25");
});

test("stale page 5 whose test has ended opens a fresh first page", async () => {
  const m = mountHmi({ url: URL });
  m.render(calPayload());
  await toRunning(m);
  m.byId("calwiz").classList.add("hidden");
  // No update in between: the tap itself finds the stale state.
  m.hmi._hmi.data = calPayload({ active: false, result: "cancelled" });
  m.click("touch-cal");
  assert.ok(wizardOpen(m));
  assert.equal(page(m), "start");
  assert.equal(m.dom.window.localStorage.getItem(CAL_STORE_KEY), null);
});

test("blocked CALIBRATE always says why (toast), never silently", () => {
  const cases = [
    [calPayload({}, { state: "fault", fault: true }), "Reset the fault first"],
    [calPayload({}, { state: "pumping", running: true }), "Stop the pump before calibrating"],
    [calPayload({}, { state: "unknown" }), "Waiting for pump controller data"],
    [{ ...calPayload(), pumps: [] }, "Waiting for pump controller data"],
  ];
  for (const [payload, why] of cases) {
    const m = mountHmi();
    m.render(payload);
    m.click("touch-cal");
    assert.ok(!wizardOpen(m), why);
    assert.equal(toast(m), why);
    assert.ok(m.byId("command-toast").classList.contains("error"));
  }
});

test("a wizard that fails to render leaves no session behind and says so", () => {
  const m = mountHmi();
  m.render(calPayload());
  const hmi = m.hmi._hmi;
  const orig = hmi.renderCalwiz;
  hmi.renderCalwiz = () => {
    throw new Error("boom");
  };
  m.click("touch-cal");
  hmi.renderCalwiz = orig;
  assert.equal(hmi.cal, null);
  assert.ok(!wizardOpen(m));
  assert.match(toast(m), /could not open: boom/);
  m.click("touch-cal");
  assert.ok(wizardOpen(m));
});

// --- taps on the kiosk (WebKitGTK touch) ------------------------------------------

/**
 * A touch tap as WebKit delivers it: touchstart on the node under the finger
 * (the button's label text), then `between()` (a data update arriving
 * mid-tap), touchend, and the synthesized click only if the touchstart node
 * is still in the page. WebKit drops the click when that node was replaced,
 * which is what swallowed Start Test and CALIBRATE on the kiosk.
 */
function tap(m, id, between = () => {}) {
  const el = m.byId(id);
  const win = m.dom.window;
  const walker = m.document.createTreeWalker(el, win.NodeFilter.SHOW_TEXT);
  let label = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.textContent.trim()) {
      label = n;
      break;
    }
  }
  const under = label || el;
  const target = under.nodeType === 1 ? under : under.parentElement;
  target.dispatchEvent(new win.TouchEvent("touchstart", { bubbles: true, cancelable: true }));
  between();
  target.dispatchEvent(new win.TouchEvent("touchend", { bubbles: true, cancelable: true }));
  if (!under.isConnected) return false; // WebKit: no click
  el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  return true;
}

test("tap harness: a label replaced mid-tap loses the click (the WebKit behaviour)", () => {
  const m = mountHmi();
  m.render(calPayload());
  const clicked = tap(m, "touch-cal", () => {
    // The old per-update rewrite of the tile's caption and value.
    for (const id of ["touch-cal-caption", "touch-cal-value"]) {
      const v = m.byId(id);
      v.textContent = v.textContent;
    }
  });
  assert.equal(clicked, false);
  assert.ok(!wizardOpen(m));
});

test("Start Test: a data update between touchstart and touchend still starts the test", async () => {
  const m = mountHmi();
  m.render(calPayload());
  toSummary(m);
  const clicked = tap(m, "calwiz-next", () => m.render(calPayload()));
  assert.ok(clicked, "the label under the finger survived the update");
  await flush();
  assert.equal(m.state.sent.at(-1).cmd, "start_test_run");
  assert.equal(page(m), "5");
});

test("CALIBRATE: a data update mid-tap still opens the wizard", () => {
  const m = mountHmi();
  m.render(calPayload());
  assert.ok(tap(m, "touch-cal", () => m.render(calPayload())));
  assert.ok(wizardOpen(m));
});

test("an unchanged update does not touch any button's contents", () => {
  const m = mountHmi();
  m.render(calPayload());
  toSummary(m); // page 4 open over the touch bar
  const changed = [];
  const obs = new m.dom.window.MutationObserver((records) => {
    for (const r of records) {
      const t = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      const btn = t && t.closest("button");
      if (btn) changed.push(btn.getAttribute("data-id") || btn.className);
    }
  });
  obs.observe(m.root, { subtree: true, childList: true, characterData: true });
  m.render(calPayload());
  m.render(calPayload());
  const records = obs.takeRecords();
  obs.disconnect();
  for (const r of records) {
    const t = r.target.nodeType === 1 ? r.target : r.target.parentElement;
    const btn = t && t.closest("button");
    if (btn) changed.push(btn.getAttribute("data-id") || btn.className);
  }
  assert.deepEqual(changed, []);
});

// --- commands never fail silently -------------------------------------------------

test("Start Test with no answer: reported after the timeout, and the key is free again", async () => {
  const m = mountHmi({ commandTimeoutMs: 30 });
  m.render(calPayload());
  m.state.deferAcks = true;
  toSummary(m);
  next(m);
  assert.ok(m.byId("calwiz-next").classList.contains("pending"));
  // A second press while waiting says so instead of doing nothing.
  next(m);
  assert.equal(m.state.sent.length, 1);
  assert.equal(toast(m), "Still waiting for the pump controller to answer");
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(!m.byId("calwiz-next").classList.contains("pending"));
  assert.equal(toast(m), "No reply from the pump controller");
  assert.equal(text(m, "calwiz-error"), "No reply from the pump controller");
  assert.equal(page(m), "4");
  next(m);
  assert.equal(m.state.sent.length, 2, "pressing again sends again");
  assert.equal(m.state.sent[1].cmd, "start_test_run");
});

test("a stale pending state on the shared Next key is cleared on a page change", async () => {
  const m = mountHmi({ url: URL });
  m.render(calPayload());
  m.state.deferAcks = true;
  toSummary(m);
  next(m); // Start Test, no ack yet
  // The controller runs the test anyway (tags), then completes it.
  m.render(calPayload({ active: true, remaining_s: 60, rate: 12.5, duration_s: 60 }, { state: "pumping", running: true }));
  m.render(calPayload({ active: false, rate: 12.5, duration_s: 60, elapsed_s: 60, result: "completed" }));
  assert.equal(page(m), "6");
  assert.ok(!m.byId("calwiz-next").classList.contains("pending"));
  m.click("calwiz-field-final");
  enter(m, "250");
  next(m); // 6 -> 7
  next(m); // Set calibration factor: must go out
  assert.equal(m.state.sent.at(-1).cmd, "last_calibration_factor");
});

test("every refused command shows feedback", async () => {
  // Read Only: the render core refuses with a toast.
  const m = mountHmi();
  m.render(LEGACY_PAYLOADS.running);
  const ack = await m.hmi._hmi.sendCommand("reset_fault", null, null);
  assert.equal(ack.ok, false);
  assert.equal(toast(m), "On-screen control is off (HMI Control Mode)");
  // No command path injected.
  const n = mountHmi({ sendCommand: undefined });
  n.render(calPayload());
  toSummary(n);
  next(n);
  await flush();
  assert.equal(toast(n), "Commands are not available from this screen");
  assert.equal(text(n, "calwiz-error"), "Commands are not available from this screen");
  // A thrown / rejected command path.
  const t = mountHmi({ sendCommand: () => Promise.reject(new Error("socket closed")) });
  t.render(calPayload());
  toSummary(t);
  next(t);
  await flush();
  assert.equal(toast(t), "socket closed");
  assert.equal(page(t), "4");
});
