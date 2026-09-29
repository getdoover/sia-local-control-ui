// VSD commissioning panel: config and access, the RPCs to the Techtop app
// (channel, body, actor, fallback to get_status, write + read-back), the
// operator text, and the popover in the render core (gear, diagnostics,
// parameter list, keypad -> confirm -> write -> read-back, Local only).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EMPTY_VALUE, formatDiagnostic, VSD_POLL_MS } from "../src/core/hmi-core.js";
import { resolveConfig } from "../src/lib/assembleDashboardData.ts";
import {
  buildWriteRequest,
  checkParameterValue,
  createVsdPanelApi,
  diagnosticsFromStatus,
  explainVsdError,
  isUnknownMethod,
  normaliseCommissioning,
  normaliseDiagnostics,
  normaliseParameters,
  readBackMatches,
  stepDecimals,
  VSD_COMMISSIONING_OPTIONS,
  VSD_RPC_CHANNEL,
  vsdPanelAccess,
  WRITE_LOCAL_ONLY_TEXT,
} from "../src/lib/vsdPanel.ts";
import { deployment, fakeClient, flush, isHidden, mountHmi, withFeatures } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "..", "tests", "fixtures", "kuwait_foamer_hmi_config.json");
const APP = "sia_local_control_ui_1";
const TECHTOP = "techtop_motor_controller_1";
const AGENT = "agent-1";

const kuwait = (over = {}) => {
  const data = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  delete data._comment;
  return { ...data, ...over };
};

// A read_parameters answer (the contract shape).
const PARAMS = {
  parameters: [
    { id: "P-01", name: "Maximum frequency", value: 50, units: "Hz", min: 0, max: 100, step: 0.1, writable: true, stop_required: false, description: "Max speed" },
    { id: "P-09", name: "Motor rated frequency", value: 50, units: "Hz", min: 25, max: 500, step: 1, writable: true, stop_required: true, description: "Nameplate" },
    { id: "P-12", name: "Primary command source", value: 4, units: "", min: 0, max: 13, step: 1, writable: false, stop_required: true, description: "Modbus" },
  ],
};

const DIAG = {
  output_hz: 42.5,
  output_current_a: 2.8,
  motor_rpm: 1224,
  dc_bus_v: 562,
  heatsink_c: 38,
  drive_state: "Running",
  trip_code: 0,
  trip_description: null,
  run_hours: 1287,
  recent_trips: [3, 21],
  comms_ok: true,
};

const LOCAL_ACCESS = { enabled: true, canWrite: true, writeBlockedReason: "" };
const CLOUD_LOCAL_ONLY = vsdPanelAccess("local_only", "cloud", TECHTOP);

// --- config + access ------------------------------------------------------------

test("existing (Kuwait) config: no VSD motor app, commissioning hidden, no gear", () => {
  const cfg = resolveConfig(APP, deployment(kuwait(), APP));
  assert.equal(cfg.vsdMotorApp, null);
  assert.equal(cfg.vsdCommissioning, "hidden");
  for (const host of ["local", "cloud"]) {
    assert.equal(vsdPanelAccess(cfg.vsdCommissioning, host, cfg.vsdMotorApp).enabled, false);
  }
});

test("vsd_motor_app and vsd_commissioning are read from this install's config", () => {
  const cfg = resolveConfig(
    APP,
    deployment({ vsd_motor_app: TECHTOP, vsd_commissioning: "Local only" }, APP),
  );
  assert.equal(cfg.vsdMotorApp, TECHTOP);
  assert.equal(cfg.vsdCommissioning, "local_only");
});

test("commissioning options: Hidden default, unknown values hidden", () => {
  assert.deepEqual([...VSD_COMMISSIONING_OPTIONS], ["Hidden", "Local only", "Local and cloud"]);
  assert.equal(normaliseCommissioning(undefined), "hidden");
  assert.equal(normaliseCommissioning("Hidden"), "hidden");
  assert.equal(normaliseCommissioning("local ONLY "), "local_only");
  assert.equal(normaliseCommissioning("Local and cloud"), "local_and_cloud");
  assert.equal(normaliseCommissioning("Everywhere"), "hidden");
});

test("access: gear needs an app and a mode; Local only blocks cloud writes", () => {
  assert.equal(vsdPanelAccess("local_and_cloud", "local", null).enabled, false);
  assert.equal(vsdPanelAccess("hidden", "local", TECHTOP).enabled, false);
  assert.deepEqual(vsdPanelAccess("local_only", "local", TECHTOP), LOCAL_ACCESS);
  assert.deepEqual(CLOUD_LOCAL_ONLY, {
    enabled: true,
    canWrite: false,
    writeBlockedReason: WRITE_LOCAL_ONLY_TEXT,
  });
  assert.deepEqual(vsdPanelAccess("local_and_cloud", "cloud", TECHTOP), LOCAL_ACCESS);
});

// --- normalising answers ------------------------------------------------------------

test("diagnostics: every contract field, nulls kept as null", () => {
  const d = normaliseDiagnostics(DIAG);
  assert.deepEqual(d, { ...DIAG, source: "diagnostics" });
  const empty = normaliseDiagnostics({});
  for (const [k, v] of Object.entries(empty)) {
    if (k !== "source") assert.equal(v, null, k);
  }
});

test("get_status fallback maps the older status_dict fields", () => {
  const d = diagnosticsFromStatus({
    comms_active: true,
    drive_state: "running",
    trip_code: null,
    trip_description: null,
    output_frequency_hz: 42.5,
    motor_current_a: 2.8,
    dc_bus_voltage_v: 562,
  });
  assert.equal(d.source, "status");
  assert.equal(d.output_hz, 42.5);
  assert.equal(d.output_current_a, 2.8);
  assert.equal(d.dc_bus_v, 562);
  assert.equal(d.comms_ok, true);
  assert.equal(d.heatsink_c, null);
  assert.equal(d.run_hours, null);
  assert.equal(d.recent_trips, null);
});

test("parameters: shape, and no keypad edit without a range", () => {
  const ps = normaliseParameters({
    parameters: [...PARAMS.parameters, { id: "P-99", writable: true }, { name: "no id" }],
  });
  assert.deepEqual(ps.map((p) => p.id), ["P-01", "P-09", "P-12", "P-99"]);
  assert.equal(ps[0].writable, true);
  assert.equal(ps[2].writable, false);
  assert.equal(ps[3].writable, false, "a writable parameter without min/max stays read only");
  assert.deepEqual(normaliseParameters(null), []);
});

test("step decimals, write rounding and read-back comparison", () => {
  assert.equal(stepDecimals(0.1), 1);
  assert.equal(stepDecimals(1), 0);
  assert.equal(stepDecimals(0.01), 2);
  assert.equal(stepDecimals(null), 2);
  const [p01] = normaliseParameters(PARAMS);
  assert.deepEqual(buildWriteRequest(p01, 55.04), { parameter: "P-01", value: 55 });
  assert.ok(readBackMatches(p01, 55, 55.0));
  assert.ok(!readBackMatches(p01, 55, 54.8));
  assert.ok(!readBackMatches(p01, 55, null));
});

test("out-of-range and read-only values are refused before anything is sent", () => {
  const [p01, , p12] = normaliseParameters(PARAMS);
  assert.equal(checkParameterValue(p01, 100.1).code, "OUT_OF_RANGE");
  assert.match(checkParameterValue(p01, -1).message, /P-01 must be 0 to 100 Hz/);
  assert.equal(checkParameterValue(p01, "x").code, "INVALID");
  assert.equal(checkParameterValue(p12, 4).code, "NOT_ALLOWED");
  assert.equal(checkParameterValue(p01, 100), null);
  assert.equal(checkParameterValue(p01, 0), null);
});

test("every Techtop error code has its own operator message", () => {
  const texts = new Set();
  for (const code of ["DRIVE_RUNNING", "OUT_OF_RANGE", "NOT_ALLOWED", "READBACK_MISMATCH", "COMMS_ERROR"]) {
    const ack = explainVsdError(code, "raw drive text");
    assert.equal(ack.ok, false);
    assert.equal(ack.code, code);
    assert.doesNotMatch(ack.message, /raw drive text/);
    texts.add(ack.message);
  }
  assert.equal(texts.size, 5);
  assert.match(explainVsdError("DRIVE_RUNNING", "").message, /Stop the pump first/);
  assert.equal(explainVsdError("WEIRD", "because").message, "Refused: because");
});

test("unknown method: explicit codes, and a timeout (pydoover never answers)", () => {
  assert.ok(isUnknownMethod("TIMEOUT"));
  assert.ok(isUnknownMethod("METHOD_NOT_FOUND"));
  assert.ok(isUnknownMethod("ERROR", "Unknown method get_diagnostics"));
  assert.ok(!isUnknownMethod("COMMS_ERROR", "no answer"));
  assert.ok(!isUnknownMethod(undefined));
});

// --- transport: the real RpcDispatcher, as both hosts use ------------------------------

function apiFor(client, { access = LOCAL_ACCESS, actor = { name: "Local HMI" }, timeoutMs = 20_000 } = {}) {
  return createVsdPanelApi(() => ({ client, agentId: AGENT, appKey: TECHTOP, actor, timeoutMs, access }));
}

const lastPosted = (client) => client.posted[client.posted.length - 1];

test("get_diagnostics goes to the Techtop app on dv-rpc with the actor", async () => {
  const client = fakeClient();
  const api = apiFor(client);
  const pending = api.diagnostics();
  await flush();
  const msg = lastPosted(client);
  assert.equal(msg.agentId, AGENT);
  assert.equal(msg.channelName, VSD_RPC_CHANNEL);
  assert.equal(VSD_RPC_CHANNEL, "dv-rpc");
  assert.deepEqual(
    { type: msg.data.type, method: msg.data.method, request: msg.data.request, app_key: msg.data.app_key, actor: msg.data.actor },
    { type: "rpc", method: "get_diagnostics", request: {}, app_key: TECHTOP, actor: { name: "Local HMI" } },
  );
  client.respond({ code: "success" }, DIAG);
  const ack = await pending;
  assert.equal(ack.ok, true);
  assert.equal(ack.result.output_hz, 42.5);
  assert.equal(ack.result.source, "diagnostics");
});

test("an older Techtop app: get_diagnostics unknown -> get_status, and it sticks", async () => {
  const client = fakeClient();
  const api = apiFor(client);
  let pending = api.diagnostics();
  await flush();
  client.respond({ code: "error", message: { code: "METHOD_NOT_FOUND", message: "unknown method" } });
  await flush();
  assert.equal(lastPosted(client).data.method, "get_status");
  client.respond({ code: "success" }, { output_frequency_hz: 12, comms_active: false });
  let ack = await pending;
  assert.equal(ack.ok, true);
  assert.equal(ack.result.source, "status");
  assert.equal(ack.result.output_hz, 12);
  assert.equal(ack.result.comms_ok, false);
  // Next poll goes straight to get_status.
  pending = api.diagnostics();
  await flush();
  assert.equal(lastPosted(client).data.method, "get_status");
  client.respond({ code: "success" }, {});
  ack = await pending;
  assert.equal(ack.ok, true);
  assert.equal(client.posted.length, 3);
});

test("a timed-out get_diagnostics (pydoover drops unknown methods) also falls back", async () => {
  // A client whose dv-rpc never answers get_diagnostics.
  const sent = [];
  const client = {
    rpc: {
      send: (_ch, body) => {
        sent.push(body.method);
        if (body.method === "get_diagnostics") return Promise.reject(new Error("RPC timed out"));
        return Promise.resolve({ drive_state: "stopped" });
      },
    },
  };
  const ack = await apiFor(client).diagnostics();
  assert.deepEqual(sent, ["get_diagnostics", "get_status"]);
  assert.equal(ack.ok, true);
  assert.equal(ack.result.drive_state, "stopped");
});

test("a drive comms failure is NOT mistaken for an old app", async () => {
  const client = fakeClient();
  const pending = apiFor(client).diagnostics();
  await flush();
  client.respond({ code: "error", message: { code: "COMMS_ERROR", message: "modbus timeout" } });
  const ack = await pending;
  assert.equal(ack.ok, false);
  assert.equal(ack.code, "COMMS_ERROR");
  assert.equal(client.posted.length, 1);
});

test("read_parameters returns the parameter list", async () => {
  const client = fakeClient();
  const pending = apiFor(client).parameters();
  await flush();
  assert.equal(lastPosted(client).data.method, "read_parameters");
  assert.deepEqual(lastPosted(client).data.request, {});
  client.respond({ code: "success" }, PARAMS);
  const ack = await pending;
  assert.deepEqual(ack.result.map((p) => p.id), ["P-01", "P-09", "P-12"]);
});

test("write_parameter sends {parameter, value} and returns the read-back", async () => {
  const client = fakeClient();
  const [p01] = normaliseParameters(PARAMS);
  const pending = apiFor(client).write(p01, 55);
  await flush();
  const msg = lastPosted(client);
  assert.equal(msg.channelName, "dv-rpc");
  assert.equal(msg.data.method, "write_parameter");
  assert.equal(msg.data.app_key, TECHTOP);
  assert.deepEqual(msg.data.request, { parameter: "P-01", value: 55 });
  client.respond({ code: "success" }, { parameter: "P-01", value: 55 });
  const ack = await pending;
  assert.deepEqual(ack, { ok: true, result: { parameter: "P-01", value: 55 } });
});

test("a read-back that differs is reported as a mismatch with the drive's value", async () => {
  const client = fakeClient();
  const [p01] = normaliseParameters(PARAMS);
  const pending = apiFor(client).write(p01, 55);
  await flush();
  client.respond({ code: "success" }, { parameter: "P-01", value: 50 });
  const ack = await pending;
  assert.equal(ack.ok, false);
  assert.equal(ack.code, "READBACK_MISMATCH");
  assert.equal(ack.result.value, 50);
});

test("DRIVE_RUNNING from the Techtop app becomes the stop-first message", async () => {
  const client = fakeClient();
  const [, p09] = normaliseParameters(PARAMS);
  const pending = apiFor(client).write(p09, 60);
  await flush();
  client.respond({ code: "error", message: { code: "DRIVE_RUNNING", message: "running" } });
  const ack = await pending;
  assert.equal(ack.code, "DRIVE_RUNNING");
  assert.match(ack.message, /Stop the pump first/);
});

test("out-of-range write: refused locally, nothing sent", async () => {
  const client = fakeClient();
  const [p01] = normaliseParameters(PARAMS);
  const ack = await apiFor(client).write(p01, 120);
  assert.equal(ack.code, "OUT_OF_RANGE");
  assert.equal(client.posted.length, 0);
});

test("cloud under Local only: write blocked, nothing sent", async () => {
  const client = fakeClient({ withUser: { id: "42", name: "Jane" } });
  const [p01] = normaliseParameters(PARAMS);
  const ack = await apiFor(client, { access: CLOUD_LOCAL_ONLY, actor: { id: "42", name: "Jane" } }).write(p01, 55);
  assert.equal(ack.ok, false);
  assert.equal(ack.code, "LOCAL_ONLY");
  assert.equal(ack.message, WRITE_LOCAL_ONLY_TEXT);
  assert.equal(client.posted.length, 0);
});

// --- render core: gear + popover ------------------------------------------------------

/** A scripted vsdPanel api: records calls, answers from `replies`. */
function scriptedPanel(replies = {}) {
  const calls = [];
  const answer = (name, ...args) => {
    calls.push([name, ...args]);
    const r = replies[name];
    return Promise.resolve(typeof r === "function" ? r(...args) : r);
  };
  return {
    calls,
    api: {
      diagnostics: () => answer("diagnostics"),
      parameters: () => answer("parameters"),
      write: (p, v) => answer("write", p.id, v),
    },
  };
}

const OK_REPLIES = {
  diagnostics: { ok: true, result: { ...normaliseDiagnostics(DIAG) } },
  parameters: { ok: true, result: normaliseParameters(PARAMS) },
  write: (id, v) => ({ ok: true, result: { parameter: id, value: v } }),
};

// Every mounted core is destroyed after its test (stops an open panel's poll).
const mounted = [];
test.afterEach(() => {
  while (mounted.length) mounted.pop().hmi.destroy();
});

function mountPanel({ access = LOCAL_ACCESS, replies = OK_REPLIES, payload = withFeatures() } = {}) {
  const panel = scriptedPanel(replies);
  const m = mountHmi({ vsdPanel: panel.api });
  mounted.push(m);
  m.render(payload);
  m.hmi.setVsdPanel(access);
  return { ...m, panel };
}

const typeKeys = (m, keys) => {
  m.root.querySelector('.keypad-keys [data-key="clear"]').click();
  for (const k of keys) m.root.querySelector(`.keypad-keys [data-key="${k}"]`).click();
};

test("gear hidden by default (no access given, and Hidden)", () => {
  const m = mountHmi({ vsdPanel: scriptedPanel().api });
  mounted.push(m);
  m.render(withFeatures());
  assert.ok(isHidden(m.byId("vsd-gear")));
  m.hmi.setVsdPanel(vsdPanelAccess("hidden", "local", TECHTOP));
  assert.ok(isHidden(m.byId("vsd-gear")));
  assert.ok(isHidden(m.byId("vsd-panel")));
});

test("gear shows only with a VSD tile and access, and is a >= 44px button", () => {
  const m = mountPanel();
  const gear = m.byId("vsd-gear");
  assert.ok(!isHidden(gear));
  assert.equal(gear.tagName, "BUTTON");
  assert.equal(gear.getAttribute("aria-label"), "VSD commissioning");
  assert.ok(gear.closest('[data-id="vsd-section"]'), "gear lives in the VSD tile");
  // No VSD on the controller: no tile, no gear.
  m.render({ ...withFeatures(), vsd: undefined });
  assert.ok(isHidden(m.byId("vsd-gear")));
});

test("the popover renders diagnostics and the parameter list", async () => {
  const m = mountPanel();
  m.click("vsd-gear");
  assert.ok(!isHidden(m.byId("vsd-panel")));
  await flush();
  const cell = (f) => m.root.querySelector(`[data-diag="${f}"] .diag-number`).textContent;
  assert.equal(cell("output_hz"), "42.5");
  assert.equal(cell("output_current_a"), "2.8");
  assert.equal(cell("motor_rpm"), "1224");
  assert.equal(cell("dc_bus_v"), "562");
  assert.equal(cell("heatsink_c"), "38");
  assert.equal(cell("drive_state"), "Running");
  assert.equal(cell("trip"), "None");
  assert.equal(cell("run_hours"), "1287");
  assert.equal(cell("recent_trips"), "3, 21");
  assert.equal(cell("comms_ok"), "OK");
  assert.equal(m.byId("vsd-diag-status").textContent, "Live");

  const rows = [...m.root.querySelectorAll("[data-param]")];
  assert.deepEqual(rows.map((r) => r.dataset.param), ["P-01", "P-09", "P-12"]);
  const [p01, p09, p12] = rows;
  assert.equal(p01.querySelector(".param-label").textContent, "Maximum frequency");
  assert.equal(p01.querySelector(".param-number").textContent, "50.0");
  assert.equal(p01.querySelector(".param-units").textContent, "Hz");
  assert.equal(p01.querySelector(".param-range").textContent, "0.0 to 100.0 Hz");
  assert.equal(p01.tagName, "BUTTON");
  assert.match(p09.textContent, /Stopped only/);
  assert.equal(p12.tagName, "DIV", "read-only parameter is not a control");
  assert.match(p12.textContent, /Read only/);
});

test("null diagnostics render as an em dash", async () => {
  const m = mountPanel({ replies: { ...OK_REPLIES, diagnostics: { ok: true, result: normaliseDiagnostics({}) } } });
  m.click("vsd-gear");
  await flush();
  for (const el of m.root.querySelectorAll(".diag-number")) assert.equal(el.textContent, EMPTY_VALUE);
  assert.equal(EMPTY_VALUE, "—");
  assert.equal(formatDiagnostic({ trip_code: 7, trip_description: "Over voltage" }, "trip"), "Over voltage · code 7");
});

test("diagnostics poll every 2 s while open and stop when closed", async () => {
  const { mock } = test;
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const m = mountPanel();
    m.click("vsd-gear");
    const count = () => m.panel.calls.filter((c) => c[0] === "diagnostics").length;
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(count(), 1);
    assert.equal(VSD_POLL_MS, 2000);
    mock.timers.tick(1999);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(count(), 1);
    mock.timers.tick(1);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(count(), 2);
    m.click("vsd-panel-close");
    assert.ok(isHidden(m.byId("vsd-panel")));
    mock.timers.tick(10_000);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(count(), 2, "no polling after close");
  } finally {
    mock.timers.reset();
  }
});

test("closes with the X and by tapping outside, not by tapping inside", async () => {
  const m = mountPanel();
  m.click("vsd-gear");
  await flush();
  m.byId("vsd-panel-box").click();
  assert.ok(!isHidden(m.byId("vsd-panel")), "a tap inside keeps it open");
  m.byId("vsd-panel").dispatchEvent(new m.dom.window.MouseEvent("click", { bubbles: true }));
  assert.ok(isHidden(m.byId("vsd-panel")), "a tap on the backdrop closes it");
  m.click("vsd-gear");
  await flush();
  m.click("vsd-panel-close");
  assert.ok(isHidden(m.byId("vsd-panel")));
});

test("write: keypad (range-limited) -> confirm old -> new -> write -> read-back", async () => {
  const m = mountPanel();
  m.click("vsd-gear");
  await flush();
  m.root.querySelector('[data-param="P-01"]').click();
  assert.ok(!isHidden(m.byId("keypad")));
  assert.equal(m.byId("keypad-title").textContent, "P-01 Maximum frequency");
  assert.equal(m.byId("keypad-range").textContent, "Range 0.0 to 100.0 Hz");
  // Out of range: refused on the keypad, nothing sent.
  typeKeys(m, ["1", "2", "0"]);
  m.click("keypad-ok");
  assert.match(m.byId("keypad-error").textContent, /Out of range/);
  assert.ok(!m.panel.calls.some((c) => c[0] === "write"));
  typeKeys(m, ["5", "5"]);
  m.click("keypad-ok");
  assert.ok(isHidden(m.byId("keypad")));
  assert.equal(
    m.byId("confirm-message").textContent,
    "Change P-01 Maximum frequency from 50.0 → 55.0 Hz?",
  );
  m.click("confirm-ok");
  const row = () => m.root.querySelector('[data-param="P-01"]');
  assert.ok(row().classList.contains("pending"));
  assert.match(row().textContent, /Writing/);
  await flush();
  assert.deepEqual(m.panel.calls.find((c) => c[0] === "write"), ["write", "P-01", 55]);
  assert.ok(row().classList.contains("ok"));
  assert.equal(row().querySelector(".param-number").textContent, "55.0");
  assert.match(row().querySelector(".param-note").textContent, /drive reads 55\.0 Hz/);
  assert.ok(!isHidden(m.byId("vsd-panel")), "panel stays open after the write");
});

test("write error: the row shows the operator message and the drive's value", async () => {
  const m = mountPanel({
    replies: {
      ...OK_REPLIES,
      write: () => ({ ...explainVsdError("DRIVE_RUNNING", ""), ok: false }),
    },
  });
  m.click("vsd-gear");
  await flush();
  m.root.querySelector('[data-param="P-09"]').click();
  typeKeys(m, ["6", "0"]);
  m.click("keypad-ok");
  assert.match(m.byId("confirm-message").textContent, /The drive must be stopped\./);
  m.click("confirm-ok");
  await flush();
  const row = m.root.querySelector('[data-param="P-09"]');
  assert.ok(row.classList.contains("error"));
  assert.match(row.textContent, /Stop the pump first/);
  assert.equal(row.querySelector(".param-number").textContent, "50", "value unchanged");
  assert.match(m.byId("command-toast").textContent, /P-09: Stop the pump first/);
});

test("cloud under Local only: diagnostics shown, parameters locked, nothing written", async () => {
  const m = mountPanel({ access: CLOUD_LOCAL_ONLY });
  assert.ok(!isHidden(m.byId("vsd-gear")));
  m.click("vsd-gear");
  await flush();
  assert.equal(m.root.querySelector('[data-diag="output_hz"] .diag-number').textContent, "42.5");
  assert.equal(m.byId("vsd-params-note").textContent, WRITE_LOCAL_ONLY_TEXT);
  const p01 = m.root.querySelector('[data-param="P-01"]');
  assert.equal(p01.tagName, "DIV");
  p01.click();
  assert.ok(isHidden(m.byId("keypad")));
  assert.match(m.byId("command-toast").textContent, /local panel only/);
  assert.ok(!m.panel.calls.some((c) => c[0] === "write"));
});

test("Reset VSD Fault in the popover is the controller's reset_vsd_fault", async () => {
  const m = mountPanel();
  m.click("vsd-gear");
  await flush();
  m.click("vsd-panel-reset");
  await flush();
  assert.deepEqual(m.state.sent, [{ cmd: "reset_vsd_fault", value: null }]);
  assert.ok(!m.panel.calls.some((c) => c[0] === "write"));
});

test("Reset VSD Fault is disabled outside Touch mode; diagnostics still show", async () => {
  const m = mountPanel({ payload: { ...withFeatures(), hmi_mode: "read_only", touch: undefined } });
  m.click("vsd-gear");
  await flush();
  assert.equal(m.byId("vsd-panel-reset").disabled, true);
  m.click("vsd-panel-reset");
  await flush();
  assert.deepEqual(m.state.sent, []);
  assert.equal(m.root.querySelector('[data-diag="output_hz"] .diag-number').textContent, "42.5");
});

test("a parameter edit survives a Read Only re-render (VSD Commissioning governs it)", async () => {
  const payload = { ...withFeatures(), hmi_mode: "read_only", touch: undefined };
  const m = mountPanel({ payload });
  m.click("vsd-gear");
  await flush();
  m.root.querySelector('[data-param="P-01"]').click();
  m.render(payload);
  assert.ok(!isHidden(m.byId("keypad")), "the next tag update does not close the keypad");
});

test("failed parameter read: message and Retry", async () => {
  let fail = true;
  const m = mountPanel({
    replies: {
      ...OK_REPLIES,
      parameters: () => (fail ? explainVsdError("COMMS_ERROR", "") : OK_REPLIES.parameters),
    },
  });
  m.click("vsd-gear");
  await flush();
  assert.match(m.byId("vsd-params").textContent, /No answer from the VSD over Modbus/);
  fail = false;
  m.click("vsd-params-retry");
  await flush();
  assert.equal(m.root.querySelectorAll("[data-param]").length, 3);
});

test("older app via get_status: the status line says so", async () => {
  const m = mountPanel({
    replies: { ...OK_REPLIES, diagnostics: { ok: true, result: diagnosticsFromStatus({ output_frequency_hz: 12 }) } },
  });
  m.click("vsd-gear");
  await flush();
  assert.match(m.byId("vsd-diag-status").textContent, /basic status/);
  assert.equal(m.root.querySelector('[data-diag="heatsink_c"] .diag-number').textContent, EMPTY_VALUE);
});
