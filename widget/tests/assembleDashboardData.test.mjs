// Data adapter tests: ported from sia-local-control-ui tests/test_controller_features.py,
// test_hmi_control_mode.py and test_dashboard_data.py, where this logic used to
// run in the device app. It now lives only in the widget and is tested here.
import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleDashboardData,
  createFeatureMemory,
  liveTagIds,
  normaliseHmiMode,
  resolveConfig,
} from "../src/lib/assembleDashboardData.ts";
import { resolveAppKey } from "../src/lib/appKey.ts";
import { CTRL, deployment, featuresOffTags, legacyControllerTags } from "./helpers.mjs";

const build = ({ config = {}, tags = legacyControllerTags(), extra = {}, uiCmds, memory } = {}) =>
  assembleDashboardData({
    appKey: "sia_local_control_ui_1",
    deploymentConfig: deployment(config),
    tagValues: { [CTRL]: tags, ...extra },
    uiCmds,
    lastUpdated: Date.parse("2026-09-28T01:02:03Z"),
    memory: memory ?? createFeatureMemory(),
  });

const NEW_KEYS = ["vsd", "touch", "solar", "tank", "skid"];

// --- config -----------------------------------------------------------------

test("config defaults: read only, one controller sia_injection_controller_1", () => {
  const cfg = resolveConfig("sia_local_control_ui_1", undefined);
  assert.equal(cfg.hmiMode, "read_only");
  assert.equal(cfg.touchEnabled, false);
  assert.deepEqual(cfg.controllers, ["sia_injection_controller_1"]);
  assert.equal(cfg.rateUnits, "L/Hr");
  assert.equal(cfg.pressureUnits, "psi");
  assert.equal(cfg.pressureSensorApp, null);
  assert.equal(cfg.tankLevelApp, null);
  assert.deepEqual(cfg.solarControllers, []);
  assert.equal(cfg.rpcTimeoutMs, 20000);
});

test("config is read from this install's own block", () => {
  const cfg = resolveConfig(
    "sia_local_control_ui_2",
    deployment(
      {
        hmi_control_mode: "Touch",
        pump_controllers: ["ctrl_a", "ctrl_b"],
        pressure_sensor_app: "4_20ma_sensor_2",
        tank_level_app: "analog_level_sensor_1",
        solar_controllers: ["prostar_1"],
        rate_units: "L/Day",
        pressure_units: "kPa",
        rpc_timeout_s: 5,
      },
      "sia_local_control_ui_2",
    ),
  );
  assert.equal(cfg.touchEnabled, true);
  assert.deepEqual(cfg.controllers, ["ctrl_a", "ctrl_b"]);
  assert.equal(cfg.pressureSensorApp, "4_20ma_sensor_2");
  assert.deepEqual(cfg.solarControllers, ["prostar_1"]);
  assert.equal(cfg.rateUnits, "L/Day");
  assert.equal(cfg.rpcTimeoutMs, 5000);
});

test("HMI Control Mode: only Touch enables on-screen control", () => {
  for (const [raw, mode] of [
    ["Read Only", "read_only"],
    ["Touch", "touch"],
    ["touch", "touch"],
    ["Button", "button"],
    [undefined, "read_only"],
    ["nonsense", "read_only"],
  ]) {
    assert.equal(normaliseHmiMode(raw), mode, String(raw));
    const cfg = resolveConfig("sia_local_control_ui_1", deployment(raw === undefined ? {} : { hmi_control_mode: raw }));
    assert.equal(cfg.touchEnabled, mode === "touch", String(raw));
  }
});

test("an explicitly empty controller list means no controller", () => {
  const data = build({ config: { pump_controllers: [] } });
  assert.deepEqual(data.pumps, []);
  assert.equal(data.link_ok, false);
  for (const k of NEW_KEYS) assert.ok(!(k in data), k);
});

test("app key: cloud uiElement, local widget channel name, URL, default", () => {
  assert.equal(resolveAppKey({ app_key: "sia_local_control_ui_3" }), "sia_local_control_ui_3");
  assert.equal(resolveAppKey({ app_key: "$config.app().APP_KEY", name: "sia_local_control_ui_2_widget" }), "sia_local_control_ui_2");
  assert.equal(resolveAppKey({ name: "sia_hmi_widget" }, "?app_key=sia_local_control_ui_4"), "sia_local_control_ui_4");
  assert.equal(resolveAppKey(undefined, ""), "sia_local_control_ui_1");
});

// --- pumps, faults, warnings ------------------------------------------------------

test("single pump running: readings and link", () => {
  const data = build();
  assert.equal(data.pumps.length, 1);
  const p = data.pumps[0];
  assert.equal(p.name, "Pump");
  assert.equal(p.state, "pumping");
  assert.equal(p.target_rate, 12.5);
  assert.equal(p.min_rate, 2);
  assert.equal(data.link_ok, true);
  assert.deepEqual(data.faults, []);
  assert.deepEqual(data.units, { rate: "L/Hr", pressure: "psi" });
  assert.equal(data.timestamp, "2026-09-28T01:02:03.000Z");
});

test("legacy controller payload has no new keys", () => {
  const data = build({ tags: legacyControllerTags() });
  for (const k of NEW_KEYS) assert.ok(!(k in data), k);
});

test("a new controller with every feature off renders identically", () => {
  const legacy = build({ tags: legacyControllerTags() });
  const off = build({ tags: featuresOffTags() });
  assert.deepEqual(off, legacy);
});

test("fault surfaces its reason; missing reason falls back to the trip bit text", () => {
  let data = build({ tags: legacyControllerTags({ Fault: true, FaultReason: "Pressure high-high", StateString: "fault" }) });
  assert.deepEqual(data.faults, [{ pump: "Pump", reason: "Pressure high-high" }]);
  data = build({ tags: featuresOffTags({ Fault: true, TripVsdComms: true, StateString: "fault" }) });
  assert.deepEqual(data.faults, [{ pump: "Pump", reason: "VSD communications lost" }]);
  data = build({ tags: legacyControllerTags({ Fault: true, StateString: "fault" }) });
  assert.deepEqual(data.faults, [{ pump: "Pump", reason: "Pump tripped" }]);
});

test("warning surfaces without a trip", () => {
  const data = build({ tags: legacyControllerTags({ Warning: true, WarningReason: "No stroke feedback" }) });
  assert.deepEqual(data.warnings, [{ pump: "Pump", reason: "No stroke feedback" }]);
  assert.deepEqual(data.faults, []);
});

test("concurrent warnings joined by the controller become one banner item each", () => {
  const data = build({
    tags: legacyControllerTags({
      Warning: true,
      WarningReason: "Pressure data stale - pressure alarms held; Tank level data stale - tank alarms held",
    }),
  });
  assert.deepEqual(data.warnings, [
    { pump: "Pump", reason: "Pressure data stale - pressure alarms held" },
    { pump: "Pump", reason: "Tank level data stale - tank alarms held" },
  ]);
});

test("min/max stay null until published; a missing target stays null", () => {
  const data = build({ tags: legacyControllerTags({ MinRate: null, MaxRate: undefined, TargetRate: null }) });
  assert.equal(data.pumps[0].min_rate, null);
  assert.equal(data.pumps[0].max_rate, null);
  assert.equal(data.pumps[0].target_rate, null);
});

test("no controller data yet: state unknown and link down", () => {
  const data = assembleDashboardData({
    appKey: "sia_local_control_ui_1",
    deploymentConfig: undefined,
    tagValues: {},
    uiCmds: undefined,
    memory: createFeatureMemory(),
  });
  assert.equal(data.pumps[0].state, "unknown");
  assert.equal(data.link_ok, false);
});

test("two controllers: numbered pumps, faults from both", () => {
  const data = build({
    config: { pump_controllers: [CTRL, "ctrl_2"] },
    extra: { ctrl_2: legacyControllerTags({ Fault: true, FaultReason: "Tank level low-low" }) },
  });
  assert.deepEqual(data.pumps.map((p) => p.name), ["Pump 1", "Pump 2"]);
  assert.deepEqual(data.faults, [{ pump: "Pump 2", reason: "Tank level low-low" }]);
});

// --- control mode ---------------------------------------------------------------

test("no control-mode payload, whatever the controller publishes", () => {
  for (const tags of [
    featuresOffTags({ ControlAuthorityActive: true, ControlMode: "cloud" }),
    featuresOffTags({ ControlMode: "local", DcsCmdResult: 0 }),
    featuresOffTags({ ControlMode: "dcs" }),
  ]) {
    const data = build({ tags, config: { control_mode_switch: "Always Show" } });
    assert.ok(!("control" in data));
  }
  const cfg = resolveConfig("sia_local_control_ui_1", deployment({ control_mode_switch: "Always Show" }));
  assert.ok(!("controlModeSwitch" in cfg));
});

// --- VSD --------------------------------------------------------------------------

test("VsdConfigured true shows the card before any drive data", () => {
  const data = build({ tags: featuresOffTags({ VsdConfigured: true }) });
  assert.deepEqual(data.vsd, {
    tripped: false,
    trip_code: null,
    trip_description: null,
    motor_hz: null,
    pump_rpm: null,
  });
});

test("VsdConfigured false overrides the heuristics", () => {
  const data = build({ tags: featuresOffTags({ VsdConfigured: false, MotorOutputHz: 40, TripVsd: true }) });
  assert.ok(!("vsd" in data));
});

test("fallback: VSD card and drive line when the motor reports a frequency", () => {
  const data = build({ tags: featuresOffTags({ MotorOutputHz: 42.5, PumpRpm: 61 }) });
  assert.equal(data.vsd.motor_hz, 42.5);
  assert.equal(data.vsd.pump_rpm, 61);
  assert.equal(data.vsd.tripped, false);
});

test("VSD trip shows its description and code", () => {
  const data = build({
    tags: featuresOffTags({ VsdConfigured: true, VsdTripCode: 3, VsdTripDescription: "Over current" }),
  });
  assert.equal(data.vsd.tripped, true);
  assert.equal(data.vsd.trip_code, 3);
  assert.equal(data.vsd.trip_description, "Over current");
});

test("fallback: VSD detected from a comms trip and kept when the frequency goes null", () => {
  const memory = createFeatureMemory();
  assert.ok("vsd" in build({ tags: featuresOffTags({ TripVsdComms: true }), memory }));
  assert.ok("vsd" in build({ tags: featuresOffTags(), memory }));
  assert.ok(!("vsd" in build({ tags: featuresOffTags() })));
});

// --- units --------------------------------------------------------------------------

test("pressure units: the controller's when the HMI is on the psi default", () => {
  const data = build({ tags: featuresOffTags({ PressureUnits: "kPa" }) });
  assert.equal(data.units.pressure, "kPa");
});

test("pressure units: the HMI's own setting wins", () => {
  const data = build({ config: { pressure_units: "bar" }, tags: featuresOffTags({ PressureUnits: "kPa" }) });
  assert.equal(data.units.pressure, "bar");
});

// --- touch --------------------------------------------------------------------------

test("read only payload has no touch key; button mode neither", () => {
  assert.ok(!("touch" in build()));
  assert.ok(!("touch" in build({ config: { hmi_control_mode: "Button" } })));
  assert.equal(build({ config: { hmi_control_mode: "Button" } }).hmi_mode, "button");
});

test("touch payload carries the calibration factor and range", () => {
  const data = build({ config: { hmi_control_mode: "Touch" }, tags: legacyControllerTags({ CorrectionFactor: 1.1 }) });
  assert.deepEqual(data.touch, { calibration_factor: 1.1, calibration_min: 0.3, calibration_max: 1.7 });
});

test("touch: the saved ui_cmds calibration factor beats the (non-live) tag", () => {
  const data = build({
    config: { hmi_control_mode: "Touch" },
    tags: legacyControllerTags({ CorrectionFactor: 1.0 }),
    uiCmds: { [CTRL]: { last_calibration_factor: 1.25 } },
  });
  assert.equal(data.touch.calibration_factor, 1.25);
});

test("touch payload otherwise matches read only", () => {
  const ro = build();
  const t = build({ config: { hmi_control_mode: "Touch" } });
  delete t.touch;
  t.hmi_mode = ro.hmi_mode;
  assert.deepEqual(t, ro);
});

// --- 1min Calibration Sequence (CalibrationMethod "Manual (HMI)") -------------------

const TOUCH = { hmi_control_mode: "Touch" };

test("calibration: no key without the CalibrationMethod tag (older controller)", () => {
  assert.ok(!("calibration" in build({ config: TOUCH })));
});

for (const method of ["None", "Auto", "", null]) {
  test(`calibration: no key when the method is ${JSON.stringify(method)}`, () => {
    const data = build({ config: TOUCH, tags: legacyControllerTags({ CalibrationMethod: method }) });
    assert.ok(!("calibration" in data));
    assert.ok("touch" in data);
  });
}

test("calibration: Manual (HMI) in Touch carries the test run", () => {
  const data = build({
    config: TOUCH,
    tags: legacyControllerTags({
      CalibrationMethod: "Manual (HMI)",
      TestRunActive: true,
      TestRunRemaining_s: 41.5,
      TestRunRate: 12.5,
      TestRunDuration_s: 60,
      TestRunElapsed_s: 18.5,
      TestRunResult: null,
    }),
  });
  assert.deepEqual(data.calibration, {
    method: "Manual (HMI)",
    test_run: {
      active: true, remaining_s: 41.5, rate: 12.5, duration_s: 60, elapsed_s: 18.5, result: null, ended_by: null,
    },
  });
});

test("calibration: who ended the run (TestRunEndedBy), each value the controller publishes", () => {
  for (const by of ["hmi", "dcs", "cloud", "deadline", "fault", "restart"]) {
    const data = build({
      config: TOUCH,
      tags: legacyControllerTags({ CalibrationMethod: "Manual (HMI)", TestRunResult: "cancelled", TestRunEndedBy: by }),
    });
    assert.equal(data.calibration.test_run.result, "cancelled");
    assert.equal(data.calibration.test_run.ended_by, by);
  }
});

test("calibration: an unknown or unpublished TestRunEndedBy reads null (an older controller)", () => {
  for (const by of ["DCS", "modbus", "", 3, null, undefined]) {
    const data = build({
      config: TOUCH,
      tags: legacyControllerTags({ CalibrationMethod: "Manual (HMI)", TestRunResult: "cancelled", TestRunEndedBy: by }),
    });
    assert.equal(data.calibration.test_run.ended_by, null, String(by));
  }
});

test("calibration: an unpublished test run reads inactive, an odd result null", () => {
  const data = build({
    config: TOUCH,
    tags: legacyControllerTags({ CalibrationMethod: "Manual (HMI)", TestRunResult: "banana" }),
  });
  assert.deepEqual(data.calibration.test_run, {
    active: false, remaining_s: null, rate: null, duration_s: null, elapsed_s: null, result: null, ended_by: null,
  });
});

test("calibration: never in Read Only, even with Manual (HMI)", () => {
  const data = build({ tags: legacyControllerTags({ CalibrationMethod: "Manual (HMI)", TestRunActive: true }) });
  assert.ok(!("calibration" in data));
});

test("calibration: the cloud streams the method and test run tags", () => {
  const ids = liveTagIds(resolveConfig("sia_local_control_ui_1", deployment({})));
  for (const tag of ["CalibrationMethod", "TestRunActive", "TestRunRemaining_s", "TestRunRate",
    "TestRunDuration_s", "TestRunElapsed_s", "TestRunResult", "TestRunEndedBy"]) {
    assert.ok(ids.includes(`${CTRL}.${tag}`), tag);
  }
});

// --- peripherals -----------------------------------------------------------------------

test("no solar key when no solar controllers; card data when configured", () => {
  assert.ok(!("solar" in build()));
  const data = build({
    config: { solar_controllers: ["ps_1", "ps_2"] },
    extra: {
      ps_1: { b_voltage: 25, b_percent: 80, panel_power: 100, remaining_ah: 100 },
      ps_2: { b_voltage: 26, b_percent: 90, panel_power: 120, remaining_ah: 50 },
    },
  });
  assert.deepEqual(data.solar, { battery_voltage: 25.5, battery_percentage: 85, panel_power: 110, battery_ah: 150 });
});

test("solar card shows (empty) before any readings arrive", () => {
  const data = build({ config: { solar_controllers: ["ps_1"] } });
  assert.deepEqual(data.solar, {});
});

const solarBuild = (pct, memory, config = {}, volts = 25) =>
  build({
    config: { solar_controllers: ["ps_1"], ...config },
    extra: { ps_1: { b_voltage: volts, b_percent: pct } },
    memory,
  });
const batteryWarnings = (data) => data.warnings.filter((w) => w.pump === "Solar");

test("low battery percentage raises a warning; healthy does not", () => {
  assert.equal(batteryWarnings(solarBuild(20)).length, 1);
  assert.match(batteryWarnings(solarBuild(20))[0].reason, /Battery low: 20.0%/);
  assert.equal(batteryWarnings(solarBuild(80)).length, 0);
});

test("low battery latches until the clear margin is passed", () => {
  const memory = createFeatureMemory();
  assert.equal(batteryWarnings(solarBuild(29, memory)).length, 1);
  assert.equal(batteryWarnings(solarBuild(33, memory)).length, 1); // < 30 + 5
  assert.equal(batteryWarnings(solarBuild(36, memory)).length, 0);
  assert.equal(batteryWarnings(solarBuild(33, memory)).length, 0);
});

test("low battery voltage check is off by default and works when configured", () => {
  assert.equal(batteryWarnings(solarBuild(80, undefined, {}, 11)).length, 0);
  const data = solarBuild(80, undefined, { low_battery_warning_v: 12 }, 11);
  assert.match(batteryWarnings(data)[0].reason, /11.0V/);
});

test("a zero threshold disables the battery warning", () => {
  assert.equal(batteryWarnings(solarBuild(5, undefined, { low_battery_warning_: 0 })).length, 0);
});

test("tank and skid cards from their apps", () => {
  const data = build({
    config: { tank_level_app: "tank_1", pressure_sensor_app: "p_1", flow_sensor_app: "f_1" },
    extra: { tank_1: { level_reading: 0.85, level_filled_percentage: 64 }, p_1: { value: 350.2 }, f_1: { value: 11.2 } },
  });
  assert.deepEqual(data.tank, { tank_level_mm: 850, tank_level_percent: 64 });
  assert.deepEqual(data.skid, { skid_flow: 11.2, skid_pressure: 350.2 });
});

test("tank / skid hidden when their apps are unset or silent", () => {
  const data = build({ config: { tank_level_app: "tank_1" } });
  assert.ok(!("tank" in data));
  assert.ok(!("skid" in data));
});

test("a configured but silent pressure / flow app keeps its skid reading as null", () => {
  // A disconnected or out-of-range sensor publishes no value; the tile (and
  // its gear) must stay so an operator can calibrate it.
  const data = build({ config: { pressure_sensor_app: "p_1", flow_sensor_app: "f_1" }, extra: { p_1: {}, f_1: { value: 1.5 } } });
  assert.deepEqual(data.skid, { skid_flow: 1.5, skid_pressure: null });
});

// --- live tag claim ----------------------------------------------------------------------

test("live tag claim covers the controller and peripheral tags the cards read", () => {
  const ids = liveTagIds(
    resolveConfig("sia_local_control_ui_1", deployment({ tank_level_app: "tank_1", pressure_sensor_app: "p_1" })),
  );
  for (const id of [
    `${CTRL}.StateString`,
    `${CTRL}.TargetRate`,
    `${CTRL}.Fault`,
    `${CTRL}.VsdConfigured`,
    "tank_1.level_reading",
    "p_1.value",
  ]) {
    assert.ok(ids.includes(id), id);
  }
});
