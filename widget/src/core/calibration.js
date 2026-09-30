/**
 * 1min Calibration Sequence: the pure parts (validation and the factor
 * calculation), shared by the wizard in hmi-core.js and unit-tested in
 * tests/calibration.test.mjs.
 *
 * The factor convention is the pump controller's own
 * (sia-injection-controller calibration_attempt.py and application.py):
 *
 *   - the controller divides the nominal rate by the factor:
 *     `max_rate = nominal_max_rate / factor`, and drives the pump at
 *     `target / max_rate` of full speed, so at factor f a target T runs the
 *     pump at the nominal (factor 1) rate T x f;
 *   - its automatic calibration sets `factor = nominal volume / measured
 *     volume` (expected at factor 1 over gauge volume), rounded to 2 dp, then
 *     clamped to 0.3..1.7.
 *
 * Over the test the nominal volume is T x f_old x t and the measured volume is
 * M x t, so the new factor is
 *
 *   new = f_old x T / M
 *
 * which makes the controller's calculated flow at that rate equal the measured
 * flow. Rounded to 2 dp, then clamped, exactly as the controller does.
 */

export const CAL_TEST_DURATION_S = 60;
export const CAL_FACTOR_MIN = 0.3;
export const CAL_FACTOR_MAX = 1.7;
/**
 * The site glass's last graduation, in mL. It is graduated from the top and
 * reads up as the pump draws the glass down, so this is the most it can show:
 * a test that would draw more than (this - the starting reading) runs the
 * level off the bottom of the scale and its final reading is lost.
 */
export const SITE_GLASS_MAX_ML = 268;

// Millilitres per volume unit of the configured rate units.
const ML_PER = { L: 1000, Gal: 3785.411784 };
// Seconds per time unit of the configured rate units.
const S_PER = { Hr: 3600, Day: 86400 };

/** "L/Hr" -> {ml: 1000, s: 3600}; unknown units fall back to L/Hr. */
export function rateUnitScale(rateUnits) {
  const [vol, time] = String(rateUnits || "L/Hr").split("/");
  const v = Object.keys(ML_PER).find((k) => k.toLowerCase() === String(vol).trim().toLowerCase()) || "L";
  const t = Object.keys(S_PER).find((k) => k.toLowerCase() === String(time).trim().toLowerCase()) || "Hr";
  return { ml: ML_PER[v], s: S_PER[t] };
}

/** A volume in mL over a time in s, as a rate in the configured units. */
export function mlOverSecondsToRate(ml, seconds, rateUnits) {
  const { ml: mlPer, s: sPer } = rateUnitScale(rateUnits);
  return (ml / mlPer) * (sPer / seconds);
}

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * The starting site-glass reading. The site glass is graduated from the top,
 * so it reads low (often 0) before the test and climbs as the pump draws
 * chemical out of it.
 */
export function validateStartMl(value) {
  if (!finite(value)) return "Enter the site glass reading in mL";
  if (value < 0) return "Cannot be negative";
  if (value >= SITE_GLASS_MAX_ML) {
    return `Must be less than ${SITE_GLASS_MAX_ML} mL, the bottom of the site glass: there is no room for a test`;
  }
  return null;
}

/**
 * The final reading: more than the starting reading (the glass reads up as it
 * drains), and no more than the glass can show.
 */
export function validateFinalMl(value, startMl) {
  if (!finite(value)) return "Enter the site glass reading in mL";
  if (value < 0) return "Cannot be negative";
  if (value > SITE_GLASS_MAX_ML) return `The site glass reads at most ${SITE_GLASS_MAX_ML} mL`;
  if (finite(startMl) && value <= startMl) {
    return `Must be more than the starting ${formatMl(startMl)} mL`;
  }
  return null;
}

/**
 * How fast the test may run without drawing the site glass past its last
 * graduation. From the starting reading there is (SITE_GLASS_MAX_ML - start)
 * mL of room; over CAL_TEST_DURATION_S that is a rate, rounded DOWN to the
 * 2 dp the rate is entered to so the limit itself never exceeds the room.
 *
 * out: {roomMl, maxRate} in the configured rate units, or null without a
 *      valid starting reading.
 */
export function siteGlassRateLimit(startMl, rateUnits) {
  if (validateStartMl(startMl)) return null;
  const roomMl = SITE_GLASS_MAX_ML - startMl;
  const exact = mlOverSecondsToRate(roomMl, CAL_TEST_DURATION_S, rateUnits);
  return { roomMl, maxRate: Math.floor(exact * 100 + 1e-9) / 100 };
}

/**
 * The test rate's range: the pump's MinRate..MaxRate, capped by the site
 * glass (`siteGlassRateLimit`) when a starting reading is known.
 *
 * out: {min, max, glass: null | {roomMl, maxRate}, cappedByGlass}. `max` may
 *      come out below `min`: the glass has no room for a test at even the
 *      pump's minimum rate, which `validateTestRate` reports.
 */
export function testRateRange(min, max, startMl, rateUnits) {
  const glass = siteGlassRateLimit(startMl, rateUnits);
  if (!glass || !finite(max) || glass.maxRate >= max) {
    return { min, max, glass, cappedByGlass: false };
  }
  return { min, max: glass.maxRate, glass, cappedByGlass: true };
}

/**
 * The test rate: within the pump's MinRate..MaxRate, and within what the site
 * glass has room for when `startMl` is given.
 */
export function validateTestRate(value, min, max, startMl, rateUnits) {
  if (!finite(value)) return "Enter a rate";
  if (!finite(min) || !finite(max)) return "The pump range is not known yet";
  const range = testRateRange(min, max, startMl, rateUnits);
  if (range.cappedByGlass && range.max < round(min, 2) - 1e-9) {
    return (
      `Only ${formatMl(range.glass.roomMl)} mL of room in the site glass: not enough for a ` +
      `${CAL_TEST_DURATION_S} s test at the pump's minimum ${min.toFixed(2)}. Go back and start with a lower reading`
    );
  }
  // The range is shown to 2 dp; accept what rounds into it.
  if (value < round(min, 2) - 1e-9 || value > round(range.max, 2) + 1e-9) {
    if (range.cappedByGlass && value > round(range.max, 2) + 1e-9) {
      return `Above ${range.max.toFixed(2)} the site glass would run past ${SITE_GLASS_MAX_ML} mL in ${CAL_TEST_DURATION_S} s`;
    }
    return `Out of range (${min.toFixed(2)} to ${range.max.toFixed(2)})`;
  }
  return null;
}

export function round(value, dp) {
  const f = 10 ** dp;
  return Math.round((value + Number.EPSILON) * f) / f;
}

export function formatMl(value) {
  return finite(value) ? String(round(value, 1)) : "--";
}

/**
 * The results page.
 *
 * in: {startMl, finalMl, elapsedS, targetRate, oldFactor, rateUnits}
 * out: {ok: true, deliveredMl, measuredRate, targetRate, oldFactor,
 *       rawFactor, newFactor, clamped: null | "low" | "high"}
 *      or {ok: false, error}
 */
export function computeCalibration({ startMl, finalMl, elapsedS, targetRate, oldFactor, rateUnits }) {
  const startErr = validateStartMl(startMl);
  if (startErr) return { ok: false, error: startErr };
  const finalErr = validateFinalMl(finalMl, startMl);
  if (finalErr) return { ok: false, error: finalErr };
  if (!finite(elapsedS) || elapsedS <= 0) {
    return { ok: false, error: "The controller did not report the run time" };
  }
  if (!finite(targetRate) || targetRate <= 0) {
    return { ok: false, error: "The test rate is not known" };
  }
  // An unset factor is 1.0 on the controller too (_calibration_factor).
  const factor = finite(oldFactor) && oldFactor >= 0.01 ? oldFactor : 1.0;
  const deliveredMl = finalMl - startMl;
  const measuredRate = mlOverSecondsToRate(deliveredMl, elapsedS, rateUnits);
  const rawFactor = (factor * targetRate) / measuredRate;
  const rounded = round(rawFactor, 2);
  let newFactor = rounded;
  let clamped = null;
  if (rounded < CAL_FACTOR_MIN) {
    newFactor = CAL_FACTOR_MIN;
    clamped = "low";
  } else if (rounded > CAL_FACTOR_MAX) {
    newFactor = CAL_FACTOR_MAX;
    clamped = "high";
  }
  return {
    ok: true,
    deliveredMl,
    measuredRate,
    targetRate,
    oldFactor: factor,
    rawFactor,
    newFactor,
    clamped,
  };
}
