// DCS command pop-ups (HMI config dcs_connected, local panel only): a card
// per command the DCS sends over Modbus, from the pump controller's
// DcsCmdSeq / DcsLastCommand / DcsCmdResult / DcsCmdError / DcsCmdRequest /
// DcsAppliedRate tags. The wording and new-command detection
// (core/dcsCommand.js), the config / payload / live tags
// (lib/assembleDashboardData.ts), the host gate (lib/dcsNotices.ts) and the
// card in the render core (jsdom, fake timers).
import assert from "node:assert/strict";
import { mock } from "node:test";
import test from "node:test";

import { JSDOM } from "jsdom";

import {
  DCS_ERROR_TEXT,
  DCS_NOTICE_HOLD_MS,
  DCS_NOTICE_PENDING_MS,
  dcsCommandWhat,
  dcsErrorText,
  dcsNotice,
  followDcsSeq,
} from "../src/core/dcsCommand.js";
import {
  assembleDashboardData,
  createFeatureMemory,
  liveTagIds,
  resolveConfig,
} from "../src/lib/assembleDashboardData.ts";
import { dcsNoticesEnabled } from "../src/lib/dcsNotices.ts";
import { CTRL, deployment, isHidden, legacyControllerTags, mountHmi, pump, touchPayload } from "./helpers.mjs";

const APP = "sia_local_control_ui_1";
const U = "L/Hr";

/** A dcs_command payload: command 3 (rate) done long ago, seq 7. */
const dcs = (over = {}) => ({
  seq: 7,
  command: 3,
  result: 2,
  error: 0,
  request: 12.5,
  applied_rate: 12.5,
  ...over,
});

const text = (d) => dcsNotice(dcs(d), U).text;

// --- followDcsSeq ---------------------------------------------------------------

/** Feed a sequence of DcsCmdSeq values; which ones show (true / false). */
function follow(seqs, start = undefined) {
  let key = start;
  return seqs.map((s) => {
    const out = followDcsSeq(key, s);
    key = out.key;
    return out.show;
  });
}

test("the first DcsCmdSeq seen is the baseline, never shown", () => {
  assert.deepEqual(follow([7]), [false]);
  assert.deepEqual(follow([7, 7, 7]), [false, false, false]);
  assert.deepEqual(follow([null]), [false]);
});

test("each change to a new value after that is a new command", () => {
  assert.deepEqual(follow([7, 8, 8, 9, 11]), [false, true, false, true, true]);
});

test("a missing tag keeps the baseline: back unchanged is not news, a new value is", () => {
  assert.deepEqual(follow([7, null, null, 7, 8]), [false, false, false, false, true]);
});

test("none at load, then a first command shows; a controller's first 0 does not", () => {
  assert.deepEqual(follow([null, 1]), [false, true]);
  assert.deepEqual(follow([null, 0, 1]), [false, false, true]);
});

test("a step back (a reinstalled controller) only moves the baseline", () => {
  assert.deepEqual(follow([40, 3, 3, 4]), [false, false, false, true]);
});

test("a value that is not a number is no sequence (the adapter passes numbers)", () => {
  assert.deepEqual(followDcsSeq(undefined, "x"), { key: null, show: false });
});

// --- wording ------------------------------------------------------------------------

test("start / stop: done", () => {
  assert.equal(text({ command: 2, request: 2 }), "Start pump - done");
  assert.equal(text({ command: 0, request: 0 }), "Stop pump - done");
});

test("pending: received, applying", () => {
  assert.equal(text({ command: 2, request: 2, result: 1 }), "Start pump - Received - applying...");
  const n = dcsNotice(dcs({ command: 0, request: 0, result: 1 }), U);
  assert.equal(n.state, "pending");
  // Idle (no answer yet) reads the same.
  assert.equal(dcsNotice(dcs({ result: 0 }), U).state, "pending");
  assert.equal(dcsNotice(dcs({ result: null }), U).state, "pending");
});

test("target rate: set to, or limited to the applied rate, in the HMI rate units", () => {
  assert.equal(
    text({ command: 3, request: 15, applied_rate: 13.1 }),
    "Target rate 15.00 L/Hr - limited to 13.10 L/Hr",
  );
  assert.equal(text({ command: 3, request: 15, applied_rate: 15 }), "Target rate 15.00 L/Hr - set to 15.00 L/Hr");
  assert.equal(
    dcsNotice(dcs({ command: 3, request: 15, applied_rate: 13.1 }), "gal/h").text,
    "Target rate 15.00 gal/h - limited to 13.10 gal/h",
  );
  // No DcsAppliedRate published: the request is what was set.
  assert.equal(text({ command: 3, request: 15, applied_rate: null }), "Target rate 15.00 L/Hr - set to 15.00 L/Hr");
  assert.equal(text({ command: 3, request: 15, result: 1 }), "Target rate 15.00 L/Hr - Received - applying...");
  assert.equal(text({ command: 3, request: 200, result: 3, error: 1 }), "Target rate 200.00 L/Hr - refused: invalid value");
});

test("fault resets", () => {
  assert.equal(text({ command: 4, request: 4 }), "Process fault reset - done");
  assert.equal(text({ command: 4, request: 4, result: 3, error: 7 }), "Process fault reset - refused: fault still active");
  assert.equal(text({ command: 5, request: 5, result: 3, error: 14 }), "VSD fault reset - refused: drive not tripped");
  assert.equal(text({ command: 5, request: 5, result: 3, error: 13 }), "VSD fault reset - refused: drive still tripped");
  assert.equal(text({ command: 5, request: 5 }), "VSD fault reset - done");
});

test("alarm delays 6..11, by alarm", () => {
  const names = { 6: "Pressure H", 7: "Pressure HH", 8: "Tank L", 9: "Tank LL", 10: "Flow L", 11: "Flow LL" };
  for (const [code, name] of Object.entries(names)) {
    assert.equal(text({ command: Number(code), request: 30 }), `${name} alarm delay 30 s - done`);
  }
  assert.equal(text({ command: 8, request: 601, result: 3, error: 1 }), "Tank L alarm delay 601 s - refused: invalid value");
  assert.equal(text({ command: 9, request: 2.5, result: 3, error: 1 }), "Tank LL alarm delay 2.5 s - refused: invalid value");
});

test("a run or reset value the controller could not read is named by the value", () => {
  // The controller reports an invalid run write as START + error 1.
  assert.equal(text({ command: 2, request: 7, result: 3, error: 1 }), "Run request 7 - refused: invalid value");
  assert.equal(text({ command: 4, request: 9, result: 3, error: 1 }), "Reset request 9 - refused: invalid value");
});

test("refusal reasons in operator words; others read error N", () => {
  const expected = {
    1: "invalid value",
    2: "controller unavailable",
    3: "pump is tripped",
    5: "busy",
    7: "fault still active",
    8: "timed out",
    13: "drive still tripped",
    14: "drive not tripped",
    15: "control disabled",
  };
  assert.deepEqual({ ...DCS_ERROR_TEXT }, expected);
  for (let code = 1; code <= 15; code++) {
    assert.equal(dcsErrorText(code), expected[code] ?? `error ${code}`);
  }
  assert.equal(dcsErrorText(0), "");
  assert.equal(dcsErrorText(null), "");
  assert.equal(text({ command: 2, request: 2, result: 3, error: 3 }), "Start pump - refused: pump is tripped");
  assert.equal(text({ command: 2, request: 2, result: 3, error: 12 }), "Start pump - refused: error 12");
  assert.equal(text({ command: 2, request: 2, result: 3, error: 0 }), "Start pump - refused");
});

test("no answer in time, unknown commands and missing tags still read sensibly", () => {
  const n = dcsNotice(dcs({ command: 2, request: 2, result: 1 }), U, { timedOut: true });
  assert.equal(n.state, "timeout");
  assert.equal(n.text, "Start pump - no answer from the pump controller");
  // A final answer wins over the timeout.
  assert.equal(dcsNotice(dcs({ command: 2, request: 2 }), U, { timedOut: true }).text, "Start pump - done");
  assert.equal(dcsCommandWhat(dcs({ command: 12, request: 1 }), U), "Command 12");
  assert.equal(dcsCommandWhat(dcs({ command: null, request: null }), U), "Command");
  assert.equal(dcsCommandWhat(dcs({ command: 3, request: null }), U), "Target rate");
  assert.equal(dcsCommandWhat(dcs({ command: 2, request: null }), U), "Start pump");
  assert.equal(dcsNotice(undefined, U).text, "Command - Received - applying...");
});

// --- config, payload, live tags ------------------------------------------------------

const DCS_TAGS = {
  DcsCmdSeq: 7,
  DcsLastCommand: 3,
  DcsCmdResult: 2,
  DcsCmdError: 0,
  DcsCmdRequest: 12.5,
  DcsAppliedRate: 12.5,
};

const assemble = (hmiConfig, ctrlTags) =>
  assembleDashboardData({
    appKey: APP,
    deploymentConfig: deployment(hmiConfig, APP),
    tagValues: { [CTRL]: ctrlTags },
    uiCmds: undefined,
    lastUpdated: Date.parse("2026-10-01T00:00:00Z"),
    memory: createFeatureMemory(),
  });

test("dcs_connected: off by default; a Boolean (or the string true) turns it on", () => {
  assert.equal(resolveConfig(APP, deployment({}, APP)).dcsConnected, false);
  assert.equal(resolveConfig(APP, deployment({ dcs_connected: false }, APP)).dcsConnected, false);
  assert.equal(resolveConfig(APP, deployment({ dcs_connected: true }, APP)).dcsConnected, true);
  assert.equal(resolveConfig(APP, deployment({ dcs_connected: "true" }, APP)).dcsConnected, true);
  assert.equal(resolveConfig(APP, deployment({ dcs_connected: 1 }, APP)).dcsConnected, false);
});

test("off: no dcs_command, the payload is exactly as without the DCS tags", () => {
  const withTags = assemble({}, legacyControllerTags(DCS_TAGS));
  const without = assemble({}, legacyControllerTags());
  assert.equal("dcs_command" in withTags, false);
  assert.deepEqual(withTags, without);
});

test("on: the primary controller's DCS tags as numbers", () => {
  const data = assemble({ dcs_connected: true }, legacyControllerTags({ ...DCS_TAGS, DcsCmdSeq: "8" }));
  assert.deepEqual(data.dcs_command, {
    seq: 8,
    command: 3,
    result: 2,
    error: 0,
    request: 12.5,
    applied_rate: 12.5,
  });
});

test("on with an older controller (no DCS tags): every field null, nothing to show", () => {
  const data = assemble({ dcs_connected: true }, legacyControllerTags());
  assert.deepEqual(data.dcs_command, {
    seq: null,
    command: null,
    result: null,
    error: null,
    request: null,
    applied_rate: null,
  });
});

test("live tags: none claimed with it off; the primary controller's six with it on", () => {
  const dcsIds = Object.keys(DCS_TAGS).map((t) => `${CTRL}.${t}`);
  const off = liveTagIds(resolveConfig(APP, deployment({}, APP)));
  for (const id of dcsIds) assert.ok(!off.includes(id), id);
  assert.equal(off.filter((id) => id.includes(".Dcs")).length, 0);
  const on = liveTagIds(
    resolveConfig(APP, deployment({ dcs_connected: true, pump_controllers: [CTRL, "sia_injection_controller_2"] }, APP)),
  );
  for (const id of dcsIds) assert.ok(on.includes(id), id);
  assert.equal(on.filter((id) => id.startsWith("sia_injection_controller_2.Dcs")).length, 0);
  // Everything else is as before.
  assert.deepEqual(
    on.filter((id) => !dcsIds.includes(id)),
    liveTagIds(resolveConfig(APP, deployment({ pump_controllers: [CTRL, "sia_injection_controller_2"] }, APP))),
  );
});

test("host gate: the local panel with dcs_connected only", () => {
  assert.equal(dcsNoticesEnabled(true, "local"), true);
  assert.equal(dcsNoticesEnabled(true, "cloud"), false);
  assert.equal(dcsNoticesEnabled(false, "local"), false);
  assert.equal(dcsNoticesEnabled(false, "cloud"), false);
});

// --- the card in the render core --------------------------------------------------------

const payload = (d = {}, over = {}) => touchPayload({ dcs_command: dcs(d), ...over });
const card = (m) => m.byId("dcs-notice");
const shown = (m) => !isHidden(card(m));
const cardText = (m) => m.byId("dcs-notice-text").textContent;

/** Kiosk HMI with the card on, the baseline (seq 7) rendered. */
function mountOn(opts = {}) {
  const m = mountHmi(opts);
  m.hmi.setDcsNotices(true);
  m.render(payload());
  return m;
}

/** Run `fn` with node's fake setTimeout (the core's timers). */
function withFakeTimers(fn) {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    return fn();
  } finally {
    mock.timers.reset();
  }
}

test("the command already there at load is not shown; a new one is, pending then done", () => {
  const m = mountOn();
  assert.equal(shown(m), false, "baseline (seq 7) shown");
  m.render(payload({ seq: 8, command: 2, request: 2, result: 1 }));
  assert.equal(shown(m), true);
  assert.equal(m.root.querySelector(".dcs-notice-title").textContent, "DCS command");
  assert.equal(cardText(m), "Start pump - Received - applying...");
  assert.ok(card(m).classList.contains("dcs-pending"));
  m.render(payload({ seq: 8, command: 2, request: 2, result: 2 }));
  assert.equal(cardText(m), "Start pump - done");
  assert.ok(card(m).classList.contains("dcs-ok"));
  assert.ok(!card(m).classList.contains("dcs-pending"));
  m.hmi.destroy();
});

test("refused: red, with the reason", () => {
  const m = mountOn();
  m.render(payload({ seq: 8, command: 5, request: 5, result: 3, error: 14 }));
  assert.equal(cardText(m), "VSD fault reset - refused: drive not tripped");
  assert.ok(card(m).classList.contains("dcs-failed"));
  m.hmi.destroy();
});

test("auto-dismissed 8 s after the final result", () =>
  withFakeTimers(() => {
    const m = mountOn();
    m.render(payload({ seq: 8, command: 0, request: 0, result: 1 }));
    mock.timers.tick(5000);
    assert.equal(shown(m), true, "pending stays");
    m.render(payload({ seq: 8, command: 0, request: 0, result: 2 }));
    mock.timers.tick(DCS_NOTICE_HOLD_MS - 1);
    assert.equal(shown(m), true);
    // A repeat of the same tags neither restarts nor reopens it.
    m.render(payload({ seq: 8, command: 0, request: 0, result: 2 }, { timestamp: "2026-10-01T00:00:09Z" }));
    mock.timers.tick(1);
    assert.equal(shown(m), false);
    m.render(payload({ seq: 8, command: 0, request: 0, result: 2 }, { timestamp: "2026-10-01T00:00:20Z" }));
    assert.equal(shown(m), false, "the same command came back");
    m.hmi.destroy();
  }));

test("a final result already there when it arrives: shown, then gone 8 s later", () =>
  withFakeTimers(() => {
    const m = mountOn();
    m.render(payload({ seq: 8, command: 8, request: 601, result: 3, error: 1 }));
    assert.equal(cardText(m), "Tank L alarm delay 601 s - refused: invalid value");
    mock.timers.tick(DCS_NOTICE_HOLD_MS);
    assert.equal(shown(m), false);
    m.hmi.destroy();
  }));

test("pending for 20 s: no answer from the pump controller, gone 8 s later", () =>
  withFakeTimers(() => {
    const m = mountOn();
    m.render(payload({ seq: 8, command: 4, request: 4, result: 1 }));
    mock.timers.tick(DCS_NOTICE_PENDING_MS - 1);
    assert.equal(cardText(m), "Process fault reset - Received - applying...");
    mock.timers.tick(1);
    assert.equal(cardText(m), "Process fault reset - no answer from the pump controller");
    assert.ok(card(m).classList.contains("dcs-timeout"));
    mock.timers.tick(DCS_NOTICE_HOLD_MS);
    assert.equal(shown(m), false);
    m.hmi.destroy();
  }));

test("an answer after the no-answer text still lands, and holds another 8 s", () =>
  withFakeTimers(() => {
    const m = mountOn();
    m.render(payload({ seq: 8, command: 4, request: 4, result: 1 }));
    mock.timers.tick(DCS_NOTICE_PENDING_MS + 3000);
    m.render(payload({ seq: 8, command: 4, request: 4, result: 2 }));
    assert.equal(cardText(m), "Process fault reset - done");
    mock.timers.tick(DCS_NOTICE_HOLD_MS - 1);
    assert.equal(shown(m), true);
    mock.timers.tick(1);
    assert.equal(shown(m), false);
    m.hmi.destroy();
  }));

test("a newer command replaces the one on screen (and its timers)", () =>
  withFakeTimers(() => {
    const m = mountOn();
    m.render(payload({ seq: 8, command: 2, request: 2, result: 2 }));
    mock.timers.tick(6000);
    m.render(payload({ seq: 9, command: 3, request: 15, result: 1, applied_rate: 12.5 }));
    assert.equal(cardText(m), "Target rate 15.00 L/Hr - Received - applying...");
    mock.timers.tick(3000); // past the first command's 8 s
    assert.equal(shown(m), true);
    m.render(payload({ seq: 9, command: 3, request: 15, result: 2, applied_rate: 13.1 }));
    assert.equal(cardText(m), "Target rate 15.00 L/Hr - limited to 13.10 L/Hr");
    // Two at once (seq jumps): the newest is shown.
    m.render(payload({ seq: 11, command: 9, request: 30, result: 2 }));
    assert.equal(cardText(m), "Tank LL alarm delay 30 s - done");
    m.hmi.destroy();
  }));

test("once final it never goes back to pending; a late applied rate still corrects it", () => {
  const m = mountOn();
  m.render(payload({ seq: 8, command: 3, request: 15, result: 2, applied_rate: 12.5 }));
  assert.equal(cardText(m), "Target rate 15.00 L/Hr - limited to 12.50 L/Hr");
  m.render(payload({ seq: 8, command: 3, request: 15, result: 2, applied_rate: 15 }));
  assert.equal(cardText(m), "Target rate 15.00 L/Hr - set to 15.00 L/Hr");
  m.render(payload({ seq: 8, command: 3, request: 15, result: 0, applied_rate: 15 }));
  assert.equal(cardText(m), "Target rate 15.00 L/Hr - set to 15.00 L/Hr");
  m.hmi.destroy();
});

test("a tap closes it; the same command does not come back", () => {
  const m = mountOn();
  m.render(payload({ seq: 8, command: 2, request: 2, result: 1 }));
  m.click("dcs-notice");
  assert.equal(shown(m), false);
  m.render(payload({ seq: 8, command: 2, request: 2, result: 2 }));
  assert.equal(shown(m), false);
  m.render(payload({ seq: 9, command: 0, request: 0, result: 1 }));
  assert.equal(shown(m), true, "the next command does");
  m.hmi.destroy();
});

test("not modal: an open keypad stays open and usable under a new command and its tap", () => {
  const m = mountOn();
  m.click("touch-rate");
  assert.ok(m.hmi._hmi.keypadIsOpen(), "keypad open");
  m.render(payload({ seq: 8, command: 2, request: 2, result: 1 }));
  assert.equal(shown(m), true);
  assert.ok(m.hmi._hmi.keypadIsOpen(), "the card closed the keypad");
  assert.ok(!isHidden(m.byId("keypad")));
  m.root.querySelector('[data-key="4"]').click();
  assert.equal(m.byId("keypad-entry").textContent, "4");
  m.click("dcs-notice");
  assert.ok(m.hmi._hmi.keypadIsOpen(), "the tap on the card closed the keypad");
  assert.equal(m.byId("keypad-entry").textContent, "4");
  // A tap on the card takes no focus.
  const down = new m.dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
  card(m).dispatchEvent(down);
  assert.equal(down.defaultPrevented, true);
  assert.equal(card(m).getAttribute("tabindex"), null);
  m.hmi.destroy();
});

test("not modal: an open confirmation stays open, Escape still goes to it", () => {
  const m = mountOn();
  m.hmi._hmi.confirmAsk("Change target rate?", () => {});
  m.render(payload({ seq: 8, command: 0, request: 0, result: 2 }));
  assert.equal(shown(m), true);
  assert.ok(!isHidden(m.byId("confirm")), "confirmation closed");
  m.click("dcs-notice");
  assert.ok(!isHidden(m.byId("confirm")), "confirmation closed by the tap");
  m.hmi.destroy();
});

test("cloud (embedded layout) never shows it, even if asked", () => {
  const m = mountHmi({ layout: "embedded" });
  m.hmi.setDcsNotices(true);
  m.render(payload());
  m.render(payload({ seq: 8, command: 2, request: 2, result: 1 }));
  assert.equal(shown(m), false);
  m.hmi.destroy();
});

test("off (the default): nothing, whatever the tags do", () => {
  const m = mountHmi();
  m.render(payload());
  m.render(payload({ seq: 8, command: 2, request: 2, result: 1 }));
  m.render(payload({ seq: 9, command: 2, request: 2, result: 2 }));
  assert.equal(shown(m), false);
  m.hmi.destroy();
});

test("turned off while shown: it goes; turned back on, the current command is the baseline", () => {
  const m = mountOn();
  m.render(payload({ seq: 8, command: 2, request: 2, result: 1 }));
  m.hmi.setDcsNotices(false);
  assert.equal(shown(m), false);
  m.render(payload({ seq: 9, command: 2, request: 2, result: 1 }));
  m.hmi.setDcsNotices(true);
  assert.equal(shown(m), false, "seq 9 was already there when it came on");
  m.render(payload({ seq: 10, command: 0, request: 0, result: 1 }));
  assert.equal(shown(m), true);
  m.hmi.destroy();
});

test("missing tags (an older controller, or no dcs_command at all) show nothing", () => {
  const m = mountHmi();
  m.hmi.setDcsNotices(true);
  const none = { seq: null, command: null, result: null, error: null, request: null, applied_rate: null };
  m.render(touchPayload({ dcs_command: none }));
  m.render(touchPayload({ dcs_command: { ...none, result: 1 } }));
  m.render(touchPayload());
  m.render(touchPayload({ timestamp: "2026-10-01T00:00:01Z" }));
  assert.equal(shown(m), false);
  m.hmi.destroy();
});

test("a reload never replays the last command", () => {
  const first = mountOn();
  first.render(payload({ seq: 8, command: 2, request: 2, result: 2 }));
  assert.equal(shown(first), true);
  first.hmi.destroy();
  // The widget mounts again (page reload) with the same tags.
  const again = mountHmi({ dom: first.dom });
  again.hmi.setDcsNotices(true);
  again.render(payload({ seq: 8, command: 2, request: 2, result: 2 }));
  assert.equal(shown(again), false);
  again.hmi.destroy();
});

test("a reconnect never replays a command sent while disconnected", () => {
  const m = mountOn();
  m.render(payload({ seq: 7 }), { connected: false });
  m.render(payload({ seq: 8, command: 2, request: 2, result: 2 }), { connected: false });
  assert.equal(shown(m), false, "shown while disconnected");
  m.render(payload({ seq: 8, command: 2, request: 2, result: 2 }), { connected: true });
  assert.equal(shown(m), false, "replayed on reconnect");
  m.render(payload({ seq: 9, command: 0, request: 0, result: 1 }));
  assert.equal(shown(m), true, "the next one after reconnect shows");
  // No data at all (a read gap) is a fresh start too.
  m.click("dcs-notice");
  m.render(null);
  m.render(payload({ seq: 10, command: 0, request: 0, result: 2 }));
  assert.equal(shown(m), false);
  m.hmi.destroy();
});

// --- under a popover ------------------------------------------------------------------
// jsdom does no layout: the wizard's box is given a top. The card sits 6 px
// under the (zero-height) header; a box whose top leaves it no room above
// puts it under the backdrop.

/** Give the wizard box a top (px); returns a setter to move it later. */
function wizardBoxAt(m, top) {
  const box = m.byId("calwiz-box");
  let t = top;
  box.getBoundingClientRect = () => ({ top: t, bottom: t + 400, height: 400, left: 0, right: 600, width: 600, x: 0, y: t });
  return (v) => {
    t = v;
  };
}
const under = (m) => card(m).classList.contains("under");

/** The payload with the wizard available (pump in standby, Manual (HMI)). */
const wiz = (d = {}) =>
  payload(d, {
    pumps: [pump({ state: "standby", running: false, flow_rate: 0 })],
    calibration: {
      method: "Manual (HMI)",
      test_run: { active: false, remaining_s: 0, rate: null, duration_s: null, elapsed_s: null, result: null },
    },
  });

test("under a popover the 8 s hold waits; back on top it holds 8 s, then goes", () =>
  withFakeTimers(() => {
    const m = mountOn();
    wizardBoxAt(m, 0); // a tall wizard: no gap above it
    m.render(wiz());
    m.click("touch-cal");
    assert.ok(!isHidden(m.byId("calwiz")), "wizard open");
    m.render(wiz({ seq: 8, command: 2, request: 2, result: 1 }));
    assert.equal(shown(m), true);
    assert.ok(under(m), "card over the wizard");
    mock.timers.tick(2000);
    m.render(wiz({ seq: 8, command: 2, request: 2, result: 2 }));
    assert.equal(cardText(m), "Start pump - done");
    mock.timers.tick(10_000);
    assert.equal(shown(m), true, "dismissed unseen under the wizard");
    mock.timers.tick(60_000);
    assert.equal(shown(m), true, "dismissed unseen under the wizard");
    m.click("calwiz-close");
    assert.ok(isHidden(m.byId("calwiz")), "wizard closed");
    assert.equal(shown(m), true);
    assert.ok(!under(m), "back on top");
    mock.timers.tick(DCS_NOTICE_HOLD_MS - 1);
    assert.equal(shown(m), true);
    mock.timers.tick(1);
    assert.equal(shown(m), false);
    m.hmi.destroy();
  }));

test("a result already final when it arrives under a popover waits for it too", () =>
  withFakeTimers(() => {
    const m = mountOn();
    wizardBoxAt(m, 0);
    m.render(wiz());
    m.click("touch-cal");
    m.render(wiz({ seq: 8, command: 5, request: 5, result: 3, error: 14 }));
    assert.ok(under(m));
    mock.timers.tick(DCS_NOTICE_HOLD_MS * 3);
    assert.equal(shown(m), true);
    m.click("calwiz-close");
    assert.equal(cardText(m), "VSD fault reset - refused: drive not tripped");
    mock.timers.tick(DCS_NOTICE_HOLD_MS);
    assert.equal(shown(m), false);
    m.hmi.destroy();
  }));

test("no answer under a popover: the 20 s still counts, the 8 s waits until it is seen", () =>
  withFakeTimers(() => {
    const m = mountOn();
    wizardBoxAt(m, 0);
    m.render(wiz());
    m.click("touch-cal");
    m.render(wiz({ seq: 8, command: 4, request: 4, result: 1 }));
    mock.timers.tick(DCS_NOTICE_PENDING_MS);
    assert.equal(cardText(m), "Process fault reset - no answer from the pump controller");
    mock.timers.tick(DCS_NOTICE_HOLD_MS * 2);
    assert.equal(shown(m), true);
    m.click("calwiz-close");
    mock.timers.tick(DCS_NOTICE_HOLD_MS - 1);
    assert.equal(shown(m), true);
    mock.timers.tick(1);
    assert.equal(shown(m), false);
    m.hmi.destroy();
  }));

test("a popover with room above it: the card stays on top and the hold runs as usual", () =>
  withFakeTimers(() => {
    const m = mountOn();
    wizardBoxAt(m, 300);
    m.render(wiz());
    m.click("touch-cal");
    m.render(wiz({ seq: 8, command: 2, request: 2, result: 2 }));
    assert.ok(!under(m));
    assert.ok(!isHidden(m.byId("calwiz")), "wizard open");
    mock.timers.tick(DCS_NOTICE_HOLD_MS);
    assert.equal(shown(m), false);
    assert.ok(!isHidden(m.byId("calwiz")), "the card took the wizard with it");
    m.hmi.destroy();
  }));

/** A jsdom page with a ResizeObserver stand-in; `resize(el)` reports el resized. */
function pageWithResizeObserver() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const observers = [];
  dom.window.ResizeObserver = class {
    constructor(cb) {
      this.cb = cb;
      this.els = new Set();
      observers.push(this);
    }
    observe(el) {
      this.els.add(el);
    }
    unobserve(el) {
      this.els.delete(el);
    }
    disconnect() {
      this.els.clear();
    }
  };
  const watching = (el) => observers.some((o) => o.els.has(el));
  const resize = (el) => {
    for (const o of observers) if (o.els.has(el)) o.cb([{ target: el }], o);
  };
  return { dom, watching, resize };
}

test("a popover that grows or shrinks while the card is up moves the card at once", () =>
  withFakeTimers(() => {
    const { dom, watching, resize } = pageWithResizeObserver();
    const m = mountHmi({ dom });
    m.hmi.setDcsNotices(true);
    m.render(wiz());
    const box = m.byId("calwiz-box");
    const moveBox = wizardBoxAt(m, 300);
    m.render(wiz());
    m.click("touch-cal");
    assert.equal(watching(box), false, "popovers watched with no card up");
    m.render(wiz({ seq: 8, command: 2, request: 2, result: 2 }));
    assert.ok(!under(m));
    assert.equal(watching(box), true);
    // Next page: the wizard grows to the top of the screen. No payload.
    moveBox(0);
    resize(box);
    assert.ok(under(m), "card left over the grown wizard");
    mock.timers.tick(DCS_NOTICE_HOLD_MS * 2);
    assert.equal(shown(m), true, "dismissed unseen");
    // Back a page: room above it again, on top, the hold runs.
    moveBox(300);
    resize(box);
    assert.ok(!under(m));
    assert.equal(card(m).style.top, "6px");
    mock.timers.tick(DCS_NOTICE_HOLD_MS);
    assert.equal(shown(m), false);
    assert.equal(watching(box), false, "still watching with the card gone");
    m.hmi.destroy();
  }));
