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
