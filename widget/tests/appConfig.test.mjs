// The widget reads the SAME config keys as the sia_local_control_ui container
// (one app, one config block). Uses the Kuwait fixture the Python suite loads
// (tests/fixtures/kuwait_foamer_hmi_config.json), so a key the widget reads
// can never drift from what is deployed. The Python side pins the reverse
// (tests/test_widget_contract.py: every key read here exists in the schema).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assembleDashboardData,
  createFeatureMemory,
  liveTagIds,
  resolveConfig,
} from "../src/lib/assembleDashboardData.ts";
import { resolveAppKey } from "../src/lib/appKey.ts";
import { deployment, legacyControllerTags } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "..", "tests", "fixtures", "kuwait_foamer_hmi_config.json");
const APP = "sia_local_control_ui_1";

function kuwait(over = {}) {
  const data = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  delete data._comment;
  return { ...data, ...over };
}

test("Kuwait config (no hmi_control_mode key): read only, its own thresholds and units", () => {
  const cfg = resolveConfig(APP, deployment(kuwait(), APP));
  assert.equal(cfg.hmiMode, "read_only");
  assert.equal(cfg.touchEnabled, false);
  assert.deepEqual(cfg.controllers, ["sia_injection_controller_1"]);
  assert.deepEqual(cfg.solarControllers, ["morningstar_prostar_app_1", "morningstar_prostar_app_2"]);
  assert.equal(cfg.rateUnits, "L/Hr");
  assert.equal(cfg.pressureUnits, "psi");
  assert.equal(cfg.lowBatteryPercent, 30);
  assert.equal(cfg.lowBatteryVoltage, 0);
  assert.equal(cfg.lowBatteryClearMargin, 5);
  assert.equal(cfg.rpcTimeoutMs, 20000);
  assert.equal(cfg.tags.state, "StateString");
  assert.equal(cfg.tags.warningReason, "WarningReason");
});

test("battery thresholds come from the deployed keys low_battery_warning_ / _v", () => {
  const cfg = resolveConfig(
    APP,
    deployment(kuwait({ low_battery_warning_: 45, low_battery_warning_v: 23.5, rpc_timeout_s: 7 }), APP),
  );
  assert.equal(cfg.lowBatteryPercent, 45);
  assert.equal(cfg.lowBatteryVoltage, 23.5);
  assert.equal(cfg.rpcTimeoutMs, 7000);
});

test("Touch on a Kuwait config enables on-screen control, Button stays read only", () => {
  assert.equal(resolveConfig(APP, deployment(kuwait({ hmi_control_mode: "Touch" }), APP)).touchEnabled, true);
  assert.equal(resolveConfig(APP, deployment(kuwait({ hmi_control_mode: "Button" }), APP)).touchEnabled, false);
});

test("the configured status tag names are the ones read (same as the legacy dashboard)", () => {
  const renamed = kuwait({ state_tag: "PumpState", target_rate_tag: "Setpoint", fault_tag: "Tripped" });
  const tags = legacyControllerTags();
  tags.PumpState = "pumping";
  tags.Setpoint = 7.25;
  tags.Tripped = true;
  const data = assembleDashboardData({
    appKey: APP,
    deploymentConfig: deployment(renamed, APP),
    tagValues: { sia_injection_controller_1: tags },
    uiCmds: undefined,
    memory: createFeatureMemory(),
  });
  assert.equal(data.pumps[0].state, "pumping");
  assert.equal(data.pumps[0].target_rate, 7.25);
  assert.equal(data.pumps[0].fault, true);
  const ids = liveTagIds(resolveConfig(APP, deployment(renamed, APP)));
  assert.ok(ids.includes("sia_injection_controller_1.PumpState"));
  assert.ok(!ids.includes("sia_injection_controller_1.StateString"));
});

test("container-only keys are ignored by the widget", () => {
  // Buttons, lamps, dashboard server settings: meaningful to the container only.
  const a = resolveConfig(APP, deployment(kuwait(), APP));
  const b = resolveConfig(
    APP,
    deployment(kuwait({ local_dashboard_enabled: false, dashboard_port: 9000, run_lamp_pin: null }), APP),
  );
  assert.deepEqual(a, b);
});

test("app key: the cloud's app_key, else the widget channel name, else ?app_key=", () => {
  assert.equal(resolveAppKey({ app_key: APP, name: "sia_hmi_widget" }), APP);
  assert.equal(
    resolveAppKey({ app_key: "$config.app().APP_KEY", name: "sia_local_control_ui_2_widget" }),
    "sia_local_control_ui_2",
  );
  // The static ui_schema element name is never mistaken for an install key.
  assert.equal(resolveAppKey({ name: "sia_hmi_widget" }, "?app_key=sia_local_control_ui_3"), "sia_local_control_ui_3");
  assert.equal(resolveAppKey(undefined, ""), APP);
});
