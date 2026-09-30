// Sensor tab: the Skid pressure and Tank gears' popovers get Alarms | Sensor
// tabs under sensor_settings_access (a gate of its own). The Sensor tab reads
// the sensor app's operator calibration back from its own tags and writes it
// with RPCs on ui_cmds addressed to THAT app's key; cells are locked unless
// the app's Operator Sensor Calibration is on (operator_calibration true).
import assert from "node:assert/strict";
import test from "node:test";

import { keypadInput, validateKeypadEntry } from "../src/core/hmi-core.js";
import {
  SENSOR_FIELDS,
  SENSOR_GROUPS,
  SENSOR_LOCKED_TEXT,
  SENSOR_VALUE_COMMANDS as CORE_VALUE_COMMANDS,
  formatLoopCurrent,
  formatSensorInput,
  formatSensorReading,
  formatSensorValue,
  sensorDecimals,
  sensorEndpoint,
  sensorHint,
  sensorInput,
  sensorInputCaption,
  sensorLabel,
  sensorRange,
  sensorRangeText,
  validateSensorValue,
} from "../src/core/sensors.js";
import {
  assembleDashboardData,
  createFeatureMemory,
  liveTagIds,
  resolveConfig,
} from "../src/lib/assembleDashboardData.ts";
import {
  buildRpcRequest,
  checkSensorCommand,
  checkTouchCommand,
  explainRpcError,
  sendCommand,
  SENSOR_SETTING_COMMANDS,
  SENSOR_VALUE_COMMANDS,
  SENSOR_WRITE_BLOCKED_TEXT,
} from "../src/lib/commands.ts";
import { LOCAL_HOST_CLIENT_ID, resolveActor } from "../src/lib/host.ts";
import {
  isSensorGroup,
  SENSOR_APP_NAMES,
  SENSOR_LOCAL_ONLY_TEXT,
  sensorAppKey,
  sensorSettingsAccess,
} from "../src/lib/sensorSettings.ts";
import {
  CTRL,
  DDA_CAPABILITIES,
  deployment,
  fakeClient,
  featuresOffTags,
  flush,
  isHidden,
  mountHmi,
  touchPayload,
} from "./helpers.mjs";

const APP = "sia_local_control_ui_1";
const TANK = "tank_level_1";
const PRESSURE = "pressure_sensor_1";
const LOCAL = { enabled: true, canWrite: true, writeBlockedReason: "" };
const VIEW_ONLY = { enabled: true, canWrite: false, writeBlockedReason: SENSOR_LOCAL_ONLY_TEXT };
const OFF = { enabled: false, canWrite: false, writeBlockedReason: "" };

const PRESSURE_TAGS = { value: 350.2, raw_value: 9.6032, operator_calibration: true, range_low: 0, range_high: 1000, offset: 0 };
const TANK_TAGS = {
  level_reading: 0.85,
  level_filled_percentage: 64,
  raw_level_reading: 10.8,
  operator_calibration: true,
  zero_m: 0,
  span_m: 2,
  fluid_density: 1000,
};

// --- access and config ---------------------------------------------------------

test("access: Hidden (default) no tab; Local only view-only in the cloud; Local and cloud both", () => {
  assert.deepEqual(sensorSettingsAccess("hidden", "local"), OFF);
  assert.deepEqual(sensorSettingsAccess("hidden", "cloud"), OFF);
  assert.deepEqual(sensorSettingsAccess("local_only", "local"), LOCAL);
  assert.deepEqual(sensorSettingsAccess("local_only", "cloud"), VIEW_ONLY);
  assert.deepEqual(sensorSettingsAccess("local_and_cloud", "cloud"), LOCAL);
  assert.equal(resolveConfig(APP, deployment({}, APP)).sensorSettingsAccess, "hidden");
  assert.equal(resolveConfig(APP, deployment({ sensor_settings_access: "Local only" }, APP)).sensorSettingsAccess, "local_only");
  assert.equal(resolveConfig(APP, deployment({ sensor_settings_access: "Local and cloud" }, APP)).sensorSettingsAccess, "local_and_cloud");
  assert.equal(resolveConfig(APP, deployment({ sensor_settings_access: "nonsense" }, APP)).sensorSettingsAccess, "hidden");
  // Its own gate: alarm access does not open it, nor it alarm access.
  const alarmsOnly = resolveConfig(APP, deployment({ alarm_settings_access: "Local and cloud" }, APP));
  assert.equal(alarmsOnly.sensorSettingsAccess, "hidden");
  const sensorsOnly = resolveConfig(APP, deployment({ sensor_settings_access: "Local and cloud" }, APP));
  assert.equal(sensorsOnly.alarmSettingsAccess, "hidden");
});

test("the Sensor tab's RPCs go to the sensor app keys from this app's config", () => {
  const cfg = resolveConfig(APP, deployment({ pressure_sensor_app: PRESSURE, tank_level_app: TANK }, APP));
  assert.equal(sensorAppKey(cfg, "pressure"), PRESSURE);
  assert.equal(sensorAppKey(cfg, "tank"), TANK);
  assert.equal(sensorAppKey(resolveConfig(APP, deployment({}, APP)), "tank"), null);
  assert.ok(isSensorGroup("pressure") && isSensorGroup("tank"));
  assert.ok(!isSensorGroup("flow") && !isSensorGroup(undefined));
  assert.deepEqual(SENSOR_APP_NAMES, { pressure: "pressure sensor app", tank: "tank level sensor app" });
});

// --- payload -------------------------------------------------------------------------

function assemble(hmi, pressureTags = PRESSURE_TAGS, tankTags = TANK_TAGS, tankConfig = {}) {
  return assembleDashboardData({
    appKey: APP,
    deploymentConfig: {
      applications: { [APP]: { pressure_sensor_app: PRESSURE, tank_level_app: TANK, ...hmi }, [CTRL]: {}, [TANK]: tankConfig },
    },
    tagValues: { [CTRL]: featuresOffTags({ PressureUnits: "kPa" }), [TANK]: tankTags, [PRESSURE]: pressureTags },
    uiCmds: {},
    lastUpdated: 0,
    memory: createFeatureMemory(),
  });
}

test("payload: nothing with sensor_settings_access Hidden (the payload is as before)", () => {
  const data = assemble({});
  assert.equal(data.sensor_settings, undefined);
  assert.ok(!("sensor_settings" in data));
});

test("payload: each configured sensor app's flag, loop current, reading and values", () => {
  const data = assemble({ sensor_settings_access: "Local only" });
  assert.deepEqual(data.sensor_settings, {
    pressure: { enabled: true, loop_ma: 9.6032, reading: 350.2, range_low: 0, range_high: 1000, offset: 0, units: "kPa" },
    tank: {
      enabled: true, loop_ma: 10.8, reading: 0.85, zero_m: 0, span_m: 2, fluid_density: 1000,
      // The level app's input config (none set here: its defaults).
      input_low: 4, input_high: 20, input_units: "mA", inverted: false,
    },
  });
  // Only the configured apps.
  const tankOnly = assemble({ sensor_settings_access: "Local only", pressure_sensor_app: null });
  assert.ok(tankOnly.sensor_settings.tank && !tankOnly.sensor_settings.pressure);
  const none = assemble({ sensor_settings_access: "Local only", pressure_sensor_app: null, tank_level_app: null });
  assert.equal(none.sensor_settings, undefined);
  // The HMI's pressure unit, as the Skid tile shows it.
  const own = assemble({ sensor_settings_access: "Local only", pressure_units: "bar" });
  assert.equal(own.sensor_settings.pressure.units, "bar");
  assert.equal(own.sensor_settings.pressure.units, own.units.pressure);
});

test("payload: feature off (operator_calibration false) or an older app (no tags) reads not enabled, values null", () => {
  const off = assemble(
    { sensor_settings_access: "Local only" },
    { value: 350.2, raw_value: 9.6, operator_calibration: false },
    { level_reading: 0.85, raw_level_reading: 10.8, operator_calibration: false },
  );
  assert.deepEqual(off.sensor_settings.pressure, {
    enabled: false, loop_ma: 9.6, reading: 350.2, range_low: null, range_high: null, offset: null, units: "kPa",
  });
  assert.equal(off.sensor_settings.tank.enabled, false);
  assert.equal(off.sensor_settings.tank.zero_m, null);
  const old = assemble({ sensor_settings_access: "Local only" }, { value: 1 }, { level_reading: 0.5 });
  assert.equal(old.sensor_settings.pressure.enabled, false);
  assert.equal(old.sensor_settings.pressure.loop_ma, null);
  assert.equal(old.sensor_settings.tank.enabled, false);
  // Only a real true counts.
  const truthy = assemble({ sensor_settings_access: "Local only" }, { ...PRESSURE_TAGS, operator_calibration: "true" });
  assert.equal(truthy.sensor_settings.pressure.enabled, false);
});

test("live tags: the sensor apps' readback is claimed only with sensor settings access", () => {
  const base = { pressure_sensor_app: PRESSURE, tank_level_app: TANK };
  const hidden = liveTagIds(resolveConfig(APP, deployment(base, APP)));
  assert.ok(!hidden.some((id) => /operator_calibration|range_low|zero_m|raw_value|raw_level_reading/.test(id)), hidden.join());
  const on = liveTagIds(resolveConfig(APP, deployment({ ...base, sensor_settings_access: "Local only" }, APP)));
  for (const t of ["operator_calibration", "range_low", "range_high", "offset", "raw_value", "value"]) {
    assert.ok(on.includes(`${PRESSURE}.${t}`), t);
  }
  for (const t of ["operator_calibration", "zero_m", "span_m", "fluid_density", "raw_level_reading", "level_reading"]) {
    assert.ok(on.includes(`${TANK}.${t}`), t);
  }
  assert.ok(!on.includes(`${CTRL}.range_low`), "never on the controller");
});

// --- rules (core/sensors.js) --------------------------------------------------------

const S = { pressure: { enabled: true, range_low: 0, range_high: 1000, offset: 5, units: "psi" }, tank: { enabled: true, zero_m: 0.1, span_m: 2, fluid_density: 1000 } };

test("fields: pressure range low / high / offset, tank zero / span / density", () => {
  assert.deepEqual(SENSOR_GROUPS.pressure.fields, ["range_low", "range_high", "offset"]);
  assert.deepEqual(SENSOR_GROUPS.tank.fields, ["zero_m", "span_m", "fluid_density"]);
  for (const [g, def] of Object.entries(SENSOR_GROUPS)) {
    for (const f of def.fields) assert.equal(SENSOR_FIELDS[f].group, g);
  }
  // The shell's command list and the core's agree.
  assert.deepEqual([...SENSOR_VALUE_COMMANDS].sort(), [...CORE_VALUE_COMMANDS].sort());
  assert.deepEqual(SENSOR_SETTING_COMMANDS.pressure, ["range_low", "range_high", "offset", "reset_calibration"]);
  assert.deepEqual(SENSOR_SETTING_COMMANDS.tank, ["zero_m", "span_m", "fluid_density", "reset_calibration"]);
});

test("display: pressure in its unit, tank metres with 3 decimals, density whole kg/m3", () => {
  assert.equal(formatSensorValue("range_high", 1000, S), "1000.00 psi");
  assert.equal(formatSensorValue("offset", -2.5, S), "-2.50 psi");
  assert.equal(formatSensorValue("range_low", 12, { pressure: { units: "kPa" } }), "12.0 kPa");
  // A value with more decimals shows them (up to the app's 4), not rounded away.
  assert.equal(formatSensorValue("range_low", 12.34, { pressure: { units: "kPa" } }), "12.34 kPa");
  assert.equal(formatSensorValue("zero_m", 0.1, S), "0.100 m");
  assert.equal(formatSensorValue("span_m", 2, S), "2.000 m");
  assert.equal(formatSensorValue("fluid_density", 1025, S), "1025 kg/m³");
  assert.equal(formatSensorValue("zero_m", null, S), "—");
  assert.equal(formatLoopCurrent(9.6032), "9.60 mA");
  assert.equal(formatLoopCurrent(null), "—");
  assert.equal(formatSensorReading("tank", { tank: { reading: 0.85 } }), "0.850 m");
  assert.equal(formatSensorReading("pressure", { pressure: { reading: 350.24, units: "kPa" } }), "350.2 kPa");
  assert.equal(formatSensorReading("pressure", {}), "—");
});

test("ranges: pressure signed within 1e6; tank 0 to 100 m; density 500 to 2500 whole", () => {
  assert.deepEqual(sensorRange("offset", S), { min: -1e6, max: 1e6, unit: "psi", decimals: 2, signed: true, whole: false });
  assert.deepEqual(sensorRange("span_m", S), { min: 0, max: 100, unit: "m", decimals: 3, signed: false, whole: false });
  assert.deepEqual(sensorRange("fluid_density", S), { min: 500, max: 2500, unit: "kg/m³", decimals: 0, signed: false, whole: true });
  assert.equal(sensorRange("nope", S), null);
  assert.match(sensorRangeText("offset", S), /Up to ±1000\.00 psi/);
  assert.match(sensorRangeText("range_low", S), /Below range high \(1000\.00 psi\)/);
  assert.match(sensorRangeText("span_m", S), /Above zero \(0\.100 m\) up to 100 m/);
  assert.equal(sensorRangeText("fluid_density", S), "Range 500 to 2500 kg/m³, whole numbers");
});

test("validation: pressure as the app enforces it", () => {
  assert.equal(validateSensorValue("range_low", -14.7, S), "");
  assert.equal(validateSensorValue("range_low", 1000, S), "Range low must be below range high (1000.00 psi)");
  assert.equal(validateSensorValue("range_high", 0, S), "Range high must be above range low (0.00 psi)");
  assert.equal(validateSensorValue("range_high", 2e6, S), "Out of range (±1000000 psi)");
  assert.equal(validateSensorValue("range_high", 500, S), "");
  // The offset must stay within the new range.
  assert.match(validateSensorValue("range_high", 4, S), /offset \(5\.00 psi\) must stay within the range \(4\.00 psi\)/);
  assert.match(validateSensorValue("range_low", 996, S), /offset/);
  assert.equal(validateSensorValue("offset", -1000, S), "");
  assert.equal(validateSensorValue("offset", 1000.5, S), "The offset must be within ±1000.00 psi (the range)");
  assert.equal(validateSensorValue("offset", "x", S), "Enter a number");
  assert.equal(validateSensorValue("offset", null, S), "Enter a number");
  // Unknown other values do not constrain (the app still checks).
  assert.equal(validateSensorValue("range_low", 5000, { pressure: { units: "psi" } }), "");
});

test("validation: tank zero below span, 0 to 100 m; density 500 to 2500, whole", () => {
  assert.equal(validateSensorValue("zero_m", 0, S), "");
  assert.equal(validateSensorValue("zero_m", 2, S), "Zero must be below span (2.000 m)");
  assert.equal(validateSensorValue("zero_m", -0.1, S), "Out of range (0 to 100 m)");
  assert.equal(validateSensorValue("span_m", 0.1, S), "Span must be above zero (0.100 m)");
  assert.equal(validateSensorValue("span_m", 100.5, S), "Out of range (0 to 100 m)");
  assert.equal(validateSensorValue("span_m", 3.25, S), "");
  assert.equal(validateSensorValue("fluid_density", 499, S), "Out of range (500 to 2500 kg/m³)");
  assert.equal(validateSensorValue("fluid_density", 2501, S), "Out of range (500 to 2500 kg/m³)");
  assert.equal(validateSensorValue("fluid_density", 1025.5, S), "Whole kg/m³ only (no decimals)");
  assert.equal(validateSensorValue("fluid_density", 1025, S), "");
});

test("keypad: the ± key makes a negative entry, which validates against its range", () => {
  const run = (keys) => keys.reduce((t, k) => keypadInput(t, k), "");
  assert.equal(run(["neg", "1", "4", ".", "7"]), "-14.7");
  assert.equal(run(["1", "4", "neg"]), "-14");
  assert.equal(run(["1", "neg", "neg"]), "1");
  assert.equal(run(["neg", "."]), "-0.");
  assert.equal(run(["neg", "0", "5"]), "-5");
  assert.equal(run(["neg", "back"]), "");
  assert.deepEqual(validateKeypadEntry("-14.7", -1e6, 1e6), { ok: true, value: -14.7 });
  assert.deepEqual(validateKeypadEntry("-", -1e6, 1e6), { ok: false, error: "Enter a number" });
  assert.deepEqual(validateKeypadEntry("-.", -1e6, 1e6), { ok: false, error: "Enter a number" });
  assert.equal(validateKeypadEntry("-1", 0, 100).ok, false, "negative out of an unsigned range");
  assert.equal(validateKeypadEntry("1-", -5, 5).ok, false);
});

// --- commands -----------------------------------------------------------------------------

test("commands: access, the sensor's own commands, numbers in the app's range", () => {
  assert.equal(checkSensorCommand(true, "pressure", "range_low", -14.7), null);
  assert.equal(checkSensorCommand(true, "pressure", "reset_calibration", null), null);
  assert.equal(checkSensorCommand(true, "tank", "fluid_density", 1025), null);
  const ro = checkSensorCommand(false, "pressure", "offset", 1);
  assert.deepEqual(ro, { ok: false, code: "READ_ONLY", message: SENSOR_WRITE_BLOCKED_TEXT });
  // Another sensor's (or the controller's) command: refused.
  assert.equal(checkSensorCommand(true, "tank", "range_low", 1).code, "INVALID");
  assert.equal(checkSensorCommand(true, "pressure", "high_pressure", 1).code, "INVALID");
  assert.equal(checkSensorCommand(true, "flow", "offset", 1).code, "INVALID");
  for (const [target, cmd, v] of [
    ["pressure", "offset", "x"],
    ["pressure", "range_high", 2e6],
    ["tank", "zero_m", -1],
    ["tank", "span_m", 101],
    ["tank", "fluid_density", 400],
    ["tank", "fluid_density", null],
  ]) {
    assert.equal(checkSensorCommand(true, target, cmd, v)?.code, "INVALID", `${cmd} ${v}`);
  }
  // The sensor commands are not controller (touch) commands.
  assert.equal(checkTouchCommand(true, "range_low", 1)?.code, "INVALID");
});

test("RPC body: app_key is the sensor app's, values as floats, reset with {}", () => {
  assert.deepEqual(buildRpcRequest("range_low", "-14.7", PRESSURE, { name: "Local HMI" }), {
    method: "range_low",
    request: -14.7,
    app_key: PRESSURE,
    actor: { name: "Local HMI" },
  });
  assert.deepEqual(buildRpcRequest("offset", 0, PRESSURE, undefined), { method: "offset", request: 0, app_key: PRESSURE });
  assert.deepEqual(buildRpcRequest("reset_calibration", null, TANK, undefined), {
    method: "reset_calibration",
    request: {},
    app_key: TANK,
  });
});

test("end to end: a sensor write posts on ui_cmds to the sensor app, and its reply is the ack", async () => {
  const client = fakeClient({ clientId: LOCAL_HOST_CLIENT_ID, capabilities: DDA_CAPABILITIES });
  const actor = resolveActor("local", null);
  const pending = sendCommand({ client, agentId: "agent-1", appKey: TANK, cmd: "span_m", value: 3.5, actor, timeoutMs: 5000 });
  await flush();
  const posted = client.posted.at(-1);
  assert.equal(posted.channelName, "ui_cmds");
  assert.deepEqual(posted.data, { type: "rpc", method: "span_m", request: 3.5, app_key: TANK, actor: { name: "Local HMI" } });
  // The sensor app (not the controller) patches the status.
  client.respond({ code: "success" }, { span_m: 3.5 });
  assert.deepEqual(await pending, { ok: true, result: { span_m: 3.5 } });

  const refused = sendCommand({ client, agentId: "agent-1", appKey: PRESSURE, cmd: "offset", value: 1, actor, timeoutMs: 5000 });
  await flush();
  client.respond({ code: "error", message: { code: "UNAVAILABLE", message: "Operator Sensor Calibration is off" } });
  const ack = await refused;
  assert.deepEqual(ack, { ok: false, code: "UNAVAILABLE", message: "Operator Sensor Calibration is off" });
  assert.equal(explainRpcError(ack.code, ack.message, "pressure sensor app").message, "Refused: Operator Sensor Calibration is off");
});

test("operator text names the sensor app that did not answer or refused", () => {
  assert.equal(
    explainRpcError("TIMEOUT", "", "tank level sensor app").message,
    "No reply from the tank level sensor app (it did not answer in time).",
  );
  assert.equal(explainRpcError("INVALID", "", "pressure sensor app").message, "Refused by the pressure sensor app (INVALID).");
  // The controller's wording is unchanged.
  assert.equal(explainRpcError("TIMEOUT", "").message, "No reply from the pump controller (it did not answer in time).");
});

// --- the render core --------------------------------------------------------------------------

const ALARMS = {
  tank: { low: 20, low_low: 10, low_delay: 600, low_low_delay: 300, ll_required: false },
  pressure: { high: 0, high_high: 1000, high_delay: 0, high_high_delay: 5, units: "psi" },
};
const SENSORS = {
  pressure: { enabled: true, loop_ma: 9.6032, reading: 350.2, range_low: 0, range_high: 1000, offset: 0, units: "psi" },
  tank: { enabled: true, loop_ma: 10.8, reading: 0.85, zero_m: 0, span_m: 2, fluid_density: 1000 },
};

const payload = (over = {}) =>
  touchPayload({
    tank: { tank_level_mm: 850, tank_level_percent: 64 },
    skid: { skid_pressure: 350.2 },
    alarm_settings: structuredClone(ALARMS),
    sensor_settings: structuredClone(SENSORS),
    ...over,
  });

const withSensor = (group, over) => payload({ sensor_settings: { ...SENSORS, [group]: { ...SENSORS[group], ...over } } });

const mounted = [];
test.afterEach(() => {
  while (mounted.length) mounted.pop().hmi.destroy();
});

function mount({ alarms = LOCAL, sensors = LOCAL, data = payload(), ...opts } = {}) {
  const m = mountHmi(opts);
  mounted.push(m);
  m.render(data);
  m.hmi.setAlarmAccess(alarms);
  m.hmi.setSensorAccess(sensors);
  return m;
}

const toast = (m) => (isHidden(m.byId("command-toast")) ? "" : m.byId("command-toast").textContent);
const cell = (m, f) => m.byId(`sensor-cell-${f}`);
const cellValue = (m, f) => cell(m, f).querySelector("[data-sensor-value]").textContent;
const typeKeys = (m, keys) => {
  m.root.querySelector('.keypad-keys [data-key="clear"]').click();
  for (const k of keys) m.root.querySelector(`.keypad-keys [data-key="${k}"]`).click();
};
const shown = (m, id) => !isHidden(m.byId(id));

test("Hidden (default): no tabs, no Sensor pane; the popover is exactly the alarm one", () => {
  const m = mount({ sensors: OFF });
  m.click("pressure-gear");
  assert.equal(m.byId("alarm-panel-title").textContent, "Discharge Pressure Alarms");
  assert.ok(!shown(m, "alarm-tabs"), "no tab bar");
  assert.ok(!shown(m, "sensor-pane"));
  assert.ok(shown(m, "alarm-rows"));
  assert.equal(m.byId("alarm-rows").querySelectorAll(".alarm-row").length, 2);
  // No access set at all is the same.
  const fresh = mountHmi();
  mounted.push(fresh);
  fresh.render(payload());
  fresh.hmi.setAlarmAccess(LOCAL);
  fresh.click("tank-gear");
  assert.ok(!shown(fresh, "alarm-tabs") && !shown(fresh, "sensor-pane"));
});

test("both gates on: Alarms | Sensor tabs, Alarms first; switching shows the sensor pane", () => {
  const m = mount();
  m.click("pressure-gear");
  assert.ok(shown(m, "alarm-tabs"));
  assert.equal(m.byId("alarm-tab-alarms").textContent, "Alarms");
  assert.equal(m.byId("alarm-tab-sensor").textContent, "Sensor");
  assert.equal(m.byId("alarm-tab-alarms").getAttribute("aria-selected"), "true");
  assert.ok(shown(m, "alarm-rows") && !shown(m, "sensor-pane"));
  m.click("alarm-tab-sensor");
  assert.equal(m.byId("alarm-tab-sensor").getAttribute("aria-selected"), "true");
  assert.ok(m.byId("alarm-tab-sensor").classList.contains("active"));
  assert.ok(!shown(m, "alarm-rows") && shown(m, "sensor-pane"));
  assert.equal(m.byId("alarm-panel-title").textContent, "Pressure Sensor");
  assert.equal(m.byId("sensor-ma").textContent, "9.60 mA");
  assert.equal(m.byId("sensor-reading").textContent, "350.2 psi");
  assert.equal(m.byId("sensor-reading-caption").textContent, "Pressure");
  assert.deepEqual([...m.byId("sensor-cells").querySelectorAll("[data-sensor]")].map((c) => c.dataset.sensor), [
    "range_low", "range_high", "offset",
  ]);
  assert.equal(cellValue(m, "range_high"), "1000.00 psi");
  // The caption (upper-cased on screen) has no unit; the endpoint is in the
  // lower-case hint, so "mA" never shows as "MA".
  assert.equal(cell(m, "range_low").querySelector(".alarm-caption").textContent, "Range low");
  assert.equal(cell(m, "range_low").querySelector("[data-sensor-hint]").textContent, "Reading at 4 mA");
  assert.equal(cell(m, "range_high").querySelector("[data-sensor-hint]").textContent, "Reading at 20 mA");
  assert.equal(m.byId("sensor-ma-caption").textContent, "Loop current");
  assert.ok(!shown(m, "sensor-note"), "no lock line when enabled");
  assert.equal(m.byId("sensor-reset").textContent, "Reset to configured values");
  m.click("alarm-tab-alarms");
  assert.equal(m.byId("alarm-panel-title").textContent, "Discharge Pressure Alarms");
  assert.ok(shown(m, "alarm-rows") && !shown(m, "sensor-pane"));
  // Reopening starts on Alarms.
  m.click("alarm-tab-sensor");
  m.click("alarm-panel-close");
  m.click("pressure-gear");
  assert.equal(m.byId("alarm-tab-alarms").getAttribute("aria-selected"), "true");
});

test("tank Sensor tab: metres (3 dp), density whole, the level reading", () => {
  const m = mount();
  m.click("tank-gear");
  m.click("alarm-tab-sensor");
  assert.equal(m.byId("alarm-panel-title").textContent, "Tank Level Sensor");
  assert.equal(m.byId("sensor-ma").textContent, "10.80 mA");
  assert.equal(m.byId("sensor-reading").textContent, "0.850 m");
  assert.equal(m.byId("sensor-reading-caption").textContent, "Level");
  assert.equal(cellValue(m, "zero_m"), "0.000 m");
  assert.equal(cellValue(m, "span_m"), "2.000 m");
  assert.equal(cellValue(m, "fluid_density"), "1000 kg/m³");
  assert.match(cell(m, "fluid_density").textContent, /500 to 2500 kg\/m³/);
});

test("Sensor gate only (alarms Hidden): the gear opens the Sensor pane alone, no tab bar", () => {
  const m = mount({ alarms: OFF });
  assert.ok(shown(m, "pressure-gear") && shown(m, "tank-gear"));
  assert.ok(!shown(m, "flow-gear"), "no Sensor tab for flow");
  m.click("pressure-gear");
  assert.ok(!shown(m, "alarm-tabs"));
  assert.ok(shown(m, "sensor-pane") && !shown(m, "alarm-rows"));
  assert.equal(m.byId("alarm-panel-title").textContent, "Pressure Sensor");
  // Alarm access arrives: the tabs appear, the Sensor pane stays shown.
  m.hmi.setAlarmAccess(LOCAL);
  assert.ok(shown(m, "alarm-tabs"));
  assert.ok(shown(m, "sensor-pane"));
  assert.equal(m.byId("alarm-tab-sensor").getAttribute("aria-selected"), "true");
  // Sensor access goes: back to the Alarms pane, no tab bar.
  m.hmi.setSensorAccess(OFF);
  assert.ok(!shown(m, "alarm-tabs") && !shown(m, "sensor-pane"));
  assert.ok(shown(m, "alarm-rows"));
  assert.equal(m.byId("alarm-rows").querySelectorAll(".alarm-row").length, 2);
  // Both gone: the popover closes.
  m.hmi.setAlarmAccess(OFF);
  assert.ok(isHidden(m.byId("alarm-panel")));
  assert.ok(!shown(m, "pressure-gear"));
});

test("no sensor payload (sensor app not configured): no Sensor tab", () => {
  const m = mount({ data: payload({ sensor_settings: { tank: SENSORS.tank } }) });
  m.click("pressure-gear");
  assert.ok(!shown(m, "alarm-tabs"));
  m.click("alarm-panel-close");
  m.click("tank-gear");
  assert.ok(shown(m, "alarm-tabs"));
});

test("edit: keypad (signed for pressure), rules on the keypad, confirm old -> new, RPC to the sensor", async () => {
  const m = mount();
  m.click("pressure-gear");
  m.click("alarm-tab-sensor");
  m.click("sensor-cell-range_low");
  assert.ok(shown(m, "keypad"));
  assert.ok(shown(m, "keypad-neg"), "± key on a signed value");
  assert.ok(m.byId("keypad-keys").classList.contains("signed"));
  assert.equal(m.byId("keypad-title").textContent, "Range low (4 mA)");
  assert.equal(m.byId("keypad-unit").textContent, "psi");
  typeKeys(m, ["1", "0", "0", "0"]);
  m.click("keypad-ok");
  assert.equal(m.byId("keypad-error").textContent, "Range low must be below range high (1000.00 psi)");
  typeKeys(m, ["neg", "1", "4", ".", "7"]);
  m.click("keypad-ok");
  assert.ok(!shown(m, "keypad"));
  assert.equal(m.byId("confirm-message").textContent, "Change Range low (4 mA) from 0.00 psi → -14.70 psi?");
  assert.deepEqual(m.state.sent, []);
  m.click("confirm-ok");
  await flush();
  assert.deepEqual(m.state.sent, [{ cmd: "range_low", value: -14.7, target: "pressure" }]);
  assert.match(cell(m, "range_low").textContent, /Saved · -14\.70 psi/);
  assert.ok(cell(m, "range_low").classList.contains("ok"));
  assert.ok(!cell(m, "range_high").classList.contains("ok"), "only the written cell");
  assert.equal(toast(m), "Range low (4 mA) set to -14.70 psi");
  // The readback tag brings the value in place.
  const before = cell(m, "range_low");
  m.render(withSensor("pressure", { range_low: -14.7 }));
  assert.equal(cell(m, "range_low"), before, "cell kept (no rebuild under a tap)");
  assert.equal(cellValue(m, "range_low"), "-14.70 psi");
});

test("edit: tank values have no ± key; density is whole kg/m3", async () => {
  const m = mount();
  m.click("tank-gear");
  m.click("alarm-tab-sensor");
  m.click("sensor-cell-fluid_density");
  assert.ok(!shown(m, "keypad-neg"));
  assert.ok(!m.byId("keypad-keys").classList.contains("signed"));
  typeKeys(m, ["1", "0", "2", "5", ".", "5"]);
  m.click("keypad-ok");
  assert.equal(m.byId("keypad-error").textContent, "Whole kg/m³ only (no decimals)");
  typeKeys(m, ["1", "0", "2", "5"]);
  m.click("keypad-ok");
  assert.equal(m.byId("confirm-message").textContent, "Change Fluid density from 1000 kg/m³ → 1025 kg/m³?");
  m.click("confirm-ok");
  await flush();
  m.click("sensor-cell-zero_m");
  typeKeys(m, ["2"]);
  m.click("keypad-ok");
  assert.equal(m.byId("keypad-error").textContent, "Zero must be below span (2.000 m)");
  typeKeys(m, ["0", ".", "1", "2", "5"]);
  m.click("keypad-ok");
  m.click("confirm-ok");
  await flush();
  assert.deepEqual(m.state.sent, [
    { cmd: "fluid_density", value: 1025, target: "tank" },
    { cmd: "zero_m", value: 0.125, target: "tank" },
  ]);
});

test("locked: Operator Sensor Calibration off on the app, the reading still shows, a tap says why", async () => {
  const m = mount({ data: withSensor("pressure", { enabled: false, range_low: null, range_high: null, offset: null }) });
  m.click("pressure-gear");
  m.click("alarm-tab-sensor");
  assert.equal(m.byId("sensor-reading").textContent, "350.2 psi", "live reading shown");
  assert.equal(m.byId("sensor-ma").textContent, "9.60 mA");
  assert.ok(shown(m, "sensor-note"));
  assert.equal(m.byId("sensor-note").textContent, SENSOR_LOCKED_TEXT);
  assert.equal(SENSOR_LOCKED_TEXT, "Enable Operator Sensor Calibration on the sensor app");
  assert.equal(m.byId("alarm-panel-note").textContent, "Locked");
  assert.ok(m.byId("alarm-panel-note").classList.contains("error"));
  for (const f of ["range_low", "range_high", "offset"]) {
    assert.equal(cellValue(m, f), "—");
    assert.ok(cell(m, f).classList.contains("locked"), f);
    assert.equal(cell(m, f).getAttribute("aria-disabled"), "true");
  }
  m.click("sensor-cell-offset");
  assert.ok(!shown(m, "keypad"), "no keypad when locked");
  assert.equal(toast(m), SENSOR_LOCKED_TEXT);
  assert.ok(m.byId("sensor-reset").classList.contains("locked"));
  m.click("sensor-reset");
  assert.ok(!shown(m, "confirm"), "no reset when locked");
  await flush();
  assert.deepEqual(m.state.sent, []);
  // The app is switched on: the same cells unlock in place.
  const before = cell(m, "offset");
  m.render(payload());
  assert.equal(cell(m, "offset"), before);
  assert.ok(cell(m, "offset").classList.contains("editable"));
  assert.ok(!shown(m, "sensor-note"));
  assert.ok(!m.byId("sensor-reset").classList.contains("locked"));
  assert.equal(m.byId("alarm-panel-note").textContent, "Tap a value to change it");
  m.click("sensor-cell-offset");
  assert.ok(shown(m, "keypad"));
});

test("view only (Local only in the cloud): values shown, cells are not buttons, nothing sent", async () => {
  const m = mount({ sensors: VIEW_ONLY });
  m.click("tank-gear");
  m.click("alarm-tab-sensor");
  assert.equal(m.byId("alarm-panel-note").textContent, SENSOR_LOCAL_ONLY_TEXT);
  assert.equal(cell(m, "span_m").tagName, "DIV");
  assert.equal(cellValue(m, "span_m"), "2.000 m");
  cell(m, "span_m").click();
  assert.ok(!shown(m, "keypad"));
  assert.equal(toast(m), SENSOR_LOCAL_ONLY_TEXT);
  m.click("sensor-reset");
  assert.ok(!shown(m, "confirm"));
  await flush();
  assert.deepEqual(m.state.sent, []);
  // The alarm tab keeps its own gate (editable here).
  m.click("alarm-tab-alarms");
  assert.equal(m.byId("alarm-panel-note").textContent, "Tap a value to change it");
});

test("reset: confirm, then reset_calibration to the sensor app; the cells' notes clear", async () => {
  const m = mount();
  m.click("pressure-gear");
  m.click("alarm-tab-sensor");
  m.click("sensor-cell-offset");
  typeKeys(m, ["2"]);
  m.click("keypad-ok");
  m.click("confirm-ok");
  await flush();
  assert.match(cell(m, "offset").textContent, /Saved/);
  m.click("sensor-reset");
  assert.ok(shown(m, "confirm"));
  assert.equal(
    m.byId("confirm-message").textContent,
    "Reset the pressure sensor to its configured values? The range low, range high and offset go back to the sensor app's config.",
  );
  m.click("confirm-ok");
  await flush();
  assert.deepEqual(m.state.sent.at(-1), { cmd: "reset_calibration", value: null, target: "pressure" });
  assert.equal(toast(m), "Pressure Sensor reset to its configured values");
  assert.doesNotMatch(cell(m, "offset").textContent, /Saved/);
  // Tank's reset names its values.
  m.click("alarm-panel-close");
  m.click("tank-gear");
  m.click("alarm-tab-sensor");
  m.click("sensor-reset");
  assert.match(m.byId("confirm-message").textContent, /The zero, span and fluid density go back/);
  m.click("confirm-cancel");
});

test("a refused write shows the app's reason on the cell and as a toast", async () => {
  const m = mount();
  m.state.ackReply = { ok: false, code: "UNAVAILABLE", message: "Refused: Operator Sensor Calibration is off" };
  m.click("tank-gear");
  m.click("alarm-tab-sensor");
  m.click("sensor-cell-span_m");
  typeKeys(m, ["3"]);
  m.click("keypad-ok");
  m.click("confirm-ok");
  await flush();
  assert.ok(cell(m, "span_m").classList.contains("error"));
  assert.match(cell(m, "span_m").textContent, /Operator Sensor Calibration is off/);
  assert.ok(!cell(m, "zero_m").classList.contains("error"));
  assert.match(toast(m), /Operator Sensor Calibration is off/);
});

test("a write with no answer names the sensor app, and frees the cell", async () => {
  const m = mount({ commandTimeoutMs: 30 });
  m.state.deferAcks = true;
  m.click("pressure-gear");
  m.click("alarm-tab-sensor");
  m.click("sensor-cell-offset");
  typeKeys(m, ["1"]);
  m.click("keypad-ok");
  m.click("confirm-ok");
  assert.ok(cell(m, "offset").classList.contains("pending"));
  m.click("sensor-cell-offset");
  assert.equal(toast(m), "Still waiting for the pressure sensor app to answer");
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(!cell(m, "offset").classList.contains("pending"));
  assert.equal(toast(m), "No reply from the pressure sensor app");
  assert.match(cell(m, "offset").textContent, /No reply from the pressure sensor app/);
});

test("a Read Only re-render keeps a sensor keypad open (the gate is access, not HMI Control Mode)", () => {
  const m = mount();
  m.click("tank-gear");
  m.click("alarm-tab-sensor");
  m.click("sensor-cell-span_m");
  assert.ok(shown(m, "keypad"));
  m.render({ ...payload(), hmi_mode: "read_only", touch: undefined });
  assert.ok(shown(m, "keypad"));
});

test("closing the popover closes its sensor keypad and confirmation", () => {
  const m = mount();
  m.click("tank-gear");
  m.click("alarm-tab-sensor");
  m.click("sensor-cell-span_m");
  m.click("alarm-panel-close");
  assert.ok(!shown(m, "keypad"));
  m.click("tank-gear");
  m.click("alarm-tab-sensor");
  m.click("sensor-reset");
  assert.ok(shown(m, "confirm"));
  m.hmi.setSensorAccess(OFF);
  m.hmi.setAlarmAccess(OFF);
  assert.ok(!shown(m, "confirm"));
});

// --- review fixes -------------------------------------------------------------------------------

// The level app's labels follow its input config: a Radar reads inverted
// (common_app._map_value), so its zero is the level at the MAXIMUM input and
// its span at the minimum; the input range and units are its config.
test("payload: the level app's input range, units and Radar inversion come from its config", () => {
  const radar = assemble(
    { sensor_settings_access: "Local only" },
    PRESSURE_TAGS,
    TANK_TAGS,
    { type: "Radar", sensor_minimum_ma: 4, sensor_maximum_ma: 20, input_units: "mA" },
  );
  assert.equal(radar.sensor_settings.tank.inverted, true);
  const volts = assemble(
    { sensor_settings_access: "Local only" },
    PRESSURE_TAGS,
    TANK_TAGS,
    { type: "Submersible", sensor_minimum_ma: 0.5, sensor_maximum_ma: 4.5, input_units: "V" },
  );
  assert.deepEqual(
    [volts.sensor_settings.tank.input_low, volts.sensor_settings.tank.input_high, volts.sensor_settings.tank.input_units],
    [0.5, 4.5, "V"],
  );
  assert.equal(volts.sensor_settings.tank.inverted, false);
  // "Radar Inverted" reads like a submersible (not inverted).
  const radarInv = assemble({ sensor_settings_access: "Local only" }, PRESSURE_TAGS, TANK_TAGS, { type: "Radar Inverted" });
  assert.equal(radarInv.sensor_settings.tank.inverted, false);
});

test("labels: pressure is a fixed 4-20 mA loop; the level app's endpoints follow its input and Radar", () => {
  assert.deepEqual(sensorInput("pressure", {}), { low: 4, high: 20, units: "mA", inverted: false });
  assert.equal(sensorLabel("range_low", S), "Range low (4 mA)");
  assert.equal(sensorLabel("range_high", S), "Range high (20 mA)");
  assert.equal(sensorLabel("offset", S), "Offset");
  assert.equal(sensorLabel("fluid_density", S), "Fluid density");
  // Submersible (or no config): zero at the minimum input, span at the maximum.
  assert.equal(sensorLabel("zero_m", S), "Zero (4 mA)");
  assert.equal(sensorHint("span_m", S), "Level at 20 mA");
  // Radar: swapped, as the app's own labels (app_ui._calibration_labels).
  const radar = { tank: { ...S.tank, input_low: 4, input_high: 20, input_units: "mA", inverted: true } };
  assert.equal(sensorLabel("zero_m", radar), "Zero (20 mA)");
  assert.equal(sensorLabel("span_m", radar), "Span (4 mA)");
  assert.equal(sensorHint("zero_m", radar), "Level at 20 mA");
  assert.equal(sensorHint("span_m", radar), "Level at 4 mA");
  // A Volts / raw input: its configured range and units, and the live input
  // is not called a loop current.
  const volts = { tank: { ...S.tank, loop_ma: 2.5, input_low: 0.5, input_high: 4.5, input_units: "V", inverted: false } };
  assert.equal(sensorEndpoint("zero_m", volts), "0.5 V");
  assert.equal(sensorHint("span_m", volts), "Level at 4.5 V");
  assert.equal(sensorInputCaption("tank", volts), "Input");
  assert.equal(formatSensorInput("tank", volts), "2.50 V");
  const raw = { tank: { ...S.tank, loop_ma: 1234, input_low: 800, input_high: 4000, input_units: "raw" } };
  assert.equal(sensorLabel("span_m", raw), "Span (4000 raw)");
  assert.equal(sensorInputCaption("pressure", raw), "Loop current");
  assert.equal(formatSensorInput("pressure", { pressure: { loop_ma: 9.6032 } }), "9.60 mA");
});

test("Radar tank: the Sensor tab's hints, keypad and confirmation say zero is the level at 20 mA", async () => {
  const radar = { ...SENSORS.tank, input_low: 4, input_high: 20, input_units: "mA", inverted: true };
  const m = mount({ data: payload({ sensor_settings: { ...SENSORS, tank: radar } }) });
  m.click("tank-gear");
  m.click("alarm-tab-sensor");
  assert.equal(cell(m, "zero_m").querySelector("[data-sensor-hint]").textContent, "Level at 20 mA");
  assert.equal(cell(m, "span_m").querySelector("[data-sensor-hint]").textContent, "Level at 4 mA");
  // No unit in any (upper-cased) caption.
  for (const c of m.byId("sensor-pane").querySelectorAll(".alarm-caption")) {
    assert.doesNotMatch(c.textContent, /mA|kPa|psi|kg/, c.textContent);
  }
  m.click("sensor-cell-zero_m");
  assert.equal(m.byId("keypad-title").textContent, "Zero (20 mA)");
  typeKeys(m, ["0", ".", "5"]);
  m.click("keypad-ok");
  assert.equal(m.byId("confirm-message").textContent, "Change Zero (20 mA) from 0.000 m → 0.500 m?");
  m.click("confirm-cancel");
});

test("a Volts level input: the live input is captioned Input, in V", () => {
  const volts = { ...SENSORS.tank, loop_ma: 2.5, input_low: 0.5, input_high: 4.5, input_units: "V", inverted: false };
  const m = mount({ data: payload({ sensor_settings: { ...SENSORS, tank: volts } }) });
  m.click("tank-gear");
  m.click("alarm-tab-sensor");
  assert.equal(m.byId("sensor-ma-caption").textContent, "Input");
  assert.equal(m.byId("sensor-ma").textContent, "2.50 V");
  assert.equal(cell(m, "zero_m").querySelector("[data-sensor-hint]").textContent, "Level at 0.5 V");
  // The pressure tab is still a loop current.
  m.click("alarm-panel-close");
  m.click("pressure-gear");
  m.click("alarm-tab-sensor");
  assert.equal(m.byId("sensor-ma-caption").textContent, "Loop current");
  assert.equal(m.byId("sensor-ma").textContent, "9.60 mA");
});

test("decimals: what is shown, confirmed and saved is what is sent (up to the app's 4 dp)", async () => {
  const kpa = { pressure: { ...S.pressure, units: "kPa", offset: 0 } };
  // At least the unit's decimals, more where the value has them, never rounded away.
  assert.equal(formatSensorValue("offset", 0.25, kpa), "0.25 kPa");
  assert.equal(formatSensorValue("offset", 0, kpa), "0.0 kPa");
  assert.equal(formatSensorValue("zero_m", 1.2345, S), "1.2345 m");
  assert.equal(formatSensorValue("zero_m", 0.1 + 0.2, S), "0.300 m");
  assert.equal(formatSensorValue("fluid_density", 1025.5, S), "1025.5 kg/m³");
  assert.equal(sensorDecimals("offset", 0.25, kpa), 2);
  assert.equal(sensorDecimals("offset", null, kpa), 1);
  // More than the app keeps: refused, so nothing is rounded on the way.
  assert.equal(validateSensorValue("zero_m", 1.23456, S), "Up to 4 decimal places");
  assert.equal(validateSensorValue("offset", 0.12345, kpa), "Up to 4 decimal places");
  assert.equal(validateSensorValue("zero_m", 1.2345, S), "");

  const m = mount({ data: withSensor("pressure", { units: "kPa", offset: 0.25 }) });
  m.click("pressure-gear");
  m.click("alarm-tab-sensor");
  assert.equal(cellValue(m, "offset"), "0.25 kPa", "the app's value, not rounded to 0.3");
  m.click("sensor-cell-offset");
  assert.equal(m.byId("keypad-entry").textContent, "0.25", "placeholder is the stored value");
  typeKeys(m, ["0", ".", "3"]);
  m.click("keypad-ok");
  assert.equal(m.byId("confirm-message").textContent, "Change Offset from 0.25 kPa → 0.3 kPa?");
  m.click("confirm-ok");
  await flush();
  m.click("sensor-cell-offset");
  typeKeys(m, ["0", ".", "1", "2", "5"]);
  m.click("keypad-ok");
  assert.equal(m.byId("confirm-message").textContent, "Change Offset from 0.25 kPa → 0.125 kPa?");
  m.click("confirm-ok");
  await flush();
  assert.deepEqual(m.state.sent.map((x) => x.value), [0.3, 0.125]);
  assert.match(cell(m, "offset").textContent, /Saved · 0\.125 kPa/);
  m.click("alarm-panel-close");
  m.click("tank-gear");
  m.click("alarm-tab-sensor");
  m.click("sensor-cell-span_m");
  typeKeys(m, ["1", ".", "2", "3", "4", "5", "6"]);
  m.click("keypad-ok");
  assert.equal(m.byId("keypad-error").textContent, "Up to 4 decimal places");
  assert.ok(shown(m, "keypad"));
});

test("a tab switch while a sensor write is out keeps the cell pending and blocks a second write", async () => {
  const m = mount({ commandTimeoutMs: 5000 });
  m.state.deferAcks = true;
  m.click("pressure-gear");
  m.click("alarm-tab-sensor");
  m.click("sensor-cell-offset");
  typeKeys(m, ["1"]);
  m.click("keypad-ok");
  m.click("confirm-ok");
  assert.ok(cell(m, "offset").classList.contains("pending"));
  // Alarms and back: the cells are rebuilt while the write is still out.
  const before = cell(m, "offset");
  m.click("alarm-tab-alarms");
  m.click("alarm-tab-sensor");
  assert.notEqual(cell(m, "offset"), before, "rebuilt");
  assert.ok(cell(m, "offset").classList.contains("pending"), "still pending after the rebuild");
  assert.match(cell(m, "offset").textContent, /Writing/);
  m.click("sensor-cell-offset");
  assert.ok(!shown(m, "keypad"), "no keypad for a cell still waiting");
  assert.equal(toast(m), "Still waiting for the pressure sensor app to answer");
  // Close and reopen: still guarded.
  m.click("alarm-panel-close");
  m.click("pressure-gear");
  m.click("alarm-tab-sensor");
  m.click("sensor-cell-offset");
  assert.ok(!shown(m, "keypad"));
  assert.equal(m.state.sent.length, 1, "one RPC only");
  // Its answer frees the (new) cell and marks it saved.
  await m.ackNext({ ok: true });
  assert.ok(!cell(m, "offset").classList.contains("pending"));
  assert.ok(cell(m, "offset").classList.contains("ok"));
  m.click("sensor-cell-offset");
  assert.ok(shown(m, "keypad"));
});

test("a tab switch while an alarm write is out keeps the alarm cell pending and blocks a second write", async () => {
  const m = mount({ commandTimeoutMs: 5000 });
  m.state.deferAcks = true;
  m.click("tank-gear");
  m.click("alarm-cell-tank_l_delay");
  typeKeys(m, ["3", "0"]);
  m.click("keypad-ok");
  m.click("confirm-ok");
  const alarmCell = () => m.byId("alarm-cell-tank_l_delay");
  assert.ok(alarmCell().classList.contains("pending"));
  m.click("alarm-tab-sensor");
  m.click("alarm-tab-alarms");
  assert.ok(alarmCell().classList.contains("pending"), "still pending after the rebuild");
  m.click("alarm-cell-tank_l_delay");
  assert.ok(!shown(m, "keypad"));
  assert.equal(toast(m), "Still waiting for the pump controller to answer");
  assert.equal(m.state.sent.length, 1);
  await m.ackNext({ ok: true });
  assert.ok(!alarmCell().classList.contains("pending"));
  assert.ok(alarmCell().classList.contains("ok"));
});

test("a second Reset while the first is out names the sensor app and sends nothing", async () => {
  const m = mount({ commandTimeoutMs: 5000 });
  m.state.deferAcks = true;
  m.click("tank-gear");
  m.click("alarm-tab-sensor");
  m.click("sensor-reset");
  m.click("confirm-ok");
  assert.ok(m.byId("sensor-reset").classList.contains("pending"));
  m.click("sensor-reset");
  assert.ok(!shown(m, "confirm"), "no second confirmation");
  assert.equal(toast(m), "Still waiting for the tank level sensor app to answer");
  assert.doesNotMatch(toast(m), /pump controller/);
  assert.equal(m.state.sent.length, 1);
  // The button is shared: the pressure pane's reset is not blocked by the tank's.
  m.click("alarm-panel-close");
  m.click("pressure-gear");
  m.click("alarm-tab-sensor");
  assert.ok(!m.byId("sensor-reset").classList.contains("pending"));
  m.click("sensor-reset");
  assert.ok(shown(m, "confirm"));
  m.click("confirm-cancel");
  await m.ackNext({ ok: true });
  m.click("alarm-panel-close");
  m.click("tank-gear");
  m.click("alarm-tab-sensor");
  assert.ok(!m.byId("sensor-reset").classList.contains("pending"));
});
