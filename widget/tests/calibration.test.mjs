// 1min Calibration Sequence: validation and the factor calculation, with
// worked numbers. The convention is the pump controller's
// (calibration_attempt.py): factor = nominal / measured volume, and the
// controller divides the nominal rate by the factor, so
//   new = old x target / measured, rounded to 2 dp, then clamped 0.3..1.7.
import assert from "node:assert/strict";
import test from "node:test";

import {
  CAL_TEST_DURATION_S,
  computeCalibration,
  mlOverSecondsToRate,
  SITE_GLASS_MAX_ML,
  siteGlassRateLimit,
  testRateRange,
  validateFinalMl,
  validateStartMl,
  validateTestRate,
} from "../src/core/calibration.js";

const calc = (over) =>
  computeCalibration({
    startMl: 50,
    finalMl: 250,
    elapsedS: 60,
    targetRate: 12.5,
    oldFactor: 1.0,
    rateUnits: "L/Hr",
    ...over,
  });

test("the HMI's test is 60 s", () => {
  assert.equal(CAL_TEST_DURATION_S, 60);
});

test("worked example, L/Hr: 200 mL in 60 s at 12.5 L/Hr, factor 1.00 -> 1.04", () => {
  const r = calc();
  assert.equal(r.ok, true);
  assert.equal(r.deliveredMl, 200);
  // 200 mL / 60 s = 3.333 mL/s = 12.0 L/Hr
  assert.ok(Math.abs(r.measuredRate - 12.0) < 1e-9, r.measuredRate);
  assert.equal(r.targetRate, 12.5);
  // 1.00 x 12.5 / 12.0 = 1.0417
  assert.ok(Math.abs(r.rawFactor - 1.0416667) < 1e-6, r.rawFactor);
  assert.equal(r.newFactor, 1.04);
  assert.equal(r.clamped, null);
});

test("worked example: the old factor scales the result (0.90 x 12.5 / 12.0 = 0.94)", () => {
  const r = calc({ oldFactor: 0.9 });
  assert.equal(r.newFactor, 0.94);
});

test("worked example, L/Day: 15 mL in 60 s at 20 L/Day, factor 0.90 -> 0.83", () => {
  const r = calc({ startMl: 105, finalMl: 120, targetRate: 20, oldFactor: 0.9, rateUnits: "L/Day" });
  // 15 mL / 60 s = 0.25 mL/s = 21.6 L/Day; 0.9 x 20 / 21.6 = 0.8333
  assert.ok(Math.abs(r.measuredRate - 21.6) < 1e-9, r.measuredRate);
  assert.equal(r.newFactor, 0.83);
});

test("worked example, Gal/Hr: 1 gallon an hour measured at a 1.1 Gal/Hr target -> 1.10", () => {
  const ml = 3785.411784 / 60; // one US gallon per hour, over 60 s
  const r = calc({ startMl: 100, finalMl: 100 + ml, targetRate: 1.1, rateUnits: "Gal/Hr" });
  assert.ok(Math.abs(r.measuredRate - 1.0) < 1e-9, r.measuredRate);
  assert.equal(r.newFactor, 1.1);
});

test("the controller's actual run time is used, not the nominal 60 s", () => {
  const r = calc({ elapsedS: 60.4 });
  // 200 mL / 60.4 s = 11.921 L/Hr; 12.5 / 11.921 = 1.0486 -> 1.05
  assert.ok(Math.abs(r.measuredRate - 11.9205) < 1e-3, r.measuredRate);
  assert.equal(r.newFactor, 1.05);
});

test("the factor makes the controller's calculated flow equal the measured flow", () => {
  // Controller: max_rate = nominal_max / factor, duty = target / max_rate, so
  // the real flow at duty d is d x true_max and the displayed flow for a
  // nominal-rate duty is nominal / factor.
  const nominalMax = 92.16;
  const trueMax = 80; // the pump really delivers less than nominal
  const oldFactor = 1.0;
  const target = 15; // 217 mL over the test: fits the site glass
  const duty = target / (nominalMax / oldFactor);
  const measured = duty * trueMax; // L/Hr, what the site glass shows
  const deliveredMl = (measured * 1000 * 60) / 3600;
  const r = calc({ startMl: 0, finalMl: deliveredMl, targetRate: target, oldFactor });
  // With the unrounded factor the controller's duty for the same target
  // now delivers exactly the target.
  const newDuty = target / (nominalMax / r.rawFactor);
  assert.ok(Math.abs(newDuty * trueMax - target) < 1e-9);
  assert.equal(r.newFactor, Math.round((nominalMax / trueMax) * 100) / 100);
});

test("clamped high to 1.7, with the raw value kept for the note", () => {
  const r = calc({ finalMl: 100 }); // 50 mL -> 3 L/Hr; 12.5 / 3 = 4.17
  assert.equal(r.newFactor, 1.7);
  assert.equal(r.clamped, "high");
  assert.ok(r.rawFactor > 4);
});

test("clamped low to 0.3", () => {
  const r = calc({ startMl: 0, finalMl: 250, targetRate: 1.5 }); // 250 mL -> 15 L/Hr; 0.1
  assert.equal(r.newFactor, 0.3);
  assert.equal(r.clamped, "low");
});

test("rounded to 2 dp before the clamp, like the controller", () => {
  // raw 1.7049 rounds to 1.70: inside the range, not clamped.
  const measured = 12.5 / 1.7049;
  const ml = (measured * 1000 * 60) / 3600;
  const r = calc({ startMl: 0, finalMl: ml });
  assert.equal(r.newFactor, 1.7);
  assert.equal(r.clamped, null);
});

test("an unknown old factor counts as 1.00, as on the controller", () => {
  assert.equal(calc({ oldFactor: null }).newFactor, 1.04);
  assert.equal(calc({ oldFactor: 0 }).oldFactor, 1.0);
});

test("mL over seconds in each rate unit", () => {
  assert.equal(mlOverSecondsToRate(1000, 3600, "L/Hr"), 1);
  assert.equal(mlOverSecondsToRate(1000, 86400, "L/Day"), 1);
  assert.ok(Math.abs(mlOverSecondsToRate(3785.411784, 3600, "Gal/Hr") - 1) < 1e-12);
  assert.ok(Math.abs(mlOverSecondsToRate(3785.411784, 86400, "Gal/Day") - 1) < 1e-12);
});

test("start mL can be 0 up to the bottom of the site glass (it reads up as it drains)", () => {
  assert.equal(SITE_GLASS_MAX_ML, 268);
  assert.equal(validateStartMl(250), null);
  assert.equal(validateStartMl(267.9), null);
  assert.equal(validateStartMl(0.1), null);
  assert.equal(validateStartMl(0), null);
  assert.match(validateStartMl(-5), /negative/);
  assert.match(validateStartMl(268), /less than 268 mL/);
  assert.match(validateStartMl(500), /less than 268 mL/);
  assert.ok(validateStartMl(null));
  assert.ok(validateStartMl(NaN));
});

test("final mL must be more than the start, and no more than the glass can show", () => {
  assert.equal(validateFinalMl(260, 250), null);
  assert.equal(validateFinalMl(268, 250), null);
  assert.equal(validateFinalMl(150, 0), null);
  assert.match(validateFinalMl(250, 250), /more than the starting 250 mL/);
  assert.match(validateFinalMl(100, 250), /more than/);
  assert.match(validateFinalMl(268.1, 250), /at most 268 mL/);
  assert.match(validateFinalMl(-1, 250), /negative/);
  assert.ok(validateFinalMl(null, 250));
});

test("the site glass caps the test rate: 180 mL start leaves 88 mL, 5.28 L/Hr over 60 s", () => {
  assert.deepEqual(siteGlassRateLimit(180, "L/Hr"), { roomMl: 88, maxRate: 5.28 });
  // Rounded down, never up: 268 mL of room is 16.08 L/Hr exactly; 267 mL is
  // 16.02 exactly; 100 mL is 6.0 exactly; 150 mL is 9.0.
  assert.equal(siteGlassRateLimit(0, "L/Hr").maxRate, 16.08);
  assert.equal(siteGlassRateLimit(118, "L/Hr").maxRate, 9);
  assert.equal(siteGlassRateLimit(180.5, "L/Hr").maxRate, 5.25); // 87.5 mL -> 5.25
  assert.equal(siteGlassRateLimit(181, "L/Hr").maxRate, 5.22); // 87 mL -> 5.22
  // Other units: 88 mL over 60 s in Gal/Day.
  assert.equal(siteGlassRateLimit(180, "Gal/Day").maxRate, 33.47);
  assert.equal(siteGlassRateLimit(268, "L/Hr"), null);
  assert.equal(siteGlassRateLimit(null, "L/Hr"), null);
});

test("the test rate range is the pump's, capped by the glass when that is lower", () => {
  assert.deepEqual(testRateRange(2, 92.16, 180, "L/Hr"), {
    min: 2,
    max: 5.28,
    glass: { roomMl: 88, maxRate: 5.28 },
    cappedByGlass: true,
  });
  // A pump slower than the glass allows: its own range stands.
  assert.deepEqual(testRateRange(0.5, 4, 180, "L/Hr"), {
    min: 0.5,
    max: 4,
    glass: { roomMl: 88, maxRate: 5.28 },
    cappedByGlass: false,
  });
  // No start reading yet: the pump's range.
  assert.deepEqual(testRateRange(2, 92.16, null, "L/Hr"), { min: 2, max: 92.16, glass: null, cappedByGlass: false });
});

test("validation against the glass: at the limit passes, above it says why", () => {
  assert.equal(validateTestRate(5.28, 2, 92.16, 180, "L/Hr"), null);
  assert.equal(validateTestRate(2, 2, 92.16, 180, "L/Hr"), null);
  assert.match(validateTestRate(5.29, 2, 92.16, 180, "L/Hr"), /Above 5\.28 the site glass would run past 268 mL in 60 s/);
  assert.match(validateTestRate(1.5, 2, 92.16, 180, "L/Hr"), /Out of range \(2\.00 to 5\.28\)/);
  // Too little room for even the pump's minimum: no rate passes, and the
  // message says to go back.
  const tooFull = validateTestRate(2, 2, 92.16, 260, "L/Hr");
  assert.match(tooFull, /Only 8 mL of room/);
  assert.match(tooFull, /minimum 2\.00/);
  assert.match(tooFull, /Go back/);
});

test("test rate within MinRate..MaxRate (as shown, to 2 dp)", () => {
  assert.equal(validateTestRate(12.5, 2, 92.16), null);
  assert.equal(validateTestRate(2, 2, 92.16), null);
  assert.equal(validateTestRate(92.16, 2, 92.16), null);
  assert.equal(validateTestRate(1.54, 1.536, 7.68), null); // shown as 1.54
  assert.match(validateTestRate(1.99, 2, 92.16), /Out of range/);
  assert.match(validateTestRate(92.17, 2, 92.16), /Out of range/);
  assert.ok(validateTestRate(10, null, 92.16));
});

test("a VSD start boost: the delivered volume is compared against the nominal rate", () => {
  // 200 mL in 60 s = 12.0 L/Hr; average commanded 13.5 (test rate 12.5).
  const r = calc({ nominalRate: 13.5 });
  assert.equal(r.ok, true);
  assert.equal(r.targetRate, 13.5);
  assert.equal(r.testRate, 12.5);
  assert.equal(r.boosted, true);
  assert.equal(r.newFactor, 1.13);
});

test("no nominal rate, or one equal to the test rate: unchanged, not boosted", () => {
  for (const nominalRate of [undefined, null, 0, 12.5]) {
    const r = calc({ nominalRate });
    assert.equal(r.targetRate, 12.5);
    assert.equal(r.boosted, false);
    assert.equal(r.newFactor, 1.04);
  }
});

test("computeCalibration refuses impossible inputs", () => {
  assert.equal(calc({ finalMl: 500 }).ok, false);
  assert.equal(calc({ startMl: -1 }).ok, false);
  assert.equal(calc({ finalMl: 300 }).ok, false); // below the start: the glass only reads up
  assert.equal(calc({ startMl: 0, finalMl: 200 }).deliveredMl, 200);
  assert.equal(calc({ elapsedS: 0 }).ok, false);
  assert.equal(calc({ elapsedS: null }).ok, false);
  assert.equal(calc({ targetRate: null }).ok, false);
});
