/**
 * Sensor settings access: who sees the Sensor tab on the Skid pressure and
 * Tank gears' popovers and who may change the sensors' operator values
 * (range / offset, zero / span / density). Config `sensor_settings_access`,
 * a gate of its own with the same three options as `alarm_settings_access`:
 *
 *   Hidden (default): no Sensor tab, so existing installs are unchanged.
 *   Local only:       the tab on both hosts; changes from the local panel
 *                     only (the cloud shows the values, view only).
 *   Local and cloud:  the tab and changes on both hosts.
 *
 * The values and their rules are core/sensors.js; the writes are RPCs on
 * `ui_cmds` addressed to the SENSOR app's key (pressure_sensor_app /
 * tank_level_app from this app's config), lib/commands.ts
 * checkSensorCommand. Governed by this access, not HMI Control Mode.
 */
import type { HmiConfig, VsdCommissioning } from "./assembleDashboardData.ts";
import type { HostKind } from "./host.ts";

export type SensorGroup = "pressure" | "tank";

export interface SensorSettingsAccess {
  /** The Sensor tab (and the read-only values) is shown. */
  enabled: boolean;
  /** Operator value changes are allowed from this host. */
  canWrite: boolean;
  /** Why changes are off here ("" when they are on). */
  writeBlockedReason: string;
}

export const SENSOR_LOCAL_ONLY_TEXT = "Sensor changes are allowed from the local panel only.";

export function sensorSettingsAccess(mode: VsdCommissioning, host: HostKind): SensorSettingsAccess {
  if (mode === "hidden") return { enabled: false, canWrite: false, writeBlockedReason: "" };
  if (mode === "local_only" && host !== "local") {
    return { enabled: true, canWrite: false, writeBlockedReason: SENSOR_LOCAL_ONLY_TEXT };
  }
  return { enabled: true, canWrite: true, writeBlockedReason: "" };
}

/** Who answers a sensor write, for the operator messages. */
export const SENSOR_APP_NAMES: Readonly<Record<SensorGroup, string>> = {
  pressure: "pressure sensor app",
  tank: "tank level sensor app",
};

export function isSensorGroup(value: unknown): value is SensorGroup {
  return value === "pressure" || value === "tank";
}

/** The sensor app a Sensor tab's RPCs go to (this app's config), or null. */
export function sensorAppKey(
  cfg: Pick<HmiConfig, "pressureSensorApp" | "tankLevelApp">,
  group: SensorGroup,
): string | null {
  return group === "pressure" ? cfg.pressureSensorApp : cfg.tankLevelApp;
}
