// Render cadence (src/lib/renderCadence.ts): at most one render per window,
// leading edge, newest payload wins, connection changes render at once.
import test from "node:test";
import assert from "node:assert/strict";

import { createRenderScheduler, RENDER_CADENCE_MS } from "../src/lib/renderCadence.ts";

// A fake clock with its own timer queue, so every test is deterministic.
function fakeTime() {
  let t = 0;
  const timers = new Map();
  let seq = 0;
  return {
    now: () => t,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
    pending: () => timers.size,
  };
}

function harness(cadenceMs = 100) {
  const time = fakeTime();
  const renders = [];
  const s = createRenderScheduler({
    render: (data, status) => renders.push({ data, status, at: time.now() }),
    cadenceMs,
    now: time.now,
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
  });
  return { time, renders, s };
}

const ok = { connected: true };

test("the default cadence is two frames a second", () => {
  assert.equal(RENDER_CADENCE_MS, 500);
});

test("the first payload renders at once (leading edge)", () => {
  const { renders, s } = harness();
  s.push("a", ok);
  assert.deepEqual(renders.map((r) => r.data), ["a"]);
});

test("payloads inside the window wait for it to close, newest wins", () => {
  const { time, renders, s } = harness(100);
  s.push("a", ok);
  time.advance(10);
  s.push("b", ok);
  time.advance(10);
  s.push("c", ok);
  assert.deepEqual(renders.map((r) => r.data), ["a"], "nothing inside the window");
  time.advance(80);
  assert.deepEqual(renders.map((r) => [r.data, r.at]), [["a", 0], ["c", 100]]);
  assert.equal(time.pending(), 0, "no timer left behind");
});

test("a payload after a quiet spell renders immediately", () => {
  const { time, renders, s } = harness(100);
  s.push("a", ok);
  time.advance(250);
  s.push("b", ok);
  assert.deepEqual(renders.map((r) => [r.data, r.at]), [["a", 0], ["b", 250]]);
});

test("a steady 6/s feed renders once per window with the latest snapshot", () => {
  const { time, renders, s } = harness(500);
  for (let i = 0; i < 30; i++) {
    s.push(i, ok);
    time.advance(1000 / 6);
  }
  time.advance(500);
  // 5 s of feed at 2 frames/s: about 10 renders, never two inside a window.
  assert.ok(renders.length >= 10 && renders.length <= 11, `${renders.length} renders`);
  for (let i = 1; i < renders.length; i++) {
    assert.ok(renders[i].at - renders[i - 1].at >= 500, "renders are at least a window apart");
  }
  assert.equal(renders.at(-1).data, 29, "the last snapshot is the one shown");
});

test("a connection change renders at once, even inside the window", () => {
  const { time, renders, s } = harness(100);
  s.push("a", { connected: true });
  time.advance(10);
  s.push("b", { connected: false });
  assert.deepEqual(renders.map((r) => [r.data, r.status.connected]), [["a", true], ["b", false]]);
  time.advance(10);
  s.push("c", { connected: true });
  assert.equal(renders.at(-1).data, "c", "reconnecting also renders at once");
  time.advance(200);
  assert.equal(renders.length, 3, "the cancelled window timer does not fire a stale render");
});

test("an unchanged connection inside the window is not treated as a change", () => {
  const { time, renders, s } = harness(100);
  s.push("a", { connected: false });
  time.advance(10);
  s.push("b", { connected: false });
  assert.equal(renders.length, 1);
  time.advance(90);
  assert.equal(renders.length, 2);
});

test("a null payload (no data yet) goes through the same path", () => {
  const { renders, s } = harness();
  s.push(null, ok);
  assert.deepEqual(renders.map((r) => r.data), [null]);
});

test("dispose drops the pending payload and its timer", () => {
  const { time, renders, s } = harness(100);
  s.push("a", ok);
  time.advance(10);
  s.push("b", ok);
  s.dispose();
  time.advance(200);
  assert.deepEqual(renders.map((r) => r.data), ["a"]);
  assert.equal(time.pending(), 0);
});

test("the real clock and timers are used by default", async () => {
  const renders = [];
  const s = createRenderScheduler({ render: (d) => renders.push(d), cadenceMs: 20 });
  s.push("a", ok);
  s.push("b", ok);
  assert.deepEqual(renders, ["a"]);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(renders, ["a", "b"]);
  s.dispose();
});
