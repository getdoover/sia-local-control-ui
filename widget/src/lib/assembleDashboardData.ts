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

/**
 * The tank app's level-sensor fault tag: "under_range" while the loop current
 * is below the sensor's 4 mA zero, null / absent otherwise (and never
 * published by an older tank app). While it is set the tank app nulls its
 * level tags and keeps publishing `raw_level_reading` (the loop current, mA:
 * SENSOR_TAGS.tank.loop).
 */
export const TANK_SENSOR_FAULT_TAG = "sensor_fault";

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
  /** Header title; null keeps the widget's default title. */
  headerTitle: string | null;
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
  /** Alarm settings gears on the Tank / Skid / Pump Control tiles (same options as VSD). */
  alarmSettingsAccess: VsdCommissioning;
  /** Sensor tab on the Tank / Skid pressure gears' popovers (same options, own gate). */
  sensorSettingsAccess: VsdCommissioning;
  /** Local panel only: gap on every side of the whole HMI (cover plate). */
  kioskInsetMm: number;
  /** Local panel only: popover gap from the screen edge, on top of the inset. */
  popoverInsetMm: number;
  /** Local panel pixels per mm, to turn the insets into pixels. */
  kioskPxPerMm: number;
  /**
   * `dcs_connected`: a DCS commands this skid over Modbus, so the local panel
   * shows a pop-up per DCS command (payload `dcs_command`, lib/dcsNotices.ts).
   * Off by default: no payload key and no live tags claimed.
   */
  dcsConnected: boolean;
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

/** A Boolean config value: true (or the string "true") only. */
function asBool(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.trim().toLowerCase() === "true");
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
    headerTitle: asString(c.header_title),
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
    sensorSettingsAccess: normaliseCommissioning(c.sensor_settings_access),
    kioskInsetMm: clampNum(c.kiosk_inset_mm, 0, 0, 30),
    popoverInsetMm: clampNum(c.popover_inset_mm, 0, 0, 40),
    kioskPxPerMm: positiveNum(c.kiosk_px_per_mm, DEFAULT_KIOSK_PX_PER_MM),
    dcsConnected: asBool(c.dcs_connected),
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
  /**
   * The last completed run's average commanded rate (TestRunNominalRate):
   * the test rate, raised by the VSD start boost when the run was boosted.
   * Null while running or from a controller that predates it.
   */
  nominal_rate: number | null;
  result: "completed" | "cancelled" | "faulted" | null;
  /**
   * Who ended the last run (the controller's TestRunEndedBy): "hmi" / "dcs" /
   * "cloud" when a command from that source cancelled it, "deadline",
   * "fault" or "restart"; null while running, before any run, from an older
   * controller, or for a stop no command asked for.
   */
  ended_by: TestRunEndedBy | null;
}

export type TestRunEndedBy = "hmi" | "dcs" | "cloud" | "deadline" | "fault" | "restart";

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
 * The controller's tank / discharge pressure / flow alarm thresholds (0 =
 * off) and each alarm's delay (whole seconds, the delay in effect), for the
 * alarm settings popovers (core/alarms.js). The tank and pressure groups are
 * present only when their sensor app is configured on the HMI; the flow
 * group only when the primary controller has a dedicated flow meter.
 */
export interface AlarmSettingsData {
  tank?: {
    low: number | null;
    low_low: number | null;
    low_delay: number | null;
    low_low_delay: number | null;
    ll_required: boolean;
  };
  pressure?: {
    high: number | null;
    high_high: number | null;
    high_delay: number | null;
    high_high_delay: number | null;
    units: string;
  };
  flow?: { low: number | null; low_low: number | null; low_delay: number | null; low_low_delay: number | null };
}

/**
 * Whether the controller has a dedicated flow meter, so flow L / LL alarms
 * (app_config.py has_flow_meter): a Flow Meter Source other than Disabled
 * (DI / AI, or a legacy AI0 / AI1), a pin (AI0 / AI1 carry theirs) and a
 * K-factor above 0. Without one the controller runs no flow alarms.
 */
export function controllerHasFlowMeter(controllerConfig: unknown): boolean {
  const cc = asRecord(controllerConfig);
  const source = (asString(cc.flow_meter_source) ?? "").trim().toLowerCase();
  const legacyAi = source === "ai0" || source === "ai1";
  if (!legacyAi && source !== "di" && source !== "ai") return false;
  const k = optNum(cc.flow_meter_k_factor);
  return (legacyAi || optNum(cc.flow_meter_pin) !== null) && k !== null && k > 0;
}

/**
 * Alarm thresholds and delays from the primary controller's Setpoint* and
 * Delay* tags, with the controller config facts the editor needs: its
 * pressure unit (the PressureUnits tag, else its pressure_units config),
 * whether tank LL may be off (tank_ll_validation_enabled with a tank_app: it
 * may not) and whether it has a flow meter (the flow group). A tag an older
 * controller does not publish reads null ("—"), not zero.
 */
export function collectAlarmSettings(
  get: TagReader,
  key: string,
  controllerConfig: unknown,
  cfg: Pick<HmiConfig, "tankLevelApp" | "pressureSensorApp">,
): AlarmSettingsData | undefined {
  const cc = asRecord(controllerConfig);
  const out: AlarmSettingsData = {};
  const tag = (name: string) => optNum(get(name, key));
  if (cfg.tankLevelApp) {
    out.tank = {
      low: tag("SetpointTankL"),
      low_low: tag("SetpointTankLL"),
      low_delay: tag("DelayTankL"),
      low_low_delay: tag("DelayTankLL"),
      ll_required: cc.tank_ll_validation_enabled === true && asString(cc.tank_app) !== null,
    };
  }
  if (cfg.pressureSensorApp) {
    out.pressure = {
      high: tag("SetpointPressureH"),
      high_high: tag("SetpointPressureHH"),
      high_delay: tag("DelayPressureH"),
      high_high_delay: tag("DelayPressureHH"),
      units: asString(get("PressureUnits", key)) ?? asString(cc.pressure_units) ?? DEFAULT_PRESSURE_UNITS,
    };
  }
  if (controllerHasFlowMeter(cc)) {
    out.flow = {
      low: tag("SetpointFlowL"),
      low_low: tag("SetpointFlowLL"),
      low_delay: tag("DelayFlowL"),
      low_low_delay: tag("DelayFlowLL"),
    };
  }
  return out.tank || out.pressure || out.flow ? out : undefined;
}

/**
 * The sensor apps' operator calibration (the Sensor tab, core/sensors.js),
 * read back from their own tags: whether the app has Operator Sensor
 * Calibration on (`operator_calibration`, true only then; absent on an older
 * app), the live loop current in mA, the corrected reading, and each value in
 * effect (the operator's, else the app's config default). A tag the app does
 * not publish reads null.
 */
export interface SensorSettingsData {
  pressure?: {
    enabled: boolean;
    loop_ma: number | null;
    reading: number | null;
    range_low: number | null;
    range_high: number | null;
    offset: number | null;
    units: string;
  };
  tank?: {
    enabled: boolean;
    /** The live input, in `input_units` (mA unless the app is set otherwise). */
    loop_ma: number | null;
    /** level_reading, metres. */
    reading: number | null;
    zero_m: number | null;
    span_m: number | null;
    fluid_density: number | null;
    /**
     * The level app's input range and units (its config sensor_minimum_ma /
     * sensor_maximum_ma / input_units; 4 / 20 / "mA" when unset), and whether
     * it reads inverted (type "Radar": zero at the maximum input, span at the
     * minimum, common_app._map_value). The Sensor tab's labels follow these.
     */
    input_low: number;
    input_high: number;
    input_units: string;
    inverted: boolean;
  };
}

/**
 * Sensor calibration tags each sensor app publishes (live), keyed by the
 * group. `loop` is its loop current in mA: the pressure app's `raw_value`
 * (the analog input, mA) and the level app's `raw_level_reading`.
 */
export const SENSOR_TAGS = {
  pressure: { loop: "raw_value", values: ["range_low", "range_high", "offset"] },
  tank: { loop: "raw_level_reading", values: ["zero_m", "span_m", "fluid_density"] },
} as const;
export const SENSOR_ENABLED_TAG = "operator_calibration";

/**
 * The Sensor tab payload: only with sensor_settings_access on (Hidden adds
 * nothing, so the payload and its render cadence are as before) and only
 * for the sensor apps this HMI has configured.
 */
export function collectSensorSettings(
  get: TagReader,
  cfg: Pick<HmiConfig, "sensorSettingsAccess" | "pressureSensorApp" | "tankLevelApp">,
  pressureUnits: string,
  applications: JsonRecord = {},
): SensorSettingsData | undefined {
  if (cfg.sensorSettingsAccess === "hidden") return undefined;
  const out: SensorSettingsData = {};
  const p = cfg.pressureSensorApp;
  if (p) {
    out.pressure = {
      enabled: get(SENSOR_ENABLED_TAG, p) === true,
      loop_ma: optNum(get(SENSOR_TAGS.pressure.loop, p)),
      reading: optNum(get("value", p)),
      range_low: optNum(get("range_low", p)),
      range_high: optNum(get("range_high", p)),
      offset: optNum(get("offset", p)),
      units: pressureUnits,
    };
  }
  const t = cfg.tankLevelApp;
  if (t) {
    const tc = asRecord(applications[t]);
    out.tank = {
      enabled: get(SENSOR_ENABLED_TAG, t) === true,
      loop_ma: optNum(get(SENSOR_TAGS.tank.loop, t)),
      reading: optNum(get("level_reading", t)),
      zero_m: optNum(get("zero_m", t)),
      span_m: optNum(get("span_m", t)),
      fluid_density: optNum(get("fluid_density", t)),
      input_low: optNum(tc.sensor_minimum_ma) ?? 4,
      input_high: optNum(tc.sensor_maximum_ma) ?? 20,
      input_units: asString(tc.input_units) ?? "mA",
      inverted: tc.type === "Radar",
    };
  }
  return out.pressure || out.tank ? out : undefined;
}

/**
 * The last DCS command (the controller's DCS interface, CONTRACT.md REQ-008):
 * for the local panel's pop-up (core/dcsCommand.js). `seq` (DcsCmdSeq) goes
 * up by one per command the DCS sends, accepted, refused or invalid; the
 * rest describe that command. Each reads null when the controller does not
 * publish it (an older controller, or its DCS interface off).
 */
export interface DcsCommandData {
  /** DcsCmdSeq. */
  seq: number | null;
  /** DcsLastCommand: 0 stop, 2 start, 3 rate, 4 / 5 process / VSD reset, 6..11 alarm delays. */
  command: number | null;
  /** DcsCmdResult: 0 idle, 1 pending, 2 ok, 3 failed. */
  result: number | null;
  /** DcsCmdError: the Rev 0.3 error table (0 none). */
  error: number | null;
  /** DcsCmdRequest: the value the DCS wrote (rate units, 0 / 2, 4 / 5, seconds). */
  request: number | null;
  /** DcsAppliedRate: the target rate a rate command applied (rate units). */
  applied_rate: number | null;
}

/** The controller's DCS result tags the pop-up reads (live). */
export const DCS_COMMAND_TAGS = {
  seq: "DcsCmdSeq",
  command: "DcsLastCommand",
  result: "DcsCmdResult",
  error: "DcsCmdError",
  request: "DcsCmdRequest",
  applied_rate: "DcsAppliedRate",
} as const;

/** The last DCS command from the primary controller's tags. */
export function collectDcsCommand(get: TagReader, key: string): DcsCommandData {
  const out = {} as DcsCommandData;
  for (const [field, tag] of Object.entries(DCS_COMMAND_TAGS) as [keyof DcsCommandData, string][]) {
    out[field] = optNum(get(tag, key));
  }
  return out;
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
  /** Alarm thresholds and delays read back from the controller (Setpoint* / Delay* tags). */
  alarm_settings?: AlarmSettingsData;
  /** Sensor apps' operator calibration (Sensor tab), with sensor_settings_access on. */
  sensor_settings?: SensorSettingsData;
  /** The last DCS command, with dcs_connected on only (the local panel's pop-up). */
  dcs_command?: DcsCommandData;
  solar?: {
    battery_voltage?: number;
    battery_percentage?: number;
    panel_power?: number;
    battery_ah?: number;
  };
  /** Present whenever a tank level app is configured, like `skid`: a reading
   *  is null while the app has no value (sensor disconnected, out of range or
   *  in fault), so the tile and its gear stay on screen reading "--". */
  tank?: {
    tank_level_mm: number | null;
    tank_level_percent: number | null;
    /** Only when the primary reading is not the default mm (value may be null). */
    level_primary?: TankLevelReading;
    /** Only when configured AND its tag has a value. */
    level_secondary?: TankLevelReading;
    /**
     * The tank app's `sensor_fault` ("under_range"), only while it is set.
     * No level readings are carried alongside it.
     */
    sensor_fault?: string;
    /** The loop current (`raw_level_reading`, mA), only alongside sensor_fault. */
    raw_ma?: number;
  };
  /** A reading is present when its app is configured; null while that app
   *  has no value (sensor disconnected or out of range), so the tile and its
   *  gear stay on screen for an operator to calibrate it. */
  skid?: { skid_flow?: number | null; skid_pressure?: number | null };
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
const TEST_RUN_ENDED_BY = ["hmi", "dcs", "cloud", "deadline", "fault", "restart"] as const;

/** The wizard's payload, or undefined unless the method is Manual (HMI). */
export function collectCalibration(get: TagReader, key: string): CalibrationData | undefined {
  const method = asString(get("CalibrationMethod", key));
  if (method !== CALIBRATION_METHOD_MANUAL) return undefined;
  const result = asString(get("TestRunResult", key));
  const endedBy = asString(get("TestRunEndedBy", key));
  return {
    method,
    test_run: {
      active: get("TestRunActive", key) === true,
      remaining_s: optNum(get("TestRunRemaining_s", key)),
      rate: optNum(get("TestRunRate", key)),
      duration_s: optNum(get("TestRunDuration_s", key)),
      elapsed_s: optNum(get("TestRunElapsed_s", key)),
      nominal_rate: optNum(get("TestRunNominalRate", key)),
      result: (TEST_RUN_RESULTS as readonly string[]).includes(result ?? "")
        ? (result as TestRunData["result"])
        : null,
      ended_by: (TEST_RUN_ENDED_BY as readonly string[]).includes(endedBy ?? "")
        ? (endedBy as TestRunEndedBy)
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
    if (warning) {
      // The controller joins concurrent warnings with "; " in one tag; give
      // each its own banner row.
      const reasons = (warningReason ?? "").split("; ").filter((r) => r.trim() !== "");
      if (!reasons.length) reasons.push("Warning");
      for (const r of reasons) warnings.push({ pump: pump.name, reason: r });
    }
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
    const app = cfg.tankLevelApp;
    const fault = asString(get(TANK_SENSOR_FAULT_TAG, app));
    // In fault no level is shown, even one a host still holds from before.
    const level: TagReader = fault ? () => null : get;
    const metres = optNum(level("level_reading", app));
    const tank: NonNullable<DashboardData["tank"]> = {
      tank_level_mm: metres === null ? null : metres * 1000,
      tank_level_percent: optNum(level("level_filled_percentage", app)),
    };
    if (fault) {
      tank.sensor_fault = fault;
      const ma = optNum(get(SENSOR_TAGS.tank.loop, app));
      if (ma !== null) tank.raw_ma = ma;
    }
    // The default (primary mm, no secondary) adds nothing: the payload and
    // the card are exactly as before.
    if (cfg.tankPrimary !== DEFAULT_TANK_PRIMARY) {
      tank.level_primary = readTankLevel(level, app, cfg.tankPrimary);
    }
    if (cfg.tankSecondary) {
      const secondary = readTankLevel(level, app, cfg.tankSecondary);
      if (secondary.value !== null) tank.level_secondary = secondary;
    }
    // Kept whenever the tank app is configured: no reading (no sensor, an
    // older tank app under range, a sensor fault) reads "--", and the gear
    // (alarms, Sensor tab) stays reachable to fix it.
    data.tank = tank;
  }

  const skid: NonNullable<DashboardData["skid"]> = {};
  if (cfg.flowSensorApp) skid.skid_flow = optNum(get("value", cfg.flowSensorApp));
  if (cfg.pressureSensorApp) skid.skid_pressure = optNum(get("value", cfg.pressureSensorApp));
  if (Object.keys(skid).length) data.skid = skid;

  if (primaryKey !== null) {
    const applications = asRecord(asRecord(inputs.deploymentConfig).applications);
    const alarms = collectAlarmSettings(get, primaryKey, applications[primaryKey], cfg);
    if (alarms) data.alarm_settings = alarms;
  }

  const sensors = collectSensorSettings(
    get,
    cfg,
    data.units.pressure,
    asRecord(asRecord(inputs.deploymentConfig).applications),
  );
  if (sensors) data.sensor_settings = sensors;

  // DCS Connected off (the default): no key, so the payload is as before.
  if (cfg.dcsConnected && primaryKey !== null) data.dcs_command = collectDcsCommand(get, primaryKey);

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
    "TestRunNominalRate",
    "TestRunResult",
    "TestRunEndedBy",
    // Alarm settings readback: thresholds, then each alarm's delay.
    "SetpointTankL",
    "SetpointTankLL",
    "SetpointPressureH",
    "SetpointPressureHH",
    "SetpointFlowL",
    "SetpointFlowLL",
    "DelayTankL",
    "DelayTankLL",
    "DelayPressureH",
    "DelayPressureHH",
    "DelayFlowL",
    "DelayFlowLL",
  ];
  for (const key of cfg.controllers) {
    for (const tag of controllerTags) ids.push(`${key}.${tag}`);
  }
  if (cfg.tankLevelApp) {
    ids.push(
      `${cfg.tankLevelApp}.level_reading`,
      `${cfg.tankLevelApp}.level_filled_percentage`,
      // Claimed in case the tank app streams it; harmless if it does not.
      `${cfg.tankLevelApp}.${TANK_SENSOR_FAULT_TAG}`,
    );
    // level_volume is not a live tag on the tank app; it arrives with the
    // tag_values aggregate instead.
  }
  if (cfg.flowSensorApp) ids.push(`${cfg.flowSensorApp}.value`);
  if (cfg.pressureSensorApp) ids.push(`${cfg.pressureSensorApp}.value`);
  // Sensor tab readback (only with sensor_settings_access on): the apps'
  // operator values and the flag are live; the loop current streams only if
  // its app declares it live, else it arrives with the aggregate.
  if (cfg.sensorSettingsAccess !== "hidden") {
    for (const [app, tags] of [
      [cfg.pressureSensorApp, SENSOR_TAGS.pressure],
      [cfg.tankLevelApp, SENSOR_TAGS.tank],
    ] as const) {
      if (!app) continue;
      for (const tag of [SENSOR_ENABLED_TAG, ...tags.values, tags.loop]) ids.push(`${app}.${tag}`);
    }
  }
  // DCS command pop-up (only with dcs_connected on): the primary
  // controller's DCS result tags.
  const primary = cfg.controllers[0];
  if (cfg.dcsConnected && primary) {
    for (const tag of Object.values(DCS_COMMAND_TAGS)) ids.push(`${primary}.${tag}`);
  }
  return ids;
}
