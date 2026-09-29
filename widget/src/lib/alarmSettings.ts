/**
 * Alarm settings access: who sees the Tank / Skid tiles' gears and who may
 * change the thresholds. Config `alarm_settings_access`, the same three
 * options as `vsd_commissioning`:
 *
 *   Hidden (default): no gears, so existing installs are unchanged.
 *   Local only:       gears on both hosts; changes from the local panel only
 *                     (the cloud shows the values, view only).
 *   Local and cloud:  gears and changes on both hosts.
 *
 * The thresholds themselves and their rules are core/alarms.js; the writes
 * are controller RPCs on `ui_cmds` (lib/commands.ts ALARM_SETTING_COMMANDS),
 * governed by this access rather than HMI Control Mode.
 */
import type { VsdCommissioning } from "./assembleDashboardData.ts";
import type { HostKind } from "./host.ts";

export interface AlarmSettingsAccess {
  /** The gears (and the read-only values) are shown. */
  enabled: boolean;
  /** Threshold changes are allowed from this host. */
  canWrite: boolean;
  /** Why changes are off here ("" when they are on). */
  writeBlockedReason: string;
}

export const ALARM_LOCAL_ONLY_TEXT = "Alarm changes are allowed from the local panel only.";

export function alarmSettingsAccess(mode: VsdCommissioning, host: HostKind): AlarmSettingsAccess {
  if (mode === "hidden") return { enabled: false, canWrite: false, writeBlockedReason: "" };
  if (mode === "local_only" && host !== "local") {
    return { enabled: true, canWrite: false, writeBlockedReason: ALARM_LOCAL_ONLY_TEXT };
  }
  return { enabled: true, canWrite: true, writeBlockedReason: "" };
}
