import assert from "node:assert/strict";
import test from "node:test";

import { assembleDashboardData } from "./assembleDashboardData.ts";

test("assembles every existing HMI section directly from channels", () => {
  const result = assembleDashboardData({
    appKey: "hmi_1",
    deploymentConfig: {
      applications: {
        hmi_1: {
          pump_controllers: ["pump_1", "pump_2"],
          solar_controllers: ["solar_1", "solar_2"],
          tank_level_app: "tank_1",
          flow_sensor_app: "flow_1",
          pressure_sensor_app: "pressure_1",
          enable_selector: true,
          rate_units: "L/Day",
          pressure_units: "kPa",
        },
      },
    },
    tagValues: {
      pump_1: {
        StateString: "pumping",
        TargetRate: 12.5,
        FlowRate: 11.9,
        Total: 345.6,
        MinRate: 2,
        MaxRate: 30,
        Running: true,
        Fault: false,
        Warning: true,
        WarningReason: "No flow feedback",
      },
      pump_2: {
        StateString: "fault",
        Fault: true,
        FaultReason: "Tank low-low",
      },
      solar_1: { b_voltage: 24, b_percent: 40, panel_power: 10, remaining_ah: 15 },
      solar_2: { b_voltage: 26, b_percent: 60, panel_power: 30, remaining_ah: 20 },
      tank_1: { level_reading: 1.25, level_filled_percentage: 75 },
      flow_1: { value: 9.5 },
      pressure_1: { value: 320 },
      hmi_1: { SelectorState: 3 },
    },
  });

  assert.equal(result.pumps.length, 2);
  assert.equal(result.pumps[0].name, "Pump 1");
  assert.equal(result.pumps[0].target_rate, 12.5);
  assert.equal(result.pumps[0].min_rate, 2);
  assert.equal(result.link_ok, true);
  assert.deepEqual(result.warnings, [{ pump: "Pump 1", reason: "No flow feedback" }]);
  assert.deepEqual(result.faults, [{ pump: "Pump 2", reason: "Tank low-low" }]);
  assert.deepEqual(result.solar, {
    battery_voltage: 25,
    battery_percentage: 50,
    panel_power: 20,
    battery_ah: 35,
  });
  assert.deepEqual(result.tank, { tank_level_mm: 1250, tank_level_percent: 75 });
  assert.deepEqual(result.skid, { skid_flow: 9.5, skid_pressure: 320 });
  assert.deepEqual(result.selector, { state: 3 });
  assert.deepEqual(result.units, { rate: "L/Day", pressure: "kPa" });
});

test("uses tag-name overrides and preserves absent flow bounds", () => {
  const result = assembleDashboardData({
    appKey: "hmi",
    deploymentConfig: {
      applications: {
        hmi: {
          pump_controllers: [{ value: "controller" }],
          tag_state: "mode",
          tag_target_rate: "setpoint",
        },
      },
    },
    tagValues: { controller: { mode: "standby", setpoint: "7.5" } },
  });

  assert.equal(result.pumps[0].name, "Pump");
  assert.equal(result.pumps[0].state, "standby");
  assert.equal(result.pumps[0].target_rate, 7.5);
  assert.equal(result.pumps[0].min_rate, null);
  assert.equal(result.pumps[0].max_rate, null);
  assert.equal(result.skid, undefined);
});

test("reports no controller link when the primary state is unavailable", () => {
  const result = assembleDashboardData({
    appKey: "hmi",
    deploymentConfig: { applications: { hmi: { pump_controllers: ["controller"] } } },
    tagValues: {},
  });
  assert.equal(result.link_ok, false);
  assert.equal(result.pumps[0].state, "unknown");
});
