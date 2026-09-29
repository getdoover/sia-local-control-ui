/**
 * VSD commissioning panel: who may see it, the RPCs it sends to the Techtop
 * motor controller app, and the operator text for the answers.
 *
 * The gear on the VSD tile opens a popover with live drive diagnostics and
 * the drive's parameters. Unlike every other on-screen command (which goes to
 * the pump controller on `ui_cmds`), these calls go STRAIGHT to the Techtop
 * app (`vsd_motor_app`) on its RPC channel, `dv-rpc` (pydoover
 * `rpc.DEFAULT_CHANNEL`, which the Techtop app's `@rpc_handler(...,
 * channel=RPC_CHANNEL)` listens on). The wire body is the same pydoover RPC
 * shape (`{type: "rpc", method, request, app_key, actor}`, built by
 * doover-js's RpcDispatcher) with the same actor rules as lib/host.ts.
 *
 * Reset VSD Fault in the popover is NOT sent here: it stays the pump
 * controller's `reset_vsd_fault` (lib/commands.ts), so the controller stays
 * in the loop.
 *
 * Contract (the Techtop side implements it; see widget README "VSD
 * commissioning panel"):
 *
 *   get_diagnostics {} -> {output_hz, output_current_a, motor_rpm, dc_bus_v,
 *     heatsink_c, drive_state, trip_code, trip_description, run_hours,
 *     recent_trips: [int], comms_ok}         (any field may be null)
 *   read_parameters {} -> {parameters: [{id, name, value, units, min, max,
 *     step, writable, stop_required, description}]}
 *   write_parameter {parameter, value} -> {parameter, value}  (read-back)
 *     or an RPC error: DRIVE_RUNNING | OUT_OF_RANGE | NOT_ALLOWED |
 *     READBACK_MISMATCH | COMMS_ERROR
 *
 * An older Techtop app has no get_diagnostics. pydoover drops a request for
 * a method it has no handler for WITHOUT answering, so "unknown method" shows
 * up as a timeout (or as an explicit unknown-method code from a host that
 * does answer): either way the panel falls back to `get_status` and shows
 * whatever it has.
 *
 * Pure except `vsdRpc`, which only touches the injected client.
 * Unit-tested in tests/vsdPanel.test.mjs.
 */

import { optNum, type VsdCommissioning } from "./assembleDashboardData.ts";
import { sendCommand, type Ack } from "./commands.ts";
import type { HostKind, RpcActor } from "./host.ts";

/** pydoover `rpc.DEFAULT_CHANNEL`: the Techtop app's RPC_CHANNEL. */
export const VSD_RPC_CHANNEL = "dv-rpc";

export {
  normaliseCommissioning,
  VSD_COMMISSIONING_OPTIONS,
  type VsdCommissioning,
} from "./assembleDashboardData.ts";

export const VSD_METHODS = {
  diagnostics: "get_diagnostics",
  status: "get_status",
  parameters: "read_parameters",
  write: "write_parameter",
} as const;

/** How often the open popover refreshes diagnostics. */
export const DIAGNOSTICS_POLL_MS = 2_000;
/** A diagnostics probe waits at most this long (an old app never answers). */
export const DIAGNOSTICS_TIMEOUT_MS = 5_000;

export interface VsdPanelAccess {
  /** The gear (and so diagnostics) is shown. */
  enabled: boolean;
  /** Parameter writes are allowed from this host. */
  canWrite: boolean;
  /** Why writes are off here, for the panel ("" when they are on). */
  writeBlockedReason: string;
}

export const WRITE_LOCAL_ONLY_TEXT = "Parameter changes are allowed from the local panel only.";

/**
 * Whether this host shows the gear and may write parameters.
 *
 *   Hidden (default) or no vsd_motor_app: no gear.
 *   Local only:      gear on both hosts; writes from the local panel only.
 *   Local and cloud: gear and writes on both hosts.
 *
 * The host is lib/host.ts's `detectHost`, which fails safe to "cloud".
 */
export function vsdPanelAccess(
  mode: VsdCommissioning,
  host: HostKind,
  vsdMotorApp: string | null,
): VsdPanelAccess {
  if (!vsdMotorApp || mode === "hidden") {
    return { enabled: false, canWrite: false, writeBlockedReason: "" };
  }
  if (mode === "local_only" && host !== "local") {
    return { enabled: true, canWrite: false, writeBlockedReason: WRITE_LOCAL_ONLY_TEXT };
  }
  return { enabled: true, canWrite: true, writeBlockedReason: "" };
}

// --- diagnostics ------------------------------------------------------------------

export interface VsdDiagnostics {
  output_hz: number | null;
  output_current_a: number | null;
  motor_rpm: number | null;
  dc_bus_v: number | null;
  heatsink_c: number | null;
  drive_state: string | null;
  trip_code: number | null;
  trip_description: string | null;
  run_hours: number | null;
  recent_trips: number[] | null;
  comms_ok: boolean | null;
  /** Which RPC answered: the full diagnostics or the older get_status. */
  source: "diagnostics" | "status";
}

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function first(r: Rec, ...keys: string[]): unknown {
  for (const k of keys) if (r[k] !== undefined && r[k] !== null) return r[k];
  return null;
}

/** `get_diagnostics`'s answer, every field defaulting to null. */
export function normaliseDiagnostics(result: unknown): VsdDiagnostics {
  const r = rec(result);
  const trips = Array.isArray(r.recent_trips)
    ? r.recent_trips.map(optNum).filter((n): n is number => n !== null)
    : null;
  return {
    output_hz: optNum(r.output_hz),
    output_current_a: optNum(r.output_current_a),
    motor_rpm: optNum(r.motor_rpm),
    dc_bus_v: optNum(r.dc_bus_v),
    heatsink_c: optNum(r.heatsink_c),
    drive_state: str(r.drive_state),
    trip_code: optNum(r.trip_code),
    trip_description: str(r.trip_description),
    run_hours: optNum(r.run_hours),
    recent_trips: trips,
    comms_ok: bool(r.comms_ok),
    source: "diagnostics",
  };
}

/**
 * The older `get_status` answer (techtop application.py `status_dict`) in the
 * diagnostics shape. It has no speed, heatsink, run hours or trip history.
 */
export function diagnosticsFromStatus(result: unknown): VsdDiagnostics {
  const r = rec(result);
  return {
    output_hz: optNum(first(r, "output_frequency_hz", "output_hz")),
    output_current_a: optNum(first(r, "motor_current_a", "output_current_a")),
    motor_rpm: optNum(first(r, "motor_rpm", "motor_speed_rpm")),
    dc_bus_v: optNum(first(r, "dc_bus_voltage_v", "dc_bus_v")),
    heatsink_c: optNum(first(r, "heatsink_temperature_c", "heatsink_c")),
    drive_state: str(r.drive_state),
    trip_code: optNum(r.trip_code),
    trip_description: str(r.trip_description),
    run_hours: null,
    recent_trips: null,
    comms_ok: bool(first(r, "comms_active", "comms_ok")),
    source: "status",
  };
}

const UNKNOWN_METHOD_CODES = new Set([
  "METHOD_NOT_FOUND",
  "UNKNOWN_METHOD",
  "NO_HANDLER",
  "NOT_FOUND",
  "NOT_IMPLEMENTED",
]);

/**
 * The target app does not know this method. pydoover answers nothing for an
 * unhandled method, so a timeout counts too (the probe's timeout is short).
 */
export function isUnknownMethod(code: string | undefined, message = ""): boolean {
  if (!code) return false;
  if (code === "TIMEOUT" || UNKNOWN_METHOD_CODES.has(code)) return true;
  return /unknown method|no handler|method not found/i.test(message);
}

// --- parameters -----------------------------------------------------------------

export interface VsdParameter {
  id: string;
  name: string;
  value: number | null;
  units: string;
  min: number | null;
  max: number | null;
  step: number | null;
  writable: boolean;
  stop_required: boolean;
  description: string;
}

/** `read_parameters`'s answer; entries without an id are dropped. */
export function normaliseParameters(result: unknown): VsdParameter[] {
  const list = rec(result).parameters;
  if (!Array.isArray(list)) return [];
  const out: VsdParameter[] = [];
  for (const item of list) {
    const p = rec(item);
    const id = str(p.id);
    if (!id) continue;
    const min = optNum(p.min);
    const max = optNum(p.max);
    out.push({
      id,
      name: str(p.name) ?? id,
      value: optNum(p.value),
      units: str(p.units) ?? "",
      min,
      max,
      step: optNum(p.step),
      // Only a parameter with a known range can be edited from the keypad.
      writable: p.writable === true && min !== null && max !== null,
      stop_required: p.stop_required === true,
      description: str(p.description) ?? "",
    });
  }
  return out;
}

/** Decimal places implied by a step (0.1 -> 1, 1 -> 0, 0.01 -> 2). */
export function stepDecimals(step: number | null): number {
  if (step === null || !(step > 0)) return 2;
  const text = String(step);
  if (/e-/i.test(text)) return Math.min(6, Number(text.split(/e-/i)[1]));
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : Math.min(6, text.length - dot - 1);
}

/** Refuse a value outside the parameter's range, or a read-only parameter. */
export function checkParameterValue(p: VsdParameter, value: unknown): Ack | null {
  if (!p.writable) {
    return { ok: false, code: "NOT_ALLOWED", message: explainVsdError("NOT_ALLOWED", "").message };
  }
  const n = optNum(value);
  if (n === null) return { ok: false, code: "INVALID", message: "Enter a number." };
  if ((p.min !== null && n < p.min) || (p.max !== null && n > p.max)) {
    const units = p.units ? ` ${p.units}` : "";
    return {
      ok: false,
      code: "OUT_OF_RANGE",
      message: `${p.id} must be ${p.min} to ${p.max}${units}.`,
    };
  }
  return null;
}

/** The write_parameter request, the value rounded to the parameter's step. */
export function buildWriteRequest(p: VsdParameter, value: number): { parameter: string; value: number } {
  const dp = stepDecimals(p.step);
  return { parameter: p.id, value: Number(value.toFixed(dp)) };
}

/** True when the read-back equals the requested value to the step's precision. */
export function readBackMatches(p: VsdParameter, requested: number, readBack: number | null): boolean {
  if (readBack === null) return false;
  const tol = (p.step && p.step > 0 ? p.step : 10 ** -stepDecimals(p.step)) / 2;
  return Math.abs(readBack - requested) <= tol + 1e-9;
}

// --- operator text ------------------------------------------------------------------

const VSD_ERROR_TEXT: Record<string, string> = {
  DRIVE_RUNNING: "Stop the pump first: the drive only accepts this change while stopped.",
  OUT_OF_RANGE: "The drive refused the value: it is outside the allowed range.",
  NOT_ALLOWED: "This parameter cannot be changed from the HMI.",
  READBACK_MISMATCH:
    "The drive did not keep the new value (read-back differs). Check the drive and try again.",
  COMMS_ERROR: "No answer from the VSD over Modbus. Check the drive and its comms cable.",
  TIMEOUT: "The motor controller did not answer in time.",
  UNSUPPORTED: "The VSD panel is not available from this screen.",
  NOT_READY: "The device is not known yet.",
  NO_CONTROLLER: "No VSD motor app is configured.",
  LOCAL_ONLY: WRITE_LOCAL_ONLY_TEXT,
};

/** Clear operator text for a failed VSD panel RPC. */
export function explainVsdError(code: string, message: string): Ack {
  const known = VSD_ERROR_TEXT[code];
  if (known) return { ok: false, code, message: known, detail: message || undefined };
  const reason = message.trim();
  return {
    ok: false,
    code,
    message: reason ? `Refused: ${reason}` : `Refused by the motor controller (${code}).`,
  };
}

// --- transport ------------------------------------------------------------------------

export interface VsdRpcOptions {
  client: unknown;
  agentId: string | undefined;
  /** The Techtop app key (`vsd_motor_app`). */
  appKey: string | null;
  method: string;
  request?: unknown;
  actor: RpcActor | undefined;
  timeoutMs: number;
}

/** One RPC to the Techtop app on dv-rpc. Never rejects. */
export function vsdRpc(opts: VsdRpcOptions): Promise<Ack> {
  return sendCommand({
    client: opts.client,
    agentId: opts.agentId,
    appKey: opts.appKey,
    cmd: opts.method,
    value: opts.request ?? {},
    actor: opts.actor,
    timeoutMs: opts.timeoutMs,
    channelName: VSD_RPC_CHANNEL,
  });
}

/** An ack whose `result` has a known shape. */
export type VsdAck<T> = Omit<Ack, "result"> & { result?: T };

export interface VsdPanelApi {
  diagnostics(): Promise<VsdAck<VsdDiagnostics>>;
  parameters(): Promise<VsdAck<VsdParameter[]>>;
  /** `result` carries the drive's read-back, also on READBACK_MISMATCH. */
  write(p: VsdParameter, value: number): Promise<VsdAck<{ parameter: string; value: number | null }>>;
}

export interface VsdPanelContext {
  client: unknown;
  agentId: string | undefined;
  appKey: string | null;
  actor: RpcActor | undefined;
  timeoutMs: number;
  access: VsdPanelAccess;
}

/**
 * The panel's three operations over a context getter (read on every call, so
 * the latest client / actor / access apply). `get_diagnostics` falls back to
 * `get_status` once it proves unknown, and stays there for this api.
 */
export function createVsdPanelApi(ctx: () => VsdPanelContext): VsdPanelApi {
  let useStatus = false;
  const call = (method: string, request: unknown, timeoutMs: number) => {
    const c = ctx();
    return vsdRpc({
      client: c.client,
      agentId: c.agentId,
      appKey: c.appKey,
      method,
      request,
      actor: c.actor,
      timeoutMs,
    });
  };
  // A refusal never carries a result.
  const fail = (ack: Ack): VsdAck<never> => {
    const { result: _ignored, ...refusal } = explainVsdError(ack.code ?? "ERROR", ack.message ?? "");
    return refusal;
  };

  return {
    async diagnostics() {
      const timeout = Math.min(ctx().timeoutMs, DIAGNOSTICS_TIMEOUT_MS);
      if (!useStatus) {
        const ack = await call(VSD_METHODS.diagnostics, {}, timeout);
        if (ack.ok) return { ok: true, result: normaliseDiagnostics(ack.result) };
        if (!isUnknownMethod(ack.code, ack.message)) return fail(ack);
        useStatus = true;
      }
      const ack = await call(VSD_METHODS.status, {}, timeout);
      if (ack.ok) return { ok: true, result: diagnosticsFromStatus(ack.result) };
      return fail(ack);
    },
    async parameters() {
      const ack = await call(VSD_METHODS.parameters, {}, ctx().timeoutMs);
      if (ack.ok) return { ok: true, result: normaliseParameters(ack.result) };
      return fail(ack);
    },
    async write(p, value) {
      if (!ctx().access.canWrite) return fail({ ok: false, code: "LOCAL_ONLY" });
      const refused = checkParameterValue(p, value);
      if (refused) return { ok: false, code: refused.code, message: refused.message };
      const request = buildWriteRequest(p, value);
      const ack = await call(VSD_METHODS.write, request, ctx().timeoutMs);
      if (!ack.ok) return fail(ack);
      const r = rec(ack.result);
      const readBack = optNum(r.value);
      if (!readBackMatches(p, request.value, readBack)) {
        return {
          ...explainVsdError("READBACK_MISMATCH", ""),
          result: { parameter: p.id, value: readBack },
        };
      }
      return { ok: true, result: { parameter: str(r.parameter) ?? p.id, value: readBack } };
    },
  };
}
