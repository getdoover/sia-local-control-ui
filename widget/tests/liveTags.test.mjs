// Live-tag helpers (ported from petronash-hmi widget/tests/liveTags.test.mjs;
// the generic parts only). The claim list itself is tested in
// assembleDashboardData.test.mjs (liveTagIds).
import test from "node:test";
import assert from "node:assert/strict";

import {
  applyLiveValues,
  collectOneShotValues,
  isLiveCapableClient,
  overlayLiveValues,
  presenceClaimBody,
  presenceClearBody,
  presenceSlotKey,
} from "../src/lib/liveTags.ts";




test("presence: slot key can never collide with the customer-site's <user>:<session> slot", () => {
  // The customer-site keys its slot `${userId}:${gatewaySessionId}`; a
  // gateway session id is a snowflake (digits). Ours carries a literal
  // prefix after the colon, so no session id can equal it.
  const key = presenceSlotKey("user-1", "abc");
  assert.equal(key, "user-1:sia-hmi-abc");
  assert.match(key.split(":")[1], /^sia-hmi-/);
  assert.doesNotMatch(key.split(":")[1], /^\d+$/);
});

test("presence: claim body is the live_tag_open shape pydoover reads", () => {
  assert.deepEqual(presenceClaimBody("user-1:sia-hmi-abc", ["a.b", "c.d"], 1234), {
    live_tag_open: { "user-1:sia-hmi-abc": { ts: 1234, tags: ["a.b", "c.d"] } },
  });
});

test("presence: clear body nulls only our slot", () => {
  assert.deepEqual(presenceClearBody("user-1:sia-hmi-abc"), {
    live_tag_open: { "user-1:sia-hmi-abc": null },
  });
});

// -- one-shot collection ----------------------------------------------------

test("collectOneShotValues: flattens the nested {app: {tag: value}} payload", () => {
  const entries = collectOneShotValues(
    { analog_level_sensor_1: { level_reading: 0.45 }, x: { y: { z: true } } },
    100,
  );
  assert.deepEqual(entries, [
    ["analog_level_sensor_1.level_reading", { value: 0.45, at: 100 }],
    ["x.y.z", { value: true, at: 100 }],
  ]);
});

test("collectOneShotValues: ignores non-object payloads", () => {
  assert.deepEqual(collectOneShotValues(null, 1), []);
  assert.deepEqual(collectOneShotValues([1, 2], 1), []);
  assert.deepEqual(collectOneShotValues("nope", 1), []);
});

test("applyLiveValues: newest wins, older frames never regress a value", () => {
  let live = applyLiveValues(new Map(), [["a.b", { value: 1, at: 10 }]]);
  live = applyLiveValues(live, [["a.b", { value: 2, at: 20 }]]);
  live = applyLiveValues(live, [["a.b", { value: 0, at: 15 }]]);
  assert.deepEqual(live.get("a.b"), { value: 2, at: 20 });
});

// -- overlay ----------------------------------------------------------------

const AGG = {
  analog_level_sensor_1: { level_reading: 0.4, level_volume: 2400 },
  "4_20ma_sensor_1": { value: 131 },
};

test("overlayLiveValues: writes newer live values over the aggregate, keeps the rest", () => {
  const live = new Map([
    ["analog_level_sensor_1.level_reading", { value: 0.9, at: 200 }],
    ["4_20ma_sensor_2.value", { value: 7, at: 210 }],
  ]);
  const out = overlayLiveValues(AGG, live, 100);
  assert.deepEqual(out.tagValues, {
    analog_level_sensor_1: { level_reading: 0.9, level_volume: 2400 },
    "4_20ma_sensor_1": { value: 131 },
    "4_20ma_sensor_2": { value: 7 },
  });
  assert.equal(out.liveAt, 210);
  assert.deepEqual(
    [...out.applied].sort(),
    ["4_20ma_sensor_2.value", "analog_level_sensor_1.level_reading"],
  );
});

test("overlayLiveValues: a live value older than the aggregate does not override", () => {
  const live = new Map([
    ["analog_level_sensor_1.level_reading", { value: 0.9, at: 50 }],
  ]);
  const out = overlayLiveValues(AGG, live, 100);
  assert.equal(out.tagValues, AGG); // same object: nothing applied
  assert.equal(out.liveAt, null);
  assert.equal(out.applied.size, 0);
});

test("overlayLiveValues: never mutates the aggregate it was given", () => {
  const before = JSON.stringify(AGG);
  overlayLiveValues(
    AGG,
    new Map([["analog_level_sensor_1.level_reading", { value: 1, at: 999 }]]),
    0,
  );
  assert.equal(JSON.stringify(AGG), before);
});

test("overlayLiveValues: works before the aggregate has loaded", () => {
  const out = overlayLiveValues(
    undefined,
    new Map([["4_20ma_sensor_1.value", { value: 3, at: 5 }]]),
    0,
  );
  assert.deepEqual(out.tagValues, { "4_20ma_sensor_1": { value: 3 } });
});

// -- tank volume (port of analog-level-sensor common_app.py _volume) ---------

// -- host detection ---------------------------------------------------------

const cloudClient = () => ({
  clientId: "doover",
  gateway: { on() {}, off() {}, getSession: () => ({ session_id: "1" }) },
  users: { getMe: async () => ({ id: "u" }) },
  aggregates: { patchAggregate: async () => ({}) },
});


test("isLiveCapableClient: true for a doover-js-shaped cloud client", () => {
  assert.equal(isLiveCapableClient(cloudClient()), true);
});

test("isLiveCapableClient: false for the DDA local host client", () => {
  // Shape mirrors dda-agent/widget/src/dda-client.ts: a `users` stub whose
  // every property is a rejecting function, a gateway with no emitter, and
  // the local clientId. Each of those alone must be enough to say no.
  const stubApi = new Proxy({}, { get: () => () => Promise.reject(new Error("unsupported")) });
  const ddaLike = {
    clientId: "local-dda-http",
    gateway: { connect() {}, disconnect() {}, subscribeToChannel() {} },
    users: stubApi,
    aggregates: { patchAggregate: async () => ({}) },
  };
  assert.equal(isLiveCapableClient(ddaLike), false);
  assert.equal(isLiveCapableClient({ ...cloudClient(), clientId: "local-dda-http" }), false);
  assert.equal(isLiveCapableClient({ ...cloudClient(), gateway: ddaLike.gateway }), false);
  assert.equal(isLiveCapableClient(undefined), false);
});
