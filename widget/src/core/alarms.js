/**
 * Alarm settings (pure, unit-tested): the pump controller's threshold alarms
 * and each alarm's own delay, as the HMI shows and edits them from the Tank,
 * Skid and Pump Control tiles' gears.
 *
 * Mirrors sia-injection-controller (app_ui.py "Alarm Settings" submodule and
 * alarms.py). Each setting is that app's ui element, written by an RPC on
 * `ui_cmds` named after the element (as `last_calibration_factor` is); the
 * current value is read back from the controller's Setpoint* / Delay* tags.
 * L / H are warnings, LL / HH are trips, and a threshold of 0 turns its
 * alarm off. The delay is how long the condition must hold before the
 * warning / trip, in whole seconds; a delay of 0 is immediate (never "off").
 *
 *   threshold             alarm        range                    delay            delay range
 *   low_tank_level        tank L       0 to 100 %, step 0.1,    tank_l_delay     1 to 600 s
 *   low_low_tank_level    tank LL        0 = off (LL: 0.1 to    tank_ll_delay    1 to 600 s
 *                                        100, never off, with
 *                                        tank_ll_validation_enabled
 *                                        and a tank sensor)
 *   high_pressure         pressure H   0 to 4000 psi, 0 = off   pressure_h_delay   0 to 600 s
 *   high_high_pressure    pressure HH  110 to 4000 psi (never   pressure_hh_delay  0 to 600 s
 *                                        off)
 *   low_flow_percent      flow L       0 to 100 % of target,    flow_l_delay     0 to 600 s
 *   low_low_flow_percent  flow LL        whole, 0 = off         flow_ll_delay    0 to 600 s
 *
 * The flow alarms exist only with a dedicated flow meter on the controller
 * (the payload has no flow group otherwise). Pressure ranges are in psi and
 * scale with the controller's pressure unit (PRESSURE_UNIT_FACTORS, rounded
 * to 0.1; step 0.1 below psi, else 1).
 */

export const PRESSURE_UNIT_FACTORS = { psi: 1.0, kPa: 6.894757, bar: 0.06894757 };

// Thresholds: one row each, with `delay` the element of the same alarm's
// delay. Delays: `of` is their threshold; `key` is where the payload has
// the value (alarm_settings[group][key]).
const threshold = (group, key, label, short, kind, delay) => ({ group, key, label, short, kind, delay });
const delayOf = (group, key, of, label) => ({ group, key, label: `${label} delay`, short: "Delay", kind: "Delay", of });

export const ALARM_FIELDS = {
  low_tank_level: threshold("tank", "low", "Low (L) warning", "L", "Warning", "tank_l_delay"),
  low_low_tank_level: threshold("tank", "low_low", "Low-Low (LL) trip", "LL", "Trip", "tank_ll_delay"),
  high_pressure: threshold("pressure", "high", "High (H) warning", "H", "Warning", "pressure_h_delay"),
  high_high_pressure: threshold("pressure", "high_high", "High-High (HH) trip", "HH", "Trip", "pressure_hh_delay"),
  low_flow_percent: threshold("flow", "low", "Low (L) warning", "L", "Warning", "flow_l_delay"),
  low_low_flow_percent: threshold("flow", "low_low", "Low-Low (LL) trip", "LL", "Trip", "flow_ll_delay"),
  tank_l_delay: delayOf("tank", "low_delay", "low_tank_level", "Low (L) warning"),
  tank_ll_delay: delayOf("tank", "low_low_delay", "low_low_tank_level", "Low-Low (LL) trip"),
  pressure_h_delay: delayOf("pressure", "high_delay", "high_pressure", "High (H) warning"),
  pressure_hh_delay: delayOf("pressure", "high_high_delay", "high_high_pressure", "High-High (HH) trip"),
  flow_l_delay: delayOf("flow", "low_delay", "low_flow_percent", "Low (L) warning"),
  flow_ll_delay: delayOf("flow", "low_low_delay", "low_low_flow_percent", "Low-Low (LL) trip"),
};

/** Every ui_cmds command (thresholds, then delays). */
export const ALARM_COMMANDS = Object.keys(ALARM_FIELDS);

/**
 * The popovers: title, the caption over the threshold column, and the
 * threshold rows in display order (each row also carries its delay).
 */
export const ALARM_GROUPS = {
  tank: { title: "Tank Level Alarms", caption: "Level", fields: ["low_tank_level", "low_low_tank_level"] },
  pressure: { title: "Discharge Pressure Alarms", caption: "Pressure", fields: ["high_pressure", "high_high_pressure"] },
  flow: { title: "Flow Alarms", caption: "Flow (% of target)", fields: ["low_flow_percent", "low_low_flow_percent"] },
};

/**
 * Each delay's range in whole seconds (the controller's, per alarm): tank
 * 1 to 600, pressure and flow 0 to 600 with 0 = no delay. With no operator
 * value the controller uses its config default (Tank Level Timeout, Flow
 * Alarm Timeout, pressure immediate), which the Delay* tags then show.
 */
export const ALARM_DELAY_RANGES = {
  tank_l_delay: [1, 600],
  tank_ll_delay: [1, 600],
  pressure_h_delay: [0, 600],
  pressure_hh_delay: [0, 600],
  flow_l_delay: [0, 600],
  flow_ll_delay: [0, 600],
};

/**
 * A delay with no Delay* readback is on a pump controller from before the
 * per-alarm delays: it has no element to take the write, so its cell is
 * locked and a tap says this instead.
 */
export const ALARM_DELAY_MISSING_TEXT = "Update the pump controller to set alarm delays";

/** Whether `field` is an alarm delay (seconds) rather than a threshold. */
export function isDelayField(field) {
  return Object.prototype.hasOwnProperty.call(ALARM_DELAY_RANGES, field);
}

/** psi -> unit factor; an unknown unit is psi (as the controller does). */
export function pressureFactor(units) {
  return PRESSURE_UNIT_FACTORS[units] ?? 1.0;
}

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * {min, max, step, offAllowed, unit} for one field, plus `whole` for whole
 * numbers only (the delays and the flow thresholds). `settings` is the
 * payload's `alarm_settings` ({tank: {ll_required}, pressure: {units}}).
 * A delay is never off: its 0 (where allowed) is "no delay".
 */
export function alarmRange(field, settings) {
  const f = ALARM_FIELDS[field];
  if (!f) return null;
  if (isDelayField(field)) {
    const [min, max] = ALARM_DELAY_RANGES[field];
    return { min, max, step: 1, offAllowed: false, unit: "s", whole: true };
  }
  if (f.group === "tank") {
    const required = field === "low_low_tank_level" && !!(settings && settings.tank && settings.tank.ll_required);
    return { min: required ? 0.1 : 0, max: 100, step: 0.1, offAllowed: !required, unit: "%" };
  }
  if (f.group === "flow") return { min: 0, max: 100, step: 1, offAllowed: true, unit: "%", whole: true };
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

/**
 * Display text: "Off" for a threshold of 0 (a delay of 0 is "0 s"), the
 * number with its unit, or the empty dash.
 */
export function formatAlarmValue(field, value, settings, empty = "—") {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return empty;
  if (Number(value) <= 0 && !isDelayField(field)) return "Off";
  const r = alarmRange(field, settings);
  return `${Number(value).toFixed(alarmDecimals(field, settings))} ${r.unit}`;
}

/**
 * Why `value` cannot be set for `field` ("" when it can): the range, the
 * off rule, whole numbers where required, and the order L above LL (tank,
 * flow) / H below HH (each unless the other is off). The other threshold is
 * the controller's current one. A delay has only its range, in whole
 * seconds, with no rule against the other delay.
 */
export function validateAlarmValue(field, value, settings) {
  const r = alarmRange(field, settings);
  if (!r) return "Unknown setting";
  const v = Number(value);
  if (!Number.isFinite(v)) return "Enter a number";
  if (isDelayField(field)) {
    if (v < r.min || v > r.max) return `The delay must be ${r.min} to ${r.max} ${r.unit}`;
    if (!Number.isInteger(v)) return "The delay is whole seconds (no decimals)";
    return "";
  }
  if (v === 0 && !r.offAllowed) {
    return field === "low_low_tank_level"
      ? "The LL trip can't be off while tank LL validation is on"
      : "The HH trip can't be off";
  }
  if (v !== 0 && (v < r.min || v > r.max)) return `Out of range (${r.min} to ${r.max} ${r.unit})`;
  if (v < 0) return `Out of range (${r.min} to ${r.max} ${r.unit})`;
  if (r.whole && !Number.isInteger(v)) return "Whole percent only (no decimals)";
  if (v === 0) return "";
  const fmt = (x) => formatAlarmValue(field, x, settings);
  const f = ALARM_FIELDS[field];
  const other = (key) => {
    const o = settings && settings[f.group] ? settings[f.group][key] : null;
    return typeof o === "number" && o > 0 ? o : null;
  };
  if (f.key === "low") {
    const ll = other("low_low");
    if (ll !== null && v <= ll) return `The L warning must be above the LL trip (${fmt(ll)})`;
  } else if (f.key === "low_low") {
    const l = other("low");
    if (l !== null && v >= l) return `The LL trip must be below the L warning (${fmt(l)})`;
  } else if (f.key === "high") {
    const hh = other("high_high");
    if (hh !== null && v >= hh) return `The H warning must be below the HH trip (${fmt(hh)})`;
  } else if (f.key === "high_high") {
    const h = other("high");
    if (h !== null && v <= h) return `The HH trip must be above the H warning (${fmt(h)})`;
  }
  return "";
}
