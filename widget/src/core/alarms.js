/**
 * Alarm settings (pure, unit-tested): the tank level and discharge pressure
 * thresholds the pump controller trips and warns on, as the HMI shows and
 * edits them from the Tank and Skid tiles' gears.
 *
 * Mirrors sia-injection-controller (app_ui.py "Alarm Settings" submodule and
 * alarms.py). Each threshold is that app's ui element, written by an RPC on
 * `ui_cmds` named after the element (as `last_calibration_factor` is); the
 * current value is read back from the controller's Setpoint* tags. L / H are
 * warnings, LL / HH are trips, and 0 turns an alarm off.
 *
 *   low_tank_level        L warning    0 to 100 %, step 0.1, 0 = off
 *   low_low_tank_level    LL trip      0 to 100 %, step 0.1, 0 = off, unless
 *                                      tank_ll_validation_enabled with a tank
 *                                      sensor: 0.1 to 100 (never off)
 *   high_pressure         H warning    0 to 4000 psi, 0 = off
 *   high_high_pressure    HH trip      110 to 4000 psi (never off)
 *
 * Pressure ranges are in psi and scale with the controller's pressure unit
 * (PRESSURE_UNIT_FACTORS, rounded to 0.1; step 0.1 below psi, else 1).
 */

export const PRESSURE_UNIT_FACTORS = { psi: 1.0, kPa: 6.894757, bar: 0.06894757 };

export const ALARM_FIELDS = {
  low_tank_level: {
    group: "tank",
    key: "low",
    label: "Low (L) warning",
    short: "L",
    kind: "Warning",
  },
  low_low_tank_level: {
    group: "tank",
    key: "low_low",
    label: "Low-Low (LL) trip",
    short: "LL",
    kind: "Trip",
  },
  high_pressure: {
    group: "pressure",
    key: "high",
    label: "High (H) warning",
    short: "H",
    kind: "Warning",
  },
  high_high_pressure: {
    group: "pressure",
    key: "high_high",
    label: "High-High (HH) trip",
    short: "HH",
    kind: "Trip",
  },
};

/** The four ui_cmds commands, in display order per group. */
export const ALARM_COMMANDS = Object.keys(ALARM_FIELDS);

export const ALARM_GROUPS = {
  tank: { title: "Tank Level Alarms", fields: ["low_tank_level", "low_low_tank_level"] },
  pressure: { title: "Discharge Pressure Alarms", fields: ["high_pressure", "high_high_pressure"] },
};

/** psi -> unit factor; an unknown unit is psi (as the controller does). */
export function pressureFactor(units) {
  return PRESSURE_UNIT_FACTORS[units] ?? 1.0;
}

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * {min, max, step, offAllowed, unit} for one field. `settings` is the
 * payload's `alarm_settings` ({tank: {ll_required}, pressure: {units}}).
 */
export function alarmRange(field, settings) {
  const f = ALARM_FIELDS[field];
  if (!f) return null;
  if (f.group === "tank") {
    const required = field === "low_low_tank_level" && !!(settings && settings.tank && settings.tank.ll_required);
    return { min: required ? 0.1 : 0, max: 100, step: 0.1, offAllowed: !required, unit: "%" };
  }
  const units = (settings && settings.pressure && settings.pressure.units) || "psi";
  const k = pressureFactor(units);
  const scale = (psi) => (k === 1 ? psi : round1(psi * k));
  const step = k < 1 ? 0.1 : 1;
  if (field === "high_pressure") return { min: 0, max: scale(4000), step, offAllowed: true, unit: units };
  return { min: scale(110), max: scale(4000), step, offAllowed: false, unit: units };
}

/** The current value of a field from the payload (null when not published). */
export function alarmValue(field, settings) {
  const f = ALARM_FIELDS[field];
  const g = f && settings && settings[f.group];
  const v = g ? g[f.key] : null;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Decimals for a field's values. */
export function alarmDecimals(field, settings) {
  const r = alarmRange(field, settings);
  return r && r.step < 1 ? 1 : 0;
}

/** Display text: "Off" for 0, the number with its unit, or the empty dash. */
export function formatAlarmValue(field, value, settings, empty = "—") {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return empty;
  if (Number(value) <= 0) return "Off";
  const r = alarmRange(field, settings);
  return `${Number(value).toFixed(alarmDecimals(field, settings))} ${r.unit}`;
}

/**
 * Why `value` cannot be set for `field` ("" when it can): the range, the
 * off rule, and the order L above LL / H below HH (each unless the other is
 * off). The other threshold is the controller's current one.
 */
export function validateAlarmValue(field, value, settings) {
  const r = alarmRange(field, settings);
  if (!r) return "Unknown setting";
  const v = Number(value);
  if (!Number.isFinite(v)) return "Enter a number";
  if (v === 0 && !r.offAllowed) {
    return field === "low_low_tank_level"
      ? "The LL trip can't be off while tank LL validation is on"
      : "The HH trip can't be off";
  }
  if (v !== 0 && (v < r.min || v > r.max)) return `Out of range (${r.min} to ${r.max} ${r.unit})`;
  if (v < 0) return `Out of range (${r.min} to ${r.max} ${r.unit})`;
  if (v === 0) return "";
  const fmt = (x) => formatAlarmValue(field, x, settings);
  if (field === "low_tank_level") {
    const ll = alarmValue("low_low_tank_level", settings);
    if (ll && ll > 0 && v <= ll) return `The L warning must be above the LL trip (${fmt(ll)})`;
  } else if (field === "low_low_tank_level") {
    const l = alarmValue("low_tank_level", settings);
    if (l && l > 0 && v >= l) return `The LL trip must be below the L warning (${fmt(l)})`;
  } else if (field === "high_pressure") {
    const hh = alarmValue("high_high_pressure", settings);
    if (hh && hh > 0 && v >= hh) return `The H warning must be below the HH trip (${fmt(hh)})`;
  } else if (field === "high_high_pressure") {
    const h = alarmValue("high_pressure", settings);
    if (h && h > 0 && v <= h) return `The HH trip must be above the H warning (${fmt(h)})`;
  }
  return "";
}
