import type { DashboardData } from "../lib/assembleDashboardData.ts";
import type { Ack } from "../lib/commands.ts";
import type { VsdPanelAccess, VsdPanelApi } from "../lib/vsdPanel.ts";

export interface HmiOptions {
  layout: "kiosk" | "embedded";
  /** `meta.target` ("pressure" / "tank"): a Sensor tab write for that sensor app. */
  sendCommand: (cmd: string, value: unknown, meta?: { target?: string }) => Promise<Ack>;
  hostLabel?: string;
  title?: string;
  logos?: { remoteCommand?: string; doover?: string };
  /** No-answer backstop for on-screen commands (default COMMAND_TIMEOUT_MS). */
  commandTimeoutMs?: number | (() => number);
  /** VSD commissioning RPCs; the gear also needs `setVsdPanel(access)`. */
  vsdPanel?: VsdPanelApi;
  /** Refresh button (full page reload) in the header: the local kiosk only. */
  reloadButton?: boolean;
  /** What Refresh does once confirmed (default `window.location.reload()`). */
  reloadPage?: () => void;
}

/** Cover-plate insets (kiosk layout only; ignored when embedded). */
export interface HmiDisplay {
  kioskInsetMm?: number;
  popoverInsetMm?: number;
  pxPerMm?: number;
}

export interface HmiHandle {
  /** `data` must not be changed afterwards: the next payload is compared
   * against it, and one that differs only in `timestamp` skips the render. */
  update(data: DashboardData | null, status?: { connected?: boolean }): void;
  notify(message: string, level?: "ok" | "error"): void;
  setVsdPanel(access: VsdPanelAccess): void;
  setDisplay(display: HmiDisplay): void;
  /** Alarm settings gears / writes (lib/alarmSettings.ts alarmSettingsAccess). */
  setAlarmAccess(access: { enabled: boolean; canWrite: boolean; writeBlockedReason: string }): void;
  /** Sensor tab on the Tank / Skid pressure popovers (lib/sensorSettings.ts sensorSettingsAccess). */
  setSensorAccess(access: { enabled: boolean; canWrite: boolean; writeBlockedReason: string }): void;
  /** DCS command card (payload `dcs_command`): lib/dcsNotices.ts dcsNoticesEnabled; kiosk layout only. */
  setDcsNotices(enabled: boolean): void;
  destroy(): void;
}

export declare const COMMAND_DONE: Record<string, string>;
export declare const COMMAND_TIMEOUT_MS: number;
export declare const NO_REPLY_TEXT: string;
export declare function setNodeText(el: Element | null, text: string | number): void;
export declare const CAL_TITLE: string;
export declare const RELOAD_CONFIRM_TEXT: string;
export declare const CAL_STORE_KEY: string;
export declare const RATE_CONFIRM_FRACTION: number;
export declare const VSD_POLL_MS: number;
export declare const EMPTY_VALUE: string;
export declare function formatDiagnostic(d: unknown, field: string): string;
export declare function formatParameter(p: { value: number | null; step: number | null }, value?: number | null): string;
export declare function keypadInput(text: string, key: string): string;
export declare function validateKeypadEntry(
  text: string,
  min: number | null,
  max: number | null,
): { ok: true; value: number } | { ok: false; error: string };
export declare function rateNeedsConfirm(current: number | null, value: number): boolean;
export declare function mmToPx(mm: number | null | undefined, pxPerMm: number | null | undefined): number;
export declare function scrollState(el: { scrollTop: number; scrollHeight: number; clientHeight: number }): {
  overflow: boolean;
  atTop: boolean;
  atBottom: boolean;
};
export declare function scrollPageStep(clientHeight: number): number;
export declare function samePayloadButTime(a: object | null | undefined, b: object | null | undefined): boolean;
export declare function createHmi(root: HTMLElement, opts: HmiOptions): HmiHandle;
