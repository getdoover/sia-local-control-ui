// Render efficiency: an update writes only what changed. On the kiosk
// (WebKitGTK, software compositing on a CM4) every DOM write that lands can
// cost a painted frame, so the tests marked [perf] pin the writes an update
// must NOT make; the others pin that skipping them never hides a change.

import assert from "node:assert/strict";
import test from "node:test";

import { flush, isHidden, mountHmi, pump, withFeatures } from "./helpers.mjs";
import { samePayloadButTime } from "../src/core/hmi-core.js";

const CLOCK = { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false };
const SETTINGS = {
  tank: { low: 20, low_low: 10, ll_required: false },
  pressure: { high: 0, high_high: 6894.8, units: "kPa" },
};
const run = (over = {}) => ({ active: false, remaining_s: 0, rate: null, duration_s: null, elapsed_s: null, result: null, ...over });

/** The screen measured on the device: Touch + CALIBRATE, VSD, tank with a
 * secondary reading, skid pressure only, one warning, alarm gears. */
const live = (over = {}) =>
  withFeatures({
    pumps: [pump({ state: "standby", running: false, flow_rate: 0, warning: true, warning_reason: "No flow feedback" })],
    warnings: [{ pump: "Pump", reason: "No flow feedback" }],
    calibration: { method: "Manual (HMI)", test_run: run() },
    tank: {
      tank_level_mm: 850,
      tank_level_percent: 64,
      level_primary: { value: 850, unit: "mm", decimals: 0 },
      level_secondary: { value: 412.3, unit: "L", decimals: 1 },
    },
    skid: { skid_pressure: 350.2 },
    alarm_settings: SETTINGS,
    timestamp: "2026-09-28T01:02:03.100Z",
    ...over,
  });

function mountLive() {
  const m = mountHmi();
  m.hmi.setAlarmAccess({ enabled: true, canWrite: true, writeBlockedReason: "" });
  return m;
}

/** Records as "data-id:type[.attr]" (nearest data-id above the target). */
function watch(m) {
  const obs = new m.dom.window.MutationObserver(() => {});
  obs.observe(m.root, { subtree: true, childList: true, attributes: true, characterData: true });
  return () => {
    const recs = obs.takeRecords();
    obs.disconnect();
    return recs.map((r) => {
      const t = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      const id = (t.closest("[data-id]") && t.closest("[data-id]").getAttribute("data-id")) || t.tagName;
      return `${id}:${r.type}${r.attributeName ? "." + r.attributeName : ""}`;
    });
  };
}

// --- no-op updates -----------------------------------------------------------------

test("[perf] an update identical but for its timestamp writes nothing", () => {
  const m = mountLive();
  m.render(live());
  const done = watch(m);
  m.render(live({ timestamp: "2026-09-28T01:02:03.900Z" })); // same displayed second
  assert.deepEqual(done(), []);
});

test("[perf] a real change writes only the nodes that change", () => {
  const m = mountLive();
  m.render(live());
  const done = watch(m);
  m.render(live({ skid: { skid_pressure: 350.3 }, timestamp: "2026-09-28T01:02:04.100Z" }));
  assert.deepEqual([...new Set(done())].sort(), ["last-update:childList", "skid-pressure:childList"]);
  assert.equal(m.root.querySelector('[data-id="skid-pressure"] .value').textContent, "350.3");
});

// --- banner lists ----------------------------------------------------------------------

test("[perf] banner list keeps its items while the reasons are unchanged", () => {
  const m = mountLive();
  m.render(live());
  const li = m.byId("warning-message-list").firstElementChild;
  m.render(live({ skid: { skid_pressure: 351 } }));
  assert.equal(m.byId("warning-message-list").firstElementChild, li);
  assert.ok(li.isConnected);
});

test("banner lists follow every change of their reasons", () => {
  const m = mountLive();
  const list = () => [...m.byId("warning-message-list").children].map((li) => li.textContent);
  m.render(live());
  assert.deepEqual(list(), ["Pump: No flow feedback"]);
  m.render(live({ warnings: [{ pump: "Pump", reason: "Battery low" }] }));
  assert.deepEqual(list(), ["Pump: Battery low"]);
  // Lists whose items differ but whose joined text is the same.
  m.render(live({ warnings: [{ pump: null, reason: "a\nb" }, { pump: null, reason: "c" }] }));
  m.render(live({ warnings: [{ pump: null, reason: "a" }, { pump: null, reason: "b\nc" }] }));
  assert.deepEqual(list(), ["a", "b\nc"]);
  // Nor a plain concatenation.
  m.render(live({ warnings: [{ pump: null, reason: "ab" }, { pump: null, reason: "c" }] }));
  m.render(live({ warnings: [{ pump: null, reason: "a" }, { pump: null, reason: "bc" }] }));
  assert.deepEqual(list(), ["a", "bc"]);
  m.render(live({ warnings: [{ pump: null, reason: null }] }));
  assert.deepEqual(list(), ["Warning"]);
  m.render(live({ warnings: [] }));
  assert.deepEqual(list(), []);
  assert.ok(isHidden(m.byId("warning-banner")));
  m.render(live({ faults: [{ pump: "Pump", reason: "Tank LL" }] }));
  m.render(live({ faults: [] }));
  m.render(live({ faults: [{ pump: "Pump", reason: "Tank LL" }] }));
  assert.equal(m.byId("fault-message-list").textContent, "Pump: Tank LL");
  assert.ok(!isHidden(m.byId("fault-banner")));
});

// --- Last Update clock -------------------------------------------------------------------

test("Last Update shows exactly what toLocaleTimeString gives, across the day", () => {
  const m = mountLive();
  const base = Date.UTC(2026, 8, 28, 0, 0, 0);
  const stamps = [0, 999, 1000, 59_999, 3_599_000, 43_200_000, 86_399_000, 86_399_999, 86_400_000];
  for (let i = 0; i < 400; i++) stamps.push(Math.floor((i * 86_400_000) / 400) + (i % 7) * 131);
  for (const d of stamps) {
    const iso = new Date(base + d).toISOString();
    m.render(live({ timestamp: iso }));
    assert.equal(m.byId("last-update").textContent, new Date(iso).toLocaleTimeString("en-US", CLOCK), iso);
  }
  // Backwards in time, then an unparseable stamp (keeps the last text).
  m.render(live({ timestamp: "2026-09-28T05:06:07.000Z" }));
  const shown = m.byId("last-update").textContent;
  m.render(live({ timestamp: "not a date" }));
  assert.equal(m.byId("last-update").textContent, shown);
});

test("Last Update follows a time zone change within the same second", () => {
  // The clock text is reused while the second is unchanged; a new UTC
  // offset (the device's zone set, or daylight saving) must still show.
  const saved = process.env.TZ;
  try {
    process.env.TZ = "UTC";
    const m = mountLive();
    const iso = "2026-09-28T01:02:03.100Z";
    m.render(live({ timestamp: iso }));
    assert.equal(m.byId("last-update").textContent, "01:02:03");
    process.env.TZ = "Asia/Kuwait";
    m.render(live({ timestamp: "2026-09-28T01:02:03.600Z" }));
    assert.equal(m.byId("last-update").textContent, "04:02:03");
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test("Last Update with no timestamp shows the time now", () => {
  const m = mountLive();
  const before = new Date().toLocaleTimeString("en-US", CLOCK);
  m.render(live({ timestamp: null }));
  const after = new Date().toLocaleTimeString("en-US", CLOCK);
  assert.ok([before, after].includes(m.byId("last-update").textContent));
});

// --- skipped payloads never hide a change of state -----------------------------------

test("the same payload after a null one is drawn again (connection line)", () => {
  const m = mountLive();
  m.render(live({ link_ok: false }), { connected: true });
  assert.equal(m.byId("connection-status").textContent, "● No controller");
  m.render(null, { connected: true });
  assert.equal(m.byId("connection-status").textContent, "● Connected");
  m.render(live({ link_ok: false, timestamp: "2026-09-28T01:02:05.000Z" }), { connected: true });
  assert.equal(m.byId("connection-status").textContent, "● No controller");
  assert.ok(m.byId("connection-status").classList.contains("status-warning"));
});

test("the same payload with the connection flipped is drawn again", () => {
  const m = mountLive();
  m.render(live(), { connected: true });
  m.render(live({ timestamp: "2026-09-28T01:02:04.000Z" }), { connected: false });
  assert.equal(m.byId("connection-status").textContent, "● Disconnected");
  assert.equal(m.byId("connection-status").className, "status-disconnected");
  m.render(live({ timestamp: "2026-09-28T01:02:05.000Z" }), { connected: true });
  assert.equal(m.byId("connection-status").textContent, "● Connected");
  assert.equal(m.byId("connection-status").className, "status-connected");
});

test("calibration: identical payloads still end a run on the wall-clock backstop", async () => {
  // A stale result from an earlier run is ignored until this run was seen
  // active, or its duration + 30 s has passed (hmi-core.js renderCalwizLive).
  const stale = (ts) =>
    live({
      warnings: [],
      pumps: [pump({ state: "standby", running: false, flow_rate: 0 })],
      calibration: { method: "Manual (HMI)", test_run: run({ result: "completed", elapsed_s: 60, rate: 12.5, duration_s: 60 }) },
      timestamp: ts,
    });
  const m = mountLive();
  m.render(stale("2026-09-28T01:00:00.000Z"));
  m.click("touch-cal");
  m.click("calwiz-run"); // start -> 1
  m.click("calwiz-next"); // 1 -> 2
  m.click("calwiz-field-start");
  for (const k of ["clear", "5", "0"]) m.root.querySelector(`.keypad-keys [data-key="${k}"]`).click();
  m.click("keypad-ok");
  m.click("calwiz-next"); // 2 -> 3
  m.click("calwiz-next"); // 3 -> 4
  m.click("calwiz-next"); // Start Test
  await flush();
  const page = () => m.byId("calwiz-body").getAttribute("data-page");
  assert.equal(page(), "5");
  m.render(stale("2026-09-28T01:00:01.000Z"));
  assert.equal(page(), "5", "the stale result is ignored at first");
  const realNow = Date.now;
  Date.now = () => realNow.call(Date) + 91_000;
  try {
    m.render(stale("2026-09-28T01:00:02.000Z")); // identical but for the timestamp
    assert.equal(page(), "6");
  } finally {
    Date.now = realNow;
  }
});

test("a stale wizard session is still dropped by an identical payload", async () => {
  const m = mountLive();
  m.render(live({ warnings: [], pumps: [pump({ state: "standby", running: false, flow_rate: 0 })] }));
  m.click("touch-cal");
  assert.ok(!isHidden(m.byId("calwiz")));
  m.byId("calwiz").classList.add("hidden"); // popover gone without a close
  m.render(live({ warnings: [], pumps: [pump({ state: "standby", running: false, flow_rate: 0 })], timestamp: "2026-09-28T01:02:04.000Z" }));
  assert.equal(m.hmi._hmi.cal, null);
});

test("[perf] a payload identical but for its timestamp skips the render", () => {
  const m = mountLive();
  const h = m.hmi._hmi;
  let renders = 0;
  const renderPump = h.renderPump;
  h.renderPump = (...a) => {
    renders++;
    return renderPump.apply(h, a);
  };
  m.render(live());
  m.render(live({ timestamp: "2026-09-28T01:02:05.000Z" }));
  assert.equal(renders, 1);
  assert.equal(m.byId("last-update").textContent, new Date("2026-09-28T01:02:05.000Z").toLocaleTimeString("en-US", CLOCK));
  m.render(live({ skid: { skid_pressure: 351 }, timestamp: "2026-09-28T01:02:06.000Z" }));
  assert.equal(renders, 2);
});

test("after a render that throws part-way, the last good payload renders in full", () => {
  // The failed render drew the new skid pressure before the tank threw; the
  // last good payload coming back must not take the fast path past it.
  const m = mountLive();
  const h = m.hmi._hmi;
  const pressure = () => m.root.querySelector('[data-id="skid-pressure"] .value').textContent;
  m.render(live());
  const renderTank = h.renderTank;
  h.renderTank = () => {
    h.renderTank = renderTank;
    throw new Error("renderer failed");
  };
  assert.throws(() => m.render(live({ skid: { skid_pressure: 351.5 }, timestamp: "2026-09-28T01:02:04.000Z" })), /renderer failed/);
  assert.equal(pressure(), "351.5");
  m.render(live({ timestamp: "2026-09-28T01:02:05.000Z" }));
  assert.equal(pressure(), "350.2");
});

test("an alarm cell's Saved ring stays past the feedback timer on an unchanged feed", async () => {
  // The cell's pending / ok / error look is drawn only from the write's
  // state (no button is handed to sendCommand, whose feedback timer would
  // take the ring off after 2.5 s until the next update put it back).
  const { mock } = test;
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const m = mountLive();
    const settle = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    const at = (s, over) => live({ timestamp: `2026-09-28T01:00:${String(s).padStart(2, "0")}.000Z`, ...over });
    m.render(at(0));
    m.click("tank-gear");
    m.click("alarm-cell-low_tank_level");
    for (const k of ["clear", "2", "5"]) m.root.querySelector(`.keypad-keys [data-key="${k}"]`).click();
    m.click("keypad-ok");
    m.click("confirm-ok");
    await settle();
    const row = m.byId("alarm-cell-low_tank_level");
    assert.ok(row.classList.contains("ok"));
    const readback = { alarm_settings: { ...SETTINGS, tank: { ...SETTINGS.tank, low: 25 } } };
    m.render(at(1, readback));
    mock.timers.tick(2600);
    assert.ok(row.classList.contains("ok"), "no feedback timer takes the ring off");
    m.render(at(2, readback)); // identical but for the timestamp
    assert.ok(row.classList.contains("ok"));
    assert.match(row.textContent, /Saved/);
    const done = watch(m);
    m.render(at(2, readback));
    assert.deepEqual(done(), [], "an idle update with the popover open writes nothing");
    m.hmi.destroy();
  } finally {
    mock.timers.reset();
  }
});

test("alarm access changed between identical payloads still shows and hides the gears", () => {
  const m = mountHmi();
  m.render(live());
  assert.ok(isHidden(m.byId("tank-gear")));
  m.hmi.setAlarmAccess({ enabled: true, canWrite: true, writeBlockedReason: "" });
  m.render(live({ timestamp: "2026-09-28T01:02:04.000Z" }));
  assert.ok(!isHidden(m.byId("tank-gear")));
  m.hmi.setAlarmAccess({ enabled: false, canWrite: false, writeBlockedReason: "" });
  m.render(live({ timestamp: "2026-09-28T01:02:05.000Z" }));
  assert.ok(isHidden(m.byId("tank-gear")));
});

test("samePayloadButTime: only the top-level timestamp is ignored", () => {
  const same = samePayloadButTime;
  const p = live();
  assert.ok(same(p, live({ timestamp: "2030-01-01T00:00:00.000Z" })));
  assert.ok(same(p, { ...p, timestamp: null }));
  assert.ok(!same(p, live({ skid: { skid_pressure: 350.3 } })));
  assert.ok(!same(p, live({ tank: { ...p.tank, level_primary: { value: 850, unit: "mm", decimals: 1 } } })));
  assert.ok(!same(p, live({ warnings: [] })));
  assert.ok(!same({ a: 0, timestamp: 1 }, { a: -0, timestamp: 1 }), "-0 vs 0 counts as a change (errs toward a full render)");
  assert.ok(same({ a: NaN, timestamp: 1 }, { a: NaN, timestamp: 2 }));
  assert.ok(!same({ a: undefined, timestamp: 1 }, { timestamp: 1 }), "undefined key vs missing key");
  assert.ok(!same({ a: [1, 2], timestamp: 1 }, { a: { 0: 1, 1: 2 }, timestamp: 1 }));
  assert.ok(!same({ a: null, timestamp: 1 }, { a: {}, timestamp: 1 }));
  assert.ok(!same(p, { ...p, extra: 1 }));
  assert.ok(!same({ timestamp: 1 }, { ts: 1 }));
  assert.ok(!same(null, p));
  // Payloads are plain data: other objects count as a change unless the same one.
  assert.ok(!same({ a: new Date(0), timestamp: 1 }, { a: new Date(5e12), timestamp: 2 }));
  assert.ok(!same({ a: new Map([[1, 2]]), timestamp: 1 }, { a: new Map(), timestamp: 2 }));
  assert.ok(!same({ a: new (class Reading {})(), timestamp: 1 }, { a: {}, timestamp: 2 }));
  const d = new Date(0);
  assert.ok(same({ a: d, timestamp: 1 }, { a: d, timestamp: 2 }));
  assert.ok(same({ a: Object.assign(Object.create(null), { x: 1 }), timestamp: 1 }, { a: { x: 1 }, timestamp: 2 }));
  // A cycle takes a full render instead of overflowing the stack.
  const cyc = () => {
    const o = { n: 1 };
    o.self = o;
    return { a: o, timestamp: 1 };
  };
  assert.ok(!same(cyc(), cyc()));
});

// --- element cache ---------------------------------------------------------------------------

test("rebuilt wizard nodes are found again (countdown after the page is redrawn)", async () => {
  const m = mountLive();
  const standby = { state: "standby", running: false, flow_rate: 0 };
  const cal = (tr, p = standby) => live({ warnings: [], pumps: [pump(p)], calibration: { method: "Manual (HMI)", test_run: run(tr) } });
  m.render(cal({}));
  m.click("touch-cal");
  m.click("calwiz-run");
  m.click("calwiz-next");
  m.click("calwiz-field-start");
  for (const k of ["clear", "5", "0"]) m.root.querySelector(`.keypad-keys [data-key="${k}"]`).click();
  m.click("keypad-ok");
  m.click("calwiz-next");
  m.click("calwiz-next");
  m.click("calwiz-next");
  await flush();
  const running = { state: "pumping", running: true, flow_rate: 12.1 };
  m.render(cal({ active: true, remaining_s: 50, rate: 12.5, duration_s: 60 }, running));
  const first = m.byId("calwiz-countdown");
  assert.equal(first.textContent, "50");
  m.hmi._hmi.calwizGo(5); // body redrawn: a new countdown node
  const second = m.byId("calwiz-countdown");
  assert.notEqual(second, first);
  assert.ok(!first.isConnected);
  m.render(cal({ active: true, remaining_s: 42, rate: 12.5, duration_s: 60 }, running));
  assert.equal(second.textContent, "42");
});

// --- first keypad open -------------------------------------------------------------------

test("the backspace glyph is warmed at load, hidden from assistive tech", () => {
  // Its font (layout/layout.check.mjs) must be the key's, so the kiosk's
  // font fallback for U+232B happens at load instead of in the first tap.
  const m = mountHmi();
  const warm = m.root.querySelectorAll(".glyph-warm");
  assert.equal(warm.length, 1);
  assert.equal(warm[0].getAttribute("aria-hidden"), "true");
  assert.equal(warm[0].textContent, m.root.querySelector('.keypad-keys [data-key="back"]').textContent);
  assert.equal(warm[0].textContent, "⌫");
});

// --- attribute semantics kept ----------------------------------------------------------------

test("VSD Reset keeps an empty title attribute in Touch mode", async (t) => {
  const vsdPanel = {
    diagnostics: async () => ({ ok: true, result: {} }),
    parameters: async () => ({ ok: true, result: [] }),
    write: async () => ({ ok: true }),
  };
  const m = mountHmi({ vsdPanel });
  t.after(() => m.hmi.destroy()); // stops the 2 s diagnostics poll, even on a failure
  m.hmi.setVsdPanel({ enabled: true, canWrite: true, writeBlockedReason: "" });
  m.render(live());
  m.click("vsd-gear");
  await flush();
  const b = m.byId("vsd-panel-reset");
  assert.equal(b.getAttribute("title"), "");
  assert.equal(b.disabled, false);
  m.render(live({ touch: undefined, hmi_mode: "read_only", calibration: undefined }));
  assert.equal(b.getAttribute("title"), "Reset is available in HMI Control Mode Touch");
  assert.equal(b.disabled, true);
});
