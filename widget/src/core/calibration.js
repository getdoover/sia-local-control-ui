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

/** The starting site-glass reading: must be more than 0 mL. */
export function validateStartMl(value) {
  if (!finite(value)) return "Enter the site glass reading in mL";
  if (value <= 0) return "Must be more than 0 mL";
  return null;
}

/** The final reading: at least 0 and less than the starting reading. */
export function validateFinalMl(value, startMl) {
  if (!finite(value)) return "Enter the site glass reading in mL";
  if (value < 0) return "Cannot be negative";
  if (finite(startMl) && value >= startMl) {
    return `Must be less than the starting ${formatMl(startMl)} mL`;
  }
  return null;
}

/** The test rate: within the pump's MinRate..MaxRate. */
export function validateTestRate(value, min, max) {
  if (!finite(value)) return "Enter a rate";
  if (!finite(min) || !finite(max)) return "The pump range is not known yet";
  // The range is shown to 2 dp; accept what rounds into it.
  if (value < round(min, 2) - 1e-9 || value > round(max, 2) + 1e-9) {
    return `Out of range (${min.toFixed(2)} to ${max.toFixed(2)})`;
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
  const deliveredMl = startMl - finalMl;
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
