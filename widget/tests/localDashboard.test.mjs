import assert from "node:assert/strict";
import test from "node:test";
import { pollLocalDashboard } from "../src/lib/localDashboard.ts";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("local dashboard polls all three snapshots without gateway subscriptions", async () => {
  const calls = [];
  const snapshots = [];
  const stop = pollLocalDashboard({ aggregates: { getAggregate: async (id) => {
    calls.push(id);
    return { data: { channel: id.channelName } };
  } } }, "device", (data) => snapshots.push(data), () => assert.fail("unexpected failure"), 10);
  await delay(25);
  stop();
  assert.ok(snapshots.length >= 2);
  assert.deepEqual(calls.slice(0, 3).map((c) => c.channelName), ["deployment_config", "tag_values", "ui_cmds"]);
  assert.equal(snapshots[0].uiCmds.data.channel, "ui_cmds");
  const count = calls.length;
  await delay(20);
  assert.equal(calls.length, count);
});

test("slow reads never overlap cycles; stopped reads cannot update the screen", async () => {
  const resolve = [];
  const stop = pollLocalDashboard({ aggregates: { getAggregate: () => new Promise((r) => resolve.push(r)) } },
    "device", () => assert.fail("snapshot after stop"), () => assert.fail("error after stop"), 1);
  await delay(15);
  assert.equal(resolve.length, 3);
  stop();
  resolve.forEach((r) => r({ data: {} }));
  await delay(10);
  assert.equal(resolve.length, 3);
});

test("a failed read reports disconnection and polling recovers", async () => {
  let fail = true;
  let errors = 0;
  let snapshots = 0;
  const stop = pollLocalDashboard({ aggregates: { getAggregate: async () => {
    if (fail) throw Error("offline");
    return { data: {} };
  } } }, "device", () => snapshots++, () => errors++, 5);
  await delay(10);
  fail = false;
  await delay(20);
  stop();
  assert.ok(errors > 0);
  assert.ok(snapshots > 0);
});

test("a failing read is logged once per distinct failure, with the channel and the stack, and once on recovery", async () => {
  const logs = [];
  let mode = "boom";
  const stop = pollLocalDashboard({ aggregates: { getAggregate: async ({ channelName }) => {
    if (mode === "ok") return { data: {} };
    if (channelName === "tag_values") throw new TypeError(mode);
    return { data: {} };
  } } }, "device", () => {}, () => {}, 2, (m) => logs.push(m));
  await delay(15);
  mode = "worse";
  await delay(15);
  mode = "ok";
  await delay(15);
  stop();
  assert.equal(logs.length, 3, logs.join("\n"));
  assert.match(logs[0], /^Local dashboard: read failed \(poll 1\), showing Disconnected: tag_values: TypeError: boom/);
  assert.match(logs[0], /localDashboard\.test\.mjs/); // the stack came through
  assert.match(logs[1], /read failed \(poll \d+\).*tag_values: TypeError: worse/);
  assert.match(logs[2], /^Local dashboard: reads recovered after \d+ failed polls$/);
});

test("a non-Error failure is still described", async () => {
  const logs = [];
  const stop = pollLocalDashboard({ aggregates: { getAggregate: async () => { throw { code: 13, detail: "x" }; } } },
    "device", () => {}, () => {}, 2, (m) => logs.push(m));
  await delay(10);
  stop();
  assert.equal(logs.length, 1);
  assert.match(logs[0], /deployment_config: \{"code":13,"detail":"x"\}/);
});

test("deployment_config is read on its own slower clock and the same object is reused between reads", async () => {
  const calls = [];
  const snapshots = [];
  let clock = 0;
  const stop = pollLocalDashboard({ aggregates: { getAggregate: async ({ channelName }) => {
    calls.push(channelName);
    return { data: { channel: channelName, n: calls.length } };
  } } }, "device", (s) => snapshots.push(s), () => assert.fail("unexpected failure"), 2, () => {}, 100, () => clock);
  await delay(15);
  assert.equal(calls.filter((c) => c === "deployment_config").length, 1, "one config read while it is fresh");
  assert.ok(calls.filter((c) => c === "tag_values").length >= 3, "tag_values every poll");
  assert.ok(snapshots.length >= 3);
  assert.equal(snapshots[0].deploymentConfig, snapshots.at(-1).deploymentConfig, "same object reused");
  clock = 100; // the config is now stale
  await delay(10);
  assert.equal(calls.filter((c) => c === "deployment_config").length, 2, "re-read once stale");
  stop();
});

test("after a failed cycle the next successful cycle re-reads deployment_config", async () => {
  const calls = [];
  let fail = false;
  const stop = pollLocalDashboard({ aggregates: { getAggregate: async ({ channelName }) => {
    calls.push(channelName);
    if (fail && channelName === "tag_values") throw new Error("offline");
    return { data: {} };
  } } }, "device", () => {}, () => {}, 2, () => {}, 100_000, () => 0);
  await delay(10);
  assert.equal(calls.filter((c) => c === "deployment_config").length, 1);
  fail = true;
  await delay(10);
  fail = false;
  await delay(10);
  stop();
  assert.ok(calls.filter((c) => c === "deployment_config").length >= 2, "re-read after the failure");
});
