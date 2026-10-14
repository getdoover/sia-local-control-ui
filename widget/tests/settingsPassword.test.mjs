// Settings password: config `settings_password` (4 to 16 letters / digits,
// case-sensitive), asked on the LOCAL panel on an on-screen keyboard before
// any settings change (target rate, calibration, alarm thresholds and
// delays, sensor values, VSD parameters), then unlocked until
// PASSWORD_UNLOCK_MS with no taps. Start, Stop and fault resets never ask;
// the cloud never asks. Layout (fits every panel size) is checked by
// layout/layout.check.mjs.
import assert from "node:assert/strict";
import test from "node:test";

import {
  PASSWORD_MAX_CHARS,
  PASSWORD_TITLE,
  PASSWORD_UNLOCK_MS,
  PASSWORD_WRONG_TEXT,
  passwordInput,
} from "../src/core/hmi-core.js";
import { resolveConfig } from "../src/lib/assembleDashboardData.ts";
import { settingsPasswordFor } from "../src/lib/settingsPassword.ts";
import { deployment, flush, isHidden, mountHmi, touchPayload } from "./helpers.mjs";

const APP = "sia_local_control_ui_1";
const ALARM_ACCESS = { enabled: true, canWrite: true, writeBlockedReason: "" };
const ALARMS = {
  tank: { low: 20, low_low: 10, low_delay: 600, low_low_delay: 300, ll_required: false },
  pressure: { high: 0, high_high: 3000, high_delay: 0, high_high_delay: 5, units: "psi" },
};
const payload = () => ({
  ...touchPayload(),
  tank: { tank_level_mm: 850, tank_level_percent: 64 },
  alarm_settings: ALARMS,
});

const mounted = [];
test.afterEach(() => {
  while (mounted.length) mounted.pop().hmi.destroy();
});

function mount(password = "Pump42") {
  const m = mountHmi();
  mounted.push(m);
  m.render(payload());
  m.hmi.setAlarmAccess(ALARM_ACCESS);
  m.hmi.setSettingsPassword(password);
  return m;
}

const pwdKey = (m, k) => m.root.querySelector(`[data-pwd-key="${k}"]`);

/** Type on the on-screen keyboard: an upper-case letter taps Shift first. */
function type(m, text) {
  for (const ch of text) {
    if (/[A-Z]/.test(ch)) pwdKey(m, "shift").click();
    pwdKey(m, ch.toLowerCase()).click();
  }
}

function unlock(m, text = "Pump42") {
  type(m, text);
  m.click("pwd-ok");
}

const pwdShown = (m) => !isHidden(m.byId("pwd"));
const keypadShown = (m) => !isHidden(m.byId("keypad"));
const keypadTitle = (m) => m.byId("keypad-title").textContent;

// --- config and host ----------------------------------------------------------

test("config: 4 to 16 letters and digits, else no password", () => {
  const pwd = (v) => resolveConfig(APP, deployment({ settings_password: v })).settingsPassword;
  assert.equal(pwd("Pump42"), "Pump42");
  assert.equal(pwd("0123"), "0123");
  assert.equal(pwd(" abcd "), "abcd");
  assert.equal(pwd("A".repeat(16)), "A".repeat(16));
  for (const v of [undefined, "", "abc", "A".repeat(17), "pump-1", "pump 1", 1234]) {
    assert.equal(pwd(v), null, String(v));
  }
});

test("host: the local panel asks, the cloud never does", () => {
  assert.equal(settingsPasswordFor("Pump42", "local"), "Pump42");
  assert.equal(settingsPasswordFor("Pump42", "cloud"), null);
  assert.equal(settingsPasswordFor(null, "local"), null);
});

test("passwordInput: letters and digits, at most PASSWORD_MAX_CHARS", () => {
  assert.equal(passwordInput("", "a"), "a");
  assert.equal(passwordInput("a", "B"), "aB");
  assert.equal(passwordInput("aB", "0"), "aB0");
  assert.equal(passwordInput("aB", "-"), "aB");
  assert.equal(passwordInput("aB", "back"), "a");
  assert.equal(PASSWORD_MAX_CHARS, 16);
  assert.equal(passwordInput("x".repeat(16), "y"), "x".repeat(16));
});

// --- the keyboard -------------------------------------------------------------

test("keyboard: digits, qwerty letters, Shift and Backspace", () => {
  const m = mount();
  for (const k of [..."1234567890qwertyuiopasdfghjklzxcvbnm", "shift", "back"]) {
    assert.ok(pwdKey(m, k), k);
  }
  assert.equal(m.byId("pwd").querySelector(".keypad-title").textContent, PASSWORD_TITLE);
});

test("Shift is one-shot: the next letter is upper case, labels follow", () => {
  const m = mount();
  m.click("touch-rate");
  pwdKey(m, "shift").click();
  assert.equal(pwdKey(m, "q").textContent, "Q");
  assert.ok(m.byId("pwd-shift").classList.contains("on"));
  pwdKey(m, "q").click();
  assert.equal(pwdKey(m, "q").textContent, "q");
  assert.ok(!m.byId("pwd-shift").classList.contains("on"));
  // The entry is masked.
  pwdKey(m, "w").click();
  assert.equal(m.byId("pwd-entry").textContent, "••");
});

// --- the gate -----------------------------------------------------------------

test("no password: the rate keypad opens straight away, as before", () => {
  const m = mount(null);
  m.click("touch-rate");
  assert.ok(!pwdShown(m));
  assert.equal(keypadTitle(m), "Target rate");
});

test("target rate: password first, then the rate keypad", async () => {
  const m = mount();
  m.click("touch-rate");
  assert.ok(pwdShown(m));
  assert.ok(!keypadShown(m));
  unlock(m);
  assert.ok(!pwdShown(m));
  assert.equal(keypadTitle(m), "Target rate");
  m.root.querySelector('.keypad-keys [data-key="1"]').click();
  m.root.querySelector('.keypad-keys [data-key="3"]').click();
  m.click("keypad-ok");
  await flush();
  assert.deepEqual(m.state.sent, [{ cmd: "set_target_rate", value: 13 }]);
});

test("case-sensitive; wrong password says so, clears, stays, sends nothing", async () => {
  const m = mount();
  m.click("touch-rate");
  unlock(m, "pump42");
  assert.ok(pwdShown(m));
  assert.equal(m.byId("pwd-error").textContent, PASSWORD_WRONG_TEXT);
  assert.equal(m.byId("pwd-entry").textContent, "");
  type(m, "P");
  assert.equal(m.byId("pwd-error").textContent, "", "typing clears the message");
  m.click("pwd-cancel");
  assert.ok(!pwdShown(m));
  assert.ok(!keypadShown(m));
  await flush();
  assert.deepEqual(m.state.sent, []);
});

test("one correct entry unlocks every setting until the screen is left alone", () => {
  const m = mount();
  m.click("touch-cal");
  unlock(m);
  assert.equal(keypadTitle(m), "Calibration factor");
  m.click("keypad-cancel");
  m.click("tank-gear");
  m.click("alarm-cell-low_tank_level");
  assert.ok(!pwdShown(m));
  assert.ok(keypadShown(m));
});

test("locks again after PASSWORD_UNLOCK_MS with no taps; a tap restarts the clock", (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const m = mount();
  m.click("touch-rate");
  unlock(m);
  m.click("keypad-cancel");
  now += PASSWORD_UNLOCK_MS - 1000;
  m.click("touch-rate");
  assert.ok(!pwdShown(m));
  m.click("keypad-cancel");
  now += PASSWORD_UNLOCK_MS - 1000;
  m.click("touch-rate");
  assert.ok(!pwdShown(m), "still unlocked: the last tap was under the limit ago");
  m.click("keypad-cancel");
  now += PASSWORD_UNLOCK_MS + 1;
  m.click("touch-rate");
  assert.ok(pwdShown(m));
});

test("alarm threshold: password first, then its keypad; closing the popover closes the keyboard", () => {
  const m = mount();
  m.click("tank-gear");
  m.click("alarm-cell-low_tank_level");
  assert.ok(pwdShown(m));
  m.click("alarm-panel-close");
  assert.ok(!pwdShown(m));
  m.click("tank-gear");
  m.click("alarm-cell-low_tank_level");
  unlock(m);
  assert.ok(keypadShown(m));
});

test("Start, Stop and Reset Fault never ask", async () => {
  const m = mount();
  m.click("touch-start");
  m.click("touch-stop");
  m.click("touch-reset");
  assert.ok(!pwdShown(m));
  await flush();
  assert.deepEqual(
    m.state.sent.map((c) => c.cmd),
    ["set_pump_state", "set_pump_state", "reset_fault"],
  );
});

test("a changed password locks again", () => {
  const m = mount();
  m.click("touch-rate");
  unlock(m);
  m.click("keypad-cancel");
  m.hmi.setSettingsPassword("Other99");
  m.click("touch-rate");
  assert.ok(pwdShown(m));
});
