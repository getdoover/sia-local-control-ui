// Command path: Touch-mode gating and validation, the RPC the controller
// receives (through doover-js's real RpcDispatcher, as both hosts use), and
// the operator text for its answers. Ported from sia-local-control-ui
// tests/test_hmi_control_mode.py and test_controller_features.py.
import assert from "node:assert/strict";
import test from "node:test";

import { DooverRpcError, UnsupportedCapabilityError } from "doover-js";

import {
  buildRpcRequest,
  checkTouchCommand,
  explainRpcError,
  rpcErrorOf,
  sendCommand,
  TOUCH_COMMANDS,
  ALARM_SETTING_COMMANDS,
} from "../src/lib/commands.ts";
import { detectHost, LOCAL_HOST_CLIENT_ID, resolveActor } from "../src/lib/host.ts";
import { CTRL, DDA_CAPABILITIES, fakeClient, flush } from "./helpers.mjs";

const TOUCH_CASES = [
  ["set_pump_state", "start"],
  ["set_pump_state", "stop"],
  ["nudge_rate", "+1"],
  ["nudge_rate", "-1"],
  ["set_target_rate", 14],
  ["reset_fault", null],
  ["reset_vsd_fault", null],
  ["last_calibration_factor", 1.05],
];

// --- gating + validation --------------------------------------------------------

for (const [cmd, value] of TOUCH_CASES) {
  test(`read only refuses ${cmd}(${JSON.stringify(value)})`, () => {
    const ack = checkTouchCommand(false, cmd, value);
    assert.equal(ack.ok, false);
    assert.equal(ack.code, "READ_ONLY");
  });
  test(`touch allows ${cmd}(${JSON.stringify(value)})`, () => {
    assert.equal(checkTouchCommand(true, cmd, value), null);
  });
}

test("touch rejects bad values and unknown commands", () => {
  for (const [cmd, value] of [
    ["set_target_rate", "abc"],
    ["set_target_rate", null],
    ["last_calibration_factor", "x"],
    ["last_calibration_factor", 0.2],
    ["last_calibration_factor", 1.8],
    ["start_calibration", null],
    ["set_control_mode", "local"],
    ["reboot", null],
  ]) {
    const ack = checkTouchCommand(true, cmd, value);
    assert.equal(ack?.ok, false, `${cmd}(${value})`);
    assert.equal(ack.code, "INVALID");
  }
  assert.equal(checkTouchCommand(true, "last_calibration_factor", 0.3), null);
  assert.equal(checkTouchCommand(true, "last_calibration_factor", 1.7), null);
});

test("the touch command list is exactly the controller contract", () => {
  assert.deepEqual([...TOUCH_COMMANDS].sort(), [
    "cancel_test_run",
    "high_high_pressure",
    "high_pressure",
    "last_calibration_factor",
    "low_low_tank_level",
    "low_tank_level",
    "nudge_rate",
    "reset_fault",
    "reset_vsd_fault",
    "set_pump_state",
    "set_target_rate",
    "start_test_run",
    "tank_level_timeout",
  ]);
});

test("start_test_run needs a numeric rate and duration; cancel needs nothing", () => {
  assert.equal(checkTouchCommand(true, "start_test_run", { rate: 12.5, duration_s: 60 }), null);
  assert.equal(checkTouchCommand(true, "start_test_run", { rate: "12.5", duration_s: "60" }), null);
  for (const bad of [null, {}, { rate: 12.5 }, { rate: "x", duration_s: 60 }]) {
    assert.equal(checkTouchCommand(true, "start_test_run", bad)?.code, "INVALID", JSON.stringify(bad));
  }
  assert.equal(checkTouchCommand(true, "cancel_test_run", null), null);
  assert.equal(checkTouchCommand(false, "start_test_run", { rate: 1, duration_s: 60 })?.code, "READ_ONLY");
  assert.equal(checkTouchCommand(false, "cancel_test_run", null)?.code, "READ_ONLY");
});

test("test run RPC bodies: {rate, duration_s} as numbers, cancel sends {}", () => {
  const actor = { name: "Local HMI" };
  assert.deepEqual(buildRpcRequest("start_test_run", { rate: "12.5", duration_s: 60 }, CTRL, actor), {
    method: "start_test_run",
    request: { rate: 12.5, duration_s: 60 },
    app_key: CTRL,
    actor,
  });
  assert.deepEqual(buildRpcRequest("cancel_test_run", null, CTRL, actor).request, {});
});

// --- RPC body -----------------------------------------------------------------------

test("RPC bodies match pydoover ui_manager.call(method, value, app_key, actor)", () => {
  const actor = { name: "Local HMI" };
  assert.deepEqual(buildRpcRequest("set_pump_state", "start", CTRL, actor), {
    method: "set_pump_state",
    request: "start",
    app_key: CTRL,
    actor,
  });
  assert.deepEqual(buildRpcRequest("nudge_rate", "+1", CTRL, actor).request, "+1");
  assert.deepEqual(buildRpcRequest("set_target_rate", "14.5", CTRL, actor).request, 14.5);
  assert.deepEqual(buildRpcRequest("last_calibration_factor", 1.05, CTRL, actor).request, 1.05);
  // A command with no value sends {}, as call(method, None) does.
  assert.deepEqual(buildRpcRequest("reset_fault", null, CTRL, actor).request, {});
  assert.deepEqual(buildRpcRequest("reset_vsd_fault", undefined, CTRL, actor).request, {});
  // No actor -> no actor key at all.
  assert.ok(!("actor" in buildRpcRequest("reset_fault", null, CTRL, undefined)));
});

// --- end to end: host -> actor -> dispatcher -> ui_cmds message ------------------

async function roundTrip(client, user, cmd, value, answer) {
  const host = detectHost(client).kind;
  const actor = resolveActor(host, user);
  const pending = sendCommand({ client, agentId: "agent-1", appKey: CTRL, cmd, value, actor, timeoutMs: 5000 });
  await flush();
  const posted = client.posted[client.posted.length - 1];
  client.respond(...answer);
  return { host, posted, ack: await pending };
}

test("local host: Start posts the HMI actor on ui_cmds via the local dispatcher", async () => {
  const client = fakeClient({ clientId: LOCAL_HOST_CLIENT_ID, capabilities: DDA_CAPABILITIES });
  const { host, posted, ack } = await roundTrip(client, null, "set_pump_state", "start", [
    { code: "success" },
    { state: "pumping" },
  ]);
  assert.equal(host, "local");
  assert.equal(posted.agentId, "agent-1");
  assert.equal(posted.channelName, "ui_cmds");
  assert.deepEqual(posted.data, {
    type: "rpc",
    method: "set_pump_state",
    request: "start",
    app_key: CTRL,
    actor: { name: "Local HMI" },
  });
  assert.deepEqual(ack, { ok: true, result: { state: "pumping" } });
});

test("cloud host: Start posts the cloud user's actor, never Local HMI", async () => {
  const client = fakeClient({ clientId: "cloud", capabilities: [...DDA_CAPABILITIES, "users.me"] });
  const user = { id: "42", name: "Jane", email: "jane@example.com" };
  const { host, posted } = await roundTrip(client, user, "set_pump_state", "start", [{ code: "success" }]);
  assert.equal(host, "cloud");
  assert.deepEqual(posted.data.actor, user);
  assert.notEqual(posted.data.actor.name, "Local HMI");
});

test("cloud host with no user: the RPC carries no actor", async () => {
  const client = fakeClient({ clientId: "cloud", capabilities: [...DDA_CAPABILITIES, "users.me"] });
  const { posted } = await roundTrip(client, null, "nudge_rate", "+1", [{ code: "success" }]);
  assert.ok(!("actor" in posted.data));
});

test("denial: REMOTE_DENIED comes back as an error ack with its code", async () => {
  const client = fakeClient({ clientId: "cloud", capabilities: [...DDA_CAPABILITIES, "users.me"] });
  const { ack } = await roundTrip(client, { id: "1", name: "J" }, "set_pump_state", "start", [
    {
      code: "error",
      message: { code: "REMOTE_DENIED", message: "cloud may not start the pump while the control mode is dcs" },
    },
  ]);
  assert.equal(ack.ok, false);
  assert.equal(ack.code, "REMOTE_DENIED");
  assert.match(ack.message, /control mode is dcs/);
});

test("send guards: no controller, no agent, a host that cannot send", async () => {
  const base = { agentId: "a", appKey: CTRL, cmd: "reset_fault", value: null, actor: undefined, timeoutMs: 100 };
  assert.equal((await sendCommand({ ...base, client: fakeClient(), appKey: null })).code, "NO_CONTROLLER");
  assert.equal((await sendCommand({ ...base, client: fakeClient(), agentId: undefined })).code, "NOT_READY");
  assert.equal((await sendCommand({ ...base, client: {} })).code, "UNSUPPORTED");
});

test("a controller that never answers times out instead of hanging", async () => {
  const client = fakeClient({ clientId: LOCAL_HOST_CLIENT_ID, capabilities: DDA_CAPABILITIES });
  const ack = await sendCommand({
    client,
    agentId: "a",
    appKey: CTRL,
    cmd: "set_pump_state",
    value: "stop",
    actor: { name: "Local HMI" },
    timeoutMs: 20,
  });
  assert.equal(ack.ok, false);
  assert.equal(ack.code, "TIMEOUT");
});

// --- error mapping + operator text ----------------------------------------------------

test("rpcErrorOf reads DooverRpcError's {code, message}", () => {
  const err = new DooverRpcError(
    { code: "error", message: { code: "NOT_CLEARABLE", message: "Tank level low-low" } },
    { method: "reset_fault", request: {} },
  );
  assert.deepEqual(rpcErrorOf(err), { code: "NOT_CLEARABLE", message: "Tank level low-low" });
  assert.deepEqual(rpcErrorOf(new Error("RPC timed out")).code, "TIMEOUT");
  assert.deepEqual(rpcErrorOf(new UnsupportedCapabilityError("rpc.send", "local:x")).code, "UNSUPPORTED");
  assert.deepEqual(rpcErrorOf("weird").code, "ERROR");
});

test("refusals show the controller's own reason, generically", () => {
  assert.deepEqual(
    explainRpcError("REMOTE_DENIED", "cloud may not start the pump while the control mode is dcs"),
    {
      ok: false,
      code: "REMOTE_DENIED",
      message: "Refused: cloud may not start the pump while the control mode is dcs",
    },
  );
  assert.equal(explainRpcError("NOT_TRIPPED", "the VSD is not tripped").message, "Refused: the VSD is not tripped");
  assert.equal(explainRpcError("FAULTED", "pump tripped").message, "Refused: pump tripped");
  assert.equal(explainRpcError("NOT_CLEARABLE", "").message, "Refused by the pump controller (NOT_CLEARABLE).");
  assert.equal(explainRpcError("TIMEOUT", "").message, "No reply from the pump controller (it did not answer in time).");
  assert.equal(explainRpcError("UNSUPPORTED", "").message, "Commands are not available from this screen.");
});

test("local alarm settings use the shared RPC dispatcher, including its timeout", async () => {
  const opts = {
    agentId: "device", appKey: CTRL, value: 2500,
    actor: { name: "Local HMI" }, timeoutMs: 20_000,
  };
  for (const cmd of ALARM_SETTING_COMMANDS) {
    for (const timeout of [false, true]) {
      const calls = [];
      const forbidden = async () => assert.fail("alarm writes must not bypass RPC or infer success from readback");
      const client = {
        clientId: LOCAL_HOST_CLIENT_ID,
        messages: { postMessage: forbidden, listMessages: forbidden },
        aggregates: { getAggregate: forbidden },
        rpc: { send: async (...args) => {
          calls.push(args);
          if (timeout) throw new Error("RPC timed out");
          return { saved: true };
        } },
      };
      const ack = await sendCommand({ ...opts, cmd, client });
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], [
        { agentId: "device", channelName: "ui_cmds" },
        { method: cmd, request: 2500, app_key: CTRL, actor: opts.actor },
        { timeoutMs: 20_000 },
      ]);
      if (timeout) assert.equal(ack.code, "TIMEOUT");
      else assert.deepEqual(ack, { ok: true, result: { saved: true } });
    }
  }
});
