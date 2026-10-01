// Shared test fixtures. No network, no browser: jsdom for the render core,
// real doover-js classes where the wire shape matters.
import { JSDOM } from "jsdom";
import { RpcDispatcher } from "doover-js";

import { createHmi } from "../src/core/hmi-core.js";

// --- dashboard payloads (the shape assembleDashboardData builds) -----------

const TS = "2026-09-28T01:02:03+00:00";
const UNITS = { rate: "L/Hr", pressure: "psi" };

export const pump = (over = {}) => ({
  name: "Pump",
  target_rate: 12.5,
  flow_rate: 11.9,
  total: 345.6,
  min_rate: 2.0,
  max_rate: 92.16,
  state: "pumping",
  running: true,
  fault: false,
  fault_reason: null,
  warning: false,
  warning_reason: null,
  ...over,
});

// Payloads for an older controller (or a new one with every feature off):
// no control / vsd / touch keys. Ported from sia-local-control-ui
// tests/js/payloads.mjs.
export const LEGACY_PAYLOADS = {
  running: {
    pumps: [pump()],
    faults: [],
    warnings: [],
    link_ok: true,
    units: UNITS,
    timestamp: TS,
    hmi_mode: "read_only",
  },
  faulted: {
    pumps: [pump({ state: "fault", running: false, fault: true, fault_reason: "Tank level low-low" })],
    faults: [{ pump: "Pump", reason: "Tank level low-low" }],
    warnings: [],
    link_ok: true,
    units: UNITS,
    timestamp: TS,
    hmi_mode: "read_only",
  },
  warning_with_peripherals: {
    pumps: [pump({ warning: true, warning_reason: "No flow feedback" })],
    faults: [],
    warnings: [{ pump: "Pump", reason: "No flow feedback" }],
    link_ok: true,
    units: UNITS,
    timestamp: TS,
    hmi_mode: "read_only",
    solar: { battery_voltage: 25.4, battery_percentage: 81, panel_power: 120.5, battery_ah: 200 },
    tank: { tank_level_mm: 850, tank_level_percent: 64 },
    skid: { skid_flow: 11.2, skid_pressure: 350.2 },
  },
  no_controller: {
    pumps: [],
    faults: [],
    warnings: [],
    link_ok: false,
    units: UNITS,
    timestamp: TS,
    hmi_mode: "read_only",
  },
};

// Elements that only exist for the newer features / touch mode.
export const NEW_ONLY_IDS = [
  "pump-drive-line",
  "vsd-section",
  "command-toast",
  "dcs-notice",
  "touch-bar",
  "keypad",
  "confirm",
  "tank-level-secondary",
  "tank-fault",
  "tank-fault-reason",
];

export const TOUCH = { calibration_factor: 1.0, calibration_min: 0.3, calibration_max: 1.7 };

export const withFeatures = (over = {}) => ({
  ...LEGACY_PAYLOADS.running,
  hmi_mode: "touch",
  touch: TOUCH,
  vsd: { tripped: false, trip_code: null, trip_description: null, motor_hz: 42.5, pump_rpm: 61 },
  ...over,
});

export const touchPayload = (over = {}) => ({
  ...LEGACY_PAYLOADS.running,
  hmi_mode: "touch",
  touch: TOUCH,
  ...over,
});

// --- render core mount ------------------------------------------------------

/**
 * Mount the render core in a fresh jsdom page. `sendCommand` records every
 * command; acks resolve immediately with `ackReply` unless `deferAcks` is set,
 * in which case `ackNext(ack)` settles the oldest pending one.
 */
export function mountHmi({ url, dom: existing, ...opts } = {}) {
  // `url` gives the page an origin (and so localStorage); `dom` mounts again
  // in an existing page, as a reload of the widget would.
  const dom = existing ?? new JSDOM("<!doctype html><html><body></body></html>", url ? { url } : undefined);
  const document = dom.window.document;
  const root = document.createElement("div");
  document.body.appendChild(root);
  const state = { sent: [], pending: [], ackReply: { ok: true }, deferAcks: false };
  // A Sensor tab write carries its sensor (meta.target), recorded with it.
  const sendCommand = (cmd, value, meta) => {
    state.sent.push(meta ? { cmd, value, ...meta } : { cmd, value });
    if (!state.deferAcks) return Promise.resolve(state.ackReply);
    return new Promise((resolve) => state.pending.push(resolve));
  };
  const logos = { remoteCommand: "data:image/png;base64,AA==", doover: "data:image/svg+xml,%3Csvg/%3E" };
  const hmi = createHmi(root, { layout: "kiosk", sendCommand, logos, ...opts });
  const byId = (id) => root.querySelector(`[data-id="${id}"]`);
  return {
    dom,
    document,
    root,
    hmi,
    state,
    byId,
    render: (data, status = { connected: true }) => hmi.update(data, status),
    click: (id) => byId(id).click(),
    ackNext: async (ack) => {
      state.pending.shift()(ack);
      await flush();
    },
  };
}

/** Let queued promise callbacks run (command acks resolve asynchronously). */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Hidden by the `.hidden` class on the element or any ancestor. */
export function isHidden(el) {
  for (let e = el; e; e = e.parentElement) {
    if (e.classList && e.classList.contains("hidden")) return true;
  }
  return false;
}

// --- clients ------------------------------------------------------------------

/**
 * A stand-in for the device agent's `DdaDataClient`
 * (dda-agent/widget/src/dda-client.ts) with the same identity and the same
 * `rpc`: doover-js's own RpcDispatcher over a gateway + postMessage. The
 * gateway lets a test answer the RPC the way the controller would, by
 * patching a status onto the posted message.
 */
export function fakeClient({ clientId, capabilities, withUser } = {}) {
  const posted = [];
  const handlers = new Map();
  let nextId = 1000;
  const gateway = {
    subscribeToChannel(channel, h) {
      handlers.set(`${channel.agent_id}/${channel.name}`, h);
      return () => handlers.delete(`${channel.agent_id}/${channel.name}`);
    },
  };
  const messages = {
    async postMessage(agentId, channelName, body) {
      const id = String(nextId++);
      posted.push({ id, agentId, channelName, data: body.data });
      return { id };
    },
  };
  const client = {
    ...(clientId ? { clientId } : {}),
    rpc: new RpcDispatcher(gateway, messages),
    posted,
    /** Answer the newest posted RPC as the controller would. */
    respond(status, response = {}) {
      const msg = posted[posted.length - 1];
      const h = handlers.get(`${msg.agentId}/${msg.channelName}`);
      h.onMessageUpdate({ id: msg.id, data: { ...msg.data, status, response } });
    },
  };
  if (capabilities) {
    const caps = new Set(capabilities);
    client.supports = (c) => caps.has(c);
    client.getCapabilities = () => caps;
  }
  if (withUser) client.users = { getMe: async () => withUser };
  return client;
}

/** Capabilities DdaDataClient advertises. */
export const DDA_CAPABILITIES = [
  "agents.list",
  "channels.list",
  "channels.get",
  "aggregates.get",
  "aggregates.patch",
  "gateway.subscribe",
  "gateway.oneShot",
  "rpc.send",
  "messages.post",
  "messages.list",
];

// --- controller tags (tag_values fixtures) -----------------------------------

export const CTRL = "sia_injection_controller_1";

/** Tags an older controller (pre Rev 0.4) publishes. */
export const legacyControllerTags = (over = {}) => ({
  StateString: "pumping",
  TargetRate: 12.5,
  FlowRate: 11.9,
  Total: 345.6,
  MinRate: 2.0,
  MaxRate: 92.16,
  Running: true,
  Fault: false,
  FaultReason: null,
  Warning: false,
  WarningReason: null,
  CorrectionFactor: 1.0,
  ...over,
});

/** A Rev 0.4 controller with every new feature switched off. */
export const featuresOffTags = (over = {}) =>
  legacyControllerTags({
    TripVsd: false,
    TripVsdComms: false,
    TripVsdNoStart: false,
    TripVsdStoppedExt: false,
    WarnVsdOverload: false,
    WarnVsdNotReady: false,
    WarnVsdNoModbusControl: false,
    VsdTripCode: 0,
    VsdTripDescription: null,
    MotorOutputHz: null,
    PumpRpm: null,
    ControlMode: "cloud",
    ControlModeInt: 2,
    PressureUnits: "psi",
    ...over,
  });

export const deployment = (hmiConfig = {}, appKey = "sia_local_control_ui_1") => ({
  applications: { [appKey]: hmiConfig },
});
