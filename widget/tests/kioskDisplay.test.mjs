// Kiosk display: the cover-plate insets (kiosk_inset_mm, popover_inset_mm,
// kiosk_px_per_mm) from config to the render core, and the scroll areas'
// up / down buttons that replace scrollbars. Layout (pixels on screen) is
// checked in a real browser by layout/layout.check.mjs.
import assert from "node:assert/strict";
import test from "node:test";

import { mmToPx, scrollPageStep, scrollState } from "../src/core/hmi-core.js";
import { DEFAULT_KIOSK_PX_PER_MM, resolveConfig } from "../src/lib/assembleDashboardData.ts";
import { deployment, flush, isHidden, mountHmi, pump, touchPayload, withFeatures } from "./helpers.mjs";

const APP = "sia_local_control_ui_1";

// --- config -------------------------------------------------------------------

test("insets default to none, so existing installs are unchanged", () => {
  const cfg = resolveConfig(APP, deployment({}, APP));
  assert.equal(cfg.kioskInsetMm, 0);
  assert.equal(cfg.popoverInsetMm, 0);
  assert.equal(cfg.kioskPxPerMm, DEFAULT_KIOSK_PX_PER_MM);
});

test("px/mm default is the J5261 Xenarc 892 at 1024x600 (177.6 x 100.4 mm active)", () => {
  assert.equal(DEFAULT_KIOSK_PX_PER_MM, 5.8);
  assert.ok(Math.abs(1024 / 177.6 - DEFAULT_KIOSK_PX_PER_MM) < 0.05);
  assert.ok(Math.abs(600 / 100.4 - DEFAULT_KIOSK_PX_PER_MM) < 0.2);
});

test("insets read from config, clamped; a bad px/mm falls back to the default", () => {
  const cfg = resolveConfig(
    APP,
    deployment({ kiosk_inset_mm: 2, popover_inset_mm: "10", kiosk_px_per_mm: 6.2 }, APP),
  );
  assert.equal(cfg.kioskInsetMm, 2);
  assert.equal(cfg.popoverInsetMm, 10);
  assert.equal(cfg.kioskPxPerMm, 6.2);
  const bad = resolveConfig(
    APP,
    deployment({ kiosk_inset_mm: -3, popover_inset_mm: 999, kiosk_px_per_mm: 0 }, APP),
  );
  assert.equal(bad.kioskInsetMm, 0);
  assert.equal(bad.popoverInsetMm, 40);
  assert.equal(bad.kioskPxPerMm, DEFAULT_KIOSK_PX_PER_MM);
});

test("mmToPx", () => {
  assert.equal(mmToPx(2, 5.8), 11.6);
  assert.equal(mmToPx(10, 5.8), 58);
  assert.equal(mmToPx(0, 5.8), 0);
  assert.equal(mmToPx(2, 0), 0);
  assert.equal(mmToPx(null, 5.8), 0);
  assert.equal(mmToPx("x", 5.8), 0);
  assert.equal(mmToPx(-1, 5.8), 0);
});

// --- render core ----------------------------------------------------------------

test("kiosk: setDisplay sets the inset variables the stylesheet pads with", () => {
  const m = mountHmi({ layout: "kiosk" });
  m.render(touchPayload());
  m.hmi.setDisplay({ kioskInsetMm: 2, popoverInsetMm: 10, pxPerMm: 5.8 });
  assert.equal(m.root.style.getPropertyValue("--hmi-kiosk-inset"), "11.6px");
  assert.equal(m.root.style.getPropertyValue("--hmi-popover-inset"), "58px");
  m.hmi.setDisplay({ kioskInsetMm: 0, popoverInsetMm: 0, pxPerMm: 5.8 });
  assert.equal(m.root.style.getPropertyValue("--hmi-kiosk-inset"), "0px");
});

test("embedded (cloud): the insets are ignored", () => {
  const m = mountHmi({ layout: "embedded" });
  m.render(touchPayload());
  m.hmi.setDisplay({ kioskInsetMm: 2, popoverInsetMm: 10, pxPerMm: 5.8 });
  assert.equal(m.root.style.getPropertyValue("--hmi-kiosk-inset"), "");
  assert.equal(m.root.style.getPropertyValue("--hmi-popover-inset"), "");
});

test("wizard page 1: manual entry is a full key, not a link", () => {
  const m = mountHmi();
  m.render(
    touchPayload({
      pumps: [pump({ state: "standby", running: false })],
      calibration: { method: "Manual (HMI)", test_run: { active: false, result: null } },
    }),
  );
  m.click("touch-cal");
  const b = m.byId("calwiz-manual");
  assert.equal(b.tagName, "BUTTON");
  assert.ok(b.classList.contains("key"));
  assert.equal(b.textContent, "Enter calibration factor manually");
});

// --- scroll buttons -------------------------------------------------------------

test("scrollState / scrollPageStep", () => {
  assert.deepEqual(scrollState({ scrollTop: 0, scrollHeight: 300, clientHeight: 300 }), {
    overflow: false,
    atTop: true,
    atBottom: true,
  });
  assert.deepEqual(scrollState({ scrollTop: 0, scrollHeight: 1000, clientHeight: 300 }), {
    overflow: true,
    atTop: true,
    atBottom: false,
  });
  assert.deepEqual(scrollState({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 }), {
    overflow: true,
    atTop: false,
    atBottom: true,
  });
  assert.equal(scrollPageStep(300), 255);
  assert.equal(scrollPageStep(10), 40);
});

const PARAMS = Array.from({ length: 12 }, (_, i) => ({
  id: `P-${String(i + 1).padStart(2, "0")}`,
  name: `Parameter ${i + 1}`,
  value: i,
  units: "",
  min: 0,
  max: 100,
  step: 1,
  writable: true,
  stop_required: false,
}));

// Every panel mounted here is destroyed after its test (stops the poll).
const mounted = [];
test.afterEach(() => {
  while (mounted.length) mounted.pop().hmi.destroy();
});

async function openPanel() {
  const panel = {
    diagnostics: () => Promise.resolve({ ok: true, result: { output_hz: 40, comms_ok: true } }),
    parameters: () => Promise.resolve({ ok: true, result: PARAMS }),
    write: () => Promise.resolve({ ok: true, result: {} }),
  };
  const m = mountHmi({ vsdPanel: panel });
  mounted.push(m);
  m.render(withFeatures());
  m.hmi.setVsdPanel({ enabled: true, canWrite: true, writeBlockedReason: "" });
  m.click("vsd-gear");
  await flush();
  return m;
}

/** jsdom does no layout: give the list a size and a real scrollTop. */
function sizeList(m, scrollHeight, clientHeight) {
  const list = m.byId("vsd-params");
  let top = 0;
  Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(list, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(list, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v) => {
      top = Math.max(0, Math.min(scrollHeight - clientHeight, v));
    },
  });
  list.dispatchEvent(new m.dom.window.Event("scroll"));
  return list;
}

test("VSD parameter list: no buttons when everything fits", async () => {
  const m = await openPanel();
  sizeList(m, 300, 300);
  assert.ok(isHidden(m.byId("vsd-params-rail")));
});

test("VSD parameter list: up / down appear on overflow, page through, and disable at the ends", async () => {
  const m = await openPanel();
  const list = sizeList(m, 1000, 300);
  const up = m.byId("vsd-params-up");
  const down = m.byId("vsd-params-down");
  assert.ok(!isHidden(m.byId("vsd-params-rail")));
  assert.equal(up.tagName, "BUTTON");
  assert.equal(up.disabled, true, "up disabled at the top");
  assert.equal(down.disabled, false);
  m.click("vsd-params-down");
  assert.equal(list.scrollTop, 255, "about one visible page");
  assert.equal(up.disabled, false);
  m.click("vsd-params-down");
  m.click("vsd-params-down");
  assert.equal(list.scrollTop, 700);
  assert.equal(down.disabled, true, "down disabled at the bottom");
  m.click("vsd-params-up");
  assert.equal(list.scrollTop, 445);
  assert.equal(down.disabled, false);
  // Touch-drag still scrolls; the buttons follow it.
  list.scrollTop = 0;
  list.dispatchEvent(new m.dom.window.Event("scroll"));
  assert.equal(up.disabled, true);
});

test("VSD parameter list: reopening starts at the top", async () => {
  const m = await openPanel();
  const list = sizeList(m, 1000, 300);
  m.click("vsd-params-down");
  m.click("vsd-panel-close");
  m.click("vsd-gear");
  await flush();
  assert.equal(list.scrollTop, 0);
  assert.equal(m.byId("vsd-params-up").disabled, true);
});
