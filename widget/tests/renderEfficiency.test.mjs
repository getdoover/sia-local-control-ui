// Render efficiency: an update writes only what changed. On the kiosk
// (WebKitGTK, software compositing on a CM4) every DOM write that lands can
// cost a painted frame, so the tests marked [perf] pin the writes an update
// must NOT make; the others pin that skipping them never hides a change.

import assert from "node:assert/strict";
import test from "node:test";

import { flush, isHidden, mountHmi, pump, withFeatures } from "./helpers.mjs";

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

// --- element cache ---------------------------------------------------------------------------

test("rebuilt wizard nodes are found again (countdown after the page is redrawn)", async () => {
  const m = mountLive();
  const standby = { state: "standby", running: false, flow_rate: 0 };
  const cal = (tr, p = standby) => live({ warnings: [], pumps: [pump(p)], calibration: { method: "Manual (HMI)", test_run: run(tr) } });
  m.render(cal({}));
  m.click("touch-cal");
  m.click("calwiz-next");
  m.click("calwiz-field-start");
  for (const k of ["clear", "5", "0", "0"]) m.root.querySelector(`.keypad-keys [data-key="${k}"]`).click();
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

// --- attribute semantics kept ----------------------------------------------------------------

test("VSD Reset keeps an empty title attribute in Touch mode", async () => {
  const vsdPanel = {
    diagnostics: async () => ({ ok: true, result: {} }),
    parameters: async () => ({ ok: true, result: [] }),
    write: async () => ({ ok: true }),
  };
  const m = mountHmi({ vsdPanel });
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
  m.hmi.destroy(); // stops the 2 s diagnostics poll
});
