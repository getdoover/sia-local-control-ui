/**
 * Data adapter: fold the raw channel aggregates into the dashboard payload the
 * render core draws (src/core/hmi-core.js).
 *
 *   - `deployment_config` { applications: { <app_key>: {...config} } }: this
 *     install's settings (HMI Control Mode, controllers, peripheral apps,
 *     units, battery thresholds).
 *   - `tag_values` { <app_key>: { <tag>: value } }: the pump controller's
 *     status tags (controller CONTRACT.md) and the peripheral apps' readings.
 *   - `ui_cmds` { <app_key>: { <element>: value } }: the controller's saved
 *     calibration factor (`last_calibration_factor`).
 *
 * The payload keeps the exact shape this app's legacy Flask dashboard
 * (src/sia_local_control_ui, frozen) pushes over Socket.IO, so the render
 * rules are shared. Optional features appear only when detected: `vsd` (drive
 * card), `touch` (on-screen controls), `solar`, `tank`, `skid`. There is no
 * control-mode switch: control priority (local HMI > DCS > cloud) is fixed by
 * the controller and its config, not an HMI option.
 *
 * Pure: no hooks, no DOM. The only state is `FeatureMemory`, which the caller
 * keeps across renders for the sticky detection heuristics and the battery
 * warning hysteresis. Unit-tested in tests/assembleDashboardData.test.mjs.
 */

type JsonRecord = Record<string, unknown>;

// --- config -------------------------------------------------------------------

export const HMI_MODES = {
  readOnly: "Read Only",
  touch: "Touch",
  button: "Button",
} as const;
export type HmiMode = "read_only" | "touch" | "button";

export const DEFAULT_APP_KEY = "sia_local_control_ui_1";
export const DEFAULT_CONTROLLERS: readonly string[] = ["sia_injection_controller_1"];
export const DEFAULT_RATE_UNITS = "L/Hr";
export const DEFAULT_PRESSURE_UNITS = "psi";
export const DEFAULT_RPC_TIMEOUT_S = 20;

// The controller's last_calibration_factor FloatInput range (app_ui.py).
export const CAL_FACTOR_MIN = 0.3;
export const CAL_FACTOR_MAX = 1.7;

/**
 * Controller status tag names. Configurable in this app's config (the
 * `*_tag` keys, shared with the legacy dashboard); the defaults are the
 * controller CONTRACT.md names.
 */
export interface StatusTags {
  state: string;
  targetRate: string;
  flowRate: string;
  total: string;
  minRate: string;
  maxRate: string;
  running: string;
  fault: string;
  faultReason: string;
  warning: string;
  warningReason: string;
}

/** config key -> (StatusTags field, default tag name). */
const STATUS_TAG_KEYS: [string, keyof StatusTags, string][] = [
  ["state_tag", "state", "StateString"],
  ["target_rate_tag", "targetRate", "TargetRate"],
  ["flow_rate_tag", "flowRate", "FlowRate"],
  ["total_tag", "total", "Total"],
  ["min_rate_tag", "minRate", "MinRate"],
  ["max_rate_tag", "maxRate", "MaxRate"],
  ["running_tag", "running", "Running"],
  ["fault_tag", "fault", "Fault"],
  ["fault_reason_tag", "faultReason", "FaultReason"],
  ["warning_tag", "warning", "Warning"],
  ["warning_reason_tag", "warningReason", "WarningReason"],
];

// --- tank readings ------------------------------------------------------------

/**
 * Tank Level readings, each mapped to the tag the analog level sensor app
 * (getdoover/apps/analog-level-sensor, common_tags.py) really publishes:
 *
 *   mm  level_reading (canonical metres) x 1000
 *   m   level_reading
 *   L   level_volume, as published: the tank app computes it from its Volume
 *       Curve (or Max Volume, linear between Empty/Full Level) in its
 *       Volume Units (default "L"). The HMI never computes volume.
 *   %   level_filled_percentage
 *
 * No gallons option: the tank app publishes no gallons tag.
 */
export const TANK_READINGS = ["mm", "m", "L", "%"] as const;
export type TankReading = (typeof TANK_READINGS)[number];
export const TANK_NONE = "None";
export const DEFAULT_TANK_PRIMARY: TankReading = "mm";

const TANK_READING_SOURCE: Record<
  TankReading,
  { tag: string; scale: number; unit: string; decimals: number }
> = {
  mm: { tag: "level_reading", scale: 1000, unit: "mm", decimals: 0 },
  m: { tag: "level_reading", scale: 1, unit: "m", decimals: 2 },
  L: { tag: "level_volume", scale: 1, unit: "L", decimals: 0 },
  "%": { tag: "level_filled_percentage", scale: 1, unit: "%", decimals: 0 },
};

function tankReading(value: unknown): TankReading | null {
  const t = typeof value === "string" ? value.trim() : "";
  return (TANK_READINGS as readonly string[]).includes(t) ? (t as TankReading) : null;
}

export interface TankLevelReading {
  /** Already scaled and rounded; null when the tag has no value. */
  value: number | null;
  unit: string;
  decimals: number;
}

/** One configured reading from the tank app's tags. */
export function readTankLevel(
  get: (tag: string, key: string) => unknown,
  tankApp: string,
  reading: TankReading,
): TankLevelReading {
  const src = TANK_READING_SOURCE[reading];
  const raw = optNum(get(src.tag, tankApp));
  return {
    value: raw === null ? null : Number((raw * src.scale).toFixed(src.decimals)),
    unit: src.unit,
    decimals: src.decimals,
  };
}

// --- VSD commissioning panel --------------------------------------------------

/**
 * The `vsd_commissioning` options, as the config editor shows them (pinned
 * against app_config.py VSD_COMMISSIONING by tests/test_widget_contract.py).
 * The first is the default: no gear. See lib/vsdPanel.ts.
 */
export const VSD_COMMISSIONING_OPTIONS = ["Hidden", "Local only", "Local and cloud"] as const;
export type VsdCommissioning = "hidden" | "local_only" | "local_and_cloud";

/** "Local only" -> local_only; anything unknown (or unset) is hidden. */
export function normaliseCommissioning(value: unknown): VsdCommissioning {
  const t = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (t === "local only") return "local_only";
  if (t === "local and cloud") return "local_and_cloud";
  return "hidden";
}

export interface HmiConfig {
  hmiMode: HmiMode;
  touchEnabled: boolean;
  controllers: string[];
  pressureSensorApp: string | null;
  tankLevelApp: string | null;
  tankPrimary: TankReading;
  tankSecondary: TankReading | null;
  flowSensorApp: string | null;
  solarControllers: string[];
  rateUnits: string;
  pressureUnits: string;
  lowBatteryPercent: number;
  lowBatteryVoltage: number;
  lowBatteryClearMargin: number;
  rpcTimeoutMs: number;
  tags: StatusTags;
  /** Techtop motor controller app the VSD panel calls; null hides the gear. */
  vsdMotorApp: string | null;
  vsdCommissioning: VsdCommissioning;
  /** Alarm settings gears on the Tank / Skid tiles (same options as VSD). */
  alarmSettingsAccess: VsdCommissioning;
  /** Local panel only: gap on every side of the whole HMI (cover plate). */
  kioskInsetMm: number;
  /** Local panel only: popover gap from the screen edge, on top of the inset. */
  popoverInsetMm: number;
  /** Local panel pixels per mm, to turn the insets into pixels. */
  kioskPxPerMm: number;
}

/**
 * J5261 panel, a Xenarc 892: 177.6 x 100.4 mm active area shown at
 * 1024 x 600 (1024 / 177.6 = 5.77, 600 / 100.4 = 5.98 px/mm).
 */
export const DEFAULT_KIOSK_PX_PER_MM = 5.8;

function clampNum(value: unknown, fallback: number, min: number, max: number): number {
  const n = optNum(value);
  return n === null ? fallback : Math.min(max, Math.max(min, n));
}

function positiveNum(value: unknown, fallback: number): number {
  const n = optNum(value);
  return n !== null && n > 0 ? n : fallback;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Finite number, or null. Numeric strings count (tags are loosely typed). */
export function optNum(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  const n = typeof value === "string" ? (value.trim() === "" ? NaN : Number(value)) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function num(value: unknown, fallback = 0): number {
  return optNum(value) ?? fallback;
}

/** An application list config value: strings, or `{value}` / `{app_key}` items. */
function appList(value: unknown, fallback: readonly string[]): string[] {
  if (value === undefined || value === null) return [...fallback];
  if (!Array.isArray(value)) {
    const single = asString(value);
    return single ? [single] : [];
  }
  const out: string[] = [];
  for (const item of value) {
    const key =
      asString(item) ?? asString(asRecord(item).value) ?? asString(asRecord(item).app_key);
    if (key) out.push(key);
  }
  return out;
}

/** "Touch" / "touch" -> touch; "Button" -> button; anything else read only. */
export function normaliseHmiMode(value: unknown): HmiMode {
  const t = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (t === "touch") return "touch";
  if (t === "button") return "button";
  return "read_only";
}

/**
 * This install's settings from its own deployment_config block, with defaults.
 *
 * The keys are the app's config keys (src/sia_local_control_ui/app_config.py),
 * which derive from the display names; the two battery thresholds keep the
 * odd keys already deployed on the Kuwait skids (`low_battery_warning_` from
 * "Low Battery Warning (%)", `low_battery_warning_v` from "(V)"). Pinned by
 * tests/test_widget_contract.py on the Python side.
 */
export function resolveConfig(
  appKey: string,
  deploymentConfig: JsonRecord | undefined,
): HmiConfig {
  const applications = asRecord(asRecord(deploymentConfig).applications);
  const c = asRecord(applications[appKey]);
  const hmiMode = normaliseHmiMode(c.hmi_control_mode);
  const timeoutS = optNum(c.rpc_timeout_s);
  const tags = {} as StatusTags;
  for (const [key, field, fallback] of STATUS_TAG_KEYS) {
    tags[field] = asString(c[key]) ?? fallback;
  }
  return {
    hmiMode,
    // "Button" is reserved and deliberately behaves exactly like Read Only.
    touchEnabled: hmiMode === "touch",
    controllers: appList(c.pump_controllers, DEFAULT_CONTROLLERS),
    pressureSensorApp: asString(c.pressure_sensor_app),
    tankLevelApp: asString(c.tank_level_app),
    tankPrimary: tankReading(c.tank_primary_reading) ?? DEFAULT_TANK_PRIMARY,
    tankSecondary: tankReading(c.tank_secondary_reading),
    flowSensorApp: asString(c.flow_sensor_app),
    solarControllers: appList(c.solar_controllers, []),
    rateUnits: asString(c.rate_units) ?? DEFAULT_RATE_UNITS,
    pressureUnits: asString(c.pressure_units) ?? DEFAULT_PRESSURE_UNITS,
    lowBatteryPercent: num(c.low_battery_warning_, 30),
    lowBatteryVoltage: num(c.low_battery_warning_v, 0),
    lowBatteryClearMargin: num(c.low_battery_clear_margin, 5),
    rpcTimeoutMs: Math.max(1, timeoutS ?? DEFAULT_RPC_TIMEOUT_S) * 1000,
    tags,
    vsdMotorApp: asString(c.vsd_motor_app),
    vsdCommissioning: normaliseCommissioning(c.vsd_commissioning),
    alarmSettingsAccess: normaliseCommissioning(c.alarm_settings_access),
    kioskInsetMm: clampNum(c.kiosk_inset_mm, 0, 0, 30),
    popoverInsetMm: clampNum(c.popover_inset_mm, 0, 0, 40),
    kioskPxPerMm: positiveNum(c.kiosk_px_per_mm, DEFAULT_KIOSK_PX_PER_MM),
  };
}

// --- feature memory -----------------------------------------------------------

/**
 * State carried between renders (the device-hosted HMI kept the same sets on
 * its Application). Create one per mounted widget with `createFeatureMemory`.
 */
export interface FeatureMemory {
  /** Controllers seen with a VSD (pre-flag heuristics). */
  vsdSeen: Set<string>;
  /** Latched low-battery checks (hysteresis). */
  lowBattery: Record<string, boolean>;
}

export function createFeatureMemory(): FeatureMemory {
  return {
    vsdSeen: new Set(),
    lowBattery: {},
  };
}

// --- payload types --------------------------------------------------------------

export interface PumpData {
  name: string;
  target_rate: number | null;
  flow_rate: number;
  total: number;
  min_rate: number | null;
  max_rate: number | null;
  state: string;
  running: boolean;
  fault: boolean;
  fault_reason: string | null;
  warning: boolean;
  warning_reason: string | null;
}

export interface BannerItem {
  pump: string;
  reason: string;
}

export interface VsdData {
  tripped: boolean;
  trip_code: number | null;
  trip_description: string | null;
  motor_hz: number | null;
  pump_rpm: number | null;
}

export interface TouchData {
  calibration_factor: number | null;
  calibration_min: number;
  calibration_max: number;
}

/** The controller's CalibrationMethod that turns the wizard on. */
export const CALIBRATION_METHOD_MANUAL = "Manual (HMI)";

/** The controller's timed test run (CONTRACT.md, REQ-009). */
export interface TestRunData {
  active: boolean;
  remaining_s: number | null;
  rate: number | null;
  duration_s: number | null;
  elapsed_s: number | null;
  result: "completed" | "cancelled" | "faulted" | null;
}

/**
 * The 1min Calibration Sequence: only in Touch, and only when the controller
 * publishes `CalibrationMethod` = "Manual (HMI)". Absent otherwise (including
 * an older controller with no such tag): the tile stays CAL FACTOR.
 */
export interface CalibrationData {
  method: string;
  test_run: TestRunData;
}

/**
 * The controller's tank / discharge pressure alarm thresholds (0 = off) and
 * the tank alarm delay (seconds), for the alarm settings popovers
 * (core/alarms.js). A group is present only when its sensor app is
 * configured on the HMI.
 */
export interface AlarmSettingsData {
  tank?: { low: number | null; low_low: number | null; delay: number | null; ll_required: boolean };
  pressure?: { high: number | null; high_high: number | null; units: string };
}

/**
 * Alarm thresholds from the primary controller's Setpoint* tags, with the
 * two controller config facts the editor needs: its pressure unit (the
 * PressureUnits tag, else its pressure_units config) and whether tank LL
 * may be off (tank_ll_validation_enabled with a tank_app: it may not). The
 * tank alarm delay is SetpointTankLevelTimeout (null on an older controller
 * that does not publish it, as for the thresholds).
 */
export function collectAlarmSettings(
  get: TagReader,
  key: string,
  controllerConfig: unknown,
  cfg: Pick<HmiConfig, "tankLevelApp" | "pressureSensorApp">,
): AlarmSettingsData | undefined {
  const cc = asRecord(controllerConfig);
  const out: AlarmSettingsData = {};
  if (cfg.tankLevelApp) {
    out.tank = {
      low: optNum(get("SetpointTankL", key)),
      low_low: optNum(get("SetpointTankLL", key)),
      delay: optNum(get("SetpointTankLevelTimeout", key)),
      ll_required: cc.tank_ll_validation_enabled === true && asString(cc.tank_app) !== null,
    };
  }
  if (cfg.pressureSensorApp) {
    out.pressure = {
      high: optNum(get("SetpointPressureH", key)),
      high_high: optNum(get("SetpointPressureHH", key)),
      units: asString(get("PressureUnits", key)) ?? asString(cc.pressure_units) ?? DEFAULT_PRESSURE_UNITS,
    };
  }
  return out.tank || out.pressure ? out : undefined;
}

export interface DashboardData {
  pumps: PumpData[];
  faults: BannerItem[];
  warnings: BannerItem[];
  link_ok: boolean;
  units: { rate: string; pressure: string };
  timestamp: string;
  hmi_mode: HmiMode;
  vsd?: VsdData;
  touch?: TouchData;
  calibration?: CalibrationData;
  /** Alarm thresholds read back from the controller (Setpoint* tags). */
  alarm_settings?: AlarmSettingsData;
  solar?: {
    battery_voltage?: number;
    battery_percentage?: number;
    panel_power?: number;
    battery_ah?: number;
  };
  tank?: {
    tank_level_mm?: number;
    tank_level_percent?: number;
    /** Only when the primary reading is not the default mm. */
    level_primary?: TankLevelReading;
    /** Only when configured AND its tag has a value. */
    level_secondary?: TankLevelReading;
  };
  skid?: { skid_flow?: number; skid_pressure?: number };
}

export interface AssembleInputs {
  appKey: string;
  deploymentConfig: JsonRecord | undefined;
  tagValues: JsonRecord | undefined;
  uiCmds: JsonRecord | undefined;
  /** Epoch-ms of the last tag_values update. */
  lastUpdated?: number | null;
  memory: FeatureMemory;
}

// --- controller features (CONTRACT.md "Modbus Rev 0.4 additions") -------------

// Only ever set when the controller has a motor_controller_app (a VSD).
const VSD_FLAG_TAGS = [
  "TripVsd",
  "TripVsdComms",
  "TripVsdNoStart",
  "TripVsdStoppedExt",
  "WarnVsdOverload",
  "WarnVsdNotReady",
  "WarnVsdNoModbusControl",
];

// Fault text from the per-cause bits, used only when the controller raises
// Fault without a FaultReason (it normally sends the same text).
const TRIP_TEXT: [string, string][] = [
  ["TripVsdComms", "VSD communications lost"],
  ["TripVsdNoStart", "VSD did not start"],
  ["TripVsdStoppedExt", "VSD stopped externally"],
  ["TripVsd", "VSD trip"],
];

type TagReader = (tag: string, key: string) => unknown;

function makeReader(tagValues: JsonRecord | undefined): TagReader {
  const tags = asRecord(tagValues);
  return (tag, key) => asRecord(tags[key])[tag];
}

/** The drive itself is tripped (not just the latched pump fault). */
export function vsdTripped(code: unknown, description: unknown): boolean {
  return Boolean(num(code)) || Boolean(asString(description));
}

function tripText(get: TagReader, key: string): string | null {
  for (const [tag, text] of TRIP_TEXT) {
    if (get(tag, key)) return text;
  }
  return null;
}

/**
 * Drive status + reset, when the controller has a VSD.
 *
 * `VsdConfigured` is authoritative when published. Older controllers are
 * detected from values only a configured motor produces (a drive frequency,
 * any VSD bit, a live drive trip); once seen it stays shown so a stale motor
 * app (frequency null) does not make Reset VSD vanish.
 */
export function collectVsd(
  get: TagReader,
  key: string,
  memory: FeatureMemory,
): VsdData | undefined {
  const hz = optNum(get("MotorOutputHz", key));
  const code = get("VsdTripCode", key);
  const description = get("VsdTripDescription", key);
  const tripped = vsdTripped(code, description);
  const configured = get("VsdConfigured", key);
  if (configured !== null && configured !== undefined) {
    if (!configured) return undefined;
  } else {
    const flags = VSD_FLAG_TAGS.some((tag) => Boolean(get(tag, key)));
    if (hz !== null || flags || tripped) memory.vsdSeen.add(key);
    else if (!memory.vsdSeen.has(key)) return undefined;
  }
  return {
    tripped,
    trip_code: tripped && num(code) ? Math.trunc(num(code)) : null,
    trip_description: tripped ? asString(description) : null,
    motor_hz: hz,
    pump_rpm: optNum(get("PumpRpm", key)),
  };
}

/**
 * The pressure unit label: the HMI's own when changed from psi, otherwise the
 * controller's published `PressureUnits` (every new controller publishes it).
 */
export function resolvePressureUnits(
  own: string,
  get: TagReader,
  key: string | null,
): string {
  if (own !== DEFAULT_PRESSURE_UNITS || key === null) return own;
  const published = get("PressureUnits", key);
  return asString(published) ?? own;
}

function collectSolar(get: TagReader, controllers: string[]): DashboardData["solar"] {
  if (controllers.length === 0) return undefined;
  const voltages: number[] = [];
  const percents: number[] = [];
  const powers: number[] = [];
  const ahs: number[] = [];
  for (const key of controllers) {
    const v = optNum(get("b_voltage", key));
    if (v !== null) voltages.push(v);
    const p = optNum(get("b_percent", key));
    if (p !== null) percents.push(p);
    const pw = optNum(get("panel_power", key));
    if (pw !== null) powers.push(pw);
    const ah = optNum(get("remaining_ah", key));
    if (ah !== null) ahs.push(ah);
  }
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  // Shown whenever solar controllers are configured, even before readings
  // arrive: unpublished fields render as "--" instead of hiding the card.
  const out: NonNullable<DashboardData["solar"]> = {};
  if (voltages.length) out.battery_voltage = avg(voltages);
  if (percents.length) out.battery_percentage = avg(percents);
  if (powers.length) out.panel_power = avg(powers);
  if (ahs.length) out.battery_ah = ahs.reduce((a, b) => a + b, 0);
  return out;
}

/**
 * Low-battery warnings, latched with a clear margin so a reading sitting on the
 * threshold does not flap the banner. Each check is off at threshold 0.
 */
export function batteryWarnings(
  solar: NonNullable<DashboardData["solar"]>,
  cfg: Pick<HmiConfig, "lowBatteryPercent" | "lowBatteryVoltage" | "lowBatteryClearMargin">,
  memory: FeatureMemory,
): BannerItem[] {
  const checks: [string, number | undefined, number, string][] = [
    ["percentage", solar.battery_percentage, cfg.lowBatteryPercent, "%"],
    ["voltage", solar.battery_voltage, cfg.lowBatteryVoltage, "V"],
  ];
  const out: BannerItem[] = [];
  for (const [name, reading, threshold, unit] of checks) {
    if (threshold <= 0 || reading === undefined || reading === null) {
      memory.lowBattery[name] = false;
      continue;
    }
    const tripAt = memory.lowBattery[name]
      ? threshold + cfg.lowBatteryClearMargin
      : threshold;
    const active = reading <= tripAt;
    memory.lowBattery[name] = active;
    if (active) {
      out.push({
        pump: "Solar",
        reason: `Battery low: ${reading.toFixed(1)}${unit} (warn below ${threshold.toFixed(1)}${unit})`,
      });
    }
  }
  return out;
}

const TEST_RUN_RESULTS = ["completed", "cancelled", "faulted"] as const;

/** The wizard's payload, or undefined unless the method is Manual (HMI). */
export function collectCalibration(get: TagReader, key: string): CalibrationData | undefined {
  const method = asString(get("CalibrationMethod", key));
  if (method !== CALIBRATION_METHOD_MANUAL) return undefined;
  const result = asString(get("TestRunResult", key));
  return {
    method,
    test_run: {
      active: get("TestRunActive", key) === true,
      remaining_s: optNum(get("TestRunRemaining_s", key)),
      rate: optNum(get("TestRunRate", key)),
      duration_s: optNum(get("TestRunDuration_s", key)),
      elapsed_s: optNum(get("TestRunElapsed_s", key)),
      result: (TEST_RUN_RESULTS as readonly string[]).includes(result ?? "")
        ? (result as TestRunData["result"])
        : null,
    },
  };
}

/** Saved calibration factor: the controller's ui_cmds value, else its tag. */
function calibrationFactor(
  uiCmds: JsonRecord | undefined,
  get: TagReader,
  key: string,
): number | null {
  const saved = optNum(asRecord(asRecord(uiCmds)[key]).last_calibration_factor);
  return saved ?? optNum(get("CorrectionFactor", key));
}

// --- the payload --------------------------------------------------------------

export function assembleDashboardData(inputs: AssembleInputs): DashboardData {
  const cfg = resolveConfig(inputs.appKey, inputs.deploymentConfig);
  const get = makeReader(inputs.tagValues);
  const memory = inputs.memory;
  const multi = cfg.controllers.length > 1;
  const t = cfg.tags;

  const pumps: PumpData[] = [];
  const faults: BannerItem[] = [];
  const warnings: BannerItem[] = [];
  cfg.controllers.forEach((key, idx) => {
    const state = get(t.state, key);
    const fault = Boolean(get(t.fault, key));
    const reason = asString(get(t.faultReason, key));
    const warning = Boolean(get(t.warning, key));
    const warningReason = asString(get(t.warningReason, key));
    const pump: PumpData = {
      name: multi ? `Pump ${idx + 1}` : "Pump",
      // The controller owns defaulting and clamping: absence stays null.
      target_rate: optNum(get(t.targetRate, key)),
      flow_rate: num(get(t.flowRate, key)),
      total: num(get(t.total, key)),
      min_rate: optNum(get(t.minRate, key)),
      max_rate: optNum(get(t.maxRate, key)),
      state: typeof state === "string" && state !== "" ? state : "unknown",
      running: Boolean(get(t.running, key)),
      fault,
      fault_reason: reason,
      warning,
      warning_reason: warningReason,
    };
    pumps.push(pump);
    if (fault) {
      faults.push({ pump: pump.name, reason: reason ?? tripText(get, key) ?? "Pump tripped" });
    }
    if (warning) warnings.push({ pump: pump.name, reason: warningReason ?? "Warning" });
  });

  const solar = collectSolar(get, cfg.solarControllers);
  if (solar) warnings.push(...batteryWarnings(solar, cfg, memory));

  const primary = pumps[0];
  const primaryKey = cfg.controllers[0] ?? null;

  const data: DashboardData = {
    pumps,
    faults,
    warnings,
    link_ok: primary !== undefined && primary.state !== "unknown",
    units: {
      rate: cfg.rateUnits,
      pressure: resolvePressureUnits(cfg.pressureUnits, get, primaryKey),
    },
    timestamp: new Date(inputs.lastUpdated ?? Date.now()).toISOString(),
    hmi_mode: cfg.hmiMode,
  };

  if (primary !== undefined && primaryKey !== null) {
    const vsd = collectVsd(get, primaryKey, memory);
    if (vsd) data.vsd = vsd;
    if (cfg.touchEnabled) {
      data.touch = {
        calibration_factor: calibrationFactor(inputs.uiCmds, get, primaryKey),
        calibration_min: CAL_FACTOR_MIN,
        calibration_max: CAL_FACTOR_MAX,
      };
      const calibration = collectCalibration(get, primaryKey);
      if (calibration) data.calibration = calibration;
    }
  }

  if (solar) data.solar = solar;

  if (cfg.tankLevelApp) {
    const tank: NonNullable<DashboardData["tank"]> = {};
    const metres = optNum(get("level_reading", cfg.tankLevelApp));
    if (metres !== null) tank.tank_level_mm = metres * 1000;
    const pct = optNum(get("level_filled_percentage", cfg.tankLevelApp));
    if (pct !== null) tank.tank_level_percent = pct;
    // The default (primary mm, no secondary) adds nothing: the payload and
    // the card are exactly as before.
    if (cfg.tankPrimary !== DEFAULT_TANK_PRIMARY) {
      const primary = readTankLevel(get, cfg.tankLevelApp, cfg.tankPrimary);
      if (primary.value !== null || Object.keys(tank).length) tank.level_primary = primary;
    }
    if (cfg.tankSecondary) {
      const secondary = readTankLevel(get, cfg.tankLevelApp, cfg.tankSecondary);
      if (secondary.value !== null) tank.level_secondary = secondary;
    }
    if (Object.keys(tank).length) data.tank = tank;
  }

  const skid: NonNullable<DashboardData["skid"]> = {};
  if (cfg.flowSensorApp) {
    const f = optNum(get("value", cfg.flowSensorApp));
    if (f !== null) skid.skid_flow = f;
  }
  if (cfg.pressureSensorApp) {
    const p = optNum(get("value", cfg.pressureSensorApp));
    if (p !== null) skid.skid_pressure = p;
  }
  if (Object.keys(skid).length) data.skid = skid;

  if (primaryKey !== null) {
    const applications = asRecord(asRecord(inputs.deploymentConfig).applications);
    const alarms = collectAlarmSettings(get, primaryKey, applications[primaryKey], cfg);
    if (alarms) data.alarm_settings = alarms;
  }

  return data;
}

/**
 * The qualified `<app_key>.<tag>` ids the cloud widget claims for live
 * streaming (lib/liveTags.ts): every tag the payload above reads that its app
 * declares `live=True`.
 */
export function liveTagIds(cfg: HmiConfig): string[] {
  const ids: string[] = [];
  const t = cfg.tags;
  const controllerTags = [
    t.state,
    t.targetRate,
    t.flowRate,
    t.minRate,
    t.maxRate,
    t.running,
    t.fault,
    t.faultReason,
    t.warning,
    t.warningReason,
    "VsdConfigured",
    "VsdTripCode",
    "VsdTripDescription",
    "MotorOutputHz",
    "PumpRpm",
    "PressureUnits",
    ...VSD_FLAG_TAGS,
    // 1min Calibration Sequence (only published with Manual (HMI)).
    "CalibrationMethod",
    "TestRunActive",
    "TestRunRemaining_s",
    "TestRunRate",
    "TestRunDuration_s",
    "TestRunElapsed_s",
    "TestRunResult",
    // Alarm settings readback.
    "SetpointTankL",
    "SetpointTankLL",
    "SetpointTankLevelTimeout",
    "SetpointPressureH",
    "SetpointPressureHH",
  ];
  for (const key of cfg.controllers) {
    for (const tag of controllerTags) ids.push(`${key}.${tag}`);
  }
  if (cfg.tankLevelApp) {
    ids.push(`${cfg.tankLevelApp}.level_reading`, `${cfg.tankLevelApp}.level_filled_percentage`);
    // level_volume is not a live tag on the tank app; it arrives with the
    // tag_values aggregate instead.
  }
  if (cfg.flowSensorApp) ids.push(`${cfg.flowSensorApp}.value`);
  if (cfg.pressureSensorApp) ids.push(`${cfg.pressureSensorApp}.value`);
  return ids;
}
