// "Calibration stopped": a test run the DCS (or Doover) cancelled
// (TestRunResult "cancelled" + TestRunEndedBy). The transition detection
// (calibration.js followTestRunEnd: once per ending, never on a repeat poll,
// again after a new run, not for an ending already there at load) and the
// popover in the render core (jsdom), with and without the wizard open.
import assert from "node:assert/strict";
import test from "node:test";

import { followTestRunEnd, RUN_STOP_NOTICES, testRunEndKey } from "../src/core/calibration.js";
import { flush, isHidden, LEGACY_PAYLOADS, mountHmi, pump, touchPayload } from "./helpers.mjs";

const run = (over = {}) => ({
  active: false,
  remaining_s: 0,
  rate: null,
  duration_s: null,
  elapsed_s: null,
  result: null,
  ended_by: null,
  ...over,
});

const ACTIVE = { active: true, remaining_s: 50, rate: 12.5, duration_s: 60, elapsed_s: 10 };
const BY_DCS = { result: "cancelled", ended_by: "dcs", rate: 12.5, duration_s: 60, elapsed_s: 21.4 };

/** Feed a sequence of test runs; the notice raised by each ("" for none). */
function follow(runs, sources) {
  let key = null;
  return runs.map((tr) => {
    const out = followTestRunEnd(key, tr === null ? null : run(tr), sources);
    key = out.key;
    return out.notice || "";
  });
}

// --- followTestRunEnd ------------------------------------------------------------

test("key: active, else result|ended by; null without the payload", () => {
  assert.equal(testRunEndKey(null), null);
  assert.equal(testRunEndKey(run()), "|");
  assert.equal(testRunEndKey(run(ACTIVE)), "active");
  // A new run's tags may still carry the last ending: active wins.
  assert.equal(testRunEndKey(run({ ...BY_DCS, active: true })), "active");
  assert.equal(testRunEndKey(run(BY_DCS)), "cancelled|dcs");
});

test("raised once on the change into cancelled by the DCS, not on repeat polls", () => {
  assert.deepEqual(follow([{}, ACTIVE, ACTIVE, BY_DCS, BY_DCS, BY_DCS]), ["", "", "", "dcs", "", ""]);
});

test("a new run clears it: the next DCS stop raises it again", () => {
  assert.deepEqual(follow([ACTIVE, BY_DCS, BY_DCS, ACTIVE, BY_DCS, BY_DCS]), ["", "dcs", "", "", "dcs", ""]);
});

test("tags landing one at a time still raise it once, on the last", () => {
  assert.deepEqual(
    follow([
      ACTIVE,
      { active: false, result: null, ended_by: null },
      { active: false, result: "cancelled", ended_by: null },
      { active: false, result: "cancelled", ended_by: "dcs" },
      { active: false, result: "cancelled", ended_by: "dcs" },
    ]),
    ["", "", "", "dcs", ""],
  );
});

test("a missed active phase still counts: a different ending before it", () => {
  // A run the DCS stopped between two payloads: last seen was this panel's cancel.
  assert.deepEqual(follow([{ result: "cancelled", ended_by: "hmi" }, BY_DCS]), ["", "dcs"]);
  assert.deepEqual(follow([{ result: "completed", ended_by: "deadline" }, BY_DCS]), ["", "dcs"]);
});

test("the first payload is the baseline: an ending already there at load is not raised", () => {
  assert.deepEqual(follow([BY_DCS, BY_DCS]), ["", ""]);
});

test("no payload keeps the last key: an old ending does not come back", () => {
  assert.deepEqual(follow([ACTIVE, BY_DCS, null, null, BY_DCS]), ["", "dcs", "", "", ""]);
  // ... and nothing before the first payload is a baseline.
  assert.deepEqual(follow([null, BY_DCS]), ["", ""]);
});

test("not for this panel's cancel, the deadline, a fault, a restart or an unnamed stop", () => {
  for (const end of [
    { result: "cancelled", ended_by: "hmi" },
    { result: "completed", ended_by: "deadline" },
    { result: "faulted", ended_by: "fault" },
    { result: "cancelled", ended_by: "restart" },
    { result: "cancelled", ended_by: null }, // an older controller, or a stop no command asked for
  ]) {
    assert.deepEqual(follow([ACTIVE, end]), ["", ""], JSON.stringify(end));
  }
});

test("Doover (cloud) only where asked for", () => {
  const byCloud = { ...BY_DCS, ended_by: "cloud" };
  assert.deepEqual(follow([ACTIVE, byCloud]), ["", "cloud"]);
  assert.deepEqual(follow([ACTIVE, byCloud], ["dcs"]), ["", ""]);
  assert.deepEqual(follow([ACTIVE, BY_DCS], ["dcs"]), ["", "dcs"]);
});

test("the notice text names the DCS and says no factor was changed", () => {
  assert.equal(RUN_STOP_NOTICES.dcs.title, "Calibration stopped");
  assert.match(RUN_STOP_NOTICES.dcs.lead, /stopped by the DCS/);
  assert.match(RUN_STOP_NOTICES.dcs.note, /No calibration factor was changed/);
  assert.match(RUN_STOP_NOTICES.cloud.lead, /stopped from Doover/);
});

// --- the popover in the render core ---------------------------------------------

/** Touch, Calibration Method Manual (HMI), the test run `tr`. */
const calPayload = (tr = {}, pumpOver = {}) =>
  touchPayload({
    pumps: [pump({ state: "standby", running: false, flow_rate: 0, ...pumpOver })],
    calibration: { method: "Manual (HMI)", test_run: run(tr) },
  });
const running = () => calPayload(ACTIVE, { state: "pumping", running: true, flow_rate: 12.1 });

const noticeOpen = (m) => !isHidden(m.byId("run-notice"));
const wizardOpen = (m) => !isHidden(m.byId("calwiz"));
const text = (m, id) => m.byId(id).textContent;

test("wizard open on the countdown: the DCS stop replaces it with the notice", () => {
  const m = mountHmi();
  m.render(running()); // reattaches: page 5
  assert.ok(wizardOpen(m));
  assert.equal(m.byId("calwiz-body").getAttribute("data-page"), "5");
  m.render(calPayload(BY_DCS));
  assert.ok(noticeOpen(m));
  assert.ok(!wizardOpen(m), "the wizard closes for the notice");
  assert.equal(m.hmi._hmi.cal, null);
  assert.equal(text(m, "run-notice-title"), "Calibration stopped");
  assert.equal(text(m, "run-notice-lead"), "The calibration test was stopped by the DCS.");
  assert.match(text(m, "run-notice-note"), /No calibration factor was changed/);
  assert.equal(m.byId("run-notice").getAttribute("role"), "alertdialog");
  // One button.
  assert.deepEqual(
    [...m.byId("run-notice").querySelectorAll("button")].map((b) => b.dataset.id),
    ["run-notice-ok"],
  );
  assert.equal(m.state.sent.length, 0, "the notice sends nothing");
});

test("shown once: repeat polls keep it up, OK closes it, and it stays closed", () => {
  const m = mountHmi();
  m.render(running());
  m.render(calPayload(BY_DCS));
  assert.ok(noticeOpen(m));
  m.render({ ...calPayload(BY_DCS), timestamp: "2026-09-28T01:02:04+00:00" });
  m.render(calPayload({ ...BY_DCS }, { flow_rate: 0.1 })); // a full render, same run tags
  assert.ok(noticeOpen(m));
  m.click("run-notice-ok");
  assert.ok(!noticeOpen(m));
  for (let i = 0; i < 3; i++) m.render(calPayload(BY_DCS, { flow_rate: i / 10 }));
  assert.ok(!noticeOpen(m), "not shown again for the same ending");
  assert.ok(!wizardOpen(m), "and the wizard does not come back");
});

test("a new run takes an unread notice away (the countdown shows); its DCS stop raises it again", () => {
  const m = mountHmi();
  m.render(running());
  m.render(calPayload(BY_DCS));
  assert.ok(noticeOpen(m));
  m.render(running()); // started again from another screen, notice never closed
  assert.ok(!noticeOpen(m));
  assert.ok(wizardOpen(m));
  m.render(calPayload({ ...BY_DCS, elapsed_s: 5 }));
  assert.ok(noticeOpen(m));
  m.click("run-notice-ok");
  m.render(running());
  m.render(calPayload(BY_DCS));
  assert.ok(noticeOpen(m), "each DCS stop is said");
});

test("wizard not open: the notice shows on its own", () => {
  const m = mountHmi();
  // Last seen: this panel's own cancel. The next run started and was stopped
  // by the DCS between two payloads, so the wizard never reattached.
  m.render(calPayload({ result: "cancelled", ended_by: "hmi" }));
  assert.ok(!wizardOpen(m));
  m.render(calPayload(BY_DCS));
  assert.ok(noticeOpen(m));
  assert.ok(!wizardOpen(m));
});

test("reload: an ending already in the tags at load is not shown", () => {
  const m = mountHmi();
  m.render(calPayload(BY_DCS));
  m.render(calPayload(BY_DCS, { flow_rate: 0.2 }));
  assert.ok(!noticeOpen(m));
  // The next run it does follow.
  m.render(running());
  m.render(calPayload(BY_DCS));
  assert.ok(noticeOpen(m));
});

test("this panel's own Cancel: the wizard's cancelled page as before, no notice", async () => {
  const m = mountHmi();
  m.render(running());
  m.click("calwiz-cancel");
  await flush();
  assert.deepEqual(m.state.sent.at(-1), { cmd: "cancel_test_run", value: null });
  m.render(calPayload({ result: "cancelled", ended_by: "hmi", elapsed_s: 12.5 }));
  assert.ok(!noticeOpen(m));
  assert.equal(m.byId("calwiz-body").getAttribute("data-page"), "ended");
  assert.equal(text(m, "calwiz-ended"), "The test was cancelled and the pump stopped.");
});

test("a fault: the wizard's faulted page as before, no notice", () => {
  const m = mountHmi();
  m.render(running());
  m.render(calPayload({ result: "faulted", ended_by: "fault", elapsed_s: 30 }, { state: "fault", fault: true, fault_reason: "Pressure high-high" }));
  assert.ok(!noticeOpen(m));
  assert.match(text(m, "calwiz-ended"), /Pressure high-high/);
});

test("the wizard's cancelled page names the DCS when it ends a run the notice did not", async () => {
  // The last ending was already the DCS's and this run's active phase was
  // never seen: no change for the notice, so the wizard's backstop ends it.
  const m = mountHmi();
  m.render(calPayload(BY_DCS));
  m.click("touch-cal");
  m.click("calwiz-run");
  m.click("calwiz-next");
  m.click("calwiz-field-start");
  for (const k of ["clear", "5", "0"]) m.root.querySelector(`.keypad-keys [data-key="${k}"]`).click();
  m.click("keypad-ok");
  m.click("calwiz-next");
  m.click("calwiz-next");
  m.click("calwiz-next"); // Start Test
  await flush();
  assert.equal(m.byId("calwiz-body").getAttribute("data-page"), "5");
  m.hmi._hmi.cal.run.startedAt -= 120_000; // past the wall-clock backstop
  m.render(calPayload(BY_DCS, { flow_rate: 0.3 }));
  assert.ok(!noticeOpen(m));
  assert.equal(m.byId("calwiz-body").getAttribute("data-page"), "ended");
  assert.equal(text(m, "calwiz-ended"), "The calibration test was stopped by the DCS.");
});

test("stopped from Doover: named on the panel; not in the cloud, where it was stopped", () => {
  const byCloud = { ...BY_DCS, ended_by: "cloud" };
  const kiosk = mountHmi();
  kiosk.render(running());
  kiosk.render(calPayload(byCloud));
  assert.ok(noticeOpen(kiosk));
  assert.equal(text(kiosk, "run-notice-lead"), "The calibration test was stopped from Doover.");

  const cloud = mountHmi({ layout: "embedded" });
  cloud.render(running());
  cloud.render(calPayload(byCloud));
  assert.ok(!noticeOpen(cloud));
  assert.match(text(cloud, "calwiz-ended"), /cancelled/);
  // The DCS is named in the cloud too.
  cloud.render(running());
  cloud.render(calPayload(BY_DCS));
  assert.ok(noticeOpen(cloud));
});

test("Read Only: no notice, even with the calibration payload", () => {
  const m = mountHmi();
  const readOnly = (tr) => ({ ...LEGACY_PAYLOADS.running, calibration: { method: "Manual (HMI)", test_run: run(tr) } });
  m.render(readOnly(ACTIVE));
  m.render(readOnly(BY_DCS));
  assert.ok(!noticeOpen(m));
});

test("switching Read Only / Touch: an old ending never comes back; one that happened meanwhile is said once", () => {
  const m = mountHmi();
  m.render(running());
  m.render({ ...LEGACY_PAYLOADS.running }); // Read Only: no calibration payload
  m.render(calPayload(BY_DCS));
  assert.ok(noticeOpen(m), "the run was last seen running");
  m.click("run-notice-ok");
  m.render({ ...LEGACY_PAYLOADS.running });
  m.render(calPayload(BY_DCS));
  assert.ok(!noticeOpen(m));
});

test("leaving Touch takes the notice away", () => {
  const m = mountHmi();
  m.render(running());
  m.render(calPayload(BY_DCS));
  assert.ok(noticeOpen(m));
  m.render({ ...calPayload(BY_DCS), touch: undefined, hmi_mode: "read_only" });
  assert.ok(!noticeOpen(m));
});

test("Escape closes the notice first", () => {
  const m = mountHmi();
  m.render(running());
  m.render(calPayload(BY_DCS));
  const win = m.dom.window;
  m.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
  assert.ok(!noticeOpen(m));
});

test("it opens above an open keypad (last popover in the markup)", () => {
  const m = mountHmi();
  m.render(calPayload({ result: "cancelled", ended_by: "hmi" }));
  m.click("touch-rate"); // the target rate keypad, on the main screen
  assert.ok(!isHidden(m.byId("keypad")));
  m.render(calPayload(BY_DCS));
  const overlays = [...m.root.querySelectorAll(".modal-overlay")].map((o) => o.dataset.id);
  assert.equal(overlays.at(-1), "run-notice");
  assert.ok(noticeOpen(m));
});
