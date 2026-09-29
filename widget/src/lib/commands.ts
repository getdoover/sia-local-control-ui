/**
 * On-screen commands: validation, the RPC the controller receives, and the
 * operator text for its answer. Port of sia-local-control-ui
 * application.py (`_check_touch_command`, `_dispatch_command`,
 * `_explain_rpc_error`).
 *
 * Wire shape. Every command is an RPC message on the device's `ui_cmds`
 * channel, exactly what pydoover's `ui_manager.call(method, value,
 * app_key=..., actor=...)` posts and what the controller's `@ui.handler`s
 * answer:
 *
 *   { type: "rpc", method, request: <value or {}>, app_key, actor? }
 *
 * The controller patches `status` onto that message (`success` + `response`,
 * or `error` + `{code, message}`); doover-js's `RpcDispatcher` (`client.rpc`)
 * posts it and waits for that status in both hosts: the cloud client through
 * the data API, the device agent's `DdaDataClient` through the local broker.
 *
 * `last_calibration_factor` has no custom handler on the controller: the
 * UI element's default handler stores the value (auto_update), so the RPC
 * lands in ui_cmds exactly as a cloud edit would, and the range is enforced
 * here.
 *
 * Pure except `sendCommand`, which only touches the injected client.
 * Unit-tested in tests/commands.test.mjs.
 */

import { CAL_FACTOR_MAX, CAL_FACTOR_MIN, optNum } from "./assembleDashboardData.ts";
import type { RpcActor } from "./host.ts";

export const UI_CMDS_CHANNEL = "ui_cmds";

export const TOUCH_COMMANDS: readonly string[] = [
  "set_pump_state",
  "set_target_rate",
  "nudge_rate",
  "reset_fault",
  "reset_vsd_fault",
  "last_calibration_factor",
  // 1min Calibration Sequence (controller calibration_method "Manual (HMI)").
  "start_test_run",
  "cancel_test_run",
];

export interface Ack {
  ok: boolean;
  code?: string;
  message?: string;
  detail?: string;
  result?: unknown;
}

/**
 * Refuse a command unless HMI Control Mode is Touch; validate numeric values.
 * Returns an error ack, or null to allow.
 */
export function checkTouchCommand(
  touchEnabled: boolean,
  cmd: string,
  value: unknown,
): Ack | null {
  if (!touchEnabled) {
    return {
      ok: false,
      code: "READ_ONLY",
      message: "On-screen control is off (HMI Control Mode).",
    };
  }
  if (!TOUCH_COMMANDS.includes(cmd)) {
    return { ok: false, code: "INVALID", message: `unknown command ${cmd}` };
  }
  if (cmd === "set_target_rate" || cmd === "last_calibration_factor") {
    const n = optNum(value);
    if (n === null) return { ok: false, code: "INVALID", message: "enter a number" };
    if (cmd === "last_calibration_factor" && (n < CAL_FACTOR_MIN || n > CAL_FACTOR_MAX)) {
      return {
        ok: false,
        code: "INVALID",
        message: `Calibration factor must be ${CAL_FACTOR_MIN} to ${CAL_FACTOR_MAX}.`,
      };
    }
  }
  if (cmd === "start_test_run") {
    const v = (value ?? {}) as { rate?: unknown; duration_s?: unknown };
    if (optNum(v.rate) === null || optNum(v.duration_s) === null) {
      return { ok: false, code: "INVALID", message: "enter a test rate and duration" };
    }
  }
  return null;
}

export interface RpcRequestBody {
  method: string;
  request: unknown;
  app_key: string;
  actor?: RpcActor;
}

/**
 * The RPC body for a command. Numbers are sent as floats (the controller's
 * set_target_rate parser is `float`); a command with no value sends `{}`,
 * as pydoover's `call(method, None)` does.
 */
export function buildRpcRequest(
  cmd: string,
  value: unknown,
  appKey: string,
  actor: RpcActor | undefined,
): RpcRequestBody {
  let request: unknown = value;
  if (cmd === "set_target_rate" || cmd === "last_calibration_factor") {
    request = optNum(value);
  }
  if (cmd === "start_test_run") {
    const v = (value ?? {}) as { rate?: unknown; duration_s?: unknown };
    request = { rate: optNum(v.rate), duration_s: optNum(v.duration_s) };
  }
  if (request === null || request === undefined) request = {};
  return {
    method: cmd,
    request,
    app_key: appKey,
    ...(actor ? { actor } : {}),
  };
}

/** `{code, message}` from whatever a failed RPC threw. */
export function rpcErrorOf(error: unknown): { code: string; message: string } {
  const e = error as {
    status?: { code?: unknown; message?: unknown };
    message?: unknown;
    name?: unknown;
    capability?: unknown;
  } | null;
  const status = e?.status;
  if (status && status.code === "error") {
    const m = status.message;
    if (m && typeof m === "object") {
      const rec = m as { code?: unknown; message?: unknown };
      return {
        code: typeof rec.code === "string" ? rec.code : "UNKNOWN",
        message: typeof rec.message === "string" ? rec.message : "",
      };
    }
    return { code: "UNKNOWN", message: typeof m === "string" ? m : "" };
  }
  const text =
    typeof e?.message === "string" ? e.message : typeof error === "string" ? error : "";
  if (/timed out|timeout/i.test(text)) return { code: "TIMEOUT", message: text };
  if (e?.name === "UnsupportedCapabilityError" || typeof e?.capability === "string") {
    return { code: "UNSUPPORTED", message: text || "this host cannot send commands" };
  }
  return { code: "ERROR", message: text || "Command failed" };
}

/**
 * Operator text for a refused command. Deliberately generic: the controller's
 * own reason text is shown as given (it already says why, e.g. the control
 * priority it enforces), prefixed with the refusal code's plain meaning only
 * where the controller sent no text. Transport failures get a fixed message.
 */
export function explainRpcError(code: string, message: string): Ack {
  if (code === "TIMEOUT") {
    return { ok: false, code, message: "No reply from the pump controller (it did not answer in time)." };
  }
  if (code === "UNSUPPORTED") {
    return { ok: false, code, message: "Commands are not available from this screen." };
  }
  const reason = message.trim();
  return {
    ok: false,
    code,
    message: reason ? `Refused: ${reason}` : `Refused by the pump controller (${code}).`,
  };
}

interface RpcClientLike {
  rpc?: {
    send: (
      channel: { agentId: string; channelName: string },
      request: RpcRequestBody,
      options?: { timeoutMs?: number; onStatus?: (status: unknown) => void },
    ) => Promise<unknown>;
  };
}

export interface SendCommandOptions {
  client: unknown;
  agentId: string | undefined;
  appKey: string | null;
  cmd: string;
  value: unknown;
  actor: RpcActor | undefined;
  timeoutMs: number;
  /** Defaults to `ui_cmds` (the pump controller); the VSD panel uses `dv-rpc`. */
  channelName?: string;
}

/**
 * Send one command and resolve to an ack. Never rejects.
 *
 * The timeout is enforced here as well as passed to the dispatcher, so an
 * older doover-js that ignores `timeoutMs` still cannot leave a button
 * pending forever.
 */
export async function sendCommand(opts: SendCommandOptions): Promise<Ack> {
  const client = opts.client as RpcClientLike | null;
  if (!opts.appKey) {
    return { ok: false, code: "NO_CONTROLLER", message: "No pump controller is configured." };
  }
  if (!opts.agentId) {
    return { ok: false, code: "NOT_READY", message: "The device is not known yet." };
  }
  if (!client?.rpc || typeof client.rpc.send !== "function") {
    return { ok: false, code: "UNSUPPORTED", message: "Commands are not available from this screen." };
  }
  const body = buildRpcRequest(opts.cmd, opts.value, opts.appKey, opts.actor);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("RPC timed out")), opts.timeoutMs + 2_000);
  });
  try {
    const result = await Promise.race([
      client.rpc.send(
        { agentId: opts.agentId, channelName: opts.channelName ?? UI_CMDS_CHANNEL },
        body,
        { timeoutMs: opts.timeoutMs },
      ),
      timeout,
    ]);
    return { ok: true, result: result ?? {} };
  } catch (error) {
    const { code, message } = rpcErrorOf(error);
    return { ok: false, code, message };
  } finally {
    clearTimeout(timer);
  }
}
