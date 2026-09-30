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

const alarmWriteOptions = {
  agentId: "agent-1", appKey: CTRL, cmd: "high_high_pressure",
  value: 15000, actor: { name: "Local HMI" }, timeoutMs: 20,
};
function lostAlarmReply(value, error = new Error("RPC timed out")) {
  const reads = [];
  return {
    clientId: LOCAL_HOST_CLIENT_ID,
    rpc: { send: async () => { throw error; } },
    aggregates: { getAggregate: async (channel) => {
      reads.push(channel);
      return { data: { [CTRL]: { high_high_pressure: value } } };
    } },
    reads,
  };
}
test("lost alarm reply: verify the saved threshold directly on the device", async () => {
  const client = lostAlarmReply(15000);
  assert.deepEqual(await sendCommand({ ...alarmWriteOptions, client }), { ok: true, result: { verified: true } });
  assert.deepEqual(client.reads, [{ agentId: "agent-1", channelName: "ui_cmds" }]);
});
test("unchanged, missing, or wrong-controller threshold does not confirm a write", async () => {
  for (const value of [9800, null, undefined]) {
    assert.equal((await sendCommand({ ...alarmWriteOptions, client: lostAlarmReply(value) })).code, "TIMEOUT");
  }
  assert.equal((await sendCommand({ ...alarmWriteOptions, appKey: "another_controller", client: lostAlarmReply(15000) })).code, "TIMEOUT");
});
test("alarm verification never overrides an explicit controller refusal", async () => {
  const client = lostAlarmReply(15000, new DooverRpcError(
    { code: "error", message: { code: "INVALID", message: "Refused threshold" } },
    { method: "high_high_pressure", request: 15000 },
  ));
  assert.equal((await sendCommand({ ...alarmWriteOptions, client })).code, "INVALID");
  assert.equal(client.reads.length, 0);
});
test("verification never trusts cloud caches or infers motor command success", async () => {
  for (const cloud of [true, false]) {
    const client = lostAlarmReply(15000);
    if (cloud) client.clientId = "cloud";
    const opts = cloud ? alarmWriteOptions : { ...alarmWriteOptions, cmd: "set_pump_state", value: "start" };
    assert.equal((await sendCommand({ ...opts, client })).code, "TIMEOUT");
    assert.equal(client.reads.length, 0);
  }
});
test("failed or stalled verification preserves the timeout and stays bounded", async () => {
  for (const getAggregate of [async () => { throw new Error("offline"); }, () => new Promise(() => {})]) {
    const client = lostAlarmReply(15000);
    client.aggregates.getAggregate = getAggregate;
    assert.equal((await sendCommand({ ...alarmWriteOptions, client })).code, "TIMEOUT");
  }
});

function localReceiptClient(receipts) {
  const posts = [];
  let reads = 0;
  return {
    clientId: LOCAL_HOST_CLIENT_ID,
    rpc: { send: () => { throw new Error("must not subscribe for a local alarm"); } },
    messages: {
      postMessage: async (channel, body) => {
        posts.push({ channel, body });
        return { message_id: "12345" };
      },
      listMessages: async (_channel, query) => {
        assert.deepEqual(query, { limit: 1, after: "12344", before: "12346" });
        return receipts(reads++);
      },
    },
    posts,
    get reads() { return reads; },
  };
}

test("local alarm: a stored receipt confirms an early reply without waiting for timeout", async () => {
  const client = localReceiptClient(() => [{ id: "12345", data: { status: { code: "success" } } }]);
  assert.equal((await sendCommand({ ...alarmWriteOptions, client })).ok, true);
  assert.equal(client.posts.length, 1);
  assert.equal(client.posts[0].body.method, "high_high_pressure");
  assert.equal(client.posts[0].body.request, 15000);
});

test("local alarm: ignore other commands and retry receipt reads, never writes", async () => {
  const client = localReceiptClient((n) => n === 0
    ? [{ id: "12344", data: { status: { code: "success" } } }]
    : [{ id: "12345", data: { status: { code: "success" } } }]);
  assert.equal((await sendCommand({ ...alarmWriteOptions, timeoutMs: 1000, client })).ok, true);
  assert.equal(client.posts.length, 1);
  assert.equal(client.reads, 2);
});

test("local alarm: the exact command's rejection is preserved", async () => {
  const client = localReceiptClient(() => [{ id: "12345", data: { status: { code: "error", message: { code: "INVALID", message: "Threshold refused" } } } }]);
  assert.deepEqual(await sendCommand({ ...alarmWriteOptions, client }), { ok: false, code: "INVALID", message: "Threshold refused" });
});

test("local alarm: missing or stalled receipts retain the deadline and stop polling", async () => {
  for (const receipts of [() => [], () => new Promise(() => {})]) {
    const client = localReceiptClient(receipts);
    assert.equal((await sendCommand({ ...alarmWriteOptions, client })).code, "TIMEOUT");
    const reads = client.reads;
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(client.reads, reads);
    assert.equal(client.posts.length, 1);
  }
});
