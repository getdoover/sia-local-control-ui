/**
 * Sensor calibration (pure, unit-tested): the 4-20 mA sensors' operator
 * values, as the HMI shows and edits them on the Sensor tab of the Skid
 * pressure and Tank gears' popovers.
 *
 * Mirrors the sensor apps' "Sensor Calibration" submodule (Operator Sensor
 * Calibration on): each value is that app's ui element, written by an RPC on
 * `ui_cmds` named after the element and addressed to the SENSOR app's key
 * (not the pump controller's); the value in effect is read back from the
 * app's tag of the same name. The operator value overrides the app's config
 * default until "Reset to configured values" (reset_calibration) clears it.
 *
 *   group     element        meaning                     rule (as the app enforces it)
 *   pressure  range_low      reading at 4 mA              |v| <= 1e6, below range_high
 *   (getdoover/4-20ma-sensor, units = its measurement_units, shown in the
 *   HMI's pressure unit like the Skid tile)
 *             range_high     reading at 20 mA             |v| <= 1e6, above range_low
 *             offset         added after scaling          |offset| <= range_high - range_low
 *   tank      zero_m         minimum level (m)            0 <= zero_m < span_m <= 100
 *   (getdoover/analog-level-sensor, always metres)
 *             span_m         maximum level (m)
 *             fluid_density  kg/m3                        500 to 2500
 *
 * Where each value applies on the input: the pressure app is a fixed 4-20 mA
 * loop, range_low at 4 mA and range_high at 20 mA. The level app's input
 * range and units are its config (sensor_minimum_ma / sensor_maximum_ma,
 * input_units mA / V / raw), and a Radar reads inverted
 * (common_app._map_value), so its zero is the level at the MAXIMUM input and
 * its span the level at the minimum; the payload carries that config
 * (sensorInput) and the labels follow it, as the app's own cloud labels do
 * (app_ui._calibration_labels). The endpoint is only ever in lower-case text
 * (the hint, the keypad title, the confirmation), never in the upper-cased
 * cell caption, so "mA" never reads "MA".
 *
 * The apps keep each value to 4 decimal places, so the HMI accepts no more
 * than that and shows a value with as many of them as it has (at least the
 * unit's usual decimals): what the confirmation and "Saved" say is exactly
 * what is sent and stored.
 *
 * The app refuses a write while its Operator Sensor Calibration is off
 * (RPCError UNAVAILABLE) and then publishes none of the readback tags, so the
 * HMI locks the cells unless the app's `operator_calibration` tag is true
 * (an older app has no such tag and is locked the same way).
 */

export const SENSOR_LOCKED_TEXT = "Enable Operator Sensor Calibration on the sensor app";

/** The RPC that clears the operator values (back to the app's config). */
export const SENSOR_RESET_COMMAND = "reset_calibration";

/** Largest magnitude the pressure sensor app accepts for any of its values. */
export const PRESSURE_VALUE_LIMIT = 1e6;

export const TANK_LIMITS = { metres: [0, 100], density: [500, 2500] };

/**
 * The Sensor tabs: title, who answers (for the operator messages), the live
 * reading's caption and the operator values in display order.
 */
export const SENSOR_GROUPS = {
  pressure: {
    title: "Pressure Sensor",
    who: "pressure sensor app",
    reading: "Pressure",
    fields: ["range_low", "range_high", "offset"],
  },
  tank: {
    title: "Tank Level Sensor",
    who: "tank level sensor app",
    reading: "Level",
    fields: ["zero_m", "span_m", "fluid_density"],
  },
};

/**
 * Each operator value: its group, its name (the cell caption, upper-cased on
 * screen, so no unit in it) and whether it may be negative. The keypad /
 * confirmation label adds the input endpoint (sensorLabel).
 */
export const SENSOR_FIELDS = {
  range_low: { group: "pressure", name: "Range low", signed: true },
  range_high: { group: "pressure", name: "Range high", signed: true },
  offset: { group: "pressure", name: "Offset", signed: true },
  zero_m: { group: "tank", name: "Zero", signed: false },
  span_m: { group: "tank", name: "Span", signed: false },
  fluid_density: { group: "tank", name: "Fluid density", signed: false },
};

/** Every operator value's element name (the numeric writes). */
export const SENSOR_VALUE_COMMANDS = Object.keys(SENSOR_FIELDS);

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The sensor apps round every operator value to 4 decimal places. */
export const SENSOR_MAX_DECIMALS = 4;

/** The pressure app's input: a fixed 4-20 mA loop (sensor.convert_reading). */
const PRESSURE_INPUT = Object.freeze({ low: 4, high: 20, units: "mA", inverted: false });

/**
 * {low, high, units, inverted} of a group's input: the pressure app's fixed
 * 4-20 mA, or the level app's configured input range and units, inverted for
 * a Radar (payload tank.input_low / input_high / input_units / inverted;
 * 4 / 20 / mA / not inverted when absent).
 */
export function sensorInput(group, settings) {
  if (group !== "tank") return PRESSURE_INPUT;
  const t = (settings && settings.tank) || {};
  const low = num(t.input_low);
  const high = num(t.input_high);
  return {
    low: low !== null ? low : 4,
    high: high !== null ? high : 20,
    units: typeof t.input_units === "string" ? t.input_units : "mA",
    inverted: t.inverted === true,
  };
}

// An input level as the app's own labels print it ("4 mA", "0.5 V", "4000 raw").
const inputText = (v, units) => `${Number(v.toFixed(SENSOR_MAX_DECIMALS))}${units ? ` ${units}` : ""}`;

/**
 * The input at which a value applies ("4 mA"), or "" for one that is not an
 * endpoint (offset, density). A Radar swaps the level app's zero and span.
 */
export function sensorEndpoint(field, settings) {
  const f = SENSOR_FIELDS[field];
  if (!f) return "";
  const i = sensorInput(f.group, settings);
  let atLow;
  if (field === "range_low") atLow = true;
  else if (field === "range_high") atLow = false;
  else if (field === "zero_m") atLow = !i.inverted;
  else if (field === "span_m") atLow = i.inverted;
  else return "";
  return inputText(atLow ? i.low : i.high, i.units);
}

/** The keypad title / confirmation label: "Zero (4 mA)", "Offset". */
export function sensorLabel(field, settings) {
  const f = SENSOR_FIELDS[field];
  if (!f) return "";
  const at = sensorEndpoint(field, settings);
  return at ? `${f.name} (${at})` : f.name;
}

/**
 * Decimals to show `value` with: the unit's usual (`min`), more where the
 * value has them, up to the 4 the apps keep.
 */
function decimalsFor(value, min) {
  const exact = Number(Number(value).toFixed(SENSOR_MAX_DECIMALS));
  let d = min;
  while (d < SENSOR_MAX_DECIMALS && Number(exact.toFixed(d)) !== exact) d += 1;
  return d;
}

/** A number with more decimals than the apps keep (4). */
function tooPrecise(v) {
  return Number(v.toFixed(SENSOR_MAX_DECIMALS)) !== v;
}

/** Pressure decimals: kPa whole-ish (0.1), psi / bar finer (0.01). */
export function pressureDecimals(units) {
  return units === "kPa" ? 1 : 2;
}

/**
 * {min, max, unit, decimals, signed, whole} for one value. `settings` is the
 * payload's `sensor_settings` ({pressure: {units, ...}, tank: {...}}).
 */
export function sensorRange(field, settings) {
  const f = SENSOR_FIELDS[field];
  if (!f) return null;
  if (f.group === "pressure") {
    const units = (settings && settings.pressure && settings.pressure.units) || "psi";
    return {
      min: -PRESSURE_VALUE_LIMIT,
      max: PRESSURE_VALUE_LIMIT,
      unit: units,
      decimals: pressureDecimals(units),
      signed: true,
      whole: false,
    };
  }
  if (field === "fluid_density") {
    const [min, max] = TANK_LIMITS.density;
    return { min, max, unit: "kg/m³", decimals: 0, signed: false, whole: true };
  }
  const [min, max] = TANK_LIMITS.metres;
  return { min, max, unit: "m", decimals: 3, signed: false, whole: false };
}

/** The value in effect from the payload (null when not published). */
export function sensorValue(field, settings) {
  const f = SENSOR_FIELDS[field];
  const g = f && settings && settings[f.group];
  return g ? num(g[field]) : null;
}

/**
 * Decimals to show a value with (at least the unit's, as many as the value
 * has up to 4), so a shown value is the stored one.
 */
export function sensorDecimals(field, value, settings) {
  const r = sensorRange(field, settings);
  if (!r) return 0;
  return value !== null && value !== undefined && Number.isFinite(Number(value))
    ? decimalsFor(value, r.decimals)
    : r.decimals;
}

/** Display text: the number with its unit, or the empty dash. */
export function formatSensorValue(field, value, settings, empty = "—") {
  const r = sensorRange(field, settings);
  if (!r || value === null || value === undefined || !Number.isFinite(Number(value))) return empty;
  return `${Number(value).toFixed(decimalsFor(value, r.decimals))} ${r.unit}`;
}

/** The hint under a cell's value: what it is, or its range. */
export function sensorHint(field, settings) {
  const r = sensorRange(field, settings);
  if (!r) return "";
  switch (field) {
    case "range_low":
    case "range_high":
      return `Reading at ${sensorEndpoint(field, settings)}`;
    case "offset":
      return "Added after scaling";
    case "zero_m":
    case "span_m":
      return `Level at ${sensorEndpoint(field, settings)}`;
    default:
      return `${r.min} to ${r.max} ${r.unit}`;
  }
}

/** The keypad's range line for one value. */
export function sensorRangeText(field, settings) {
  const r = sensorRange(field, settings);
  if (!r) return "";
  const g = settings && settings[SENSOR_FIELDS[field].group];
  const fmt = (v) => formatSensorValue(field, v, settings);
  switch (field) {
    case "range_low": {
      const hi = g ? num(g.range_high) : null;
      return hi !== null ? `Below range high (${fmt(hi)}); ± for negative` : "± for negative";
    }
    case "range_high": {
      const lo = g ? num(g.range_low) : null;
      return lo !== null ? `Above range low (${fmt(lo)}); ± for negative` : "± for negative";
    }
    case "offset": {
      const span = pressureSpan(g);
      return span !== null ? `Up to ±${fmt(span)}; ± for negative` : "± for negative";
    }
    case "zero_m": {
      const span = g ? num(g.span_m) : null;
      return span !== null ? `${r.min} m up to below span (${fmt(span)})` : `${r.min} to ${r.max} m`;
    }
    case "span_m": {
      const zero = g ? num(g.zero_m) : null;
      return zero !== null ? `Above zero (${fmt(zero)}) up to ${r.max} m` : `${r.min} to ${r.max} m`;
    }
    default:
      return `Range ${r.min} to ${r.max} ${r.unit}, whole numbers`;
  }
}

function pressureSpan(g) {
  const lo = g ? num(g.range_low) : null;
  const hi = g ? num(g.range_high) : null;
  return lo !== null && hi !== null ? hi - lo : null;
}

/**
 * Why `value` cannot be set for `field` ("" when it can), with the app's
 * rules against its current other values (a value the app has not published
 * yet does not constrain).
 */
export function validateSensorValue(field, value, settings) {
  const f = SENSOR_FIELDS[field];
  const r = sensorRange(field, settings);
  if (!f || !r) return "Unknown setting";
  const v = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(v)) return "Enter a number";
  const g = (settings && settings[f.group]) || {};
  const fmt = (x) => formatSensorValue(field, x, settings);
  const places = `Up to ${SENSOR_MAX_DECIMALS} decimal places`;
  if (f.group === "pressure") {
    if (Math.abs(v) > PRESSURE_VALUE_LIMIT) return `Out of range (±${PRESSURE_VALUE_LIMIT} ${r.unit})`;
    if (tooPrecise(v)) return places;
    const lo = num(g.range_low);
    const hi = num(g.range_high);
    const off = num(g.offset);
    if (field === "range_low") {
      if (hi !== null && v >= hi) return `Range low must be below range high (${fmt(hi)})`;
      if (hi !== null && off !== null && Math.abs(off) > hi - v) {
        return `The offset (${fmt(off)}) must stay within the range (${fmt(hi - v)})`;
      }
    } else if (field === "range_high") {
      if (lo !== null && v <= lo) return `Range high must be above range low (${fmt(lo)})`;
      if (lo !== null && off !== null && Math.abs(off) > v - lo) {
        return `The offset (${fmt(off)}) must stay within the range (${fmt(v - lo)})`;
      }
    } else if (lo !== null && hi !== null && Math.abs(v) > hi - lo) {
      return `The offset must be within ±${fmt(hi - lo)} (the range)`;
    }
    return "";
  }
  if (v < r.min || v > r.max) return `Out of range (${r.min} to ${r.max} ${r.unit})`;
  if (r.whole && !Number.isInteger(v)) return "Whole kg/m³ only (no decimals)";
  if (tooPrecise(v)) return places;
  if (field === "zero_m") {
    const span = num(g.span_m);
    if (span !== null && v >= span) return `Zero must be below span (${fmt(span)})`;
  } else if (field === "span_m") {
    const zero = num(g.zero_m);
    if (v <= r.min) return `Span must be above ${r.min} m`;
    if (zero !== null && v <= zero) return `Span must be above zero (${fmt(zero)})`;
  }
  return "";
}

/** Loop current text: "12.34 mA", or the empty dash. */
export function formatLoopCurrent(ma, empty = "—") {
  return typeof ma === "number" && Number.isFinite(ma) ? `${ma.toFixed(2)} mA` : empty;
}

/**
 * The live input's caption: "Loop current" for a mA input, else "Input"
 * (a level app configured for Volts or raw counts).
 */
export function sensorInputCaption(group, settings) {
  return sensorInput(group, settings).units === "mA" ? "Loop current" : "Input";
}

/**
 * The live input (payload `loop_ma`, in the input's units): "12.34 mA",
 * "4.20 V", "1234.00 raw", or the empty dash.
 */
export function formatSensorInput(group, settings, empty = "—") {
  const g = settings && settings[group];
  const v = g ? num(g.loop_ma) : null;
  if (v === null) return empty;
  const units = sensorInput(group, settings).units;
  return `${v.toFixed(2)}${units ? ` ${units}` : ""}`;
}

/** The live (corrected) reading: pressure as the Skid tile, level in metres (3 dp). */
export function formatSensorReading(group, settings, empty = "—") {
  const g = settings && settings[group];
  const v = g ? num(g.reading) : null;
  if (v === null) return empty;
  if (group === "tank") return `${v.toFixed(3)} m`;
  return `${v.toFixed(1)} ${(g && g.units) || "psi"}`;
}
