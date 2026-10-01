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
import { TANK_FAULT_LABEL, tankFaultReason } from "../src/core/hmi-core.js";
import {
  CTRL,
  deployment,
  isHidden,
  LEGACY_PAYLOADS,
  legacyControllerTags,
  mountHmi,
  touchPayload,
} from "./helpers.mjs";

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

// --- no reading / level sensor fault -----------------------------------------------
//
// The tank app (analog-level-sensor) publishes sensor_fault "under_range" while
// the loop current is below 4 mA, nulls its level tags and keeps publishing
// raw_level_reading (mA). An older tank app publishes no sensor_fault and just
// leaves the level tags null. Either way the Tank tile stays, reading "--".

const FAULT_TAGS = {
  level_reading: null,
  level_filled_percentage: null,
  level_reading_display: null,
  level_volume: null,
  raw_level_reading: 3.7349,
  sensor_fault: "under_range",
};
// Like the Skid tile's readings: null while the app has no value.
const NO_READING = { tank_level_mm: null, tank_level_percent: null };
const OLD_APP_UNDER_RANGE = { level_reading: null, level_filled_percentage: null, raw_level_reading: 3.73 };

const tile = (m) => ({
  shown: !isHidden(m.byId("tank-section")),
  primary: m.byId("tank-level-mm").querySelector(".value").textContent,
  primaryUnit: m.byId("tank-level-mm").querySelector(".unit").textContent,
  fill: m.byId("tank-level-percent").querySelector(".value").textContent,
  fillUnit: m.byId("tank-level-percent").querySelector(".unit").textContent,
  bar: m.byId("tank-progress").style.width,
  secondaryHidden: isHidden(m.byId("tank-level-secondary")),
  badge: isHidden(m.byId("tank-fault")) ? null : m.byId("tank-fault").textContent,
  reason: isHidden(m.byId("tank-fault-reason")) ? null : m.byId("tank-fault-reason").textContent,
  faultEdge: m.byId("tank-section").classList.contains("sensor-fault"),
});

const EMPTY_TILE = {
  shown: true,
  primary: "--",
  primaryUnit: "mm",
  fill: "--",
  fillUnit: "%",
  bar: "0%",
  secondaryHidden: true,
  badge: null,
  reason: null,
  faultEdge: false,
};
const FAULT_TILE = {
  ...EMPTY_TILE,
  badge: "SENSOR FAULT",
  reason: "Signal below range (3.73 mA)",
  faultEdge: true,
};

test("adapter: a configured tank app with no readings still gives the tile", () => {
  assert.deepEqual(build({}, {}).tank, NO_READING);
  assert.deepEqual(build({}, null).tank, NO_READING);
  // A non-default primary keeps its unit for the "--".
  assert.deepEqual(build({ tank_primary_reading: "L", tank_secondary_reading: "mm" }, {}).tank, {
    ...NO_READING,
    level_primary: { value: null, unit: "L", decimals: 0 },
  });
  // No tank app: no tile (unchanged).
  const none = assembleDashboardData({
    appKey: APP,
    deploymentConfig: deployment({}, APP),
    tagValues: { [CTRL]: legacyControllerTags(), [TANK]: TANK_TAGS },
    uiCmds: undefined,
    memory: createFeatureMemory(),
  });
  assert.ok(!("tank" in none));
});

test("adapter: sensor_fault and the loop current are mapped, no level alongside", () => {
  assert.deepEqual(build({}, FAULT_TAGS).tank, { ...NO_READING, sensor_fault: "under_range", raw_ma: 3.7349 });
  assert.deepEqual(build({ tank_primary_reading: "L", tank_secondary_reading: "mm" }, FAULT_TAGS).tank, {
    ...NO_READING,
    sensor_fault: "under_range",
    raw_ma: 3.7349,
    level_primary: { value: null, unit: "L", decimals: 0 },
  });
  // A level a host still holds from before the fault is never shown with it.
  assert.deepEqual(build({}, { ...TANK_TAGS, sensor_fault: "under_range", raw_level_reading: 3.73 }).tank, {
    ...NO_READING,
    sensor_fault: "under_range",
    raw_ma: 3.73,
  });
  // No loop current published: the fault alone.
  assert.deepEqual(build({}, { sensor_fault: "under_range" }).tank, { ...NO_READING, sensor_fault: "under_range" });
});

test("adapter: an older tank app (no sensor_fault) under range reads empty, with no fault", () => {
  assert.deepEqual(build({}, OLD_APP_UNDER_RANGE).tank, NO_READING);
  // A healthy reading with sensor_fault null / "" is the normal payload.
  for (const sensor_fault of [null, ""]) {
    assert.deepEqual(build({}, { ...TANK_TAGS, sensor_fault, raw_level_reading: 12.1 }).tank, {
      tank_level_mm: 850,
      tank_level_percent: 64.4,
    });
  }
});

test("tankFaultReason: the reason, with the loop current to 2 dp when known", () => {
  assert.equal(TANK_FAULT_LABEL, "SENSOR FAULT");
  assert.equal(tankFaultReason("under_range", 3.7349), "Signal below range (3.73 mA)");
  assert.equal(tankFaultReason("under_range", 3.7), "Signal below range (3.70 mA)");
  assert.equal(tankFaultReason("under_range", null), "Signal below range");
  assert.equal(tankFaultReason("under_range", undefined), "Signal below range");
  assert.equal(tankFaultReason("over_range", 20.9), "Signal above range (20.90 mA)");
  assert.equal(tankFaultReason("something_new", 3.7), "Sensor signal fault (3.70 mA)");
});

for (const [mode, base] of [
  ["Read Only", LEGACY_PAYLOADS.running],
  ["Touch", touchPayload()],
]) {
  for (const layout of ["kiosk", "embedded"]) {
    test(`render (${mode}, ${layout}): no reading shows the tile with "--", no fault`, () => {
      const m = mountHmi({ layout });
      m.render({ ...base, tank: build({}, OLD_APP_UNDER_RANGE).tank });
      assert.deepEqual(tile(m), EMPTY_TILE);
    });

    test(`render (${mode}, ${layout}): sensor fault shows the badge and reason, values "--"`, () => {
      const m = mountHmi({ layout });
      m.render({ ...base, tank: build({}, FAULT_TAGS).tank });
      assert.deepEqual(tile(m), FAULT_TILE);
    });
  }
}

test("render: a reading that goes away (or faults) is cleared, never left stale", () => {
  const m = mountHmi();
  m.render({ ...LEGACY_PAYLOADS.running, tank: build({ tank_secondary_reading: "L" }).tank });
  assert.deepEqual(
    [tile(m).primary, tile(m).fill, tile(m).bar, tile(m).secondaryHidden],
    ["850", "64", "64%", false],
  );
  m.render({ ...LEGACY_PAYLOADS.running, tank: build({ tank_secondary_reading: "L" }, FAULT_TAGS).tank });
  assert.deepEqual(tile(m), FAULT_TILE);
  m.render({ ...LEGACY_PAYLOADS.running, tank: build({ tank_secondary_reading: "L" }).tank });
  m.render({ ...LEGACY_PAYLOADS.running, tank: build({ tank_secondary_reading: "L" }, OLD_APP_UNDER_RANGE).tank });
  assert.deepEqual(tile(m), EMPTY_TILE);
});

test("render: the fault clears when the tank app clears sensor_fault", () => {
  const m = mountHmi();
  m.render({ ...LEGACY_PAYLOADS.running, tank: build({}, FAULT_TAGS).tank });
  assert.deepEqual(tile(m), FAULT_TILE);
  // Loop current moves: the reason follows it.
  m.render({ ...LEGACY_PAYLOADS.running, tank: build({}, { ...FAULT_TAGS, raw_level_reading: 3.61 }).tank });
  assert.equal(tile(m).reason, "Signal below range (3.61 mA)");
  // Back in range.
  m.render({ ...LEGACY_PAYLOADS.running, tank: build({}, { ...TANK_TAGS, sensor_fault: null, raw_level_reading: 9.5 }).tank });
  assert.deepEqual(tile(m), {
    ...EMPTY_TILE,
    primary: "850",
    fill: "64",
    bar: "64%",
  });
});

test("render: a configured primary keeps its unit beside the '--', in fault too", () => {
  const m = mountHmi();
  m.render({ ...LEGACY_PAYLOADS.running, tank: build({ tank_primary_reading: "L", tank_secondary_reading: "mm" }, FAULT_TAGS).tank });
  assert.deepEqual(tile(m), { ...FAULT_TILE, primaryUnit: "L" });
});

test("render: the alarm settings gear stays on the Tank tile with no reading and in fault", () => {
  const m = mountHmi();
  m.hmi.setAlarmAccess({ enabled: true, canWrite: true, writeBlockedReason: "" });
  const alarm_settings = { tank: { low: 20, low_low: 10, low_delay: 600, low_low_delay: 600, ll_required: false } };
  for (const tags of [{}, OLD_APP_UNDER_RANGE, FAULT_TAGS]) {
    m.render({ ...touchPayload(), alarm_settings, tank: build({}, tags).tank });
    assert.ok(!isHidden(m.byId("tank-gear")), JSON.stringify(tags));
  }
  m.click("tank-gear");
  assert.ok(!isHidden(m.byId("alarm-panel")));
});

function getComputedStyleDisplay(m, id) {
  const el = m.byId(id);
  return el.classList.contains("hidden") ? "none" : el.ownerDocument.defaultView.getComputedStyle(el).display;
}
