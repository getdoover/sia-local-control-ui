// End-to-end command check: the real widget (mock host build) in headless
// Chromium, driven through its on-screen controls, as the local panel and as
// the cloud. Asserts every RPC body the widget hands the injected client:
//
//   { method, request, app_key: <first pump_controllers entry>, actor }
//
// and that the actor follows the HOST (decided from the injected client, not
// the URL): exactly {name: "Local HMI"} on the device agent's widget host,
// the signed-in user in the cloud, never "Local HMI" there. Read Only sends
// nothing.
//
// Run: npm run test:layout   (builds the mock host first)
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, "..", "mock-host", "dist");
const CTRL = "sia_injection_controller_1";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const ACTORS = {
  local: { name: "Local HMI" },
  // mock-host/mockClient.ts users.getMe()
  cloud: { id: "42", name: "Jane Operator", email: "jane@example.com" },
};

// Each on-screen action and the exact RPC it must produce.
const EXPECTED = [
  ["set_pump_state", "stop"],
  ["set_pump_state", "start"],
  ["nudge_rate", "+1"],
  ["nudge_rate", "-1"],
  ["set_target_rate", 14],
  ["last_calibration_factor", 1.05],
  ["reset_fault", {}],
  ["reset_vsd_fault", {}],
];

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

let server;
let browser;
let base;

test.before(async () => {
  assert.ok(fs.existsSync(path.join(DIST, "index.html")), "run npm run build:mock first");
  server = await serve();
  base = `http://127.0.0.1:${server.address().port}/index.html`;
  browser = await chromium.launch();
});

test.after(async () => {
  await browser?.close();
  server?.close();
});

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  await page.goto(`${base}?${query}`);
  await page.waitForSelector('.sia-hmi [data-id="loading-overlay"].hidden', { state: "attached" });
  return page;
}

const click = (page, id) => page.click(`.sia-hmi [data-id="${id}"]`);
const posted = (page) => page.evaluate(() => window.__rpcLog ?? []);

/** Click, then wait until the widget has handed the client one more RPC and
 *  the button has left its pending state. */
async function act(page, n, steps) {
  for (const step of steps) await step();
  await page.waitForFunction((k) => (window.__rpcLog ?? []).length >= k, n);
  await page.waitForFunction(() => !document.querySelector(".sia-hmi .pending"));
}

async function keypad(page, id, keys) {
  await click(page, id);
  await page.click('.sia-hmi [data-key="clear"]');
  for (const k of keys) await page.click(`.sia-hmi [data-key="${k}"]`);
  await click(page, "keypad-ok");
}

for (const host of ["local", "cloud"]) {
  test(`${host} host, Touch: every control sends its RPC with the ${host} actor`, async () => {
    // control=cloud: the mock controller accepts cloud starts too, so every
    // command gets an answer and the next control is free.
    const page = await open(`host=${host}&mode=Touch&scenario=running&control=cloud`);
    try {
      const badge = await page.textContent('.sia-hmi [data-id="host-badge"]');
      assert.equal(badge.trim(), `${host === "local" ? "Local panel" : "Cloud"} · Touch`);

      await act(page, 1, [() => click(page, "touch-stop")]);
      await act(page, 2, [() => click(page, "touch-start")]);
      await act(page, 3, [() => click(page, "touch-rate-up")]);
      await act(page, 4, [() => click(page, "touch-rate-down")]);
      // 12.5 -> 14 is under the 20% confirmation threshold: sent directly.
      await act(page, 5, [() => keypad(page, "touch-rate", ["1", "4"])]);
      // Calibration factor changes always confirm first.
      await act(page, 6, [
        () => keypad(page, "touch-cal", ["1", ".", "0", "5"]),
        () => click(page, "confirm-ok"),
      ]);
      await act(page, 7, [() => click(page, "touch-reset")]);
      await act(page, 8, [() => click(page, "reset-vsd-btn")]);

      const log = await posted(page);
      assert.equal(log.length, EXPECTED.length, JSON.stringify(log));
      EXPECTED.forEach(([method, request], i) => {
        assert.deepEqual(
          log[i],
          { method, request, app_key: CTRL, actor: ACTORS[host] },
          `RPC ${i}: ${JSON.stringify(log[i])}`,
        );
      });
      if (host === "cloud") {
        for (const body of log) assert.notEqual(body.actor.name, "Local HMI");
      }
    } finally {
      await page.close();
    }
  });
}

test("cloud host: a refusal shows the controller's reason and the actor stays the cloud user", async () => {
  // control=local: the mock controller refuses cloud starts (REMOTE_DENIED).
  const page = await open("host=cloud&mode=Touch&scenario=standby&control=local");
  try {
    await act(page, 1, [() => click(page, "touch-start")]);
    const [body] = await posted(page);
    assert.deepEqual(body.actor, ACTORS.cloud);
    await page.waitForFunction(() =>
      /Refused: cloud may not start/.test(
        document.querySelector('.sia-hmi [data-id="command-toast"]')?.textContent ?? "",
      ),
    );
  } finally {
    await page.close();
  }
});

for (const host of ["local", "cloud"]) {
  test(`${host} host, Read Only: no controls and nothing is sent`, async () => {
    const page = await open(`host=${host}&mode=${encodeURIComponent("Read Only")}&scenario=faulted`);
    try {
      assert.equal(await page.isVisible('.sia-hmi [data-id="touch-bar"]'), false);
      assert.equal(await page.isVisible('.sia-hmi [data-id="reset-vsd-btn"]'), false);
      await page.waitForTimeout(300);
      assert.deepEqual(await posted(page), []);
    } finally {
      await page.close();
    }
  });
}

// --- VSD commissioning panel: straight to the Techtop app on dv-rpc -----------

const TECHTOP = "techtop_motor_controller_1";
const vsdLog = (page) => page.evaluate(() => window.__vsdLog ?? []);

async function openPanel(page) {
  await click(page, "vsd-gear");
  await page.waitForSelector('.sia-hmi .vsd-param', { state: "visible" });
}

async function writeParam(page, id, keys) {
  await page.click(`.sia-hmi [data-param="${id}"]`);
  await page.click('.sia-hmi [data-key="clear"]');
  for (const k of keys) await page.click(`.sia-hmi [data-key="${k}"]`);
  await click(page, "keypad-ok");
  await click(page, "confirm-ok");
  await page.waitForFunction(
    (pid) => {
      const row = document.querySelector(`.sia-hmi [data-param="${pid}"]`);
      return row && (row.classList.contains("ok") || row.classList.contains("error"));
    },
    id,
  );
}

for (const [host, commission] of [["local", "Local only"], ["cloud", "Local and cloud"]]) {
  test(`${host} host, ${commission}: diagnostics, parameters and a write go to the Techtop app`, async () => {
    const page = await open(
      `host=${host}&mode=Touch&scenario=standby&control=cloud&commission=${encodeURIComponent(commission)}`,
    );
    try {
      await openPanel(page);
      await writeParam(page, "P-01", ["5", "5"]);
      const row = await page.textContent('.sia-hmi [data-param="P-01"]');
      assert.match(row, /55\.0/);
      assert.match(row, /drive reads 55\.0 Hz/);
      const log = await vsdLog(page);
      for (const body of log) {
        assert.equal(body.channel, "dv-rpc");
        assert.equal(body.app_key, TECHTOP);
        assert.deepEqual(body.actor, ACTORS[host]);
      }
      const methods = log.map((b) => b.method);
      assert.ok(methods.includes("get_diagnostics") && methods.includes("read_parameters"), methods.join());
      const writes = log.filter((b) => b.method === "write_parameter");
      assert.deepEqual(writes.map((b) => b.request), [{ parameter: "P-01", value: 55 }]);
      // Nothing about the panel reached the pump controller.
      assert.deepEqual(await posted(page), []);
    } finally {
      await page.close();
    }
  });
}

test("cloud host, Local only: diagnostics shown, writes blocked, nothing written", async () => {
  const page = await open(`host=cloud&mode=Touch&scenario=running&commission=${encodeURIComponent("Local only")}`);
  try {
    await openPanel(page);
    await page.click('.sia-hmi [data-param="P-01"]');
    assert.equal(await page.isVisible('.sia-hmi [data-id="keypad"]'), false);
    await page.waitForFunction(() =>
      /local panel only/.test(document.querySelector('.sia-hmi [data-id="command-toast"]')?.textContent ?? ""),
    );
    const log = await vsdLog(page);
    assert.ok(log.some((b) => b.method === "get_diagnostics"));
    assert.ok(!log.some((b) => b.method === "write_parameter"), JSON.stringify(log));
  } finally {
    await page.close();
  }
});

test("local host: a stop-only parameter while running shows the DRIVE_RUNNING message", async () => {
  const page = await open(`host=local&mode=Touch&scenario=running&commission=${encodeURIComponent("Local only")}`);
  try {
    await openPanel(page);
    await writeParam(page, "P-09", ["6", "0"]);
    const row = await page.textContent('.sia-hmi [data-param="P-09"]');
    assert.match(row, /Stop the pump first/);
  } finally {
    await page.close();
  }
});

test("local host: Reset VSD Fault in the popover is the controller's reset_vsd_fault", async () => {
  const page = await open(`host=local&mode=Touch&scenario=faulted&commission=${encodeURIComponent("Local only")}`);
  try {
    await openPanel(page);
    await act(page, 1, [() => click(page, "vsd-panel-reset")]);
    assert.deepEqual(await posted(page), [
      { method: "reset_vsd_fault", request: {}, app_key: CTRL, actor: ACTORS.local },
    ]);
    assert.ok(!(await vsdLog(page)).some((b) => b.method === "reset_fault"));
  } finally {
    await page.close();
  }
});

test("older Techtop app: the popover falls back to get_status", async () => {
  const page = await open(`host=local&mode=Touch&scenario=running&commission=${encodeURIComponent("Local only")}&legacy=1`);
  try {
    await openPanel(page);
    await page.waitForFunction(() =>
      /basic status/.test(document.querySelector('.sia-hmi [data-id="vsd-diag-status"]')?.textContent ?? ""),
    );
    const methods = (await vsdLog(page)).map((b) => b.method);
    assert.ok(methods.includes("get_status"), methods.join());
    assert.equal(
      await page.textContent('.sia-hmi [data-diag="output_hz"] .diag-number'),
      "42.5",
    );
  } finally {
    await page.close();
  }
});
