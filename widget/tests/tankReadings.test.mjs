// Tank Level readings: tank_primary_reading (default "mm") and
// tank_secondary_reading (default "None"), each mapped to the tag the analog
// level sensor app publishes (level_reading in metres, level_volume in its
// Volume Units, level_filled_percentage). Adapter + render core.
import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleDashboardData,
  createFeatureMemory,
  readTankLevel,
  resolveConfig,
  TANK_READINGS,
} from "../src/lib/assembleDashboardData.ts";
import { CTRL, deployment, isHidden, LEGACY_PAYLOADS, legacyControllerTags, mountHmi } from "./helpers.mjs";

const APP = "sia_local_control_ui_1";
const TANK = "analog_level_sensor_1";
const TANK_TAGS = { level_reading: 0.85, level_filled_percentage: 64.4, level_volume: 1284.6 };

const build = (config = {}, tankTags = TANK_TAGS) =>
  assembleDashboardData({
    appKey: APP,
    deploymentConfig: deployment({ tank_level_app: TANK, ...config }, APP),
    tagValues: { [CTRL]: legacyControllerTags(), [TANK]: tankTags },
    uiCmds: undefined,
    memory: createFeatureMemory(),
  });

const reading = (m) => ({
  primary: m.byId("tank-level-mm").querySelector(".value").textContent,
  primaryUnit: m.byId("tank-level-mm").querySelector(".unit").textContent,
  secondaryHidden: isHidden(m.byId("tank-level-secondary")),
  secondary: m.byId("tank-level-secondary").textContent,
});

// --- config -------------------------------------------------------------------

test("defaults: primary mm, no secondary (existing configs)", () => {
  const cfg = resolveConfig(APP, deployment({}, APP));
  assert.equal(cfg.tankPrimary, "mm");
  assert.equal(cfg.tankSecondary, null);
  const none = resolveConfig(APP, deployment({ tank_secondary_reading: "None" }, APP));
  assert.equal(none.tankSecondary, null);
  // An unknown value falls back rather than breaking the card.
  assert.equal(resolveConfig(APP, deployment({ tank_primary_reading: "Gal" }, APP)).tankPrimary, "mm");
});

// --- unit mapping ---------------------------------------------------------------

test("each reading maps to the tank app's real tag with the right conversion", () => {
  const get = (tag, key) => (key === TANK ? TANK_TAGS[tag] : undefined);
  assert.deepEqual(TANK_READINGS, ["mm", "m", "L", "%"]);
  assert.deepEqual(readTankLevel(get, TANK, "mm"), { value: 850, unit: "mm", decimals: 0 });
  assert.deepEqual(readTankLevel(get, TANK, "m"), { value: 0.85, unit: "m", decimals: 2 });
  assert.deepEqual(readTankLevel(get, TANK, "L"), { value: 1285, unit: "L", decimals: 0 });
  assert.deepEqual(readTankLevel(get, TANK, "%"), { value: 64, unit: "%", decimals: 0 });
  // An unpublished tag is null, never a made-up 0.
  assert.equal(readTankLevel(() => undefined, TANK, "L").value, null);
  assert.equal(readTankLevel(() => null, TANK, "mm").value, null);
});

// --- default renders exactly as before --------------------------------------------

test("default config: tank payload and card exactly as before", () => {
  const data = build();
  assert.deepEqual(data.tank, { tank_level_mm: 850, tank_level_percent: 64.4 });
  // Same card as the legacy payload the old HMI pushed.
  const before = mountHmi();
  before.render(LEGACY_PAYLOADS.warning_with_peripherals);
  const now = mountHmi();
  now.render({ ...LEGACY_PAYLOADS.warning_with_peripherals, tank: data.tank });
  assert.equal(
    now.byId("tank-section").outerHTML.replace("64.4", "64"),
    before.byId("tank-section").outerHTML,
  );
  assert.deepEqual(reading(now), { primary: "850", primaryUnit: "mm", secondaryHidden: true, secondary: "" });
});

// --- configured readings -------------------------------------------------------------

test("primary L with secondary mm", () => {
  const data = build({ tank_primary_reading: "L", tank_secondary_reading: "mm" });
  assert.deepEqual(data.tank.level_primary, { value: 1285, unit: "L", decimals: 0 });
  assert.deepEqual(data.tank.level_secondary, { value: 850, unit: "mm", decimals: 0 });
  const m = mountHmi();
  m.render({ ...LEGACY_PAYLOADS.running, tank: data.tank });
  assert.deepEqual(reading(m), { primary: "1285", primaryUnit: "L", secondaryHidden: false, secondary: "850mm" });
  // Fill % bar unchanged.
  assert.equal(m.byId("tank-level-percent").querySelector(".value").textContent, "64");
  assert.equal(m.byId("tank-progress").style.width, "64%");
});

test("secondary None renders nothing", () => {
  const data = build({ tank_primary_reading: "L", tank_secondary_reading: "None" });
  assert.ok(!("level_secondary" in data.tank));
  const m = mountHmi();
  m.render({ ...LEGACY_PAYLOADS.running, tank: data.tank });
  const r = reading(m);
  assert.equal(r.secondaryHidden, true);
  assert.equal(r.secondary, "");
  assert.equal(getComputedStyleDisplay(m, "tank-level-secondary"), "none");
});

test("a secondary whose tag has no value is hidden", () => {
  const noVolume = { level_reading: 0.85, level_filled_percentage: 64 };
  const data = build({ tank_secondary_reading: "L" }, noVolume);
  assert.ok(!("level_secondary" in data.tank));
  const m = mountHmi();
  m.render({ ...LEGACY_PAYLOADS.running, tank: build({ tank_secondary_reading: "L" }).tank });
  assert.equal(reading(m).secondaryHidden, false);
  // The tag stops publishing: the line goes away, no placeholder.
  m.render({ ...LEGACY_PAYLOADS.running, tank: data.tank });
  assert.equal(reading(m).secondaryHidden, true);
});

test("a primary whose tag has no value shows a dash with its unit", () => {
  const data = build({ tank_primary_reading: "L" }, { level_reading: 0.85, level_filled_percentage: 64 });
  assert.deepEqual(data.tank.level_primary, { value: null, unit: "L", decimals: 0 });
  const m = mountHmi();
  m.render({ ...LEGACY_PAYLOADS.running, tank: data.tank });
  assert.equal(reading(m).primary, "--");
  assert.equal(reading(m).primaryUnit, "L");
});

test("m and % as primary / secondary", () => {
  const data = build({ tank_primary_reading: "m", tank_secondary_reading: "%" });
  const m = mountHmi();
  m.render({ ...LEGACY_PAYLOADS.running, tank: data.tank });
  assert.deepEqual(reading(m), { primary: "0.85", primaryUnit: "m", secondaryHidden: false, secondary: "64%" });
});

test("switching back to the defaults restores the mm card", () => {
  const m = mountHmi();
  m.render({ ...LEGACY_PAYLOADS.running, tank: build({ tank_primary_reading: "L", tank_secondary_reading: "mm" }).tank });
  m.render({ ...LEGACY_PAYLOADS.running, tank: build().tank });
  const r = reading(m);
  assert.deepEqual([r.primary, r.primaryUnit, r.secondaryHidden], ["850", "mm", true]);
});

function getComputedStyleDisplay(m, id) {
  const el = m.byId(id);
  return el.classList.contains("hidden") ? "none" : el.ownerDocument.defaultView.getComputedStyle(el).display;
}
