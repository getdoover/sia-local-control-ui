// Kiosk layout check: every tile fits on ONE screen with no scrolling.
//
// Loads the mock host (npm run build:mock) in headless Chromium at the three
// panel sizes and measures, for Read Only and Touch, with and without a VSD,
// a fault banner, a warning banner and a solar card:
//   - no vertical or horizontal overflow of the page or the content area;
//   - every visible tile ends above the touch bar (or the screen edge);
//   - Start / Stop / step / keypad targets are at least 56 px;
//   - Tank and VSD share a row, and Tank spans the row without a VSD;
//   - readings stay readable (value text >= 16 px, labels >= 11 px);
//   - no VSD commissioning gear unless it is configured.
//
// VSD commissioning (vsd_commissioning set): the gear is a >= 44 px target in
// the VSD tile's top-right corner, clear of every other control, and the
// popover (diagnostics + parameter list) fits the screen with no page
// scroll; only the parameter list may scroll, inside the popover.
//
// 1min Calibration Sequence (controller CalibrationMethod "Manual (HMI)"):
// the CALIBRATE tile keeps the bar's targets, and every wizard page (1 valve,
// 2 start mL + keypad, 3 test rate, 4 summary, 5 countdown, 6 final mL,
// 7 results) fits the screen with no page scroll and no scroll inside the
// popover, with >= 44 px buttons.
//
// Run: npm run test:layout   (builds the mock host first)
// Screenshots: SHOTS=<dir> npm run test:layout
// Popover screenshots: VSD_SHOTS=<dir> npm run test:layout  (vsd-panel-<w>x<h>.png)
// Wizard screenshots (1024x600): CAL_SHOTS=<dir> npm run test:layout  (calwiz-<page>.png)
// Alarm settings (alarm_settings_access): the Tank / Skid gears fit their
// tiles, and each popover (tank L / LL, pressure H / HH) and its keypad fit
// at every size, with and without the insets. Screenshots:
// ALARM_SHOTS=<dir> (alarm-tank.png, alarm-pressure.png at 1024x600 inset)
// Cover-plate insets (kiosk_inset_mm 2 + popover_inset_mm 10) at every size:
// the whole HMI inside the inset, the VSD popover (with its up / down scroll
// buttons, no scrollbar), the wizard, keypad and confirmation inside the
// popover inset. Screenshots: INSET_SHOTS=<dir> (inset-*.png at 1024x600)
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, "..", "mock-host", "dist");
const SIZES = [
  [800, 480],
  // The HDMI panel on the Doovit bench (and the Tamboran skids).
  [1024, 600],
  [1024, 768],
];
const MODES = ["Touch", "Read Only"];
const CASES = [
  { name: "running", q: "scenario=running" },
  { name: "faulted", q: "scenario=faulted" },
  { name: "faulted + warning", q: "scenario=faulted&warning=1" },
  { name: "no VSD", q: "scenario=running&vsd=0" },
  { name: "no VSD, faulted", q: "scenario=faulted&vsd=0" },
  { name: "with solar", q: "scenario=running&solar=1" },
  { name: "with solar, faulted + warning", q: "scenario=faulted&warning=1&solar=1" },
  // Tank primary L + secondary mm, beside the VSD (and with solar).
  { name: "tank L + mm", q: "scenario=running&tank=L,mm" },
  { name: "tank L + mm, faulted + warning", q: "scenario=faulted&warning=1&tank=L,mm" },
  { name: "tank L + mm, solar, faulted + warning", q: "scenario=faulted&warning=1&solar=1&tank=L,mm" },
  // CALIBRATE tile in place of CAL FACTOR (Calibration Method Manual (HMI)).
  { name: "calibrate tile", q: "scenario=standby&cal=manual" },
  { name: "calibrate tile, faulted + warning + solar", q: "scenario=faulted&warning=1&solar=1&cal=manual" },
];
const SHOTS = process.env.SHOTS;
const VSD_SHOTS = process.env.VSD_SHOTS;
const CAL_SHOTS = process.env.CAL_SHOTS;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const file = path.join(DIST, url.pathname === "/" ? "index.html" : url.pathname);
    if (!file.startsWith(DIST) || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/** Everything measured in the page, in one evaluate. */
function measure() {
  const vis = (el) => el && el.getClientRects().length > 0 && getComputedStyle(el).display !== "none";
  const rect = (el) => el.getBoundingClientRect();
  const doc = document.documentElement;
  const content = document.querySelector(".sia-hmi .dashboard-content");
  const body = document.querySelector(".sia-hmi .hmi-body");
  const bar = document.querySelector('.sia-hmi [data-id="touch-bar"]');
  const barTop = vis(bar) ? rect(bar).top : innerHeight;
  const tiles = [...document.querySelectorAll(".sia-hmi .control-section, .sia-hmi .fault-banner, .sia-hmi .warning-banner, .sia-hmi .dashboard-header")]
    .filter(vis)
    .map((el) => ({
      name: el.dataset.id || el.className.split(" ").slice(0, 2).join("."),
      top: rect(el).top,
      bottom: rect(el).bottom,
      left: rect(el).left,
      right: rect(el).right,
      width: rect(el).width,
    }));
  const targets = vis(bar)
    ? [...bar.querySelectorAll(".touch-btn")].map((b) => ({ id: b.dataset.id, h: rect(b).height, w: rect(b).width }))
    : [];
  const px = (sel) =>
    [...document.querySelectorAll(sel)].filter(vis).map((e) => parseFloat(getComputedStyle(e).fontSize));
  const tank = document.querySelector('.sia-hmi [data-id="tank-section"]');
  const vsd = document.querySelector('.sia-hmi [data-id="vsd-section"]');
  const row = tank && tank.parentElement;
  const gear = document.querySelector('.sia-hmi [data-id="vsd-gear"]');
  const sec = document.querySelector('.sia-hmi [data-id="tank-level-secondary"]');
  const card = sec && sec.closest(".control-card");
  return {
    secondary: vis(sec)
      ? {
          bottom: rect(sec).bottom,
          cardBottom: rect(card).bottom,
          overflow: card.scrollHeight - card.clientHeight,
          text: sec.textContent,
        }
      : null,
    gear: vis(gear) ? true : null,
    inner: [innerWidth, innerHeight],
    doc: [doc.scrollWidth, doc.scrollHeight],
    content: content && [content.scrollWidth, content.clientWidth, content.scrollHeight, content.clientHeight],
    body: body && [body.scrollWidth, body.clientWidth, body.scrollHeight, body.clientHeight],
    barTop,
    tiles,
    targets,
    valueFonts: px(".sia-hmi .value"),
    labelFonts: px(".sia-hmi .control-card h3"),
    tank: vis(tank) ? { top: rect(tank).top, width: rect(tank).width } : null,
    vsd: vis(vsd) ? { top: rect(vsd).top, left: rect(vsd).left } : null,
    tankRight: vis(tank) ? rect(tank).right : null,
    rowWidth: row ? rect(row).width : null,
  };
}

let server;
let browser;
let base;

test.before(async () => {
  assert.ok(fs.existsSync(path.join(DIST, "index.html")), "run npm run build:mock first");
  server = await serve();
  base = `http://127.0.0.1:${server.address().port}/index.html`;
  browser = await chromium.launch();
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  if (VSD_SHOTS) fs.mkdirSync(VSD_SHOTS, { recursive: true });
  if (CAL_SHOTS) fs.mkdirSync(CAL_SHOTS, { recursive: true });
  if (process.env.INSET_SHOTS) fs.mkdirSync(process.env.INSET_SHOTS, { recursive: true });
  if (process.env.ALARM_SHOTS) fs.mkdirSync(process.env.ALARM_SHOTS, { recursive: true });
});

test.after(async () => {
  await browser?.close();
  server?.close();
});

for (const [w, h] of SIZES) {
  for (const mode of MODES) {
    for (const c of CASES) {
      test(`${w}x${h} ${mode}, ${c.name}: fits one screen, no scroll`, async () => {
        const page = await browser.newPage({ viewport: { width: w, height: h } });
        try {
          await page.goto(`${base}?host=local&mode=${encodeURIComponent(mode)}&${c.q}`);
          await page.waitForSelector('.sia-hmi [data-id="loading-overlay"].hidden', { state: "attached" });
          await page.waitForTimeout(150);
          const m = await page.evaluate(measure);
          if (SHOTS) {
            const slug = `${w}x${h}-${mode.replace(" ", "").toLowerCase()}-${c.name.replace(/[^a-z0-9]+/gi, "-")}`;
            await page.screenshot({ path: path.join(SHOTS, `layout-${slug}.png`) });
          }
          const ctx = JSON.stringify(m);

          // No page scroll, either axis.
          assert.ok(m.doc[0] <= w, `page scrollWidth ${m.doc[0]} > ${w}`);
          assert.ok(m.doc[1] <= h, `page scrollHeight ${m.doc[1]} > ${h}`);
          // No scroll inside the kiosk body / content area.
          for (const [label, v] of [["content", m.content], ["body", m.body]]) {
            assert.ok(v[0] <= v[1] + 1, `${label} overflows horizontally: ${v}`);
            assert.ok(v[2] <= v[3] + 1, `${label} overflows vertically: ${v}`);
          }
          // Every tile fully on screen, above the touch bar.
          for (const t of m.tiles) {
            assert.ok(t.bottom <= m.barTop + 0.5, `${t.name} bottom ${t.bottom} under bar/edge ${m.barTop}`);
            assert.ok(t.right <= w + 0.5 && t.left >= -0.5, `${t.name} off screen horizontally`);
          }
          // Touch targets.
          if (mode === "Touch") {
            assert.ok(m.targets.length >= 7, ctx);
            for (const t of m.targets) assert.ok(t.h >= 56 && t.w >= 56, `${t.id} ${t.w}x${t.h} < 56px`);
          } else {
            assert.equal(m.targets.length, 0);
          }
          // Tank beside VSD on one row; alone it spans the row.
          assert.ok(m.tank, "tank tile shown");
          if (m.vsd) {
            assert.ok(Math.abs(m.tank.top - m.vsd.top) < 1, `tank/VSD not on one row: ${m.tank.top} vs ${m.vsd.top}`);
            assert.ok(m.vsd.left >= m.tankRight - 1, "VSD sits right of Tank");
          } else if (!c.q.includes("solar=1")) {
            assert.ok(m.tank.width >= m.rowWidth - 1, `tank ${m.tank.width} does not span ${m.rowWidth}`);
          }
          // Tank secondary reading: shown only when configured, inside its card.
          if (c.q.includes("tank=")) {
            assert.ok(m.secondary, "tank secondary reading shown");
            assert.equal(m.secondary.text, "850mm");
            assert.ok(m.secondary.bottom <= m.secondary.cardBottom + 0.5, `secondary spills out of its card: ${ctx}`);
            assert.ok(m.secondary.overflow <= 1, `tank level card overflows: ${ctx}`);
          } else {
            assert.equal(m.secondary, null, "no secondary reading by default");
          }
          // No commissioning configured: no gear.
          assert.equal(m.gear, null, "gear shown without vsd_commissioning");
          // Readable at arm's length.
          assert.ok(Math.min(...m.valueFonts) >= 16, `value text ${Math.min(...m.valueFonts)}px`);
          assert.ok(Math.min(...m.labelFonts) >= 11, `label text ${Math.min(...m.labelFonts)}px`);
        } finally {
          await page.close();
        }
      });
    }
  }
}

// --- VSD commissioning gear + popover ------------------------------------------

/** The gear and every other visible control, for the overlap check. */
function measureGear() {
  const vis = (el) => el && el.getClientRects().length > 0 && getComputedStyle(el).display !== "none";
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
  };
  const gear = document.querySelector('.sia-hmi [data-id="vsd-gear"]');
  const section = document.querySelector('.sia-hmi [data-id="vsd-section"]');
  const others = [...document.querySelectorAll(".sia-hmi .dashboard-container button")]
    .filter((b) => b !== gear && vis(b))
    .map((b) => ({ id: b.dataset.id, ...box(b) }));
  const heading = section && section.querySelector("h2");
  return {
    gear: vis(gear) ? box(gear) : null,
    section: section && vis(section) ? box(section) : null,
    heading: heading ? box(heading) : null,
    others,
    doc: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
  };
}

/** The open popover: overflow, clipping and target sizes. */
function measurePanel() {
  const vis = (el) => el && el.getClientRects().length > 0 && getComputedStyle(el).display !== "none";
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
  };
  const q = (id) => document.querySelector(`.sia-hmi [data-id="${id}"]`);
  const panel = q("vsd-panel-box");
  const list = q("vsd-params");
  const rows = [...document.querySelectorAll(".sia-hmi .vsd-param")].filter(vis);
  const diag = [...document.querySelectorAll(".sia-hmi .diag-cell")].filter(vis);
  return {
    open: vis(q("vsd-panel")),
    doc: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    panel: panel && { ...box(panel), sh: panel.scrollHeight, ch: panel.clientHeight, sw: panel.scrollWidth, cw: panel.clientWidth },
    list: list && { ...box(list), sh: list.scrollHeight, ch: list.clientHeight, sw: list.scrollWidth, cw: list.clientWidth },
    close: box(q("vsd-panel-close")),
    reset: box(q("vsd-panel-reset")),
    diag: diag.map((d) => ({ ...box(d), text: d.textContent, overflow: d.scrollWidth - d.clientWidth })),
    diagNumbers: [...document.querySelectorAll(".sia-hmi .diag-number")].map((e) => e.textContent),
    rows: rows.map((r) => ({ id: r.dataset.param, ...box(r), overflowX: r.scrollWidth - r.clientWidth })),
    rowCount: rows.length,
  };
}

const VSD_CASES = [
  { name: "running", q: "scenario=running" },
  { name: "faulted + warning + solar", q: "scenario=faulted&warning=1&solar=1" },
  { name: "tank L + mm, faulted + warning", q: "scenario=faulted&warning=1&tank=L,mm" },
];

for (const [w, h] of SIZES) {
  for (const mode of MODES) {
    for (const c of VSD_CASES) {
      test(`${w}x${h} ${mode}, ${c.name}, VSD commissioning: gear and popover fit`, async () => {
        const page = await browser.newPage({ viewport: { width: w, height: h } });
        try {
          await page.goto(
            `${base}?host=local&mode=${encodeURIComponent(mode)}&commission=${encodeURIComponent("Local only")}&${c.q}`,
          );
          await page.waitForSelector('.sia-hmi [data-id="loading-overlay"].hidden', { state: "attached" });
          await page.waitForTimeout(150);

          // The tiles still fit with the gear in.
          const m = await page.evaluate(measure);
          assert.ok(m.doc[0] <= w && m.doc[1] <= h, `page scrolls: ${m.doc}`);
          for (const [label, v] of [["content", m.content], ["body", m.body]]) {
            assert.ok(v[2] <= v[3] + 1, `${label} overflows vertically with the gear: ${v}`);
          }
          for (const t of m.tiles) assert.ok(t.bottom <= m.barTop + 0.5, `${t.name} under the bar`);

          // Gear: top-right of the VSD tile, >= 44 px, clear of other controls.
          const g = await page.evaluate(measureGear);
          const ctx = JSON.stringify(g);
          assert.ok(g.gear && g.section, `gear not shown: ${ctx}`);
          assert.ok(g.gear.w >= 44 && g.gear.h >= 44, `gear ${g.gear.w}x${g.gear.h} < 44px`);
          assert.ok(g.gear.top >= g.section.top - 0.5 && g.gear.right <= g.section.right + 0.5, `gear outside the tile: ${ctx}`);
          assert.ok(g.gear.right >= g.section.right - 20, `gear not at the right edge: ${ctx}`);
          assert.ok(g.gear.top <= g.section.top + 20, `gear not at the top: ${ctx}`);
          for (const o of g.others) {
            const overlap = g.gear.left < o.right && o.left < g.gear.right && g.gear.top < o.bottom && o.top < g.gear.bottom;
            assert.ok(!overlap, `gear overlaps ${o.id}: ${ctx}`);
          }

          // Popover.
          await page.click('.sia-hmi [data-id="vsd-gear"]');
          await page.waitForSelector('.sia-hmi .vsd-param', { state: "visible" });
          await page.waitForFunction(() =>
            document.querySelector('.sia-hmi [data-diag="output_hz"] .diag-number')?.textContent !== "—",
          );
          const p = await page.evaluate(measurePanel);
          const pctx = JSON.stringify(p);
          if (VSD_SHOTS && mode === "Touch" && c.name === "running") {
            await page.screenshot({ path: path.join(VSD_SHOTS, `vsd-panel-${w}x${h}.png`) });
          }
          assert.ok(p.open, "popover open");
          // No page scroll with it open, either axis.
          assert.ok(p.doc[0] <= w && p.doc[1] <= h, `page scrolls with the popover: ${p.doc}`);
          // The popover is fully on screen and does not itself scroll.
          assert.ok(p.panel.left >= 0 && p.panel.top >= 0 && p.panel.right <= w && p.panel.bottom <= h, `popover off screen: ${pctx}`);
          assert.ok(p.panel.sh <= p.panel.ch + 1 && p.panel.sw <= p.panel.cw + 1, `popover overflows: ${pctx}`);
          // Only the parameter list scrolls, vertically, inside the popover.
          assert.ok(p.list.sw <= p.list.cw + 1, `parameter list scrolls sideways: ${pctx}`);
          assert.ok(p.list.bottom <= p.panel.bottom + 0.5, `parameter list spills out: ${pctx}`);
          assert.ok(p.list.h >= 100, `parameter list too short to use: ${p.list.h}px`);
          assert.ok(p.rowCount >= 8, `parameters not rendered: ${pctx}`);
          for (const r of p.rows) {
            assert.ok(r.h >= 44, `${r.id} row ${r.h}px < 44`);
            assert.ok(r.overflowX <= 1, `${r.id} row overflows: ${pctx}`);
          }
          // Diagnostics: all ten, above the list, no clipped cell.
          assert.equal(p.diag.length, 10, pctx);
          for (const d of p.diag) {
            assert.ok(d.bottom <= p.list.top + 0.5, `diagnostics overlap the list: ${pctx}`);
            assert.ok(d.overflow <= 1, `diagnostic cell overflows: ${d.text}`);
          }
          assert.ok(!p.diagNumbers.includes("—"), `diagnostics missing: ${p.diagNumbers}`);
          // Targets.
          for (const [label, b] of [["close", p.close], ["reset", p.reset]]) {
            assert.ok(b.w >= 44 && b.h >= 44, `${label} ${b.w}x${b.h} < 44px`);
          }

          // Keypad and confirmation open above the popover and fit too.
          if (mode === "Touch" && c.name === "running") {
            await page.click('.sia-hmi [data-param="P-01"]');
            const k = await page.evaluate(() => {
              const r = document.querySelector('.sia-hmi .keypad').getBoundingClientRect();
              const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 10);
              return { top: r.top, bottom: r.bottom, onTop: !!hit?.closest(".keypad"), doc: document.documentElement.scrollHeight };
            });
            assert.ok(k.onTop, "keypad is above the popover");
            assert.ok(k.top >= 0 && k.bottom <= h && k.doc <= h, `keypad does not fit: ${JSON.stringify(k)}`);
            await page.click('.sia-hmi [data-id="keypad-cancel"]');
          }

          // Close by tapping outside the panel.
          await page.mouse.click(2, 2);
          assert.equal(await page.isVisible('.sia-hmi [data-id="vsd-panel"]'), false, "tap outside closes");
        } finally {
          await page.close();
        }
      });
    }
  }
}

// --- 1min Calibration Sequence wizard ---------------------------------------------

/** The open wizard: on screen, no scroll, big enough targets. */
function measureWizard() {
  const vis = (el) => el && el.getClientRects().length > 0 && getComputedStyle(el).display !== "none";
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
  };
  const q = (id) => document.querySelector(`.sia-hmi [data-id="${id}"]`);
  const panel = q("calwiz-box");
  const body = q("calwiz-body");
  const buttons = [...panel.querySelectorAll("button")].filter(vis).map((b) => ({
    id: b.dataset.id || b.className, ...box(b), text: b.textContent.trim(),
    overflowX: b.scrollWidth - b.clientWidth,
  }));
  const texts = [...panel.querySelectorAll(".calwiz-row, .calwiz-field, .calwiz-text, .calwiz-note")]
    .filter(vis)
    .map((e) => ({ cls: e.className, ...box(e), overflowX: e.scrollWidth - e.clientWidth }));
  return {
    open: vis(q("calwiz")),
    page: body.getAttribute("data-page"),
    doc: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    panel: { ...box(panel), sh: panel.scrollHeight, ch: panel.clientHeight, sw: panel.scrollWidth, cw: panel.clientWidth },
    body: { ...box(body), sh: body.scrollHeight, ch: body.clientHeight },
    title: q("calwiz-box").querySelector(".calwiz-title").textContent,
    buttons,
    texts,
    countdown: q("calwiz-countdown") ? q("calwiz-countdown").textContent : null,
  };
}

function assertWizardFits(m, w, h, label) {
  const ctx = `${label}: ${JSON.stringify(m)}`;
  assert.ok(m.open, `wizard not open: ${ctx}`);
  assert.equal(m.title, "1min Calibration Sequence");
  assert.ok(m.doc[0] <= w && m.doc[1] <= h, `page scrolls: ${ctx}`);
  const p = m.panel;
  assert.ok(p.left >= 0 && p.top >= 0 && p.right <= w + 0.5 && p.bottom <= h + 0.5, `wizard off screen: ${ctx}`);
  assert.ok(p.sh <= p.ch + 1 && p.sw <= p.cw + 1, `wizard overflows: ${ctx}`);
  assert.ok(m.body.sh <= m.body.ch + 1, `wizard body clipped: ${ctx}`);
  for (const b of m.buttons) {
    assert.ok(b.h >= 44 && b.w >= 44, `${b.id} ${b.w}x${b.h} < 44px: ${ctx}`);
    assert.ok(b.bottom <= p.bottom + 0.5 && b.right <= p.right + 0.5, `${b.id} outside the wizard: ${ctx}`);
    assert.ok(b.overflowX <= 1, `${b.id} text overflows: ${ctx}`);
  }
  for (const t of m.texts) assert.ok(t.overflowX <= 1, `${t.cls} overflows: ${ctx}`);
}

async function wizardPage(page, id) {
  await page.waitForFunction(
    (want) => document.querySelector('.sia-hmi [data-id="calwiz-body"]')?.getAttribute("data-page") === want,
    id,
  );
}

async function keypadEntry(page, keys, w, h) {
  const k = await page.evaluate(() => {
    const r = document.querySelector(".sia-hmi .keypad").getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 10);
    return { top: r.top, bottom: r.bottom, onTop: !!hit?.closest(".keypad"), doc: document.documentElement.scrollHeight };
  });
  assert.ok(k.onTop, "keypad is above the wizard");
  assert.ok(k.top >= 0 && k.bottom <= h && k.doc <= h, `keypad does not fit: ${JSON.stringify(k)}`);
  await page.click('.sia-hmi [data-key="clear"]');
  for (const key of keys) await page.click(`.sia-hmi [data-key="${key}"]`);
  await page.click('.sia-hmi [data-id="keypad-ok"]');
}

for (const [w, h] of SIZES) {
  test(`${w}x${h} Touch, 1min Calibration Sequence: every page fits`, async () => {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    const shoot = CAL_SHOTS && w === 1024 && h === 600;
    const shot = (name) => shoot && page.screenshot({ path: path.join(CAL_SHOTS, `calwiz-${name}.png`) });
    try {
      await page.goto(`${base}?host=local&mode=Touch&scenario=standby&cal=manual&calspeed=15`);
      await page.waitForSelector('.sia-hmi [data-id="loading-overlay"].hidden', { state: "attached" });
      await page.waitForTimeout(150);
      const tile = await page.textContent('.sia-hmi [data-id="touch-cal"]');
      assert.match(tile, /Calibrate/);
      assert.match(tile, /Factor 1\.00/);

      await page.click('.sia-hmi [data-id="touch-cal"]');
      await wizardPage(page, "1");
      assertWizardFits(await page.evaluate(measureWizard), w, h, "page 1");
      await shot("p1");

      await page.click('.sia-hmi [data-id="calwiz-next"]');
      await wizardPage(page, "2");
      assertWizardFits(await page.evaluate(measureWizard), w, h, "page 2");
      await page.click('.sia-hmi [data-id="calwiz-field-start"]');
      await keypadEntry(page, ["5", "0", "0"], w, h);
      assertWizardFits(await page.evaluate(measureWizard), w, h, "page 2 entered");

      await page.click('.sia-hmi [data-id="calwiz-next"]');
      await wizardPage(page, "3");
      assertWizardFits(await page.evaluate(measureWizard), w, h, "page 3");
      await shot("p3");

      await page.click('.sia-hmi [data-id="calwiz-next"]');
      await wizardPage(page, "4");
      assertWizardFits(await page.evaluate(measureWizard), w, h, "page 4");
      await shot("p4");

      await page.click('.sia-hmi [data-id="calwiz-next"]');
      await wizardPage(page, "5");
      assertWizardFits(await page.evaluate(measureWizard), w, h, "page 5");
      const log = await page.evaluate(() => window.__rpcLog);
      assert.deepEqual(log.at(-1).request, { rate: 12.5, duration_s: 60 });
      assert.equal(log.at(-1).method, "start_test_run");

      // 60 s at 15x: the mock controller completes the run in 4 s.
      await wizardPage(page, "6");
      assertWizardFits(await page.evaluate(measureWizard), w, h, "page 6");
      await page.click('.sia-hmi [data-id="calwiz-field-final"]');
      await keypadEntry(page, ["7", "0", "0"], w, h); // the site glass reads up as it drains
      await page.click('.sia-hmi [data-id="calwiz-next"]');
      await wizardPage(page, "7");
      const m7 = await page.evaluate(measureWizard);
      assertWizardFits(m7, w, h, "page 7");
      await shot("p7");

      await page.click('.sia-hmi [data-id="calwiz-next"]'); // Set calibration factor
      await page.waitForSelector('.sia-hmi [data-id="calwiz-saved"]');
      assertWizardFits(await page.evaluate(measureWizard), w, h, "page 7 saved");
      const set = await page.evaluate(() => window.__rpcLog.at(-1));
      assert.equal(set.method, "last_calibration_factor");
    } finally {
      await page.close();
    }
  });

  test(`${w}x${h} Touch, 1min Calibration Sequence: reattach to a running test, countdown fits`, async () => {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    try {
      await page.goto(`${base}?host=local&mode=Touch&scenario=standby&cal=manual&calrun=42`);
      await page.waitForSelector('.sia-hmi [data-id="loading-overlay"].hidden', { state: "attached" });
      await wizardPage(page, "5");
      await page.waitForTimeout(150);
      const m = await page.evaluate(measureWizard);
      assertWizardFits(m, w, h, "countdown");
      assert.equal(m.countdown, "42");
      assert.ok(m.buttons.some((b) => b.id === "calwiz-cancel" && b.h >= 56), "Cancel is prominent");
      assert.ok(!m.buttons.some((b) => ["calwiz-back", "calwiz-close", "calwiz-next"].includes(b.id)), "no Back / X while running");
      if (CAL_SHOTS && w === 1024 && h === 600) {
        await page.screenshot({ path: path.join(CAL_SHOTS, "calwiz-p5.png") });
      }
      await page.click('.sia-hmi [data-id="calwiz-cancel"]');
      await wizardPage(page, "ended");
      assertWizardFits(await page.evaluate(measureWizard), w, h, "cancelled");
    } finally {
      await page.close();
    }
  });
}

// --- Cover-plate insets (kiosk_inset_mm 2 + popover_inset_mm 10) ---------------------
//
// At the default 5.8 px/mm: 11.6 px around the whole HMI, and every popover a
// further 58 px in. Everything (header, banners, tiles, the touch bar) stays
// inside the inset with no scroll, and the VSD popover (with its parameter
// list's up / down buttons) and the calibration wizard fit inside theirs.
// Screenshots (1024x600): INSET_SHOTS=<dir>  (inset-main.png, inset-vsd.png,
// inset-calwiz-p1.png)

const INSET_Q = "inset=2&popinset=10";
const INSET_PX = 2 * 5.8;
const POP_PX = INSET_PX + 10 * 5.8;
const INSET_SHOTS = process.env.INSET_SHOTS;

/** Everything visible in the kiosk view, for the inset bounds check. */
function measureInset() {
  const vis = (el) => el && el.getClientRects().length > 0 && getComputedStyle(el).display !== "none";
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
  };
  const els = [...document.querySelectorAll(
    ".sia-hmi .dashboard-header, .sia-hmi .fault-banner, .sia-hmi .warning-banner, .sia-hmi .control-section, .sia-hmi [data-id='touch-bar'], .sia-hmi .touch-btn",
  )].filter(vis);
  return {
    doc: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    items: els.map((e) => ({ name: e.dataset.id || e.className.split(" ").slice(0, 2).join("."), ...box(e) })),
  };
}

/** A popover box (and, for the VSD panel, its scroll buttons). */
function measurePopover(boxId) {
  const vis = (el) => el && el.getClientRects().length > 0 && getComputedStyle(el).display !== "none";
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
  };
  const q = (id) => document.querySelector(`.sia-hmi [data-id="${id}"]`);
  const panel = q(boxId);
  const list = q("vsd-params");
  const rail = q("vsd-params-rail");
  const scrollbar = list ? list.offsetWidth - list.clientWidth : 0;
  return {
    doc: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    panel: { ...box(panel), sh: panel.scrollHeight, ch: panel.clientHeight },
    rail: vis(rail) ? box(rail) : null,
    up: vis(q("vsd-params-up")) ? { ...box(q("vsd-params-up")), disabled: q("vsd-params-up").disabled } : null,
    down: vis(q("vsd-params-down")) ? { ...box(q("vsd-params-down")), disabled: q("vsd-params-down").disabled } : null,
    list: list && vis(list) ? { ...box(list), sh: list.scrollHeight, ch: list.clientHeight, top: list.scrollTop, scrollbar } : null,
  };
}

function assertInside(b, w, h, gap, label) {
  const ctx = `${label}: ${JSON.stringify(b)}`;
  assert.ok(b.left >= gap - 0.6, `${label} left ${b.left} < ${gap}: ${ctx}`);
  assert.ok(b.top >= gap - 0.6, `${label} top ${b.top} < ${gap}: ${ctx}`);
  assert.ok(b.right <= w - gap + 0.6, `${label} right ${b.right} > ${w - gap}: ${ctx}`);
  assert.ok(b.bottom <= h - gap + 0.6, `${label} bottom ${b.bottom} > ${h - gap}: ${ctx}`);
}

const INSET_CASES = [
  { name: "running", q: "scenario=running" },
  { name: "faulted + warning + solar", q: "scenario=faulted&warning=1&solar=1" },
  { name: "calibrate tile, tank L + mm, faulted + warning", q: "scenario=faulted&warning=1&cal=manual&tank=L,mm" },
];

for (const [w, h] of SIZES) {
  for (const mode of MODES) {
    for (const c of INSET_CASES) {
      test(`${w}x${h} ${mode}, ${c.name}, inset 2 mm: everything inside the plate, no scroll`, async () => {
        const page = await browser.newPage({ viewport: { width: w, height: h } });
        try {
          await page.goto(`${base}?host=local&mode=${encodeURIComponent(mode)}&${INSET_Q}&${c.q}`);
          await page.waitForSelector('.sia-hmi [data-id="loading-overlay"].hidden', { state: "attached" });
          await page.waitForTimeout(150);
          const m = await page.evaluate(measure);
          assert.ok(m.doc[0] <= w && m.doc[1] <= h, `page scrolls: ${m.doc}`);
          for (const [label, v] of [["content", m.content], ["body", m.body]]) {
            assert.ok(v[0] <= v[1] + 1, `${label} overflows horizontally: ${v}`);
            assert.ok(v[2] <= v[3] + 1, `${label} overflows vertically: ${v}`);
          }
          for (const t of m.tiles) assert.ok(t.bottom <= m.barTop + 0.5, `${t.name} under the bar`);
          if (mode === "Touch") {
            for (const t of m.targets) assert.ok(t.h >= 56 && t.w >= 56, `${t.id} ${t.w}x${t.h} < 56px`);
          }
          assert.ok(Math.min(...m.valueFonts) >= 16, `value text ${Math.min(...m.valueFonts)}px`);
          const inset = await page.evaluate(measureInset);
          assert.ok(inset.items.length >= 4, JSON.stringify(inset));
          for (const it of inset.items) assertInside(it, w, h, INSET_PX, it.name);
          if (INSET_SHOTS && w === 1024 && h === 600 && mode === "Touch" && c.name === "running") {
            await page.screenshot({ path: path.join(INSET_SHOTS, "inset-main.png") });
          }
        } finally {
          await page.close();
        }
      });
    }
  }

  test(`${w}x${h} Touch, inset 2 mm + popover 10 mm: VSD popover fits, list pages with up / down`, async () => {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    try {
      await page.goto(`${base}?host=local&mode=Touch&commission=${encodeURIComponent("Local only")}&${INSET_Q}&scenario=running`);
      await page.waitForSelector('.sia-hmi [data-id="loading-overlay"].hidden', { state: "attached" });
      await page.waitForTimeout(150);
      await page.click('.sia-hmi [data-id="vsd-gear"]');
      await page.waitForSelector(".sia-hmi .vsd-param", { state: "visible" });
      await page.waitForFunction(
        () => document.querySelector('.sia-hmi [data-diag="output_hz"] .diag-number')?.textContent !== "—",
      );
      await page.waitForTimeout(100);
      const p = await page.evaluate(measurePopover, "vsd-panel-box");
      const ctx = JSON.stringify(p);
      assert.ok(p.doc[0] <= w && p.doc[1] <= h, `page scrolls: ${ctx}`);
      assertInside(p.panel, w, h, POP_PX, "VSD popover");
      assert.ok(p.panel.sh <= p.panel.ch + 1, `popover overflows: ${ctx}`);
      assert.ok(p.list && p.list.h >= 96, `parameter list too short: ${ctx}`);
      assert.ok(p.list.bottom <= p.panel.bottom + 0.5, `list spills out: ${ctx}`);
      assert.equal(p.list.scrollbar, 0, `a scrollbar is showing: ${ctx}`);
      // The list overflows here: the buttons show, >= 48 px, beside the list.
      assert.ok(p.list.sh > p.list.ch + 1, `expected an overflowing list: ${ctx}`);
      assert.ok(p.rail && p.up && p.down, `scroll buttons missing: ${ctx}`);
      for (const b of [p.up, p.down]) assert.ok(b.w >= 48 && b.h >= 48, `scroll button ${b.w}x${b.h} < 48px`);
      assert.ok(p.rail.left >= p.list.right - 0.5 && p.rail.right <= p.panel.right + 0.5, `rail placement: ${ctx}`);
      assert.equal(p.up.disabled, true, "up disabled at the top");
      assert.equal(p.down.disabled, false);
      const detail = await page.evaluate(() => {
        const list = document.querySelector('.sia-hmi [data-id="vsd-params"]');
        return getComputedStyle(list).scrollbarWidth;
      });
      assert.equal(detail, "none");
      const rows = await page.$$eval(".sia-hmi .vsd-param", (r) => r.length);
      assert.ok(rows >= 8, "parameters rendered");
      if (INSET_SHOTS && w === 1024 && h === 600) {
        await page.screenshot({ path: path.join(INSET_SHOTS, "inset-vsd.png") });
      }
      // Page down, then to the end: down disables; up pages back.
      await page.click('.sia-hmi [data-id="vsd-params-down"]');
      const after = await page.evaluate(measurePopover, "vsd-panel-box");
      // About one visible page (85 %), or to the end if that is nearer.
      const want = Math.min(Math.max(40, Math.round(p.list.ch * 0.85)), p.list.sh - p.list.ch);
      assert.ok(Math.abs(after.list.top - want) <= 2, `down scrolled ${after.list.top}, want ${want} (page ${p.list.ch})`);
      assert.equal(after.up.disabled, false);
      for (let i = 0; i < 30; i++) {
        if (await page.isDisabled('.sia-hmi [data-id="vsd-params-down"]')) break;
        await page.click('.sia-hmi [data-id="vsd-params-down"]');
      }
      const end = await page.evaluate(measurePopover, "vsd-panel-box");
      assert.equal(end.down.disabled, true, "down disabled at the end");
      assert.ok(Math.abs(end.list.top - (end.list.sh - end.list.ch)) <= 1, `not at the end: ${JSON.stringify(end)}`);
      await page.click('.sia-hmi [data-id="vsd-params-up"]');
      const back = await page.evaluate(measurePopover, "vsd-panel-box");
      assert.ok(back.list.top < end.list.top && back.down.disabled === false, JSON.stringify(back));

      // The keypad from a parameter row sits inside the popover inset too.
      for (let i = 0; i < 30; i++) {
        if (await page.isDisabled('.sia-hmi [data-id="vsd-params-up"]')) break;
        await page.click('.sia-hmi [data-id="vsd-params-up"]');
      }
      await page.click('.sia-hmi [data-param="P-01"]');
      await page.waitForSelector('.sia-hmi [data-id="keypad"]', { state: "visible" });
      const k = await page.evaluate(() => {
        const r = document.querySelector(".sia-hmi .keypad").getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      });
      assertInside(k, w, h, POP_PX, "keypad");
    } finally {
      await page.close();
    }
  });

  test(`${w}x${h} Touch, inset 2 mm + popover 10 mm: every calibration wizard page fits`, async () => {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    const shoot = INSET_SHOTS && w === 1024 && h === 600;
    const fits = async (label) => {
      const m = await page.evaluate(measureWizard);
      assertWizardFits(m, w, h, label);
      assertInside(m.panel, w, h, POP_PX, `wizard ${label}`);
      return m;
    };
    try {
      await page.goto(`${base}?host=local&mode=Touch&scenario=standby&cal=manual&calspeed=15&${INSET_Q}`);
      await page.waitForSelector('.sia-hmi [data-id="loading-overlay"].hidden', { state: "attached" });
      await page.waitForTimeout(150);
      await page.click('.sia-hmi [data-id="touch-cal"]');
      await wizardPage(page, "1");
      const m1 = await fits("page 1");
      const manual = m1.buttons.find((b) => b.id === "calwiz-manual");
      assert.ok(manual, "manual entry key shown");
      assert.ok(manual.h >= 56, `manual key ${manual.h}px < 56`);
      assert.ok(manual.w >= m1.panel.w * 0.8, `manual key not full width: ${manual.w} of ${m1.panel.w}`);
      assert.equal(manual.text, "Enter calibration factor manually");
      if (shoot) await page.screenshot({ path: path.join(INSET_SHOTS, "inset-calwiz-p1.png") });

      await page.click('.sia-hmi [data-id="calwiz-next"]');
      await wizardPage(page, "2");
      await fits("page 2");
      await page.click('.sia-hmi [data-id="calwiz-field-start"]');
      const k = await page.evaluate(() => {
        const r = document.querySelector(".sia-hmi .keypad").getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      });
      assertInside(k, w, h, POP_PX, "keypad");
      await keypadEntry(page, ["5", "0", "0"], w, h);
      await page.click('.sia-hmi [data-id="calwiz-next"]');
      await wizardPage(page, "3");
      await fits("page 3");
      await page.click('.sia-hmi [data-id="calwiz-next"]');
      await wizardPage(page, "4");
      await fits("page 4");
      await page.click('.sia-hmi [data-id="calwiz-next"]');
      await wizardPage(page, "5");
      await fits("page 5");
      await wizardPage(page, "6");
      await fits("page 6");
      await page.click('.sia-hmi [data-id="calwiz-field-final"]');
      await keypadEntry(page, ["7", "0", "0"], w, h); // the site glass reads up as it drains
      await page.click('.sia-hmi [data-id="calwiz-next"]');
      await wizardPage(page, "7");
      await fits("page 7");
      await page.click('.sia-hmi [data-id="calwiz-next"]');
      await page.waitForSelector('.sia-hmi [data-id="calwiz-saved"]');
      await fits("page 7 saved");
      // The confirmation (manual factor) sits inside the inset too.
      await page.click('.sia-hmi [data-id="calwiz-next"]'); // Close
      await page.click('.sia-hmi [data-id="touch-cal"]');
      await wizardPage(page, "1");
      await page.click('.sia-hmi [data-id="calwiz-manual"]');
      await page.click('.sia-hmi [data-key="clear"]');
      for (const key of ["1", ".", "1"]) await page.click(`.sia-hmi [data-key="${key}"]`);
      await page.click('.sia-hmi [data-id="keypad-ok"]');
      const cb = await page.evaluate(() => {
        const r = document.querySelector(".sia-hmi .confirm-box").getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      });
      assertInside(cb, w, h, POP_PX, "confirmation");
    } finally {
      await page.close();
    }
  });
}

// --- Alarm settings gears and popovers --------------------------------------------

const ALARM_SHOTS = process.env.ALARM_SHOTS;

/** The two gears, their tiles and every other control, for the overlap check. */
function measureAlarmGears() {
  const vis = (el) => el && el.getClientRects().length > 0 && getComputedStyle(el).display !== "none";
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
  };
  const q = (id) => document.querySelector(`.sia-hmi [data-id="${id}"]`);
  const gears = ["tank-gear", "pressure-gear", "vsd-gear"].filter((id) => vis(q(id)));
  return {
    gears: Object.fromEntries(
      ["tank-gear", "pressure-gear"].map((id) => [id, vis(q(id)) ? box(q(id)) : null]),
    ),
    tank: box(q("tank-section")),
    skid: box(q("skid-section")),
    others: [...document.querySelectorAll(".sia-hmi .dashboard-container button")]
      .filter((b) => vis(b) && !gears.includes(b.dataset.id))
      .map((b) => ({ id: b.dataset.id, ...box(b) })),
  };
}

function measureAlarmPanel() {
  const vis = (el) => el && el.getClientRects().length > 0 && getComputedStyle(el).display !== "none";
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
  };
  const panel = document.querySelector('.sia-hmi [data-id="alarm-panel-box"]');
  return {
    open: vis(document.querySelector('.sia-hmi [data-id="alarm-panel"]')),
    doc: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    panel: { ...box(panel), sh: panel.scrollHeight, ch: panel.clientHeight, sw: panel.scrollWidth, cw: panel.clientWidth },
    title: document.querySelector('.sia-hmi [data-id="alarm-panel-title"]').textContent,
    close: box(document.querySelector('.sia-hmi [data-id="alarm-panel-close"]')),
    rows: [...panel.querySelectorAll(".alarm-row")].filter(vis).map((r) => ({
      id: r.dataset.alarm,
      ...box(r),
      overflowX: r.scrollWidth - r.clientWidth,
      value: r.querySelector("[data-alarm-value]").textContent,
    })),
  };
}

const ALARM_Q = `alarms=${encodeURIComponent("Local only")}&punits=kPa&scenario=running`;

for (const [w, h] of SIZES) {
  for (const [insetName, insetQ, gap] of [["no inset", "", 8], ["inset 2 mm + popover 10 mm", `&${INSET_Q}`, POP_PX]]) {
    test(`${w}x${h} Touch, ${insetName}: alarm settings gears and popovers fit`, async () => {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      const shoot = ALARM_SHOTS && w === 1024 && h === 600 && insetQ;
      try {
        await page.goto(`${base}?host=local&mode=Touch&${ALARM_Q}${insetQ}&commission=${encodeURIComponent("Local only")}`);
        await page.waitForSelector('.sia-hmi [data-id="loading-overlay"].hidden', { state: "attached" });
        await page.waitForTimeout(150);

        // The tiles still fit with the gears in.
        const m = await page.evaluate(measure);
        assert.ok(m.doc[0] <= w && m.doc[1] <= h, `page scrolls: ${m.doc}`);
        for (const [label, v] of [["content", m.content], ["body", m.body]]) {
          assert.ok(v[2] <= v[3] + 1, `${label} overflows vertically with the gears: ${v}`);
        }
        for (const t of m.tiles) assert.ok(t.bottom <= m.barTop + 0.5, `${t.name} under the bar`);

        // Gears: >= 44 px, top-right of their tiles, clear of other controls.
        const g = await page.evaluate(measureAlarmGears);
        const gctx = JSON.stringify(g);
        for (const [id, tile] of [["tank-gear", g.tank], ["pressure-gear", g.skid]]) {
          const b = g.gears[id];
          assert.ok(b, `${id} not shown: ${gctx}`);
          assert.ok(b.w >= 44 && b.h >= 44, `${id} ${b.w}x${b.h} < 44px`);
          assert.ok(b.top >= tile.top - 0.5 && b.right <= tile.right + 0.5 && b.left >= tile.left - 0.5, `${id} outside its tile: ${gctx}`);
          assert.ok(b.right >= tile.right - 20 && b.top <= tile.top + 20, `${id} not top-right: ${gctx}`);
          for (const o of g.others) {
            const overlap = b.left < o.right && o.left < b.right && b.top < o.bottom && o.top < b.bottom;
            assert.ok(!overlap, `${id} overlaps ${o.id}: ${gctx}`);
          }
        }

        for (const [gear, title, file] of [
          ["tank-gear", "Tank Level Alarms", "alarm-tank.png"],
          ["pressure-gear", "Discharge Pressure Alarms", "alarm-pressure.png"],
        ]) {
          await page.click(`.sia-hmi [data-id="${gear}"]`);
          await page.waitForSelector('.sia-hmi [data-id="alarm-panel"]', { state: "visible" });
          const p = await page.evaluate(measureAlarmPanel);
          const ctx = `${title}: ${JSON.stringify(p)}`;
          assert.equal(p.title, title);
          assert.ok(p.doc[0] <= w && p.doc[1] <= h, `page scrolls with the popover: ${ctx}`);
          assertInside(p.panel, w, h, gap, title);
          assert.ok(p.panel.sh <= p.panel.ch + 1 && p.panel.sw <= p.panel.cw + 1, `popover overflows: ${ctx}`);
          assert.equal(p.rows.length, 2, ctx);
          for (const r of p.rows) {
            assert.ok(r.h >= 56, `${r.id} row ${r.h}px < 56`);
            assert.ok(r.overflowX <= 1, `${r.id} row overflows: ${ctx}`);
            assert.ok(r.bottom <= p.panel.bottom + 0.5, `${r.id} outside the popover: ${ctx}`);
            assert.notEqual(r.value, "\u2014", `${r.id} readback missing: ${ctx}`);
          }
          assert.ok(p.close.w >= 44 && p.close.h >= 44, "close < 44px");
          if (shoot) await page.screenshot({ path: path.join(ALARM_SHOTS, file) });

          // The keypad from a row sits above the popover and inside the gap.
          await page.click(`.sia-hmi [data-alarm="${p.rows[0].id}"]`);
          await page.waitForSelector('.sia-hmi [data-id="keypad"]', { state: "visible" });
          const k = await page.evaluate(() => {
            const r = document.querySelector(".sia-hmi .keypad").getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 10);
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, onTop: !!hit?.closest(".keypad") };
          });
          assert.ok(k.onTop, "keypad above the alarm popover");
          assertInside(k, w, h, gap, "keypad");
          await page.click('.sia-hmi [data-id="keypad-cancel"]');
          await page.click('.sia-hmi [data-id="alarm-panel-close"]');
          assert.equal(await page.isVisible('.sia-hmi [data-id="alarm-panel"]'), false);
        }

        // One real edit end to end at the panel size: L 20 -> 25 %.
        await page.click('.sia-hmi [data-id="tank-gear"]');
        await page.click('.sia-hmi [data-alarm="low_tank_level"]');
        await page.click('.sia-hmi [data-key="clear"]');
        for (const key of ["2", "5"]) await page.click(`.sia-hmi [data-key="${key}"]`);
        await page.click('.sia-hmi [data-id="keypad-ok"]');
        const cb = await page.evaluate(() => {
          const r = document.querySelector(".sia-hmi .confirm-box").getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        });
        assertInside(cb, w, h, gap, "confirmation");
        await page.click('.sia-hmi [data-id="confirm-ok"]');
        await page.waitForFunction(
          () => document.querySelector('.sia-hmi [data-alarm="low_tank_level"] [data-alarm-value]')?.textContent === "25.0 %",
        );
        const sent = await page.evaluate(() => window.__rpcLog.at(-1));
        assert.equal(sent.method, "low_tank_level");
        assert.equal(sent.request, 25);
      } finally {
        await page.close();
      }
    });
  }
}

// The keypad's backspace glyph (U+232B) is missing from the kiosk's bold
// sans, and its font fallback is warmed at load by .glyph-warm. The warm-up
// only helps if it resolves the same font as the key: same computed font,
// same platform font for the glyph, and no box of its own.
for (const host of ["local", "cloud"]) {
  test(`${host}: the glyph warm-up uses the backspace key's font and takes no room`, async () => {
    const page = await browser.newPage({ viewport: { width: 1024, height: 600 } });
    try {
      await page.goto(`${base}?host=${host}&mode=Touch&scenario=running`);
      await page.waitForSelector('.sia-hmi [data-id="loading-overlay"].hidden', { state: "attached" });
      await page.click('.sia-hmi [data-id="touch-rate"]');
      await page.waitForSelector('.sia-hmi [data-id="keypad"]', { state: "visible" });
      const css = await page.evaluate(() => {
        const font = (el) => {
          const s = getComputedStyle(el);
          return [s.fontFamily, s.fontSize, s.fontWeight, s.fontStyle, s.fontStretch, s.fontVariant].join(" | ");
        };
        const warm = document.querySelector(".sia-hmi .glyph-warm");
        const key = document.querySelector('.sia-hmi [data-key="back"]');
        const r = warm.getBoundingClientRect();
        return {
          warm: font(warm),
          key: font(key),
          text: [warm.textContent, key.textContent],
          box: [r.width, r.height],
          visibility: getComputedStyle(warm).visibility,
        };
      });
      assert.equal(css.warm, css.key);
      assert.equal(css.text[0], css.text[1]);
      assert.deepEqual(css.box, [0, 0]);
      assert.equal(css.visibility, "hidden");

      const cdp = await page.context().newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("CSS.enable");
      const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
      const fonts = async (sel) => {
        const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: sel });
        const res = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
        return res.fonts.map((f) => f.postScriptName || f.familyName).sort();
      };
      const warmFonts = await fonts(".sia-hmi .glyph-warm");
      assert.ok(warmFonts.length > 0, "the warm-up glyph is laid out");
      assert.deepEqual(warmFonts, await fonts('.sia-hmi [data-key="back"]'));
    } finally {
      await page.close();
    }
  });
}
