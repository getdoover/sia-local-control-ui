import type { DashboardData } from "../lib/assembleDashboardData.ts";
import type { Ack } from "../lib/commands.ts";
import type { VsdPanelAccess, VsdPanelApi } from "../lib/vsdPanel.ts";

export interface HmiOptions {
  layout: "kiosk" | "embedded";
  sendCommand: (cmd: string, value: unknown) => Promise<Ack>;
  hostLabel?: string;
  title?: string;
  logos?: { remoteCommand?: string; doover?: string };
  /** VSD commissioning RPCs; the gear also needs `setVsdPanel(access)`. */
  vsdPanel?: VsdPanelApi;
}

export interface HmiHandle {
  update(data: DashboardData | null, status?: { connected?: boolean }): void;
  notify(message: string, level?: "ok" | "error"): void;
  setVsdPanel(access: VsdPanelAccess): void;
  destroy(): void;
}

export declare const COMMAND_DONE: Record<string, string>;
export declare const CAL_TITLE: string;
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
export declare function createHmi(root: HTMLElement, opts: HmiOptions): HmiHandle;
