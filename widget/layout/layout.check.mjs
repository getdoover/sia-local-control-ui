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
// Alarm settings (alarm_settings_access): the Tank / Skid (and, with a
// controller flow meter, Pump Control) gears fit their tiles, and each
// popover (tank L / LL, pressure H / HH, flow L / LL, each row the threshold
// and its delay side by side) and its keypad fit at every size, with and
// without the insets. Screenshots: ALARM_SHOTS=<dir> (alarm-tank-<w>x<h>.png,
// alarm-pressure-<w>x<h>.png, alarm-flow-<w>x<h>.png at 800x480 and 1024x600
// inset)
// Cover-plate insets (kiosk_inset_mm 2 + popover_inset_mm 10) at every size:
// the whole HMI inside the inset, the VSD popover (with its up / down scroll
// buttons, no scrollbar), the wizard, keypad and confirmation inside the
// popover inset. Screenshots: INSET_SHOTS=<dir> (inset-*.png at 1024x600)
// Refresh button (local kiosk only): top right of the header, >= 44 px, clear
// of the title and status, with and without the insets; none in the cloud.
// Screenshots: HEADER_SHOTS=<dir> (header-refresh-1024x600*.png)
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
  // Two concurrent warnings: one row each, the second below the first.
  { name: "tank L + mm, solar, faulted + two warnings", q: "scenario=faulted&warning=2&solar=1&tank=L,mm" },
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
          if (c.q.includes("warning=2")) {
            const rows = await page.$$eval(".sia-hmi .warning-banner-list li", (lis) =>
              lis.map((li) => li.getBoundingClientRect().toJSON()),
            );
            assert.equal(rows.length, 2, "one banner row per warning");
            assert.ok(rows[1].top >= rows[0].bottom - 0.5, `second warning not below the first: ${JSON.stringify(rows)}`);
          }
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

      // The "?" (top left) opens the calibration factor help over the wizard;
      // it fits the screen and its X closes it.
      await page.click('.sia-hmi [data-id="calwiz-help"]');
      const help = await page.evaluate(() => {
        const q = (sel) => document.querySelector(`.sia-hmi ${sel}`).getBoundingClientRect();
        const box = q(".cal-help-box");
        const x = q('[data-id="cal-help-close"]');
        const btn = q('[data-id="calwiz-help"]');
        const wiz = q('[data-id="calwiz-box"]');
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 10);
        const el = document.querySelector(".sia-hmi .cal-help-box");
        return {
          box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
          onTop: !!hit?.closest(".cal-help-box"),
          clipped: el.scrollHeight > el.clientHeight + 1,
          xRight: box.right - x.right, xTop: x.top - box.top, xSize: Math.min(x.width, x.height),
          btnLeft: btn.left - wiz.left, btnTop: btn.top - wiz.top, btnSize: Math.min(btn.width, btn.height),
        };
      });
      const hctx = JSON.stringify(help);
      assertInside(help.box, w, h, 0, "calibration help");
      assert.ok(help.onTop && !help.clipped, `help not on top, or clipped: ${hctx}`);
      assert.ok(help.xSize >= 44 && help.xRight <= 20 && help.xTop <= 20, `X not top right: ${hctx}`);
      assert.ok(help.btnSize >= 44 && help.btnLeft <= 20 && help.btnTop <= 20, `? not top left: ${hctx}`);
      await shot("help");
      await page.click('.sia-hmi [data-id="cal-help-close"]');
      await wizardPage(page, "1");

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
      await page.waitForSelector('.sia-hmi [data-id="calwiz"].hidden', { state: "attached" }); // set: it closes
      // The "updated" toast is at the bottom of the screen, just above the touch bar.
      const toast = await page.evaluate(() => {
        const el = document.querySelector('.sia-hmi [data-id="command-toast"]');
        const t = el.getBoundingClientRect();
        const b = document.querySelector('.sia-hmi [data-id="touch-bar"]').getBoundingClientRect();
        return { shown: !el.classList.contains("hidden"), text: el.textContent, top: t.top, bottom: t.bottom, bar: b.top };
      });
      assert.ok(toast.shown, "updated toast shown");
      assert.equal(toast.text, "Calibration factor updated");
      assert.ok(toast.bottom <= toast.bar && toast.bar - toast.bottom <= 24, `toast not just above the touch bar: ${JSON.stringify(toast)}`);
      await shot("set");
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
      await page.waitForSelector('.sia-hmi [data-id="calwiz"].hidden', { state: "attached" }); // set: it closes
      // The confirmation (manual factor) sits inside the inset too.
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
  const gears = ["tank-gear", "pressure-gear", "flow-gear", "vsd-gear"].filter((id) => vis(q(id)));
  return {
    gears: Object.fromEntries(
      ["tank-gear", "pressure-gear", "flow-gear"].map((id) => [id, vis(q(id)) ? box(q(id)) : null]),
    ),
    tank: box(q("tank-section")),
    skid: box(q("skid-section")),
    pump: box(q("pump-section")),
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
    // Each row: the alarm's threshold and delay cells, side by side.
    rows: [...panel.querySelectorAll(".alarm-row")].filter(vis).map((r) => ({
      ...box(r),
      overflowX: r.scrollWidth - r.clientWidth,
      cells: [...r.querySelectorAll("[data-alarm]")].map((c) => {
        const v = c.querySelector("[data-alarm-value]");
        return {
          id: c.dataset.alarm,
          ...box(c),
          caption: c.querySelector(".alarm-caption").textContent,
          value: v.textContent,
          valueCut: v.scrollWidth - v.clientWidth,
          overflowX: c.scrollWidth - c.clientWidth,
        };
      }),
    })),
  };
}

/** One popover's fit: inside the gap, no overflow, the rows' cells in order,
 * side by side, captioned, comfortably tappable, values whole. */
function assertAlarmPanel(p, w, h, gap, title, rows, caption) {
  const ctx = `${title}: ${JSON.stringify(p)}`;
  assert.equal(p.title, title);
  assert.ok(p.doc[0] <= w && p.doc[1] <= h, `page scrolls with the popover: ${ctx}`);
  assertInside(p.panel, w, h, gap, title);
  assert.ok(p.panel.sh <= p.panel.ch + 1 && p.panel.sw <= p.panel.cw + 1, `popover overflows: ${ctx}`);
  assert.deepEqual(p.rows.map((r) => r.cells.map((c) => c.id)), rows, ctx);
  for (const r of p.rows) {
    assert.ok(r.overflowX <= 1, `row overflows: ${ctx}`);
    assert.ok(r.bottom <= p.panel.bottom + 0.5, `row outside the popover: ${ctx}`);
    const [value, delay] = r.cells;
    assert.equal(value.caption, caption, ctx);
    assert.equal(delay.caption, "Delay", ctx);
    // Same row: side by side, the delay to the right of the value.
    assert.ok(Math.abs(value.top - delay.top) <= 1 && delay.left >= value.right, `${delay.id} not beside ${value.id}: ${ctx}`);
    for (const c of r.cells) {
      assert.ok(c.h >= 56 && c.w >= 120, `${c.id} ${c.w}x${c.h} too small to tap: ${ctx}`);
      assert.ok(c.overflowX <= 1 && c.valueCut <= 1, `${c.id} value cut off: ${ctx}`);
      assert.notEqual(c.value, "\u2014", `${c.id} readback missing: ${ctx}`);
    }
  }
  assert.ok(p.close.w >= 44 && p.close.h >= 44, "close < 44px");
}

const ALARM_Q = `alarms=${encodeURIComponent("Local only")}&punits=kPa&scenario=running`;

for (const [w, h] of SIZES) {
  for (const [insetName, insetQ, gap] of [["no inset", "", 8], ["inset 2 mm + popover 10 mm", `&${INSET_Q}`, POP_PX]]) {
    test(`${w}x${h} Touch, ${insetName}: alarm settings gears and popovers fit`, async () => {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      const shoot = ALARM_SHOTS && w <= 1024 && h <= 600 && insetQ;
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
        // No controller flow meter (this project): no flow gear.
        assert.equal(g.gears["flow-gear"], null, `flow gear without a flow meter: ${gctx}`);
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

        for (const [gear, title, file, rows, caption] of [
          ["tank-gear", "Tank Level Alarms", "alarm-tank", [["low_tank_level", "tank_l_delay"], ["low_low_tank_level", "tank_ll_delay"]], "Level"],
          ["pressure-gear", "Discharge Pressure Alarms", "alarm-pressure", [["high_pressure", "pressure_h_delay"], ["high_high_pressure", "pressure_hh_delay"]], "Pressure"],
        ]) {
          await page.click(`.sia-hmi [data-id="${gear}"]`);
          await page.waitForSelector('.sia-hmi [data-id="alarm-panel"]', { state: "visible" });
          const p = await page.evaluate(measureAlarmPanel);
          assertAlarmPanel(p, w, h, gap, title, rows, caption);
          if (shoot) await page.screenshot({ path: path.join(ALARM_SHOTS, `${file}-${w}x${h}.png`) });

          // The keypad from a threshold and from a delay sits above the
          // popover and inside the gap.
          for (const id of p.rows[0].cells.map((c) => c.id)) {
            await page.click(`.sia-hmi [data-alarm="${id}"]`);
            await page.waitForSelector('.sia-hmi [data-id="keypad"]', { state: "visible" });
            const k = await page.evaluate(() => {
              const r = document.querySelector(".sia-hmi .keypad").getBoundingClientRect();
              const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 10);
              return {
                left: r.left, top: r.top, right: r.right, bottom: r.bottom,
                onTop: !!hit?.closest(".keypad"),
                title: document.querySelector('.sia-hmi [data-id="keypad-title"]').textContent,
              };
            });
            assert.ok(k.onTop, `keypad above the alarm popover (${id})`);
            assertInside(k, w, h, gap, `keypad (${id})`);
            await page.click('.sia-hmi [data-id="keypad-cancel"]');
          }
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

        // The "saved" toast is up at the bottom of the screen (below the
        // popover, or on the bottom edge when there is no room below it), and
        // takes no taps: each cell's centre still hits that cell (the lower
        // row's cells can sit under it, and a tap there was lost for the
        // toast's 3 s).
        const t = await page.evaluate(() => {
          const toast = document.querySelector('.sia-hmi [data-id="command-toast"]');
          const r = toast.getBoundingClientRect();
          return {
            shown: !toast.classList.contains("hidden") && r.height > 0,
            box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
            pop: document.querySelector('.sia-hmi [data-id="alarm-panel-box"]').getBoundingClientRect().bottom,
            rows: [...document.querySelectorAll(".sia-hmi .alarm-row [data-alarm]")].map((cell) => {
              const b = cell.getBoundingClientRect();
              const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
              return {
                id: cell.dataset.alarm,
                left: b.left, top: b.top, right: b.right, bottom: b.bottom,
                hit: hit?.closest("[data-alarm]")?.dataset.alarm ?? hit?.className ?? null,
              };
            }),
          };
        });
        const tctx = JSON.stringify(t);
        assert.ok(t.shown, `no toast after the save: ${tctx}`);
        assertInside(t.box, w, h, insetQ ? INSET_PX : 0, "toast");
        const edge = h - (insetQ ? INSET_PX : 0);
        assert.ok(
          t.box.top >= t.pop - 1 || Math.abs(edge - 8 - t.box.bottom) <= 1.5,
          `toast not at the bottom (below the popover or on the bottom edge): ${tctx}`,
        );
        assert.ok(t.box.top > h / 2, `toast not in the lower half: ${tctx}`);
        for (const r of t.rows) {
          assert.equal(r.hit, r.id, `a tap on ${r.id} does not reach it: ${tctx}`);
        }

        // And the L warning's delay beside it: 600 -> 45 s, read back from
        // its tag; the LL delay is untouched.
        await page.click('.sia-hmi [data-alarm="tank_l_delay"]');
        await page.click('.sia-hmi [data-key="clear"]');
        for (const key of ["4", "5"]) await page.click(`.sia-hmi [data-key="${key}"]`);
        await page.click('.sia-hmi [data-id="keypad-ok"]');
        await page.click('.sia-hmi [data-id="confirm-ok"]');
        await page.waitForFunction(
          () => document.querySelector('.sia-hmi [data-alarm="tank_l_delay"] [data-alarm-value]')?.textContent === "45 s",
        );
        const delay = await page.evaluate(() => window.__rpcLog.at(-1));
        assert.equal(delay.method, "tank_l_delay");
        assert.equal(delay.request, 45);
        assert.equal(
          await page.textContent('.sia-hmi [data-alarm="tank_ll_delay"] [data-alarm-value]'),
          "600 s",
        );

        // A pressure delay: 0 s (no delay) -> 10 s.
        await page.click('.sia-hmi [data-id="alarm-panel-close"]');
        await page.click('.sia-hmi [data-id="pressure-gear"]');
        assert.equal(await page.textContent('.sia-hmi [data-alarm="pressure_hh_delay"] [data-alarm-value]'), "0 s");
        await page.click('.sia-hmi [data-alarm="pressure_hh_delay"]');
        await page.click('.sia-hmi [data-key="clear"]');
        for (const key of ["1", "0"]) await page.click(`.sia-hmi [data-key="${key}"]`);
        await page.click('.sia-hmi [data-id="keypad-ok"]');
        await page.click('.sia-hmi [data-id="confirm-ok"]');
        await page.waitForFunction(
          () => document.querySelector('.sia-hmi [data-alarm="pressure_hh_delay"] [data-alarm-value]')?.textContent === "10 s",
        );
        const pdelay = await page.evaluate(() => window.__rpcLog.at(-1));
        assert.equal(pdelay.method, "pressure_hh_delay");
        assert.equal(pdelay.request, 10);
      } finally {
        await page.close();
      }
    });
  }
}

// Flow alarms: only with a dedicated flow meter on the controller (not on
// this project). The gear sits on the Pump Control tile; the popover fits
// like the others.
for (const [w, h] of SIZES) {
  for (const [insetName, insetQ, gap] of [["no inset", "", 8], ["inset 2 mm + popover 10 mm", `&${INSET_Q}`, POP_PX]]) {
    test(`${w}x${h} Touch, ${insetName}, flow meter: the flow alarm gear and popover fit`, async () => {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      const shoot = ALARM_SHOTS && w <= 1024 && h <= 600 && insetQ;
      try {
        await page.goto(`${base}?host=local&mode=Touch&${ALARM_Q}&flowmeter=1${insetQ}&commission=${encodeURIComponent("Local only")}`);
        await page.waitForSelector('.sia-hmi [data-id="loading-overlay"].hidden', { state: "attached" });
        await page.waitForTimeout(150);

        const m = await page.evaluate(measure);
        assert.ok(m.doc[0] <= w && m.doc[1] <= h, `page scrolls: ${m.doc}`);
        for (const [label, v] of [["content", m.content], ["body", m.body]]) {
          assert.ok(v[2] <= v[3] + 1, `${label} overflows vertically with the flow gear: ${v}`);
        }
        for (const t of m.tiles) assert.ok(t.bottom <= m.barTop + 0.5, `${t.name} under the bar`);

        const g = await page.evaluate(measureAlarmGears);
        const gctx = JSON.stringify(g);
        const b = g.gears["flow-gear"];
        assert.ok(b, `flow-gear not shown: ${gctx}`);
        assert.ok(b.w >= 44 && b.h >= 44, `flow-gear ${b.w}x${b.h} < 44px`);
        const tile = g.pump;
        assert.ok(b.top >= tile.top - 0.5 && b.right <= tile.right + 0.5 && b.left >= tile.left - 0.5, `flow-gear outside its tile: ${gctx}`);
        assert.ok(b.right >= tile.right - 20 && b.top <= tile.top + 20, `flow-gear not top-right: ${gctx}`);
        for (const o of g.others) {
          const overlap = b.left < o.right && o.left < b.right && b.top < o.bottom && o.top < b.bottom;
          assert.ok(!overlap, `flow-gear overlaps ${o.id}: ${gctx}`);
        }

        await page.click('.sia-hmi [data-id="flow-gear"]');
        await page.waitForSelector('.sia-hmi [data-id="alarm-panel"]', { state: "visible" });
        const p = await page.evaluate(measureAlarmPanel);
        assertAlarmPanel(p, w, h, gap, "Flow Alarms", [["low_flow_percent", "flow_l_delay"], ["low_low_flow_percent", "flow_ll_delay"]], "Flow (% of target)");
        if (shoot) await page.screenshot({ path: path.join(ALARM_SHOTS, `alarm-flow-${w}x${h}.png`) });

        // The L warning's delay: 120 -> 30 s, read back from its tag.
        await page.click('.sia-hmi [data-alarm="flow_l_delay"]');
        await page.click('.sia-hmi [data-key="clear"]');
        for (const key of ["3", "0"]) await page.click(`.sia-hmi [data-key="${key}"]`);
        await page.click('.sia-hmi [data-id="keypad-ok"]');
        await page.click('.sia-hmi [data-id="confirm-ok"]');
        await page.waitForFunction(
          () => document.querySelector('.sia-hmi [data-alarm="flow_l_delay"] [data-alarm-value]')?.textContent === "30 s",
        );
        const sent = await page.evaluate(() => window.__rpcLog.at(-1));
        assert.equal(sent.method, "flow_l_delay");
        assert.equal(sent.request, 30);
      } finally {
        await page.close();
      }
    });
  }
}

// A phone in the cloud (the narrow two-column popover): each cell's range
// hint wraps rather than being cut off (the kPa H warning's "... 0 = off"),
// and the two values of a row still sit side by side.
test("cloud at phone width: the alarm popovers' range hints are whole", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(`${base}?host=cloud&width=358&mode=Touch&${ALARM_Q}&flowmeter=1`);
    await page.waitForSelector('.sia-hmi [data-id="loading-overlay"].hidden', { state: "attached" });
    await page.waitForTimeout(150);
    for (const gear of ["tank-gear", "pressure-gear", "flow-gear"]) {
      await page.click(`.sia-hmi [data-id="${gear}"]`);
      await page.waitForSelector('.sia-hmi [data-id="alarm-panel"]', { state: "visible" });
      const p = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        rows: [...document.querySelectorAll('.sia-hmi [data-id="alarm-rows"] .alarm-row')].map((r) =>
          [...r.querySelectorAll("[data-alarm]")].map((c) => {
            const range = c.querySelector("[data-alarm-range]");
            const v = c.querySelector("[data-alarm-value]");
            const b = c.getBoundingClientRect();
            return {
              id: c.dataset.alarm,
              top: b.top,
              left: b.left,
              right: b.right,
              range: range.textContent,
              rangeCut: range.scrollWidth - range.clientWidth,
              valueCut: v.scrollWidth - v.clientWidth,
            };
          }),
        ),
      }));
      const ctx = `${gear}: ${JSON.stringify(p)}`;
      assert.ok(p.doc <= 390, `page scrolls sideways: ${ctx}`);
      assert.equal(p.rows.length, 2, ctx);
      for (const [value, delay] of p.rows) {
        assert.ok(Math.abs(value.top - delay.top) <= 1 && delay.left >= value.right, `${delay.id} not beside ${value.id}: ${ctx}`);
        for (const c of [value, delay]) {
          assert.ok(c.rangeCut <= 1, `${c.id} range "${c.range}" cut off: ${ctx}`);
          assert.ok(c.valueCut <= 1, `${c.id} value cut off: ${ctx}`);
        }
      }
      await page.click('.sia-hmi [data-id="alarm-panel-close"]');
    }
  } finally {
    await page.close();
  }
});

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

// --- Refresh button (local kiosk only) ------------------------------------------
//
// The header's top-right corner, just right of the connection status: a
// >= 44 px target inside the header, clear of the title and the status block,
// in every mode, with and without the cover-plate insets; its confirmation
// fits the screen. None in the cloud. Screenshots (1024x600 Touch):
// HEADER_SHOTS=<dir> (header-refresh-1024x600.png the header strip,
// screen-refresh-1024x600.png the whole screen, the same with -inset, and
// header-refresh-confirm-1024x600.png with the confirmation open)

const HEADER_SHOTS = process.env.HEADER_SHOTS;

function measureHeader() {
  const vis = (el) => el && el.getClientRects().length > 0 && getComputedStyle(el).display !== "none";
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
  };
  const q = (sel) => document.querySelector(`.sia-hmi ${sel}`);
  const btn = q('[data-id="reload-btn"]');
  const header = q(".dashboard-header");
  const title = q(".dashboard-header h1");
  return {
    btn: vis(btn) ? { ...box(btn), label: btn.getAttribute("aria-label") } : null,
    header: box(header),
    title: box(title),
    titleOverflow: title.scrollWidth - title.clientWidth,
    info: box(q(".header-info")),
    status: box(q('[data-id="connection-status"]')),
    others: [...document.querySelectorAll(".sia-hmi .dashboard-container button")]
      .filter((b) => b !== btn && vis(b))
      .map((b) => ({ id: b.dataset.id, ...box(b) })),
    doc: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
  };
}

const overlaps = (a, b) =>
  a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

const HEADER_CASES = [
  { name: "running", q: "scenario=running" },
  { name: "faulted + warning + solar", q: "scenario=faulted&warning=1&solar=1" },
  { name: "calibrate tile, tank L + mm, faulted + two warnings", q: "scenario=faulted&warning=2&cal=manual&tank=L,mm" },
];

for (const [w, h] of SIZES) {
  for (const mode of MODES) {
    for (const [insetName, insetQ, gap] of [["no inset", "", 0], ["inset 2 mm + popover 10 mm", `&${INSET_Q}`, INSET_PX]]) {
      for (const c of HEADER_CASES) {
        test(`${w}x${h} ${mode}, ${insetName}, ${c.name}: Refresh button top right of the header`, async () => {
          const page = await browser.newPage({ viewport: { width: w, height: h } });
          try {
            await page.goto(`${base}?host=local&mode=${encodeURIComponent(mode)}${insetQ}&${c.q}`);
            await page.waitForSelector('.sia-hmi [data-id="loading-overlay"].hidden', { state: "attached" });
            await page.waitForTimeout(150);
            const m = await page.evaluate(measureHeader);
            const ctx = JSON.stringify(m);
            assert.ok(m.doc[0] <= w && m.doc[1] <= h, `page scrolls: ${ctx}`);
            assert.ok(m.btn, `Refresh not shown: ${ctx}`);
            assert.equal(m.btn.label, "Refresh");
            // >= 44 px, inside the header, inside the plate.
            assert.ok(m.btn.w >= 44 && m.btn.h >= 44, `Refresh ${m.btn.w}x${m.btn.h} < 44px`);
            const hd = m.header;
            assert.ok(
              m.btn.left >= hd.left - 0.5 &&
                m.btn.right <= hd.right + 0.5 &&
                m.btn.top >= hd.top - 0.5 &&
                m.btn.bottom <= hd.bottom + 0.5,
              `Refresh outside the header: ${ctx}`,
            );
            assertInside(m.btn, w, h, gap, "Refresh");
            // Top right: at the header's right edge, right of the status block.
            assert.ok(m.btn.right >= hd.right - 24, `Refresh not at the right edge: ${ctx}`);
            assert.ok(m.btn.top <= hd.top + 16, `Refresh not at the top: ${ctx}`);
            assert.ok(m.btn.left >= m.info.right - 0.5, `Refresh not right of the status: ${ctx}`);
            // Clear of the title and the status; the title not squeezed.
            for (const [label, b] of [["title", m.title], ["status block", m.info], ["status", m.status]]) {
              assert.ok(!overlaps(m.btn, b), `Refresh overlaps the ${label}: ${ctx}`);
            }
            assert.ok(!overlaps(m.title, m.info), `title overlaps the status: ${ctx}`);
            assert.ok(m.titleOverflow <= 1, `title clipped: ${ctx}`);
            assert.ok(m.info.left >= hd.left && m.info.right <= hd.right + 0.5, `status off the header: ${ctx}`);
            for (const o of m.others) assert.ok(!overlaps(m.btn, o), `Refresh overlaps ${o.id}: ${ctx}`);
            const shoot = HEADER_SHOTS && w === 1024 && h === 600 && mode === "Touch" && c.name === "running";
            if (shoot) {
              fs.mkdirSync(HEADER_SHOTS, { recursive: true });
              const suffix = insetQ ? "-inset" : "";
              const clip = { x: 0, y: 0, width: w, height: Math.min(h, Math.ceil(hd.bottom + 8)) };
              await page.screenshot({ path: path.join(HEADER_SHOTS, `header-refresh-${w}x${h}${suffix}.png`), clip });
              await page.screenshot({ path: path.join(HEADER_SHOTS, `screen-refresh-${w}x${h}${suffix}.png`) });
            }

            // Tap: the confirmation opens, on screen; Cancel closes it.
            await page.click('.sia-hmi [data-id="reload-btn"]');
            const cf = await page.evaluate(() => {
              const r = document.querySelector('.sia-hmi [data-id="confirm"] .confirm-box').getBoundingClientRect();
              return {
                open: !document.querySelector('.sia-hmi [data-id="confirm"]').classList.contains("hidden"),
                text: document.querySelector('.sia-hmi [data-id="confirm-message"]').textContent,
                left: r.left,
                top: r.top,
                right: r.right,
                bottom: r.bottom,
              };
            });
            assert.ok(cf.open, "confirmation open");
            assert.equal(cf.text, "Reload the screen? Live data returns in a few seconds.");
            assertInside(cf, w, h, 0, "confirmation");
            if (shoot && !insetQ) {
              await page.screenshot({ path: path.join(HEADER_SHOTS, `header-refresh-confirm-${w}x${h}.png`) });
            }
            await page.click('.sia-hmi [data-id="confirm-cancel"]');
            assert.equal(await page.isVisible('.sia-hmi [data-id="confirm"]'), false, "Cancel closes it");
          } finally {
            await page.close();
          }
        });
      }
    }
  }
}

test("cloud: no Refresh button", async () => {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  try {
    await page.goto(`${base}?host=cloud&mode=Touch&scenario=running`);
    await page.waitForSelector('.sia-hmi [data-id="loading-overlay"].hidden', { state: "attached" });
    assert.equal(await page.$('.sia-hmi [data-id="reload-btn"]'), null);
    assert.ok(await page.$(".sia-hmi .dashboard-header"), "header rendered");
  } finally {
    await page.close();
  }
});
