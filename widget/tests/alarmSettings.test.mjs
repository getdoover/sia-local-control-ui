// Alarm settings: the gears on the Tank / Skid tiles, the controller's tank
// L / LL and discharge pressure H / HH thresholds and the tank alarm delay
// (read back from its Setpoint* tags), the keypad range and ordering rules,
// and the ui_cmds writes, governed by alarm_settings_access.
import assert from "node:assert/strict";
import test from "node:test";

import {
  ALARM_COMMANDS,
  alarmRange,
  formatAlarmValue,
  validateAlarmValue,
} from "../src/core/alarms.js";
import { alarmSettingsAccess, ALARM_LOCAL_ONLY_TEXT } from "../src/lib/alarmSettings.ts";
import {
  assembleDashboardData,
  createFeatureMemory,
  liveTagIds,
  resolveConfig,
} from "../src/lib/assembleDashboardData.ts";
import {
  ALARM_SETTING_COMMANDS,
  buildRpcRequest,
  checkTouchCommand,
  TOUCH_COMMANDS,
} from "../src/lib/commands.ts";
import {
  CTRL,
  deployment,
  featuresOffTags,
  flush,
  isHidden,
  LEGACY_PAYLOADS,
  mountHmi,
  touchPayload,
} from "./helpers.mjs";

const APP = "sia_local_control_ui_1";
const TANK = "analog_level_sensor_1";
const PRESSURE = "4_20ma_sensor_2";
const LOCAL = { enabled: true, canWrite: true, writeBlockedReason: "" };
const VIEW_ONLY = { enabled: true, canWrite: false, writeBlockedReason: ALARM_LOCAL_ONLY_TEXT };

const SETTINGS = {
  tank: { low: 20, low_low: 10, delay: 600, ll_required: false },
  pressure: { high: 0, high_high: 6894.8, units: "kPa" },
};

// --- access and config ---------------------------------------------------------

test("access: Hidden (default) no gears; Local only view-only in the cloud; Local and cloud both", () => {
  assert.deepEqual(alarmSettingsAccess("hidden", "local"), { enabled: false, canWrite: false, writeBlockedReason: "" });
  assert.deepEqual(alarmSettingsAccess("local_only", "local"), LOCAL);
  assert.deepEqual(alarmSettingsAccess("local_only", "cloud"), VIEW_ONLY);
  assert.deepEqual(alarmSettingsAccess("local_and_cloud", "cloud"), LOCAL);
  assert.equal(resolveConfig(APP, deployment({}, APP)).alarmSettingsAccess, "hidden");
  assert.equal(resolveConfig(APP, deployment({ alarm_settings_access: "Local only" }, APP)).alarmSettingsAccess, "local_only");
  assert.equal(resolveConfig(APP, deployment({ alarm_settings_access: "Local and cloud" }, APP)).alarmSettingsAccess, "local_and_cloud");
  assert.equal(resolveConfig(APP, deployment({ alarm_settings_access: "nonsense" }, APP)).alarmSettingsAccess, "hidden");
});

function assemble(hmi, tags, controllerCfg = {}) {
  return assembleDashboardData({
    appKey: APP,
    deploymentConfig: { applications: { [APP]: hmi, [CTRL]: controllerCfg } },
    tagValues: { [CTRL]: featuresOffTags(tags), [TANK]: { level_reading: 0.85, level_filled_percentage: 64 }, [PRESSURE]: { value: 350 } },
    uiCmds: {},
    lastUpdated: 0,
    memory: createFeatureMemory(),
  });
}

test("payload: thresholds from the Setpoint* tags, only for configured sensors", () => {
  const tags = {
    SetpointTankL: 20,
    SetpointTankLL: 10,
    SetpointTankLevelTimeout: 600,
    SetpointPressureH: 0,
    SetpointPressureHH: 6894.8,
    PressureUnits: "kPa",
  };
  const both = assemble({ tank_level_app: TANK, pressure_sensor_app: PRESSURE }, tags);
  assert.deepEqual(both.alarm_settings, {
    tank: { low: 20, low_low: 10, delay: 600, ll_required: false },
    pressure: { high: 0, high_high: 6894.8, units: "kPa" },
  });
  const tankOnly = assemble({ tank_level_app: TANK }, tags);
  assert.ok(tankOnly.alarm_settings.tank && !tankOnly.alarm_settings.pressure);
  assert.equal(assemble({}, tags).alarm_settings, undefined);
  // An older controller without the tags: values unknown, not zero.
  const old = assemble({ tank_level_app: TANK }, {});
  assert.deepEqual(old.alarm_settings.tank, { low: null, low_low: null, delay: null, ll_required: false });
  // A controller with the thresholds but not the alarm delay yet.
  const noDelay = assemble({ tank_level_app: TANK }, { SetpointTankL: 20, SetpointTankLL: 10 });
  assert.deepEqual(noDelay.alarm_settings.tank, { low: 20, low_low: 10, delay: null, ll_required: false });
});

test("payload: tank LL required from the controller's tank_ll_validation_enabled with a tank_app", () => {
  const on = assemble({ tank_level_app: TANK }, {}, { tank_ll_validation_enabled: true, tank_app: TANK });
  assert.equal(on.alarm_settings.tank.ll_required, true);
  const noSensor = assemble({ tank_level_app: TANK }, {}, { tank_ll_validation_enabled: true });
  assert.equal(noSensor.alarm_settings.tank.ll_required, false);
});

test("payload: pressure unit falls back to the controller config, then psi", () => {
  const cfgUnit = assemble({ pressure_sensor_app: PRESSURE }, { PressureUnits: null }, { pressure_units: "bar" });
  assert.equal(cfgUnit.alarm_settings.pressure.units, "bar");
  const none = assemble({ pressure_sensor_app: PRESSURE }, { PressureUnits: null });
  assert.equal(none.alarm_settings.pressure.units, "psi");
});

test("live tags: the cloud claims the Setpoint tags", () => {
  const ids = liveTagIds(resolveConfig(APP, deployment({ pump_controllers: [CTRL] }, APP)));
  for (const t of ["SetpointTankL", "SetpointTankLL", "SetpointTankLevelTimeout", "SetpointPressureH", "SetpointPressureHH"]) {
    assert.ok(ids.includes(`${CTRL}.${t}`), t);
  }
});

// --- rules (core/alarms.js) --------------------------------------------------------

test("ranges mirror the controller's sliders, pressure scaled to its unit", () => {
  assert.deepEqual(alarmRange("low_tank_level", SETTINGS), { min: 0, max: 100, step: 0.1, offAllowed: true, unit: "%" });
  assert.deepEqual(alarmRange("low_low_tank_level", SETTINGS), { min: 0, max: 100, step: 0.1, offAllowed: true, unit: "%" });
  const req = { tank: { ...SETTINGS.tank, ll_required: true } };
  assert.deepEqual(alarmRange("low_low_tank_level", req), { min: 0.1, max: 100, step: 0.1, offAllowed: false, unit: "%" });
  const psi = { pressure: { units: "psi" } };
  assert.deepEqual(alarmRange("high_pressure", psi), { min: 0, max: 4000, step: 1, offAllowed: true, unit: "psi" });
  assert.deepEqual(alarmRange("high_high_pressure", psi), { min: 110, max: 4000, step: 1, offAllowed: false, unit: "psi" });
  assert.deepEqual(alarmRange("high_high_pressure", SETTINGS), { min: 758.4, max: 27579, step: 1, offAllowed: false, unit: "kPa" });
  assert.deepEqual(alarmRange("high_pressure", { pressure: { units: "bar" } }), { min: 0, max: 275.8, step: 0.1, offAllowed: true, unit: "bar" });
  // The tank alarm delay: whole seconds, never off, whatever the LL rule.
  const delay = { min: 1, max: 600, step: 1, offAllowed: false, unit: "s", whole: true };
  assert.deepEqual(alarmRange("tank_level_timeout", SETTINGS), delay);
  assert.deepEqual(alarmRange("tank_level_timeout", req), delay);
});

test("display: Off for 0, the unit otherwise, a dash when unknown", () => {
  assert.equal(formatAlarmValue("low_tank_level", 20, SETTINGS), "20.0 %");
  assert.equal(formatAlarmValue("high_pressure", 0, SETTINGS), "Off");
  assert.equal(formatAlarmValue("high_high_pressure", 6894.8, SETTINGS), "6895 kPa");
  assert.equal(formatAlarmValue("low_tank_level", null, SETTINGS), "—");
  assert.equal(formatAlarmValue("tank_level_timeout", 600, SETTINGS), "600 s");
  assert.equal(formatAlarmValue("tank_level_timeout", 0, SETTINGS), "0 s", "the delay is never Off");
  assert.equal(formatAlarmValue("tank_level_timeout", null, SETTINGS), "—");
});

test("validation: L above LL and H below HH, each unless the other is off", () => {
  assert.match(validateAlarmValue("low_tank_level", 5, SETTINGS), /L warning must be above the LL trip \(10\.0 %\)/);
  assert.match(validateAlarmValue("low_tank_level", 10, SETTINGS), /above the LL/);
  assert.equal(validateAlarmValue("low_tank_level", 25, SETTINGS), "");
  assert.equal(validateAlarmValue("low_tank_level", 0, SETTINGS), "", "L may be off");
  assert.match(validateAlarmValue("low_low_tank_level", 20, SETTINGS), /LL trip must be below the L warning \(20\.0 %\)/);
  assert.equal(validateAlarmValue("low_low_tank_level", 5, SETTINGS), "");
  assert.equal(validateAlarmValue("low_low_tank_level", 0, SETTINGS), "", "LL may be off without validation");
  // With L off, LL is free.
  assert.equal(validateAlarmValue("low_low_tank_level", 50, { tank: { low: 0, low_low: 10 } }), "");
  const p = { pressure: { high: 3000, high_high: 6894.8, units: "kPa" } };
  assert.match(validateAlarmValue("high_pressure", 7000, p), /H warning must be below the HH trip \(6895 kPa\)/);
  assert.equal(validateAlarmValue("high_pressure", 5000, p), "");
  assert.match(validateAlarmValue("high_high_pressure", 2000, p), /HH trip must be above the H warning \(3000 kPa\)/);
  assert.equal(validateAlarmValue("high_high_pressure", 0, p), "The HH trip can't be off");
  assert.match(validateAlarmValue("high_high_pressure", 100, p), /Out of range \(758\.4 to 27579 kPa\)/);
  assert.match(validateAlarmValue("low_tank_level", 101, SETTINGS), /Out of range/);
});

test("validation: the tank alarm delay is 1 to 600 whole seconds, with no ordering rule", () => {
  assert.equal(validateAlarmValue("tank_level_timeout", 1, SETTINGS), "");
  assert.equal(validateAlarmValue("tank_level_timeout", 600, SETTINGS), "");
  assert.equal(validateAlarmValue("tank_level_timeout", 30, SETTINGS), "");
  assert.equal(validateAlarmValue("tank_level_timeout", 0, SETTINGS), "The alarm delay must be 1 to 600 s");
  assert.equal(validateAlarmValue("tank_level_timeout", 601, SETTINGS), "The alarm delay must be 1 to 600 s");
  assert.equal(validateAlarmValue("tank_level_timeout", 1.5, SETTINGS), "The alarm delay is whole seconds (no decimals)");
  for (const v of [0, 601, 1.5]) assert.doesNotMatch(validateAlarmValue("tank_level_timeout", v, SETTINGS), /HH|trip|off/, String(v));
  // Not tied to L / LL (either way round, or with LL required).
  assert.equal(validateAlarmValue("tank_level_timeout", 5, { tank: { low: 20, low_low: 10, ll_required: true } }), "");
  assert.equal(validateAlarmValue("tank_level_timeout", 50, { tank: { low: 20, low_low: 10 } }), "");
});

test("validation: tank LL can't be off while the controller's LL validation is on", () => {
  const req = { tank: { low: 20, low_low: 10, ll_required: true } };
  assert.equal(validateAlarmValue("low_low_tank_level", 0, req), "The LL trip can't be off while tank LL validation is on");
  assert.equal(validateAlarmValue("low_low_tank_level", 0.1, req), "");
});

// --- commands --------------------------------------------------------------------

test("commands: the five element names, allowed by access (not HMI Control Mode)", () => {
  assert.deepEqual([...ALARM_SETTING_COMMANDS].sort(), [...ALARM_COMMANDS].sort());
  for (const c of ALARM_SETTING_COMMANDS) assert.ok(TOUCH_COMMANDS.includes(c), c);
  // Read Only with access: allowed. Touch without access: refused.
  assert.equal(checkTouchCommand(false, "low_tank_level", 25, true), null);
  const refused = checkTouchCommand(true, "low_tank_level", 25, false);
  assert.equal(refused.ok, false);
  assert.equal(refused.message, "Alarm settings can't be changed from this screen.");
  assert.equal(checkTouchCommand(false, "high_pressure", "x", true).code, "INVALID");
  // The tank alarm delay: whole seconds 1 to 600, and access like the rest.
  assert.ok(ALARM_SETTING_COMMANDS.includes("tank_level_timeout"));
  assert.equal(checkTouchCommand(false, "tank_level_timeout", 120, true), null);
  assert.equal(checkTouchCommand(true, "tank_level_timeout", 120, false).code, "READ_ONLY");
  for (const v of [0, 601, 1.5, "x"]) assert.equal(checkTouchCommand(true, "tank_level_timeout", v, true)?.code, "INVALID", String(v));
  assert.deepEqual(buildRpcRequest("tank_level_timeout", "120", CTRL, undefined), {
    method: "tank_level_timeout",
    request: 120,
    app_key: CTRL,
  });
  // The body: the value as a float, like last_calibration_factor.
  assert.deepEqual(buildRpcRequest("high_high_pressure", "6894.8", CTRL, { name: "Local HMI" }), {
    method: "high_high_pressure",
    request: 6894.8,
    app_key: CTRL,
    actor: { name: "Local HMI" },
  });
});

// --- the render core -------------------------------------------------------------

const payload = (over = {}) =>
  touchPayload({
    tank: { tank_level_mm: 850, tank_level_percent: 64 },
    skid: { skid_pressure: 350.2 },
    alarm_settings: structuredClone(SETTINGS),
    ...over,
  });

const mounted = [];
test.afterEach(() => {
  while (mounted.length) mounted.pop().hmi.destroy();
});

function mount(access = LOCAL, data = payload()) {
  const m = mountHmi();
  mounted.push(m);
  m.render(data);
  m.hmi.setAlarmAccess(access);
  return m;
}

const toast = (m) => (isHidden(m.byId("command-toast")) ? "" : m.byId("command-toast").textContent);
const row = (m, field) => m.byId(`alarm-row-${field}`);
const rowValue = (m, field) => row(m, field).querySelector("[data-alarm-value]").textContent;
const typeKeys = (m, keys) => {
  m.root.querySelector('.keypad-keys [data-key="clear"]').click();
  for (const k of String(keys)) m.root.querySelector(`.keypad-keys [data-key="${k}"]`).click();
};

test("gears: hidden by default, shown with access on the tiles that are shown", () => {
  const m = mountHmi();
  mounted.push(m);
  m.render(payload());
  assert.ok(isHidden(m.byId("tank-gear")) && isHidden(m.byId("pressure-gear")), "Hidden by default");
  m.hmi.setAlarmAccess(LOCAL);
  assert.ok(!isHidden(m.byId("tank-gear")));
  assert.ok(!isHidden(m.byId("pressure-gear")));
  assert.ok(m.byId("tank-gear").closest('[data-id="tank-section"]'));
  assert.ok(m.byId("pressure-gear").closest('[data-id="skid-section"]'));
  // No pressure reading on screen (no sensor / tile): no pressure gear.
  m.render(payload({ skid: undefined }));
  assert.ok(isHidden(m.byId("pressure-gear")));
  // No tank tile: no tank gear.
  m.render(payload({ tank: undefined }));
  assert.ok(isHidden(m.byId("tank-gear")));
  // No readback group (sensor app not configured on the HMI): no gear.
  m.render(payload({ alarm_settings: { pressure: SETTINGS.pressure } }));
  assert.ok(isHidden(m.byId("tank-gear")));
  m.hmi.setAlarmAccess({ enabled: false, canWrite: false, writeBlockedReason: "" });
  assert.ok(isHidden(m.byId("pressure-gear")));
});

test("gears show in Read Only too (governed by access, not HMI Control Mode)", () => {
  const m = mount(LOCAL, { ...LEGACY_PAYLOADS.running, tank: { tank_level_mm: 1, tank_level_percent: 1 }, alarm_settings: SETTINGS });
  assert.ok(!isHidden(m.byId("tank-gear")));
});

test("tank popover: title, both thresholds and the delay from the readback, Off for 0, updated in place", () => {
  const m = mount();
  m.click("tank-gear");
  assert.ok(!isHidden(m.byId("alarm-panel")));
  assert.equal(m.byId("alarm-panel-title").textContent, "Tank Level Alarms");
  const ids = [...m.byId("alarm-rows").querySelectorAll("[data-alarm]")].map((r) => r.getAttribute("data-alarm"));
  assert.deepEqual(ids, ["low_tank_level", "low_low_tank_level", "tank_level_timeout"]);
  assert.equal(rowValue(m, "low_tank_level"), "20.0 %");
  assert.equal(rowValue(m, "low_low_tank_level"), "10.0 %");
  assert.equal(rowValue(m, "tank_level_timeout"), "600 s");
  assert.match(row(m, "low_tank_level").textContent, /Low \(L\) warning/);
  assert.match(row(m, "low_low_tank_level").textContent, /Low-Low \(LL\) trip/);
  assert.match(row(m, "tank_level_timeout").textContent, /Alarm delay/);
  assert.match(row(m, "tank_level_timeout").textContent, /1 to 600 s/);
  assert.doesNotMatch(row(m, "tank_level_timeout").textContent, /0 = off/);
  assert.ok(row(m, "tank_level_timeout").classList.contains("alarm-delay"));
  const before = row(m, "low_tank_level");
  const label = before.querySelector(".alarm-label").firstChild;
  m.render(payload({ alarm_settings: { ...SETTINGS, tank: { low: 0, low_low: 10, delay: 45, ll_required: false } } }));
  assert.equal(row(m, "low_tank_level"), before, "row kept (no rebuild under a tap)");
  assert.ok(label.isConnected, "label text node kept");
  assert.equal(rowValue(m, "low_tank_level"), "Off");
  assert.equal(rowValue(m, "tank_level_timeout"), "45 s");
  // An older controller without SetpointTankLevelTimeout: the row stays, value unknown.
  m.render(payload({ alarm_settings: { ...SETTINGS, tank: { low: 20, low_low: 10, delay: null, ll_required: false } } }));
  assert.equal(rowValue(m, "tank_level_timeout"), "—");
  assert.equal(rowValue(m, "low_tank_level"), "20.0 %");
  m.click("alarm-panel-close");
  assert.ok(isHidden(m.byId("alarm-panel")));
});

test("pressure popover: H / HH in the controller's unit", () => {
  const m = mount();
  m.click("pressure-gear");
  assert.equal(m.byId("alarm-panel-title").textContent, "Discharge Pressure Alarms");
  assert.equal(rowValue(m, "high_pressure"), "Off");
  assert.equal(rowValue(m, "high_high_pressure"), "6895 kPa");
  assert.match(row(m, "high_high_pressure").textContent, /758\.4 to 27579 kPa/);
  assert.doesNotMatch(row(m, "high_high_pressure").textContent, /0 = off/);
  assert.match(row(m, "high_pressure").textContent, /0 = off/);
});

test("edit: keypad range, ordering refused on the keypad, then confirm old -> new and the send", async () => {
  const m = mount();
  m.click("tank-gear");
  m.click("alarm-row-low_tank_level");
  assert.ok(!isHidden(m.byId("keypad")));
  assert.equal(m.byId("keypad-title").textContent, "Low (L) warning");
  assert.equal(m.byId("keypad-range").textContent, "0 = off, or up to 100 %");
  typeKeys(m, "150");
  m.click("keypad-ok");
  assert.match(m.byId("keypad-error").textContent, /Out of range/);
  typeKeys(m, "5");
  m.click("keypad-ok");
  assert.equal(m.byId("keypad-error").textContent, "The L warning must be above the LL trip (10.0 %)");
  typeKeys(m, "25");
  m.click("keypad-ok");
  assert.ok(isHidden(m.byId("keypad")));
  assert.equal(m.byId("confirm-message").textContent, "Change Low (L) warning from 20.0 % → 25.0 %?");
  assert.deepEqual(m.state.sent, []);
  m.click("confirm-ok");
  await flush();
  assert.deepEqual(m.state.sent, [{ cmd: "low_tank_level", value: 25 }]);
  assert.match(row(m, "low_tank_level").textContent, /Saved · 25\.0 %/);
  assert.ok(row(m, "low_tank_level").classList.contains("ok"));
  assert.equal(toast(m), "Low (L) warning set to 25.0 %");
  // The new value arrives with the readback tag.
  m.render(payload({ alarm_settings: { ...SETTINGS, tank: { low: 25, low_low: 10, ll_required: false } } }));
  assert.equal(rowValue(m, "low_tank_level"), "25.0 %");
});

test("edit: setting a threshold to 0 turns it off where allowed; HH never", async () => {
  const m = mount();
  m.click("pressure-gear");
  m.click("alarm-row-high_high_pressure");
  assert.equal(m.byId("keypad-range").textContent, "Range 758.4 to 27579 kPa (can't be off)");
  typeKeys(m, "0");
  m.click("keypad-ok");
  assert.match(m.byId("keypad-error").textContent, /Out of range/);
  m.click("keypad-cancel");
  m.render(payload({ alarm_settings: { ...SETTINGS, pressure: { high: 3000, high_high: 6894.8, units: "kPa" } } }));
  m.click("alarm-row-high_pressure");
  typeKeys(m, "0");
  m.click("keypad-ok");
  assert.equal(m.byId("confirm-message").textContent, "Change High (H) warning from 3000 kPa → Off?");
  m.click("confirm-ok");
  await flush();
  assert.deepEqual(m.state.sent.at(-1), { cmd: "high_pressure", value: 0 });
});

test("edit: the tank alarm delay, whole seconds 1 to 600, confirm old -> new and the send", async () => {
  const m = mount();
  m.click("tank-gear");
  m.click("alarm-row-tank_level_timeout");
  assert.ok(!isHidden(m.byId("keypad")));
  assert.equal(m.byId("keypad-title").textContent, "Alarm delay");
  assert.equal(m.byId("keypad-range").textContent, "Range 1 to 600 s, whole seconds");
  typeKeys(m, "0");
  m.click("keypad-ok");
  assert.match(m.byId("keypad-error").textContent, /Out of range/);
  typeKeys(m, "601");
  m.click("keypad-ok");
  assert.match(m.byId("keypad-error").textContent, /Out of range/);
  typeKeys(m, "30.5");
  m.click("keypad-ok");
  assert.equal(m.byId("keypad-error").textContent, "The alarm delay is whole seconds (no decimals)");
  assert.deepEqual(m.state.sent, []);
  // Below the LL value and the L value: no ordering rule.
  typeKeys(m, "5");
  m.click("keypad-ok");
  assert.ok(isHidden(m.byId("keypad")));
  assert.equal(m.byId("confirm-message").textContent, "Change Alarm delay from 600 s → 5 s?");
  m.click("confirm-ok");
  await flush();
  assert.deepEqual(m.state.sent, [{ cmd: "tank_level_timeout", value: 5 }]);
  assert.match(row(m, "tank_level_timeout").textContent, /Saved · 5 s/);
  assert.equal(toast(m), "Alarm delay set to 5 s");
  m.render(payload({ alarm_settings: { ...SETTINGS, tank: { ...SETTINGS.tank, delay: 5 } } }));
  assert.equal(rowValue(m, "tank_level_timeout"), "5 s");
});

test("edit: the delay from an older controller (no readback) still opens, from the dash", async () => {
  const m = mount(LOCAL, payload({ alarm_settings: { ...SETTINGS, tank: { ...SETTINGS.tank, delay: null } } }));
  m.click("tank-gear");
  m.click("alarm-row-tank_level_timeout");
  typeKeys(m, "120");
  m.click("keypad-ok");
  assert.equal(m.byId("confirm-message").textContent, "Change Alarm delay from — → 120 s?");
});

test("view only: the delay row is locked like the thresholds", () => {
  const m = mount(VIEW_ONLY);
  m.click("tank-gear");
  assert.equal(row(m, "tank_level_timeout").tagName, "DIV");
  row(m, "tank_level_timeout").click();
  assert.ok(isHidden(m.byId("keypad")));
});

test("edit: tank LL can't be off with the controller's LL validation", () => {
  const m = mount(LOCAL, payload({ alarm_settings: { ...SETTINGS, tank: { low: 20, low_low: 10, ll_required: true } } }));
  m.click("tank-gear");
  m.click("alarm-row-low_low_tank_level");
  assert.match(m.byId("keypad-range").textContent, /Range 0\.1 to 100 % \(can't be off\)/);
  typeKeys(m, "0");
  m.click("keypad-ok");
  assert.match(m.byId("keypad-error").textContent, /Out of range/);
  assert.ok(!isHidden(m.byId("keypad")));
});

test("view only (Local only in the cloud): values shown, a tap says why, nothing sent", async () => {
  const m = mount(VIEW_ONLY);
  m.click("tank-gear");
  assert.equal(m.byId("alarm-panel-note").textContent, ALARM_LOCAL_ONLY_TEXT);
  assert.equal(row(m, "low_tank_level").tagName, "DIV");
  row(m, "low_tank_level").click();
  assert.ok(isHidden(m.byId("keypad")));
  assert.equal(toast(m), ALARM_LOCAL_ONLY_TEXT);
  await flush();
  assert.deepEqual(m.state.sent, []);
});

test("a refused write shows the reason on the row and as a toast", async () => {
  const m = mount();
  m.state.ackReply = { ok: false, code: "INVALID", message: "Refused: the low-low tank level must be above 0" };
  m.click("tank-gear");
  m.click("alarm-row-low_low_tank_level");
  typeKeys(m, "5");
  m.click("keypad-ok");
  m.click("confirm-ok");
  await flush();
  assert.ok(row(m, "low_low_tank_level").classList.contains("error"));
  assert.match(row(m, "low_low_tank_level").textContent, /must be above 0/);
  assert.match(toast(m), /must be above 0/);
});

test("a write with no answer is reported and the row freed", async () => {
  const m = mountHmi({ commandTimeoutMs: 30 });
  mounted.push(m);
  m.render(payload());
  m.hmi.setAlarmAccess(LOCAL);
  m.state.deferAcks = true;
  m.click("tank-gear");
  m.click("alarm-row-low_tank_level");
  typeKeys(m, "30");
  m.click("keypad-ok");
  m.click("confirm-ok");
  assert.ok(row(m, "low_tank_level").classList.contains("pending"));
  m.click("alarm-row-low_tank_level"); // again while waiting
  assert.equal(toast(m), "Still waiting for the pump controller to answer");
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(!row(m, "low_tank_level").classList.contains("pending"));
  assert.equal(toast(m), "No reply from the pump controller");
  assert.match(row(m, "low_tank_level").textContent, /No reply from the pump controller/);
});

test("the popover closes when its tile goes away or access is removed", () => {
  const m = mount();
  m.click("pressure-gear");
  m.render(payload({ skid: undefined }));
  assert.ok(isHidden(m.byId("alarm-panel")));
  m.click("tank-gear");
  m.hmi.setAlarmAccess({ enabled: false, canWrite: false, writeBlockedReason: "" });
  assert.ok(isHidden(m.byId("alarm-panel")));
});
