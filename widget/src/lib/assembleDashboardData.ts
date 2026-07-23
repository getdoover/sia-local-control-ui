export type JsonRecord = Record<string, unknown>;

export interface PumpData {
  name: string;
  target_rate: number;
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

export interface DashboardData {
  pumps: PumpData[];
  faults: Array<{ pump: string; reason: string }>;
  warnings: Array<{ pump: string; reason: string }>;
  link_ok: boolean;
  units: { rate: string; pressure: string };
  solar?: {
    battery_voltage?: number;
    battery_percentage?: number;
    panel_power?: number;
    battery_ah?: number;
  };
  tank?: { tank_level_mm?: number; tank_level_percent?: number };
  skid?: { skid_flow?: number; skid_pressure?: number };
  selector?: { state: number };
}

interface AssembleInputs {
  appKey: string;
  deploymentConfig: JsonRecord | undefined;
  tagValues: JsonRecord | undefined;
}

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function appRef(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  const record = asRecord(value);
  for (const key of ["value", "app_key", "key", "name"]) {
    if (typeof record[key] === "string" && record[key] !== "") {
      return record[key] as string;
    }
  }
  return null;
}

function appRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(appRef).filter((value): value is string => value !== null);
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberOrZero(value: unknown): number {
  return optionalNumber(value) ?? 0;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function tagName(config: JsonRecord, key: string, fallback: string): string {
  return stringOr(config[key], fallback);
}

function average(values: number[]): number | undefined {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : undefined;
}

function sum(values: number[]): number | undefined {
  return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
}

function definedEntries<T extends JsonRecord>(record: T): T | undefined {
  return Object.keys(record).length ? record : undefined;
}

export function assembleDashboardData(inputs: AssembleInputs): DashboardData {
  const applications = asRecord(asRecord(inputs.deploymentConfig).applications);
  const config = asRecord(applications[inputs.appKey]);
  const tags = asRecord(inputs.tagValues);
  const controllerKeys = appRefs(config.pump_controllers);

  const names = {
    state: tagName(config, "tag_state", "StateString"),
    targetRate: tagName(config, "tag_target_rate", "TargetRate"),
    flowRate: tagName(config, "tag_flow_rate", "FlowRate"),
    total: tagName(config, "tag_total", "Total"),
    minRate: tagName(config, "tag_min_rate", "MinRate"),
    maxRate: tagName(config, "tag_max_rate", "MaxRate"),
    running: tagName(config, "tag_running", "Running"),
    fault: tagName(config, "tag_fault", "Fault"),
    faultReason: tagName(config, "tag_fault_reason", "FaultReason"),
    warning: tagName(config, "tag_warning", "Warning"),
    warningReason: tagName(config, "tag_warning_reason", "WarningReason"),
  };

  const pumps = controllerKeys.map<PumpData>((key, index) => {
    const values = asRecord(tags[key]);
    const fault = Boolean(values[names.fault]);
    const warning = Boolean(values[names.warning]);
    const faultReason = typeof values[names.faultReason] === "string" ? values[names.faultReason] as string : null;
    const warningReason = typeof values[names.warningReason] === "string" ? values[names.warningReason] as string : null;
    return {
      name: controllerKeys.length > 1 ? `Pump ${index + 1}` : "Pump",
      target_rate: numberOrZero(values[names.targetRate]),
      flow_rate: numberOrZero(values[names.flowRate]),
      total: numberOrZero(values[names.total]),
      min_rate: optionalNumber(values[names.minRate]),
      max_rate: optionalNumber(values[names.maxRate]),
      state: stringOr(values[names.state], "unknown"),
      running: Boolean(values[names.running]),
      fault,
      fault_reason: faultReason,
      warning,
      warning_reason: warningReason,
    };
  });

  const faults = pumps
    .filter((pump) => pump.fault)
    .map((pump) => ({ pump: pump.name, reason: pump.fault_reason || "Pump tripped" }));
  const warnings = pumps
    .filter((pump) => pump.warning)
    .map((pump) => ({ pump: pump.name, reason: pump.warning_reason || "Warning" }));

  const result: DashboardData = {
    pumps,
    faults,
    warnings,
    link_ok: pumps.length > 0 && pumps[0].state !== "unknown",
    units: {
      rate: stringOr(config.rate_units, "L/Hr"),
      pressure: stringOr(config.pressure_units, "psi"),
    },
  };

  const solarKeys = appRefs(config.solar_controllers);
  if (solarKeys.length) {
    const values = solarKeys.map((key) => asRecord(tags[key]));
    result.solar = definedEntries({
      ...(average(values.map((item) => optionalNumber(item.b_voltage)).filter((v): v is number => v !== null)) !== undefined
        ? { battery_voltage: average(values.map((item) => optionalNumber(item.b_voltage)).filter((v): v is number => v !== null)) }
        : {}),
      ...(average(values.map((item) => optionalNumber(item.b_percent)).filter((v): v is number => v !== null)) !== undefined
        ? { battery_percentage: average(values.map((item) => optionalNumber(item.b_percent)).filter((v): v is number => v !== null)) }
        : {}),
      ...(average(values.map((item) => optionalNumber(item.panel_power)).filter((v): v is number => v !== null)) !== undefined
        ? { panel_power: average(values.map((item) => optionalNumber(item.panel_power)).filter((v): v is number => v !== null)) }
        : {}),
      ...(sum(values.map((item) => optionalNumber(item.remaining_ah)).filter((v): v is number => v !== null)) !== undefined
        ? { battery_ah: sum(values.map((item) => optionalNumber(item.remaining_ah)).filter((v): v is number => v !== null)) }
        : {}),
    });
  }

  const tankKey = appRef(config.tank_level_app);
  if (tankKey) {
    const values = asRecord(tags[tankKey]);
    const level = optionalNumber(values.level_reading);
    const percent = optionalNumber(values.level_filled_percentage);
    result.tank = definedEntries({
      ...(level !== null ? { tank_level_mm: level * 1000 } : {}),
      ...(percent !== null ? { tank_level_percent: percent } : {}),
    });
  }

  const flowKey = appRef(config.flow_sensor_app);
  const pressureKey = appRef(config.pressure_sensor_app);
  const skidFlow = flowKey ? optionalNumber(asRecord(tags[flowKey]).value) : null;
  const skidPressure = pressureKey ? optionalNumber(asRecord(tags[pressureKey]).value) : null;
  result.skid = definedEntries({
    ...(skidFlow !== null ? { skid_flow: skidFlow } : {}),
    ...(skidPressure !== null ? { skid_pressure: skidPressure } : {}),
  });

  if (config.enable_selector === true) {
    result.selector = {
      state: numberOrZero(asRecord(tags[inputs.appKey]).SelectorState),
    };
  }

  return result;
}
