// Alarm settings: the gears on the Tank / Skid / Pump Control tiles, the
// controller's tank L / LL, discharge pressure H / HH and flow L / LL
// thresholds with each alarm's own delay (read back from its Setpoint* /
// Delay* tags), the keypad ranges and ordering rules, and the ui_cmds
// writes, governed by alarm_settings_access.
import assert from "node:assert/strict";
import test from "node:test";

import {
  ALARM_COMMANDS,
  ALARM_DELAY_MISSING_TEXT,
  ALARM_DELAY_RANGES,
  ALARM_FIELDS,
  ALARM_GROUPS,
  alarmRange,
  formatAlarmValue,
  validateAlarmValue,
} from "../src/core/alarms.js";
import { alarmSettingsAccess, ALARM_LOCAL_ONLY_TEXT } from "../src/lib/alarmSettings.ts";
import {
  assembleDashboardData,
  controllerHasFlowMeter,
  createFeatureMemory,
  liveTagIds,
  resolveConfig,
} from "../src/lib/assembleDashboardData.ts";
import {
  ALARM_DELAY_RANGES_S,
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
const FLOW_METER = { flow_meter_source: "DI", flow_meter_pin: 2, flow_meter_k_factor: 450 };

const SETTINGS = {
  tank: { low: 20, low_low: 10, low_delay: 600, low_low_delay: 300, ll_required: false },
  pressure: { high: 0, high_high: 6894.8, high_delay: 0, high_high_delay: 5, units: "kPa" },
};
const FLOW = { low: 50, low_low: 20, low_delay: 120, low_low_delay: 0 };

const DELAYS = ["tank_l_delay", "tank_ll_delay", "pressure_h_delay", "pressure_hh_delay", "flow_l_delay", "flow_ll_delay"];

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

const TAGS = {
  SetpointTankL: 20,
  SetpointTankLL: 10,
  SetpointPressureH: 0,
  SetpointPressureHH: 6894.8,
  SetpointFlowL: 50,
  SetpointFlowLL: 20,
  DelayTankL: 600,
  DelayTankLL: 300,
  DelayPressureH: 0,
  DelayPressureHH: 5,
  DelayFlowL: 120,
  DelayFlowLL: 0,
  PressureUnits: "kPa",
};

test("payload: thresholds and delays from the Setpoint* / Delay* tags, only for configured sensors", () => {
  const both = assemble({ tank_level_app: TANK, pressure_sensor_app: PRESSURE }, TAGS);
  assert.deepEqual(both.alarm_settings, SETTINGS);
  const tankOnly = assemble({ tank_level_app: TANK }, TAGS);
  assert.ok(tankOnly.alarm_settings.tank && !tankOnly.alarm_settings.pressure);
  assert.equal(assemble({}, TAGS).alarm_settings, undefined);
  // An older controller without the tags: values unknown, not zero.
  const old = assemble({ tank_level_app: TANK, pressure_sensor_app: PRESSURE }, {});
  assert.deepEqual(old.alarm_settings.tank, { low: null, low_low: null, low_delay: null, low_low_delay: null, ll_required: false });
  assert.deepEqual(old.alarm_settings.pressure, { high: null, high_high: null, high_delay: null, high_high_delay: null, units: "psi" });
  // A controller with the thresholds but not the delays yet.
  const noDelay = assemble({ tank_level_app: TANK }, { SetpointTankL: 20, SetpointTankLL: 10 });
  assert.deepEqual(noDelay.alarm_settings.tank, { low: 20, low_low: 10, low_delay: null, low_low_delay: null, ll_required: false });
});

test("payload: flow group only when the controller has a dedicated flow meter", () => {
  const hmi = { tank_level_app: TANK, pressure_sensor_app: PRESSURE };
  // This project: no flow meter, so no flow group (the panel is unchanged).
  assert.equal(assemble(hmi, TAGS).alarm_settings.flow, undefined);
  assert.equal(assemble(hmi, TAGS, { flow_meter_source: "Disabled" }).alarm_settings.flow, undefined);
  assert.deepEqual(assemble(hmi, TAGS, FLOW_METER).alarm_settings.flow, FLOW);
  // Flow alone (no tank / pressure sensor on the HMI) still gives the payload.
  assert.deepEqual(assemble({}, TAGS, FLOW_METER).alarm_settings, { flow: FLOW });
  // Older controller: the group is there, values unknown.
  assert.deepEqual(assemble({}, {}, FLOW_METER).alarm_settings.flow, { low: null, low_low: null, low_delay: null, low_low_delay: null });
});

test("flow meter: the controller's has_flow_meter (source, pin, K-factor)", () => {
  assert.equal(controllerHasFlowMeter({}), false, "default Disabled");
  assert.equal(controllerHasFlowMeter({ ...FLOW_METER, flow_meter_source: "Disabled" }), false);
  assert.equal(controllerHasFlowMeter(FLOW_METER), true);
  assert.equal(controllerHasFlowMeter({ ...FLOW_METER, flow_meter_source: "AI" }), true);
  assert.equal(controllerHasFlowMeter({ ...FLOW_METER, flow_meter_source: "ai" }), true);
  assert.equal(controllerHasFlowMeter({ flow_meter_source: "AI1", flow_meter_k_factor: 10 }), true, "legacy AI1 carries its pin");
  assert.equal(controllerHasFlowMeter({ ...FLOW_METER, flow_meter_pin: null }), false, "no pin");
  assert.equal(controllerHasFlowMeter({ ...FLOW_METER, flow_meter_k_factor: 0 }), false, "no K-factor");
  assert.equal(controllerHasFlowMeter({ ...FLOW_METER, flow_meter_k_factor: null }), false);
  assert.equal(controllerHasFlowMeter({ ...FLOW_METER, flow_meter_source: "nonsense" }), false);
  assert.equal(controllerHasFlowMeter(null), false);
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

test("live tags: the cloud claims the Setpoint and Delay tags (and no old single-delay tag)", () => {
  const ids = liveTagIds(resolveConfig(APP, deployment({ pump_controllers: [CTRL] }, APP)));
  for (const t of Object.keys(TAGS).filter((k) => k !== "PressureUnits")) {
    assert.ok(ids.includes(`${CTRL}.${t}`), t);
  }
  assert.ok(!ids.some((id) => id.includes("SetpointTankLevelTimeout")));
});

// --- rules (core/alarms.js) --------------------------------------------------------

test("fields: every threshold has its own delay element, and every delay its threshold", () => {
  const thresholds = Object.values(ALARM_GROUPS).flatMap((g) => g.fields);
  assert.deepEqual(thresholds, [
    "low_tank_level", "low_low_tank_level", "high_pressure", "high_high_pressure", "low_flow_percent", "low_low_flow_percent",
  ]);
  assert.deepEqual(thresholds.map((t) => ALARM_FIELDS[t].delay), DELAYS);
  for (const d of DELAYS) {
    const of = ALARM_FIELDS[d].of;
    assert.equal(ALARM_FIELDS[of].delay, d);
    assert.equal(ALARM_FIELDS[d].group, ALARM_FIELDS[of].group);
    assert.equal(ALARM_FIELDS[d].label, `${ALARM_FIELDS[of].label} delay`);
  }
  assert.deepEqual([...ALARM_COMMANDS].sort(), [...thresholds, ...DELAYS].sort());
  assert.ok(!("tank_level_timeout" in ALARM_FIELDS), "the old single delay is gone");
});

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
  // Flow: % of target, whole numbers, 0 = off.
  const flow = { min: 0, max: 100, step: 1, offAllowed: true, unit: "%", whole: true };
  assert.deepEqual(alarmRange("low_flow_percent", {}), flow);
  assert.deepEqual(alarmRange("low_low_flow_percent", {}), flow);
  // Delays: whole seconds, never off; tank 1 to 600, pressure / flow 0 to 600.
  const delay = (min) => ({ min, max: 600, step: 1, offAllowed: false, unit: "s", whole: true });
  for (const f of ["tank_l_delay", "tank_ll_delay"]) {
    assert.deepEqual(alarmRange(f, SETTINGS), delay(1), f);
    assert.deepEqual(alarmRange(f, req), delay(1), `${f} whatever the LL rule`);
  }
  for (const f of ["pressure_h_delay", "pressure_hh_delay", "flow_l_delay", "flow_ll_delay"]) {
    assert.deepEqual(alarmRange(f, SETTINGS), delay(0), f);
  }
  assert.deepEqual(alarmRange("pressure_h_delay", { pressure: { units: "bar" } }), delay(0), "not scaled by the pressure unit");
  // The command check uses the same ranges.
  assert.deepEqual(ALARM_DELAY_RANGES_S, ALARM_DELAY_RANGES);
});

test("display: Off for a threshold of 0, 0 s for a delay of 0, a dash when unknown", () => {
  assert.equal(formatAlarmValue("low_tank_level", 20, SETTINGS), "20.0 %");
  assert.equal(formatAlarmValue("high_pressure", 0, SETTINGS), "Off");
  assert.equal(formatAlarmValue("high_high_pressure", 6894.8, SETTINGS), "6895 kPa");
  assert.equal(formatAlarmValue("low_tank_level", null, SETTINGS), "—");
  assert.equal(formatAlarmValue("low_flow_percent", 50, {}), "50 %");
  assert.equal(formatAlarmValue("low_low_flow_percent", 0, {}), "Off");
  assert.equal(formatAlarmValue("tank_l_delay", 600, SETTINGS), "600 s");
  for (const f of ["pressure_h_delay", "pressure_hh_delay", "flow_l_delay", "flow_ll_delay"]) {
    assert.equal(formatAlarmValue(f, 0, SETTINGS), "0 s", `${f}: 0 is no delay, never Off`);
  }
  assert.equal(formatAlarmValue("tank_ll_delay", null, SETTINGS), "—");
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

test("validation: flow L above LL (each unless the other is off), whole percent", () => {
  const s = { flow: FLOW };
  assert.match(validateAlarmValue("low_flow_percent", 20, s), /L warning must be above the LL trip \(20 %\)/);
  assert.equal(validateAlarmValue("low_flow_percent", 60, s), "");
  assert.equal(validateAlarmValue("low_flow_percent", 0, s), "");
  assert.match(validateAlarmValue("low_low_flow_percent", 50, s), /LL trip must be below the L warning \(50 %\)/);
  assert.equal(validateAlarmValue("low_low_flow_percent", 10, s), "");
  assert.equal(validateAlarmValue("low_low_flow_percent", 80, { flow: { ...FLOW, low: 0 } }), "", "L off: LL free");
  assert.equal(validateAlarmValue("low_flow_percent", 55.5, s), "Whole percent only (no decimals)");
  assert.match(validateAlarmValue("low_flow_percent", 101, s), /Out of range \(0 to 100 %\)/);
});

test("validation: each delay is whole seconds in its range, with no ordering rule", () => {
  for (const f of DELAYS) {
    const [min, max] = ALARM_DELAY_RANGES[f];
    assert.equal(validateAlarmValue(f, min, SETTINGS), "", `${f} ${min}`);
    assert.equal(validateAlarmValue(f, max, SETTINGS), "", `${f} ${max}`);
    assert.equal(validateAlarmValue(f, 30, SETTINGS), "", `${f} 30`);
    assert.equal(validateAlarmValue(f, max + 1, SETTINGS), `The delay must be ${min} to 600 s`, f);
    assert.equal(validateAlarmValue(f, 1.5, SETTINGS), "The delay is whole seconds (no decimals)", f);
    for (const v of [max + 1, 1.5]) assert.doesNotMatch(validateAlarmValue(f, v, SETTINGS), /HH|trip|off/, `${f} ${v}`);
  }
  assert.equal(validateAlarmValue("tank_l_delay", 0, SETTINGS), "The delay must be 1 to 600 s", "tank: 0 is out of range");
  assert.equal(validateAlarmValue("pressure_h_delay", 0, SETTINGS), "", "pressure: 0 = no delay");
  assert.equal(validateAlarmValue("flow_ll_delay", 0, SETTINGS), "", "flow: 0 = no delay");
  // Not tied to the other delay or the thresholds (either way round).
  assert.equal(validateAlarmValue("tank_ll_delay", 600, { tank: { ...SETTINGS.tank, low_delay: 5 } }), "");
  assert.equal(validateAlarmValue("tank_l_delay", 600, { tank: { ...SETTINGS.tank, low_low_delay: 5, ll_required: true } }), "");
  assert.equal(validateAlarmValue("pressure_hh_delay", 600, { pressure: { ...SETTINGS.pressure, high_delay: 0 } }), "");
});

test("validation: tank LL can't be off while the controller's LL validation is on", () => {
  const req = { tank: { low: 20, low_low: 10, ll_required: true } };
  assert.equal(validateAlarmValue("low_low_tank_level", 0, req), "The LL trip can't be off while tank LL validation is on");
  assert.equal(validateAlarmValue("low_low_tank_level", 0.1, req), "");
});

// --- commands --------------------------------------------------------------------

test("commands: the twelve element names, allowed by access (not HMI Control Mode)", () => {
  assert.deepEqual([...ALARM_SETTING_COMMANDS].sort(), [...ALARM_COMMANDS].sort());
  assert.equal(ALARM_SETTING_COMMANDS.length, 12);
  for (const c of ALARM_SETTING_COMMANDS) assert.ok(TOUCH_COMMANDS.includes(c), c);
  assert.ok(!TOUCH_COMMANDS.includes("tank_level_timeout"), "the old single delay is gone");
  // Read Only with access: allowed. Touch without access: refused.
  assert.equal(checkTouchCommand(false, "low_tank_level", 25, true), null);
  const refused = checkTouchCommand(true, "low_tank_level", 25, false);
  assert.equal(refused.ok, false);
  assert.equal(refused.message, "Alarm settings can't be changed from this screen.");
  assert.equal(checkTouchCommand(false, "high_pressure", "x", true).code, "INVALID");
  assert.equal(checkTouchCommand(false, "low_flow_percent", 40, true), null);
  assert.equal(checkTouchCommand(true, "low_low_flow_percent", 40, false).code, "READ_ONLY");
  // Delays: whole seconds in range, and access like the rest.
  for (const f of DELAYS) {
    const [min, max] = ALARM_DELAY_RANGES_S[f];
    assert.equal(checkTouchCommand(false, f, 120, true), null, f);
    assert.equal(checkTouchCommand(false, f, min, true), null, `${f} ${min}`);
    assert.equal(checkTouchCommand(true, f, 120, false).code, "READ_ONLY", f);
    for (const v of [max + 1, 1.5, -1, "x"]) assert.equal(checkTouchCommand(true, f, v, true)?.code, "INVALID", `${f} ${v}`);
  }
  assert.equal(checkTouchCommand(true, "tank_l_delay", 0, true)?.code, "INVALID");
  assert.equal(checkTouchCommand(true, "pressure_hh_delay", 0, true), null, "pressure 0 = no delay");
  assert.deepEqual(buildRpcRequest("tank_ll_delay", "120", CTRL, undefined), {
    method: "tank_ll_delay",
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
const cell = (m, field) => m.byId(`alarm-cell-${field}`);
const cellValue = (m, field) => cell(m, field).querySelector("[data-alarm-value]").textContent;
const cellCaption = (m, field) => cell(m, field).querySelector(".alarm-caption").textContent;
const typeKeys = (m, keys) => {
  m.root.querySelector('.keypad-keys [data-key="clear"]').click();
  for (const k of String(keys)) m.root.querySelector(`.keypad-keys [data-key="${k}"]`).click();
};
/** Each row: its threshold and delay cells, in order. */
const rowCells = (m) =>
  [...m.byId("alarm-rows").querySelectorAll(".alarm-row")].map((r) =>
    [...r.querySelectorAll("[data-alarm]")].map((c) => c.getAttribute("data-alarm")),
  );

test("gears: hidden by default, shown with access on the tiles that are shown", () => {
  const m = mountHmi();
  mounted.push(m);
  m.render(payload());
  assert.ok(isHidden(m.byId("tank-gear")) && isHidden(m.byId("pressure-gear")), "Hidden by default");
  m.hmi.setAlarmAccess(LOCAL);
  assert.ok(!isHidden(m.byId("tank-gear")));
  assert.ok(!isHidden(m.byId("pressure-gear")));
  assert.ok(isHidden(m.byId("flow-gear")), "no flow meter: no flow gear");
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

test("flow gear: on the Pump Control tile only with a controller flow meter (the flow group)", () => {
  const m = mount();
  assert.ok(isHidden(m.byId("flow-gear")));
  assert.ok(!m.byId("pump-section").classList.contains("has-gear"));
  m.render(payload({ alarm_settings: { ...SETTINGS, flow: FLOW } }));
  assert.ok(!isHidden(m.byId("flow-gear")));
  assert.ok(m.byId("flow-gear").closest('[data-id="pump-section"]'));
  assert.ok(m.byId("pump-section").classList.contains("has-gear"));
  m.click("flow-gear");
  assert.equal(m.byId("alarm-panel-title").textContent, "Flow Alarms");
  // The meter goes (config change): the gear and the open popover go too.
  m.render(payload());
  assert.ok(isHidden(m.byId("flow-gear")));
  assert.ok(isHidden(m.byId("alarm-panel")));
  // Access hidden: no flow gear either.
  m.render(payload({ alarm_settings: { ...SETTINGS, flow: FLOW } }));
  m.hmi.setAlarmAccess({ enabled: false, canWrite: false, writeBlockedReason: "" });
  assert.ok(isHidden(m.byId("flow-gear")));
});

test("gears show in Read Only too (governed by access, not HMI Control Mode)", () => {
  const m = mount(LOCAL, { ...LEGACY_PAYLOADS.running, tank: { tank_level_mm: 1, tank_level_percent: 1 }, alarm_settings: SETTINGS });
  assert.ok(!isHidden(m.byId("tank-gear")));
});

test("tank popover: one row per alarm, its level and its delay side by side, updated in place", () => {
  const m = mount();
  m.click("tank-gear");
  assert.ok(!isHidden(m.byId("alarm-panel")));
  assert.equal(m.byId("alarm-panel-title").textContent, "Tank Level Alarms");
  assert.deepEqual(rowCells(m), [["low_tank_level", "tank_l_delay"], ["low_low_tank_level", "tank_ll_delay"]]);
  assert.equal(m.byId("alarm-rows").querySelectorAll(".alarm-row").length, 2, "no separate delay row");
  assert.equal(cellValue(m, "low_tank_level"), "20.0 %");
  assert.equal(cellValue(m, "low_low_tank_level"), "10.0 %");
  assert.equal(cellValue(m, "tank_l_delay"), "600 s");
  assert.equal(cellValue(m, "tank_ll_delay"), "300 s");
  // Which is which: captions on each value.
  assert.equal(cellCaption(m, "low_tank_level"), "Level");
  assert.equal(cellCaption(m, "tank_ll_delay"), "Delay");
  assert.ok(cell(m, "tank_l_delay").closest('[data-id="alarm-row-low_tank_level"]'), "the delay sits in its alarm's row");
  assert.match(row(m, "low_tank_level").textContent, /Low \(L\) warning/);
  assert.match(row(m, "low_low_tank_level").textContent, /Low-Low \(LL\) trip/);
  assert.match(cell(m, "tank_l_delay").textContent, /1 to 600 s/);
  assert.doesNotMatch(cell(m, "tank_l_delay").textContent, /0 = none/);
  assert.doesNotMatch(cell(m, "tank_l_delay").textContent, /0 = off/);
  assert.match(cell(m, "low_tank_level").textContent, /0 = off/);
  const before = cell(m, "low_tank_level");
  const label = row(m, "low_tank_level").querySelector(".alarm-label").firstChild;
  m.render(payload({ alarm_settings: { ...SETTINGS, tank: { ...SETTINGS.tank, low: 0, low_delay: 45 } } }));
  assert.equal(cell(m, "low_tank_level"), before, "cell kept (no rebuild under a tap)");
  assert.ok(label.isConnected, "label text node kept");
  assert.equal(cellValue(m, "low_tank_level"), "Off");
  assert.ok(cell(m, "low_tank_level").classList.contains("off"));
  assert.equal(cellValue(m, "tank_l_delay"), "45 s");
  assert.equal(cellValue(m, "tank_ll_delay"), "300 s", "the other delay unchanged");
  // An older controller without the Delay* tags: the cells stay, value unknown.
  m.render(payload({ alarm_settings: { ...SETTINGS, tank: { ...SETTINGS.tank, low_delay: null, low_low_delay: null } } }));
  assert.equal(cellValue(m, "tank_l_delay"), "—");
  assert.equal(cellValue(m, "tank_ll_delay"), "—");
  assert.equal(cellValue(m, "low_tank_level"), "20.0 %");
  m.click("alarm-panel-close");
  assert.ok(isHidden(m.byId("alarm-panel")));
});

test("pressure popover: H / HH in the controller's unit, each with its delay (0 s, not Off)", () => {
  const m = mount();
  m.click("pressure-gear");
  assert.equal(m.byId("alarm-panel-title").textContent, "Discharge Pressure Alarms");
  assert.deepEqual(rowCells(m), [["high_pressure", "pressure_h_delay"], ["high_high_pressure", "pressure_hh_delay"]]);
  assert.equal(cellCaption(m, "high_pressure"), "Pressure");
  assert.equal(cellCaption(m, "pressure_h_delay"), "Delay");
  assert.equal(cellValue(m, "high_pressure"), "Off");
  assert.equal(cellValue(m, "high_high_pressure"), "6895 kPa");
  assert.equal(cellValue(m, "pressure_h_delay"), "0 s");
  assert.ok(!cell(m, "pressure_h_delay").classList.contains("off"), "a 0 s delay is not an off alarm");
  assert.equal(cellValue(m, "pressure_hh_delay"), "5 s");
  assert.match(cell(m, "high_high_pressure").textContent, /758\.4 to 27579 kPa/);
  assert.doesNotMatch(cell(m, "high_high_pressure").textContent, /0 = off/);
  assert.match(cell(m, "high_pressure").textContent, /0 = off/);
  assert.match(cell(m, "pressure_hh_delay").textContent, /0 to 600 s · 0 = none/);
  assert.doesNotMatch(cell(m, "pressure_hh_delay").textContent, /0 = off/);
});

test("flow popover: L / LL (% of target) with their delays", () => {
  const m = mount(LOCAL, payload({ alarm_settings: { ...SETTINGS, flow: FLOW } }));
  m.click("flow-gear");
  assert.equal(m.byId("alarm-panel-title").textContent, "Flow Alarms");
  assert.deepEqual(rowCells(m), [["low_flow_percent", "flow_l_delay"], ["low_low_flow_percent", "flow_ll_delay"]]);
  assert.equal(cellCaption(m, "low_flow_percent"), "Flow (% of target)");
  assert.equal(cellValue(m, "low_flow_percent"), "50 %");
  assert.equal(cellValue(m, "low_low_flow_percent"), "20 %");
  assert.equal(cellValue(m, "flow_l_delay"), "120 s");
  assert.equal(cellValue(m, "flow_ll_delay"), "0 s");
  assert.match(cell(m, "low_flow_percent").textContent, /1 to 100 % · 0 = off/);
});

test("edit: keypad range, ordering refused on the keypad, then confirm old -> new and the send", async () => {
  const m = mount();
  m.click("tank-gear");
  m.click("alarm-cell-low_tank_level");
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
  assert.match(cell(m, "low_tank_level").textContent, /Saved · 25\.0 %/);
  assert.ok(cell(m, "low_tank_level").classList.contains("ok"));
  assert.ok(!cell(m, "tank_l_delay").classList.contains("ok"), "only the written cell");
  assert.equal(toast(m), "Low (L) warning set to 25.0 %");
  // The new value arrives with the readback tag.
  m.render(payload({ alarm_settings: { ...SETTINGS, tank: { ...SETTINGS.tank, low: 25 } } }));
  assert.equal(cellValue(m, "low_tank_level"), "25.0 %");
});

test("edit: setting a threshold to 0 turns it off where allowed; HH never", async () => {
  const m = mount();
  m.click("pressure-gear");
  m.click("alarm-cell-high_high_pressure");
  assert.equal(m.byId("keypad-range").textContent, "Range 758.4 to 27579 kPa (can't be off)");
  typeKeys(m, "0");
  m.click("keypad-ok");
  assert.match(m.byId("keypad-error").textContent, /Out of range/);
  m.click("keypad-cancel");
  m.render(payload({ alarm_settings: { ...SETTINGS, pressure: { ...SETTINGS.pressure, high: 3000 } } }));
  m.click("alarm-cell-high_pressure");
  typeKeys(m, "0");
  m.click("keypad-ok");
  assert.equal(m.byId("confirm-message").textContent, "Change High (H) warning from 3000 kPa → Off?");
  m.click("confirm-ok");
  await flush();
  assert.deepEqual(m.state.sent.at(-1), { cmd: "high_pressure", value: 0 });
});

test("edit: a tank delay, whole seconds 1 to 600, confirm old -> new and the send", async () => {
  const m = mount();
  m.click("tank-gear");
  m.click("alarm-cell-tank_ll_delay");
  assert.ok(!isHidden(m.byId("keypad")));
  assert.equal(m.byId("keypad-title").textContent, "Low-Low (LL) trip delay");
  assert.equal(m.byId("keypad-range").textContent, "Range 1 to 600 s, whole seconds");
  typeKeys(m, "0");
  m.click("keypad-ok");
  assert.match(m.byId("keypad-error").textContent, /Out of range/);
  typeKeys(m, "601");
  m.click("keypad-ok");
  assert.match(m.byId("keypad-error").textContent, /Out of range/);
  typeKeys(m, "30.5");
  m.click("keypad-ok");
  assert.equal(m.byId("keypad-error").textContent, "The delay is whole seconds (no decimals)");
  assert.deepEqual(m.state.sent, []);
  // Shorter than the L delay: no ordering rule between delays.
  typeKeys(m, "5");
  m.click("keypad-ok");
  assert.ok(isHidden(m.byId("keypad")));
  assert.equal(m.byId("confirm-message").textContent, "Change Low-Low (LL) trip delay from 300 s → 5 s?");
  m.click("confirm-ok");
  await flush();
  assert.deepEqual(m.state.sent, [{ cmd: "tank_ll_delay", value: 5 }]);
  assert.match(cell(m, "tank_ll_delay").textContent, /Saved · 5 s/);
  assert.ok(cell(m, "tank_ll_delay").classList.contains("ok"));
  assert.ok(!cell(m, "low_low_tank_level").classList.contains("ok"), "only the written cell");
  assert.equal(toast(m), "Low-Low (LL) trip delay set to 5 s");
  m.render(payload({ alarm_settings: { ...SETTINGS, tank: { ...SETTINGS.tank, low_low_delay: 5 } } }));
  assert.equal(cellValue(m, "tank_ll_delay"), "5 s");
  assert.equal(cellValue(m, "tank_l_delay"), "600 s");
});

test("edit: a pressure delay of 0 is no delay (keypad says so), shown as 0 s", async () => {
  const m = mount();
  m.click("pressure-gear");
  m.click("alarm-cell-pressure_hh_delay");
  assert.equal(m.byId("keypad-title").textContent, "High-High (HH) trip delay");
  assert.equal(m.byId("keypad-range").textContent, "0 = no delay (immediate), or up to 600 s, whole seconds");
  typeKeys(m, "2.5");
  m.click("keypad-ok");
  assert.equal(m.byId("keypad-error").textContent, "The delay is whole seconds (no decimals)");
  typeKeys(m, "0");
  m.click("keypad-ok");
  assert.equal(m.byId("confirm-message").textContent, "Change High-High (HH) trip delay from 5 s → 0 s?");
  m.click("confirm-ok");
  await flush();
  assert.deepEqual(m.state.sent, [{ cmd: "pressure_hh_delay", value: 0 }]);
  assert.equal(toast(m), "High-High (HH) trip delay set to 0 s");
});

test("edit: flow threshold and delay from the flow popover", async () => {
  const m = mount(LOCAL, payload({ alarm_settings: { ...SETTINGS, flow: FLOW } }));
  m.click("flow-gear");
  m.click("alarm-cell-low_flow_percent");
  assert.equal(m.byId("keypad-range").textContent, "0 = off, or up to 100 %, whole numbers");
  typeKeys(m, "15");
  m.click("keypad-ok");
  assert.equal(m.byId("keypad-error").textContent, "The L warning must be above the LL trip (20 %)");
  typeKeys(m, "40");
  m.click("keypad-ok");
  m.click("confirm-ok");
  await flush();
  m.click("alarm-cell-flow_ll_delay");
  typeKeys(m, "90");
  m.click("keypad-ok");
  assert.equal(m.byId("confirm-message").textContent, "Change Low-Low (LL) trip delay from 0 s → 90 s?");
  m.click("confirm-ok");
  await flush();
  assert.deepEqual(m.state.sent, [
    { cmd: "low_flow_percent", value: 40 },
    { cmd: "flow_ll_delay", value: 90 },
  ]);
});

test("edit: a delay from an older controller (no readback) is locked, a tap says why, nothing sent", async () => {
  const m = mount(LOCAL, payload({ alarm_settings: { ...SETTINGS, tank: { ...SETTINGS.tank, low_delay: null } } }));
  m.click("tank-gear");
  assert.equal(cellValue(m, "tank_l_delay"), "—");
  assert.ok(cell(m, "tank_l_delay").classList.contains("locked"));
  assert.ok(!cell(m, "tank_l_delay").classList.contains("editable"));
  assert.equal(cell(m, "tank_l_delay").getAttribute("aria-disabled"), "true");
  m.click("alarm-cell-tank_l_delay");
  assert.ok(isHidden(m.byId("keypad")), "no keypad from the dash");
  assert.equal(toast(m), ALARM_DELAY_MISSING_TEXT);
  await flush();
  assert.deepEqual(m.state.sent, []);
  // Its threshold and the LL delay (with readback) stay editable.
  assert.ok(cell(m, "low_tank_level").classList.contains("editable"));
  assert.ok(cell(m, "tank_ll_delay").classList.contains("editable"));
  m.click("alarm-cell-tank_ll_delay");
  assert.ok(!isHidden(m.byId("keypad")));
  m.click("keypad-cancel");
  // The tag arrives (controller updated): the same cell unlocks in place.
  const before = cell(m, "tank_l_delay");
  m.render(payload());
  assert.equal(cell(m, "tank_l_delay"), before);
  assert.ok(cell(m, "tank_l_delay").classList.contains("editable"));
  assert.ok(!cell(m, "tank_l_delay").classList.contains("locked"));
  assert.equal(cell(m, "tank_l_delay").getAttribute("aria-disabled"), "false");
  m.click("alarm-cell-tank_l_delay");
  assert.ok(!isHidden(m.byId("keypad")));
});

test("view only: thresholds and delays are locked", () => {
  const m = mount(VIEW_ONLY);
  m.click("tank-gear");
  for (const f of ["low_tank_level", "tank_l_delay", "tank_ll_delay"]) {
    assert.equal(cell(m, f).tagName, "DIV", f);
    cell(m, f).click();
    assert.ok(isHidden(m.byId("keypad")), f);
  }
});

test("edit: tank LL can't be off with the controller's LL validation", () => {
  const m = mount(LOCAL, payload({ alarm_settings: { ...SETTINGS, tank: { ...SETTINGS.tank, ll_required: true } } }));
  m.click("tank-gear");
  m.click("alarm-cell-low_low_tank_level");
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
  assert.equal(cell(m, "low_tank_level").tagName, "DIV");
  cell(m, "low_tank_level").click();
  assert.ok(isHidden(m.byId("keypad")));
  assert.equal(toast(m), ALARM_LOCAL_ONLY_TEXT);
  await flush();
  assert.deepEqual(m.state.sent, []);
});

test("a refused write shows the reason on the cell and as a toast", async () => {
  const m = mount();
  m.state.ackReply = { ok: false, code: "INVALID", message: "Refused: the low-low tank level must be above 0" };
  m.click("tank-gear");
  m.click("alarm-cell-low_low_tank_level");
  typeKeys(m, "5");
  m.click("keypad-ok");
  m.click("confirm-ok");
  await flush();
  assert.ok(cell(m, "low_low_tank_level").classList.contains("error"));
  assert.match(cell(m, "low_low_tank_level").textContent, /must be above 0/);
  assert.ok(cell(m, "low_low_tank_level").classList.contains("has-note"), "the note in place of the range");
  assert.ok(!cell(m, "tank_ll_delay").classList.contains("error"));
  assert.match(toast(m), /must be above 0/);
});

test("a write with no answer is reported and the cell freed; the other cell stays usable", async () => {
  const m = mountHmi({ commandTimeoutMs: 30 });
  mounted.push(m);
  m.render(payload());
  m.hmi.setAlarmAccess(LOCAL);
  m.state.deferAcks = true;
  m.click("tank-gear");
  m.click("alarm-cell-tank_l_delay");
  typeKeys(m, "30");
  m.click("keypad-ok");
  m.click("confirm-ok");
  assert.ok(cell(m, "tank_l_delay").classList.contains("pending"));
  assert.ok(!cell(m, "low_tank_level").classList.contains("pending"));
  m.click("alarm-cell-tank_l_delay"); // again while waiting
  assert.equal(toast(m), "Still waiting for the pump controller to answer");
  m.click("alarm-cell-low_tank_level"); // its threshold: not blocked
  assert.ok(!isHidden(m.byId("keypad")));
  m.click("keypad-cancel");
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(!cell(m, "tank_l_delay").classList.contains("pending"));
  assert.equal(toast(m), "No reply from the pump controller");
  assert.match(cell(m, "tank_l_delay").textContent, /No reply from the pump controller/);
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
