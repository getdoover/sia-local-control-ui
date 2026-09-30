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
 * The Sensor tab's writes (SENSOR_SETTING_COMMANDS) are the same RPC with
 * `app_key` = the sensor app's key: pydoover routes a ui_cmds RPC to the app
 * it names, and that app patches the status, so the reply path is the same.
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
  // Alarm settings (the controller's "Alarm Settings" ui elements). Governed
  // by alarm_settings_access, not HMI Control Mode: see checkTouchCommand.
  "low_tank_level",
  "low_low_tank_level",
  "high_pressure",
  "high_high_pressure",
  "low_flow_percent",
  "low_low_flow_percent",
  "tank_l_delay",
  "tank_ll_delay",
  "pressure_h_delay",
  "pressure_hh_delay",
  "flow_l_delay",
  "flow_ll_delay",
];

/**
 * Alarm delays (one per threshold alarm): whole seconds within the alarm's
 * range, as the controller enforces them (core/alarms.js
 * ALARM_DELAY_RANGES). Tank 1 to 600; pressure and flow 0 to 600, 0 = no
 * delay.
 */
export const ALARM_DELAY_RANGES_S: Readonly<Record<string, readonly [number, number]>> = {
  tank_l_delay: [1, 600],
  tank_ll_delay: [1, 600],
  pressure_h_delay: [0, 600],
  pressure_hh_delay: [0, 600],
  flow_l_delay: [0, 600],
  flow_ll_delay: [0, 600],
};

/**
 * Threshold and alarm delay writes: numbers, allowed by
 * alarm_settings_access on this host.
 */
export const ALARM_SETTING_COMMANDS: readonly string[] = [
  "low_tank_level",
  "low_low_tank_level",
  "high_pressure",
  "high_high_pressure",
  "low_flow_percent",
  "low_low_flow_percent",
  ...Object.keys(ALARM_DELAY_RANGES_S),
];

export const ALARM_WRITE_BLOCKED_TEXT = "Alarm settings can't be changed from this screen.";

/**
 * Sensor calibration writes (the Sensor tab): each sensor app's "Sensor
 * Calibration" elements, sent on `ui_cmds` to THAT app's key, not the pump
 * controller's (core/sensors.js). The numeric values, then the reset
 * (no value). Governed by sensor_settings_access, not HMI Control Mode.
 */
export const SENSOR_SETTING_COMMANDS: Readonly<Record<"pressure" | "tank", readonly string[]>> = {
  pressure: ["range_low", "range_high", "offset", "reset_calibration"],
  tank: ["zero_m", "span_m", "fluid_density", "reset_calibration"],
};

/** The numeric sensor writes (sent as floats, like the alarm settings). */
export const SENSOR_VALUE_COMMANDS: readonly string[] = [
  "range_low",
  "range_high",
  "offset",
  "zero_m",
  "span_m",
  "fluid_density",
];

/** The ranges each sensor app enforces on a lone value (core/sensors.js). */
const SENSOR_VALUE_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  range_low: [-1e6, 1e6],
  range_high: [-1e6, 1e6],
  offset: [-1e6, 1e6],
  zero_m: [0, 100],
  span_m: [0, 100],
  fluid_density: [500, 2500],
};

export const SENSOR_WRITE_BLOCKED_TEXT = "Sensor settings can't be changed from this screen.";

/**
 * Refuse a sensor write unless sensor settings access allows it from this
 * host (`canWrite`); the command must be one of that sensor's, and a value a
 * finite number within the app's range. Returns an error ack, or null.
 */
export function checkSensorCommand(
  canWrite: boolean,
  target: string,
  cmd: string,
  value: unknown,
): Ack | null {
  if (!canWrite) return { ok: false, code: "READ_ONLY", message: SENSOR_WRITE_BLOCKED_TEXT };
  const allowed = (SENSOR_SETTING_COMMANDS as Record<string, readonly string[]>)[target];
  if (!allowed || !allowed.includes(cmd)) {
    return { ok: false, code: "INVALID", message: `unknown sensor command ${cmd}` };
  }
  const range = SENSOR_VALUE_RANGES[cmd];
  if (!range) return null;
  const n = optNum(value);
  if (n === null) return { ok: false, code: "INVALID", message: "enter a number" };
  if (n < range[0] || n > range[1]) {
    return { ok: false, code: "INVALID", message: `Out of range (${range[0]} to ${range[1]}).` };
  }
  return null;
}

export interface Ack {
  ok: boolean;
  code?: string;
  message?: string;
  detail?: string;
  result?: unknown;
}

/**
 * Refuse a command unless HMI Control Mode is Touch; validate numeric values.
 * Alarm settings are the exception: they need `alarmWrite` (alarm settings
 * access allows changes from this host) instead of Touch.
 * Returns an error ack, or null to allow.
 */
export function checkTouchCommand(
  touchEnabled: boolean,
  cmd: string,
  value: unknown,
  alarmWrite = false,
): Ack | null {
  if (ALARM_SETTING_COMMANDS.includes(cmd)) {
    if (!alarmWrite) return { ok: false, code: "READ_ONLY", message: ALARM_WRITE_BLOCKED_TEXT };
    const n = optNum(value);
    if (n === null || n < 0) return { ok: false, code: "INVALID", message: "enter a number" };
    const delay = ALARM_DELAY_RANGES_S[cmd];
    if (delay && (!Number.isInteger(n) || n < delay[0] || n > delay[1])) {
      return {
        ok: false,
        code: "INVALID",
        message: `The delay must be whole seconds, ${delay[0]} to ${delay[1]}.`,
      };
    }
    return null;
  }
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
  if (
    cmd === "set_target_rate" ||
    cmd === "last_calibration_factor" ||
    ALARM_SETTING_COMMANDS.includes(cmd) ||
    SENSOR_VALUE_COMMANDS.includes(cmd)
  ) {
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
 * `who` names the app that answers (a sensor app for the Sensor tab).
 */
export function explainRpcError(code: string, message: string, who = "pump controller"): Ack {
  if (code === "TIMEOUT") {
    return { ok: false, code, message: `No reply from the ${who} (it did not answer in time).` };
  }
  if (code === "UNSUPPORTED") {
    return { ok: false, code, message: "Commands are not available from this screen." };
  }
  const reason = message.trim();
  return {
    ok: false,
    code,
    message: reason ? `Refused: ${reason}` : `Refused by the ${who} (${code}).`,
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
