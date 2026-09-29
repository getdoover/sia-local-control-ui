/**
 * SIA HMI render core: framework-free, shared by both widget hosts.
 *
 * A port of sia-local-control-ui's touchscreen (templates/dashboard.html +
 * static/js/dashboard.js), with two changes so it can live inside a widget:
 *
 *  - every element is found under the mount root by `data-id` (never by a
 *    document-wide id), so two instances and the host page cannot collide;
 *  - commands go through an injected `sendCommand(cmd, value) -> Promise<ack>`
 *    instead of a Socket.IO emit. The widget shell (SiaHmiWidget.tsx) turns
 *    that into the controller RPC with the right actor for the host.
 *
 * Payload contract (lib/assembleDashboardData.ts builds it):
 *   {pumps:[], faults:[], warnings:[], link_ok, units:{rate,pressure},
 *    timestamp, hmi_mode, vsd?:{tripped, trip_code,
 *    trip_description, motor_hz, pump_rpm}, touch?:{calibration_factor,
 *    calibration_min, calibration_max}, solar?, tank?, skid?}
 *
 * On-screen controls exist only in HMI Control Mode "Touch" (payload
 * `touch`): the bottom bar (Start / STOP / - target + / Reset Fault / Cal
 * factor), the numeric keypad and confirmations, and Reset VSD (payload
 * `vsd`). Control priority (local HMI > DCS > cloud) is fixed by the
 * controller; the HMI offers no mode switch. In "Read Only"
 * (the default) and "Button" (reserved) the screen is display only.
 *
 * Layouts: "kiosk" fills the viewport (the Doovit panel, 800x480 or
 * 1024x768) with the touch bar pinned to the bottom edge; "embedded" flows at
 * its natural height inside the cloud UI with the bar sticky at the bottom of
 * the widget. Same markup, same rules, same payload in both.
 */

import {
  CAL_TEST_DURATION_S,
  computeCalibration,
  formatMl,
  validateFinalMl,
  validateStartMl,
  validateTestRate,
} from "./calibration.js";

// Success toasts for the on-screen commands.
export const COMMAND_DONE = {
  reset_vsd_fault: "VSD reset. Now press Reset Fault.",
  reset_fault: "Fault cleared",
  last_calibration_factor: "Calibration factor updated",
};

// A keypad rate entry moving the target by more than this fraction asks first.
export const RATE_CONFIRM_FRACTION = 0.2;
const KEYPAD_MAX_CHARS = 8;
const FEEDBACK_MS = 2500;

// Pure keypad helpers (unit-tested): next entry text after a key press, and
// validation of an entry against an inclusive range.
export function keypadInput(text, key) {
  text = text || "";
  if (key === "clear") return "";
  if (key === "back") return text.slice(0, -1);
  if (key === ".") {
    if (text.includes(".")) return text;
    return (text || "0") + ".";
  }
  if (!/^[0-9]$/.test(key)) return text;
  if (text.length >= KEYPAD_MAX_CHARS) return text;
  if (text === "0") return key;
  return text + key;
}

export function validateKeypadEntry(text, min, max) {
  if (!text || text === "." || !/^[0-9]*\.?[0-9]*$/.test(text)) {
    return { ok: false, error: "Enter a number" };
  }
  const value = Number(text);
  if (!isFinite(value)) return { ok: false, error: "Enter a number" };
  if ((min != null && value < min) || (max != null && value > max)) {
    return { ok: false, error: `Out of range (${min} to ${max})` };
  }
  return { ok: true, value };
}

/** Whether a keypad rate entry is a big enough change to confirm first. */
export function rateNeedsConfirm(current, value) {
  return (
    current == null ||
    Number(current) <= 0 ||
    Math.abs(value - current) / Number(current) > RATE_CONFIRM_FRACTION
  );
}

// Line icons in the panel's own colour (currentColor), sized by CSS.
const GEAR_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
export const CAL_TITLE = "1min Calibration Sequence";
// The wizard's inputs are kept here while a test runs, so a reload can
// reattach to it with the starting reading (lib: per browser, best effort).
export const CAL_STORE_KEY = "sia-hmi-calwiz";
const CAL_STORE_MAX_AGE_MS = 30 * 60 * 1000;

const CLOSE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

// VSD panel diagnostics, in display order: [field, label, unit, decimals].
// Decimals null = text. Every value may be null and then shows EMPTY_VALUE.
export const EMPTY_VALUE = "\u2014";
const DIAG_FIELDS = [
  ["output_hz", "Output", "Hz", 1],
  ["output_current_a", "Current", "A", 1],
  ["motor_rpm", "Motor speed", "RPM", 0],
  ["dc_bus_v", "DC bus", "V", 0],
  ["heatsink_c", "Heatsink", "\u00b0C", 0],
  ["drive_state", "Drive state", "", null],
  ["trip", "Trip", "", null],
  ["run_hours", "Run hours", "h", 0],
  ["recent_trips", "Recent trips", "", null],
  ["comms_ok", "Comms", "", null],
];

function diagCell([field, label, unit]) {
  return `<div class="diag-cell" data-diag="${field}"><span class="diag-label">${label}</span>` +
    `<span class="diag-value"><span class="diag-number">${EMPTY_VALUE}</span>` +
    `<span class="diag-unit">${unit}</span></span></div>`;
}

/** Display text for one diagnostics field (pure, unit-tested). */
export function formatDiagnostic(d, field) {
  if (!d) return EMPTY_VALUE;
  const def = DIAG_FIELDS.find((f) => f[0] === field);
  if (field === "trip") {
    const code = d.trip_code;
    const text = d.trip_description;
    if (code == null && !text) return EMPTY_VALUE;
    if (!code && !text) return "None";
    return [text, code ? `code ${code}` : ""].filter(Boolean).join(" \u00b7 ");
  }
  if (field === "recent_trips") {
    const t = d.recent_trips;
    if (!Array.isArray(t)) return EMPTY_VALUE;
    return t.length ? t.join(", ") : "None";
  }
  if (field === "comms_ok") {
    if (d.comms_ok === true) return "OK";
    if (d.comms_ok === false) return "Lost";
    return EMPTY_VALUE;
  }
  const v = d[field];
  if (v === null || v === undefined || v === "") return EMPTY_VALUE;
  if (def && def[3] !== null) {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(def[3]) : EMPTY_VALUE;
  }
  return String(v);
}

/** Decimal places implied by a parameter step (0.1 -> 1, 1 -> 0). */
function stepDp(step) {
  if (!(Number(step) > 0)) return 2;
  const text = String(step);
  if (/e-/i.test(text)) return Math.min(6, Number(text.split(/e-/i)[1]));
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : Math.min(6, text.length - dot - 1);
}

/** A parameter value with its step's decimals, or the empty dash. */
export function formatParameter(p, value = p.value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return EMPTY_VALUE;
  return Number(value).toFixed(stepDp(p.step));
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function template(opts) {
  const logo = opts.logos && opts.logos.remoteCommand
    ? `<img src="${escapeAttr(opts.logos.remoteCommand)}" alt="" class="header-logo">`
    : "";
  const footer = opts.logos && opts.logos.doover
    ? `<div class="footer-logo" data-id="footer-logo"><img src="${escapeAttr(opts.logos.doover)}" alt="Doover"></div>`
    : `<div class="footer-logo hidden" data-id="footer-logo"></div>`;
  return `
<div class="dashboard-container" data-id="container">
  <div class="hmi-body">
    <header class="dashboard-header">
      <h1>${logo}<span class="header-title">${escapeAttr(opts.title || "SIA Remote Command")}</span></h1>
      <div class="header-info">
        <div class="connection-status">
          <span data-id="connection-status" class="status-disconnected">&#9679; Disconnected</span>
        </div>
        <div class="timestamp">Last Update: <span data-id="last-update">--</span></div>
        <div class="host-badge" data-id="host-badge"></div>
      </div>
    </header>

    <div data-id="fault-banner" class="fault-banner hidden" role="alert">
      <span class="fault-banner-icon" aria-hidden="true">&#9888;</span>
      <span class="fault-banner-title">Fault</span>
      <ul data-id="fault-message-list" class="fault-banner-list"></ul>
    </div>

    <div data-id="warning-banner" class="warning-banner hidden" role="status">
      <span class="warning-banner-icon" aria-hidden="true">&#9888;</span>
      <span class="warning-banner-title">Warning</span>
      <ul data-id="warning-message-list" class="warning-banner-list"></ul>
    </div>

    <main class="dashboard-content" data-id="content">
      <div class="pump-skid-row" data-id="pump-skid-row">
        <section class="control-section pump-section">
          <h2>Pump Control</h2>
          <div class="controls-grid" data-id="pump-control-1">
            <div class="control-card">
              <h3>Target Rate</h3>
              <div class="value-display" data-id="target-rate">
                <span class="value">--</span><span class="unit">L/Hr</span>
              </div>
              <div class="flow-range hidden" data-id="flow-range">
                <div class="flow-range-track"><div class="flow-range-fill" data-id="flow-range-fill"></div></div>
                <div class="flow-range-labels">
                  <span class="flow-range-min" data-id="flow-range-min">--</span>
                  <span class="flow-range-max" data-id="flow-range-max">--</span>
                </div>
              </div>
            </div>
            <div class="control-card">
              <h3>Flow Rate</h3>
              <div class="value-display" data-id="flow-rate">
                <span class="value">--</span><span class="unit">L/Hr</span>
              </div>
              <div class="secondary-line" data-id="flow-total">
                <span class="secondary-label">Total</span>
                <span class="secondary-value">--</span>
                <span class="secondary-unit">L</span>
              </div>
            </div>
            <div class="control-card">
              <h3>Pump State</h3>
              <div class="state-display" data-id="pump-state"><span class="state-value">unknown</span></div>
              <div class="secondary-line hidden" data-id="pump-drive-line">
                <span class="drive-item"><span class="secondary-label">Pump</span>
                <span class="secondary-value" data-id="pump-rpm">--</span>
                <span class="secondary-unit">RPM</span></span>
                <span class="drive-item"><span class="secondary-label">Motor</span>
                <span class="secondary-value" data-id="motor-hz">--</span>
                <span class="secondary-unit">Hz</span></span>
              </div>
            </div>
          </div>
        </section>

        <section class="control-section skid-section hidden" data-id="skid-section">
          <h2>Skid</h2>
          <div class="controls-grid">
            <div class="control-card" data-id="skid-flow-card">
              <h3>Flow</h3>
              <div class="value-display" data-id="skid-flow"><span class="value">--</span><span class="unit">L/Hr</span></div>
            </div>
            <div class="control-card" data-id="skid-pressure-card">
              <h3>Pressure</h3>
              <div class="value-display" data-id="skid-pressure"><span class="value">--</span><span class="unit">psi</span></div>
            </div>
          </div>
        </section>
      </div>

      <!-- Status row: Tank, then VSD to its right, then Solar when configured.
           Tank spans the row when it is alone. -->
      <div class="secondary-controls-row status-row" data-id="status-row">
        <section class="control-section tank-section hidden" data-id="tank-section">
          <h2>Tank</h2>
          <div class="controls-grid">
            <div class="control-card"><h3>Tank Level</h3>
              <div class="value-display" data-id="tank-level-mm"><span class="value">--</span><span class="unit">mm</span></div>
              <div class="tank-level-secondary hidden" data-id="tank-level-secondary"><span class="value"></span><span class="unit"></span></div></div>
            <div class="control-card"><h3>Fill</h3>
              <div class="value-display" data-id="tank-level-percent"><span class="value">--</span><span class="unit">%</span></div>
              <div class="progress-bar"><div class="progress-fill" data-id="tank-progress"></div></div></div>
          </div>
        </section>
        <section class="control-section vsd-section hidden" data-id="vsd-section">
          <h2 class="vsd-head"><span>VSD</span>
            <button type="button" class="icon-btn vsd-gear hidden" data-id="vsd-gear"
              aria-label="VSD commissioning" title="VSD commissioning">${GEAR_ICON}</button>
          </h2>
          <div class="vsd-body">
            <div class="vsd-status" data-id="vsd-status">
              <span class="state-value">--</span>
              <span class="vsd-trip" data-id="vsd-trip"></span>
            </div>
            <div class="vsd-actions">
              <button type="button" class="action-btn" data-id="reset-vsd-btn">Reset VSD</button>
            </div>
          </div>
        </section>
        <section class="control-section solar-section hidden" data-id="solar-section">
          <h2>Solar System</h2>
          <div class="controls-grid">
            <div class="control-card"><h3>Battery</h3>
              <div class="value-display" data-id="battery-voltage"><span class="value">--</span><span class="unit">V</span></div></div>
            <div class="control-card"><h3>Charge</h3>
              <div class="value-display" data-id="battery-percentage"><span class="value">--</span><span class="unit">%</span></div>
              <div class="progress-bar"><div class="progress-fill" data-id="battery-progress"></div></div></div>
            <div class="control-card"><h3>Panel</h3>
              <div class="value-display" data-id="panel-power"><span class="value">--</span><span class="unit">W</span></div></div>
            <div class="control-card"><h3>Capacity</h3>
              <div class="value-display" data-id="battery-ah"><span class="value">--</span><span class="unit">Ah</span></div></div>
          </div>
        </section>
      </div>

    </main>
    ${footer}
  </div>

  <div data-id="touch-bar" class="touch-bar hidden" role="toolbar" aria-label="Pump controls">
    <div class="touch-group">
      <button type="button" class="touch-btn touch-start" data-id="touch-start">
        <span class="touch-label">Start</span><span class="touch-hint" data-id="touch-start-hint"></span>
      </button>
      <button type="button" class="touch-btn touch-stop" data-id="touch-stop"><span class="touch-label">Stop</span></button>
    </div>
    <div class="touch-group touch-rate-group">
      <button type="button" class="touch-btn touch-step" data-id="touch-rate-down" aria-label="Decrease target rate">&minus;</button>
      <button type="button" class="touch-btn touch-value" data-id="touch-rate" aria-label="Enter target rate">
        <span class="touch-caption">Target</span>
        <span class="touch-number" data-id="touch-rate-value">--</span>
        <span class="touch-caption" data-id="touch-rate-unit">L/Hr</span>
      </button>
      <button type="button" class="touch-btn touch-step" data-id="touch-rate-up" aria-label="Increase target rate">+</button>
    </div>
    <div class="touch-group">
      <button type="button" class="touch-btn touch-reset" data-id="touch-reset"><span class="touch-label">Reset Fault</span></button>
      <button type="button" class="touch-btn touch-value touch-cal" data-id="touch-cal" aria-label="Enter calibration factor">
        <span class="touch-caption" data-id="touch-cal-caption">Cal factor</span>
        <span class="touch-number" data-id="touch-cal-value">--</span>
        <span class="touch-hint" data-id="touch-cal-hint"></span>
      </button>
    </div>
  </div>
</div>

<div data-id="loading-overlay" class="loading-overlay">
  <div class="loading-spinner"><div class="spinner"></div><p>Connecting to controller...</p></div>
</div>

<div data-id="vsd-panel" class="modal-overlay vsd-panel-overlay hidden" role="dialog" aria-modal="true" aria-label="VSD commissioning">
  <div class="vsd-panel" data-id="vsd-panel-box">
    <div class="vsd-panel-head">
      <h2 class="vsd-panel-title">VSD Commissioning</h2>
      <span class="vsd-panel-status" data-id="vsd-diag-status"></span>
      <button type="button" class="action-btn vsd-panel-reset" data-id="vsd-panel-reset">Reset VSD Fault</button>
      <button type="button" class="icon-btn vsd-panel-close" data-id="vsd-panel-close" aria-label="Close">${CLOSE_ICON}</button>
    </div>
    <div class="vsd-diag" data-id="vsd-diag">${DIAG_FIELDS.map(diagCell).join("")}</div>
    <div class="vsd-params-head">
      <h3>Drive Parameters</h3>
      <span class="vsd-params-note" data-id="vsd-params-note"></span>
    </div>
    <div class="vsd-params" data-id="vsd-params" role="list"></div>
  </div>
</div>

<div data-id="calwiz" class="modal-overlay calwiz-overlay hidden" role="dialog" aria-modal="true" aria-label="${CAL_TITLE}">
  <div class="calwiz" data-id="calwiz-box">
    <div class="calwiz-head">
      <h2 class="calwiz-title">${CAL_TITLE}</h2>
      <span class="calwiz-step" data-id="calwiz-step"></span>
      <button type="button" class="icon-btn calwiz-close" data-id="calwiz-close" aria-label="Close">${CLOSE_ICON}</button>
    </div>
    <div class="calwiz-body" data-id="calwiz-body"></div>
    <div class="calwiz-error" data-id="calwiz-error" role="alert"></div>
    <div class="calwiz-actions">
      <button type="button" class="key key-cancel calwiz-back" data-id="calwiz-back">Back</button>
      <button type="button" class="key calwiz-discard hidden" data-id="calwiz-discard">Discard</button>
      <button type="button" class="key key-ok calwiz-next" data-id="calwiz-next">Confirm</button>
    </div>
  </div>
</div>

<div data-id="keypad" class="modal-overlay hidden" role="dialog" aria-modal="true">
  <div class="keypad">
    <div class="keypad-info">
      <div class="keypad-title" data-id="keypad-title"></div>
      <div class="keypad-display">
        <span class="keypad-entry" data-id="keypad-entry"></span>
        <span class="keypad-unit" data-id="keypad-unit"></span>
      </div>
      <div class="keypad-range" data-id="keypad-range"></div>
      <div class="keypad-error" data-id="keypad-error" role="alert"></div>
      <div class="keypad-actions">
        <button type="button" class="key key-cancel" data-id="keypad-cancel">Cancel</button>
        <button type="button" class="key key-ok" data-id="keypad-ok">OK</button>
      </div>
    </div>
    <div class="keypad-keys">
      <button type="button" class="key" data-key="7">7</button>
      <button type="button" class="key" data-key="8">8</button>
      <button type="button" class="key" data-key="9">9</button>
      <button type="button" class="key key-fn" data-key="back" aria-label="Backspace">&#9003;</button>
      <button type="button" class="key" data-key="4">4</button>
      <button type="button" class="key" data-key="5">5</button>
      <button type="button" class="key" data-key="6">6</button>
      <button type="button" class="key key-fn" data-key="clear">C</button>
      <button type="button" class="key" data-key="1">1</button>
      <button type="button" class="key" data-key="2">2</button>
      <button type="button" class="key" data-key="3">3</button>
      <button type="button" class="key" data-key=".">.</button>
      <button type="button" class="key key-zero" data-key="0">0</button>
    </div>
  </div>
</div>

<div data-id="confirm" class="modal-overlay hidden" role="dialog" aria-modal="true">
  <div class="confirm-box">
    <p class="confirm-message" data-id="confirm-message"></p>
    <div class="confirm-actions">
      <button type="button" class="key key-cancel" data-id="confirm-cancel">Cancel</button>
      <button type="button" class="key key-ok" data-id="confirm-ok">Confirm</button>
    </div>
  </div>
</div>

<div data-id="command-toast" class="command-toast hidden" role="status"></div>`;
}

// The open VSD panel re-reads diagnostics this long after each answer.

export const VSD_POLL_MS = 2000;

const CSS_ESCAPE = (id) => String(id).replace(/["\\]/g, "\\$&");

const MODE_LABELS = { read_only: "Read Only", touch: "Touch", button: "Button" };

class Hmi {
  constructor(root, opts) {
    this.root = root;
    this.opts = opts || {};
    this.data = {};
    this.units = { rate: "L/Hr", pressure: "psi" };
    this.touch = false;
    this.connected = false;
    this.timers = new Set();
    this.toastTimer = null;
    this.keypadOpts = null;
    this.keypadText = "";
    this.keypadPlaceholder = "";
    this.confirmOk = null;
    this.confirmOwner = null;
    this.destroyed = false;
    // VSD commissioning panel (gear on the VSD tile).
    this.vsdAccess = { enabled: false, canWrite: false, writeBlockedReason: "" };
    this.vsdShown = false;
    this.vsdOpen = false;
    this.vsdGen = 0;
    this.vsdDiag = null;
    this.vsdParams = null;
    this.vsdParamState = {};
    // 1min Calibration Sequence wizard state while open (null when closed).
    this.cal = null;

    root.classList.add("sia-hmi", this.opts.layout === "kiosk" ? "kiosk" : "embedded");
    root.innerHTML = template(this.opts);
    this.bind();
  }

  $(id) {
    return this.root.querySelector(`[data-id="${id}"]`);
  }

  $$(selector) {
    return Array.from(this.root.querySelectorAll(selector));
  }

  later(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.destroyed) fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  // -- wiring ---------------------------------------------------------------
  bind() {
    const on = (id, fn) => {
      const b = this.$(id);
      if (b) b.addEventListener("click", () => fn(b));
    };
    on("reset-vsd-btn", (b) => this.sendCommand("reset_vsd_fault", null, b));
    on("touch-start", (b) => this.sendCommand("set_pump_state", "start", b));
    // Stop acts immediately and is never disabled.
    on("touch-stop", (b) => this.sendCommand("set_pump_state", "stop", b));
    on("touch-rate-up", (b) => this.sendCommand("nudge_rate", "+1", b));
    on("touch-rate-down", (b) => this.sendCommand("nudge_rate", "-1", b));
    on("touch-reset", (b) => this.sendCommand("reset_fault", null, b));
    on("touch-rate", (b) => this.openRateKeypad(b));
    on("touch-cal", (b) => (this.data.calibration ? this.calwizOpen() : this.openCalKeypad(b)));
    on("calwiz-close", () => this.calwizClose());
    on("calwiz-back", () => this.calwizBack());
    on("calwiz-next", (b) => this.calwizNext(b));
    on("calwiz-discard", () => this.calwizClose());
    const calBody = this.$("calwiz-body");
    if (calBody) {
      calBody.addEventListener("click", (e) => {
        const el = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
        if (el) this.calwizAction(el.getAttribute("data-act"), el);
      });
    }

    this.$$(".keypad-keys .key").forEach((btn) => {
      btn.addEventListener("click", () => this.keypadPress(btn.getAttribute("data-key")));
    });
    on("keypad-ok", () => this.keypadSubmit());
    on("keypad-cancel", () => this.keypadClose());
    on("confirm-ok", () => {
      const fn = this.confirmOk;
      this.confirmClose();
      if (fn) fn();
    });
    on("confirm-cancel", () => this.confirmClose());

    on("vsd-gear", () => this.vsdPanelOpen());
    on("vsd-panel-close", () => this.vsdPanelClose());
    // Reset VSD Fault: the controller's reset_vsd_fault, exactly as the tile.
    on("vsd-panel-reset", (b) => this.sendCommand("reset_vsd_fault", null, b));
    const overlay = this.$("vsd-panel");
    if (overlay) {
      // Tapping the dimmed backdrop (not the panel) closes it.
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) this.vsdPanelClose();
      });
    }
    const params = this.$("vsd-params");
    if (params) {
      params.addEventListener("click", (e) => {
        const row = e.target && e.target.closest ? e.target.closest("[data-param]") : null;
        if (row) this.vsdEditParameter(row.getAttribute("data-param"), row);
      });
    }
    this.onKey = (e) => {
      if (e.key !== "Escape") return;
      if (this.keypadIsOpen() || this.confirmOk) return;
      if (this.cal) this.calwizClose();
      else if (this.vsdOpen) this.vsdPanelClose();
    };
    this.root.ownerDocument.addEventListener("keydown", this.onKey);
  }

  // -- keypad ---------------------------------------------------------------
  keypadOpen(opts) {
    this.keypadOpts = opts;
    this.keypadText = "";
    this.setText("keypad-title", opts.title || "");
    this.setText("keypad-unit", opts.unit || "");
    const dp = opts.decimals != null ? opts.decimals : 2;
    const unit = opts.unit ? " " + opts.unit : "";
    this.setText(
      "keypad-range",
      opts.rangeText != null
        ? opts.rangeText
        : `Range ${Number(opts.min).toFixed(dp)} to ${Number(opts.max).toFixed(dp)}${unit}`
    );
    this.keypadPlaceholder = opts.value != null ? Number(opts.value).toFixed(dp) : "";
    this.setText("keypad-error", "");
    this.keypadRefresh();
    this.show(this.$("keypad"));
  }

  keypadClose() {
    this.keypadOpts = null;
    this.hide(this.$("keypad"));
  }

  keypadIsOpen() {
    return !!this.keypadOpts;
  }

  keypadPress(key) {
    this.keypadText = keypadInput(this.keypadText, key);
    this.setText("keypad-error", "");
    this.keypadRefresh();
  }

  keypadSubmit() {
    if (!this.keypadOpts) return;
    const res = validateKeypadEntry(this.keypadText, this.keypadOpts.min, this.keypadOpts.max);
    if (!res.ok) {
      this.setText("keypad-error", res.error);
      return;
    }
    const invalid = this.keypadOpts.validate ? this.keypadOpts.validate(res.value) : null;
    if (invalid) {
      this.setText("keypad-error", invalid);
      return;
    }
    const done = this.keypadOpts.onSubmit;
    this.keypadClose();
    done(res.value);
  }

  keypadRefresh() {
    const entry = this.$("keypad-entry");
    if (!entry) return;
    entry.textContent = this.keypadText || this.keypadPlaceholder;
    entry.classList.toggle("placeholder", !this.keypadText);
  }

  // -- confirmation (in-page; no alert()/confirm() on a kiosk) --------------
  confirmAsk(message, onOk, owner = "touch") {
    this.confirmOk = onOk;
    this.confirmOwner = owner;
    this.setText("confirm-message", message);
    this.show(this.$("confirm"));
  }

  confirmClose() {
    this.confirmOk = null;
    this.confirmOwner = null;
    this.hide(this.$("confirm"));
  }

  openRateKeypad(btn) {
    const pump = (this.data.pumps || [])[0];
    if (!this.touch || !pump || pump.min_rate == null || pump.max_rate == null) return;
    const current = pump.target_rate;
    this.keypadOpen({
      title: "Target rate",
      value: current,
      min: pump.min_rate,
      max: pump.max_rate,
      decimals: 2,
      unit: this.units.rate,
      onSubmit: (value) => {
        const send = () => this.sendCommand("set_target_rate", value, btn);
        if (!rateNeedsConfirm(current, value)) return send();
        const from = current != null ? this.fmt(current, 2) : "--";
        this.confirmAsk(
          `Change target rate from ${from} to ${this.fmt(value, 2)} ${this.units.rate}?`,
          send
        );
      },
    });
  }

  openCalKeypad(btn) {
    const t = this.data.touch;
    if (!this.touch || !t) return;
    this.keypadOpen({
      title: "Calibration factor",
      value: t.calibration_factor,
      min: t.calibration_min,
      max: t.calibration_max,
      decimals: 2,
      unit: "",
      onSubmit: (value) => {
        const from = t.calibration_factor != null ? this.fmt(t.calibration_factor, 2) : "--";
        this.confirmAsk(
          `Change calibration factor from ${from} to ${this.fmt(value, 2)}?`,
          () => this.sendCommand("last_calibration_factor", value, btn)
        );
      },
    });
  }

  // -- commands ---------------------------------------------------------------
  // One on-screen command with pending / success / error feedback on the
  // control that issued it. Touch mode only.
  sendCommand(cmd, value, btn) {
    if (!this.touch || typeof this.opts.sendCommand !== "function") return;
    if (btn && btn.classList.contains("pending")) return;
    this.setFeedback(btn, "pending");
    let result;
    try {
      result = Promise.resolve(this.opts.sendCommand(cmd, value));
    } catch (e) {
      result = Promise.resolve({ ok: false, message: String((e && e.message) || e) });
    }
    return result
      .catch((e) => ({ ok: false, message: String((e && e.message) || e) }))
      .then((ack) => {
        if (this.destroyed) return ack;
        if (ack && ack.ok) {
          this.setFeedback(btn, "ok");
          if (COMMAND_DONE[cmd]) this.showToast(COMMAND_DONE[cmd], "ok");
        } else {
          this.setFeedback(btn, "error");
          this.showToast((ack && ack.message) || "Command failed", "error");
        }
        return ack;
      });
  }

  setFeedback(btn, state) {
    if (!btn) return;
    btn.classList.remove("pending", "ok", "error");
    if (state) btn.classList.add(state);
    if (state === "ok" || state === "error") {
      this.later(() => btn.classList.remove(state), FEEDBACK_MS);
    }
  }

  showToast(message, level) {
    const el = this.$("command-toast");
    if (!el) return;
    el.textContent = message;
    el.className = "command-toast" + (level ? " " + level : "");
    this.placeToast(el);
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.timers.delete(this.toastTimer);
    }
    this.toastTimer = this.later(() => this.hide(el), level === "error" ? 8000 : 3000);
  }

  // Keep the toast clear of the touch bar wherever the bar is on screen (the
  // bottom edge on the kiosk, sticky in the cloud, one or two rows high).
  placeToast(el) {
    el.style.bottom = "";
    const bar = this.$("touch-bar");
    const win = this.root.ownerDocument.defaultView;
    if (!bar || bar.classList.contains("hidden") || !win) return;
    const r = bar.getBoundingClientRect();
    if (!r.height || r.top >= win.innerHeight) return;
    el.style.bottom = `${Math.max(24, win.innerHeight - r.top + 12)}px`;
  }

  // -- render -------------------------------------------------------------------
  update(data, status) {
    if (status && typeof status.connected === "boolean") this.connected = status.connected;
    if (!data) {
      this.setConnection(this.connected, undefined);
      return;
    }
    this.data = data;
    if (data.units) this.units = data.units;
    this.hide(this.$("loading-overlay"));

    this.setConnection(this.connected, data.link_ok);
    this.renderHostBadge(data.hmi_mode);
    this.renderPump((data.pumps || [])[0]);
    this.renderFaults(data.faults || []);
    this.renderWarnings(data.warnings || []);
    this.renderSkid(data.skid);
    this.renderSolar(data.solar);
    this.renderTank(data.tank);
    this.renderTouch(data.touch, (data.pumps || [])[0]);
    this.renderCalwizLive();
    this.renderVsd(data.vsd);
    if (this.vsdOpen) this.renderVsdReset();
    this.setLastUpdate(data.timestamp);
  }

  renderHostBadge(mode) {
    const parts = [];
    if (this.opts.hostLabel) parts.push(this.opts.hostLabel);
    if (mode && MODE_LABELS[mode]) parts.push(MODE_LABELS[mode]);
    this.setText("host-badge", parts.join(" · "));
  }

  renderPump(pump) {
    if (!pump) return;
    const rate = this.units.rate;
    const state = pump.state || "unknown";
    const stateClass = state.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    this.setValue("target-rate", pump.target_rate != null ? this.fmt(pump.target_rate, 2) : "--", rate);
    this.setValue("flow-rate", this.fmt(pump.flow_rate, 1), rate);
    this.setTotal(pump.total, this.volumeUnit(rate));
    this.renderFlowRange(pump);
    const st = this.root.querySelector('[data-id="pump-state"] .state-value');
    if (st) {
      st.textContent = state;
      st.className = "state-value " + stateClass + (pump.fault ? " error" : "");
    }
  }

  setTotal(value, unit) {
    const el = this.$("flow-total");
    if (!el) return;
    const v = el.querySelector(".secondary-value");
    if (v) v.textContent = this.fmt(value, 2);
    const u = el.querySelector(".secondary-unit");
    if (u) u.textContent = unit;
  }

  // "L/Day" -> "L", "Gal/Hr" -> "Gal": strip the time denominator.
  volumeUnit(rate) {
    return (rate || "").split("/")[0] || "";
  }

  renderFlowRange(pump) {
    const el = this.$("flow-range");
    if (!el) return;
    const min = pump.min_rate;
    const max = pump.max_rate;
    if (min == null || max == null || max <= min || pump.target_rate == null) {
      this.hide(el);
      return;
    }
    this.show(el);
    const rate = this.units.rate;
    this.setText("flow-range-min", this.fmt(min, 2) + " " + rate);
    this.setText("flow-range-max", this.fmt(max, 2) + " " + rate);
    const frac = Math.max(0, Math.min(1, (Number(pump.target_rate) - min) / (max - min)));
    const fill = this.$("flow-range-fill");
    if (fill) fill.style.width = `${frac * 100}%`;
  }

  renderList(bannerId, listId, items, fallback) {
    const banner = this.$(bannerId);
    const list = this.$(listId);
    if (!list) return;
    list.textContent = "";
    if (!items.length) {
      this.hide(banner);
      return;
    }
    const doc = this.root.ownerDocument;
    for (const item of items) {
      const li = doc.createElement("li");
      li.textContent = (item.pump ? `${item.pump}: ` : "") + (item.reason || fallback);
      list.appendChild(li);
    }
    this.show(banner);
  }

  renderFaults(faults) {
    this.renderList("fault-banner", "fault-message-list", faults, "Pump tripped");
  }

  renderWarnings(warnings) {
    this.renderList("warning-banner", "warning-message-list", warnings, "Warning");
  }

  renderSkid(s) {
    const section = this.$("skid-section");
    const row = this.$("pump-skid-row");
    if (!s) {
      this.hide(section);
      if (row) row.classList.add("no-skid");
      return;
    }
    this.show(section);
    if (row) row.classList.remove("no-skid");
    // Only the readings whose app is configured (and publishing) are shown.
    this.toggle(this.$("skid-flow-card"), s.skid_flow != null);
    this.toggle(this.$("skid-pressure-card"), s.skid_pressure != null);
    if (s.skid_flow != null) this.setValue("skid-flow", this.fmt(s.skid_flow, 1), this.units.rate);
    if (s.skid_pressure != null) this.setValue("skid-pressure", this.fmt(s.skid_pressure, 1), this.units.pressure);
  }

  renderSolar(s) {
    const section = this.$("solar-section");
    if (!s) {
      this.hide(section);
      return;
    }
    this.show(section);
    this.setValue("battery-voltage", s.battery_voltage != null ? this.fmt(s.battery_voltage, 1) : "--");
    if (s.battery_percentage != null) {
      const pct = Math.round(s.battery_percentage);
      this.setValue("battery-percentage", pct);
      this.setBar("battery-progress", pct);
    } else {
      this.setValue("battery-percentage", "--");
      this.setBar("battery-progress", 0);
    }
    this.setValue("panel-power", s.panel_power != null ? this.fmt(s.panel_power, 1) : "--");
    this.setValue("battery-ah", s.battery_ah != null ? this.fmt(s.battery_ah, 1) : "--");
  }

  renderTank(t) {
    const section = this.$("tank-section");
    if (!t) {
      this.hide(section);
      return;
    }
    this.show(section);
    // Primary reading (large): mm by default, else the configured reading.
    const primary = t.level_primary;
    if (primary) {
      this.setValue(
        "tank-level-mm",
        primary.value != null ? this.fmt(primary.value, primary.decimals) : "--",
        primary.unit,
      );
    } else {
      const u = this.$("tank-level-mm")?.querySelector(".unit");
      if (u && u.textContent !== "mm") u.textContent = "mm";
      if (t.tank_level_mm != null) this.setValue("tank-level-mm", Math.round(t.tank_level_mm));
    }
    // Secondary reading (small, below): only when configured and published.
    const secondary = t.level_secondary;
    const sec = this.$("tank-level-secondary");
    if (secondary && secondary.value != null) {
      this.setValue("tank-level-secondary", this.fmt(secondary.value, secondary.decimals), secondary.unit);
      this.show(sec);
    } else {
      this.hide(sec);
    }
    if (t.tank_level_percent != null) {
      const pct = Math.round(t.tank_level_percent);
      this.setValue("tank-level-percent", pct);
      this.setBar("tank-progress", pct);
    }
  }

  // Touch bar: only in HMI Control Mode "Touch" (payload `touch`).
  renderTouch(touch, pump) {
    this.touch = !!touch;
    const bar = this.$("touch-bar");
    const container = this.$("container");
    const footer = this.$("footer-logo");
    if (container) container.classList.toggle("readonly", !this.touch);
    if (!touch) {
      this.hide(bar);
      if (container) container.classList.remove("touch-mode");
      if (footer && footer.classList.contains("touch-hidden")) {
        footer.classList.remove("touch-hidden");
        this.show(footer);
      }
      // Only the touch controls' own keypad / confirmation: a VSD panel edit
      // is governed by VSD Commissioning, not HMI Control Mode.
      if (this.keypadIsOpen() && this.keypadOpts.owner !== "vsd") this.keypadClose();
      if (this.confirmOwner === "touch") this.confirmClose();
      return;
    }
    this.show(bar);
    if (container) container.classList.add("touch-mode");
    if (footer && !footer.classList.contains("hidden")) {
      footer.classList.add("touch-hidden");
      this.hide(footer);
    }

    const faulted = !!(pump && pump.fault);
    const start = this.$("touch-start");
    if (start) start.disabled = faulted || !pump;
    this.setText("touch-start-hint", faulted ? "Reset fault first" : "");
    const reset = this.$("touch-reset");
    if (reset) reset.classList.toggle("attention", faulted);

    const rateKnown = !!(pump && pump.min_rate != null && pump.max_rate != null);
    this.setText("touch-rate-value", pump && pump.target_rate != null ? this.fmt(pump.target_rate, 2) : "--");
    this.setText("touch-rate-unit", this.units.rate);
    const rateBtn = this.$("touch-rate");
    if (rateBtn) rateBtn.disabled = !rateKnown;
    ["touch-rate-up", "touch-rate-down"].forEach((id) => {
      const b = this.$(id);
      if (b) b.disabled = !pump;
    });
    this.renderCalTile(touch, pump);
  }

  // Bottom-right tile: CAL FACTOR (manual keypad) as always, or CALIBRATE
  // (the wizard) when the controller's Calibration Method is Manual (HMI).
  renderCalTile(touch, pump) {
    const tile = this.$("touch-cal");
    const factor = touch.calibration_factor != null ? this.fmt(touch.calibration_factor, 2) : "--";
    const cal = this.data.calibration;
    if (!tile) return;
    tile.classList.toggle("calibrate", !!cal);
    if (!cal) {
      tile.setAttribute("aria-label", "Enter calibration factor");
      this.setText("touch-cal-caption", "Cal factor");
      this.setText("touch-cal-value", factor);
      this.setText("touch-cal-hint", "");
      tile.disabled = false;
      return;
    }
    const active = !!cal.test_run.active;
    const faulted = !!(pump && pump.fault);
    const running = !!(pump && (pump.running || pump.state === "pumping"));
    tile.setAttribute("aria-label", "Calibrate (1min Calibration Sequence)");
    this.setText("touch-cal-value", active ? "Testing" : "Calibrate");
    this.setText("touch-cal-caption", `Factor ${factor}`);
    const hint = active ? "" : faulted ? "Reset fault first" : running ? "Stop pump first" : "";
    this.setText("touch-cal-hint", hint);
    tile.disabled = !active && (faulted || running || !pump);
  }

  // -- 1min Calibration Sequence ------------------------------------------------
  // Pages: 1 valve shut / site glass open, 2 start mL, 3 test rate, 4 summary
  // + Start Test (start_test_run), 5 running (countdown from the controller's
  // TestRunRemaining_s, Cancel = cancel_test_run), "ended" (cancelled or
  // faulted), 6 final mL, 7 results + Set calibration factor / Discard.
  // The controller times the run and stops the pump itself; the wizard only
  // follows its TestRun* tags, so a reload reattaches from TestRunActive.

  calTestRun() {
    const c = this.data.calibration;
    return c ? c.test_run : null;
  }

  calPump() {
    return (this.data.pumps || [])[0] || null;
  }

  calwizOpen() {
    if (!this.touch || !this.data.calibration || this.cal) return;
    const tr = this.calTestRun();
    if (tr && tr.active) {
      this.calwizReattach(tr);
      return;
    }
    const pump = this.calPump();
    if (pump && (pump.fault || pump.running || pump.state === "pumping")) return;
    const t = this.data.touch || {};
    this.cal = {
      page: 1,
      startMl: null,
      rate: null,
      finalMl: null,
      oldFactor: t.calibration_factor != null ? Number(t.calibration_factor) : null,
      run: null,
      ended: null,
      elapsedS: null,
      testRate: null,
      result: null,
      saved: null,
      error: "",
    };
    this.show(this.$("calwiz"));
    this.renderCalwiz();
  }

  // A test is running (this panel reloaded, or it was started elsewhere):
  // straight to the countdown, with the inputs saved at Start Test if any.
  calwizReattach(tr) {
    const saved = this.calLoad();
    const t = this.data.touch || {};
    this.cal = {
      page: 5,
      startMl: saved ? saved.startMl : null,
      rate: saved ? saved.rate : tr.rate,
      finalMl: null,
      oldFactor: saved && saved.oldFactor != null
        ? saved.oldFactor
        : t.calibration_factor != null ? Number(t.calibration_factor) : null,
      run: { seenActive: true, startedAt: Date.now(), duration: tr.duration_s || CAL_TEST_DURATION_S, rate: tr.rate },
      ended: null,
      elapsedS: null,
      testRate: null,
      result: null,
      saved: null,
      error: "",
      reattached: true,
    };
    this.show(this.$("calwiz"));
    this.renderCalwiz();
  }

  calwizClose(force = false) {
    if (!this.cal) return;
    if (this.cal.page === 5 && !force) return; // never while the pump runs
    this.cal = null;
    this.calStore(null);
    if (this.keypadIsOpen() && this.keypadOpts.owner === "calwiz") this.keypadClose();
    if (this.confirmOwner === "calwiz") this.confirmClose();
    this.hide(this.$("calwiz"));
  }

  calwizGo(page) {
    if (!this.cal) return;
    this.cal.page = page;
    this.cal.error = "";
    this.renderCalwiz();
  }

  calwizBack() {
    if (!this.cal) return;
    const back = { 1: null, 2: 1, 3: 2, 4: 3, 6: 2, 7: 6, ended: 2 }[this.cal.page];
    if (back === undefined) return; // running: no back
    if (back === null) {
      this.calwizClose();
      return;
    }
    if (back === 2) {
      // A new test needs a new starting reading.
      this.cal.finalMl = null;
      this.cal.result = null;
      this.cal.saved = null;
    }
    this.calwizGo(back);
  }

  calwizNext(btn) {
    const c = this.cal;
    if (!c) return;
    const fail = (msg) => {
      c.error = msg;
      this.setText("calwiz-error", msg);
    };
    switch (c.page) {
      case 1:
        return this.calwizGo(2);
      case 2: {
        const err = validateStartMl(c.startMl);
        if (err) return fail(err);
        if (c.rate == null) {
          const pump = this.calPump();
          if (pump && pump.target_rate != null) c.rate = Number(pump.target_rate);
        }
        return this.calwizGo(3);
      }
      case 3: {
        const pump = this.calPump() || {};
        const err = validateTestRate(c.rate, pump.min_rate, pump.max_rate);
        if (err) return fail(err);
        return this.calwizGo(4);
      }
      case 4:
        return this.calwizStart(btn);
      case 6: {
        const err = validateStartMl(c.startMl) || validateFinalMl(c.finalMl, c.startMl);
        if (err) return fail(err);
        const res = this.calResult();
        if (!res.ok) return fail(res.error);
        c.result = res;
        return this.calwizGo(7);
      }
      case 7:
        if (c.saved != null) return this.calwizClose();
        return this.calwizSetFactor(btn);
      case "ended":
        return this.calwizClose();
      default:
        return undefined;
    }
  }

  calResult() {
    const c = this.cal;
    return computeCalibration({
      startMl: c.startMl,
      finalMl: c.finalMl,
      elapsedS: c.elapsedS,
      targetRate: c.testRate != null ? c.testRate : c.rate,
      oldFactor: c.oldFactor,
      rateUnits: this.units.rate,
    });
  }

  calwizStart(btn) {
    const c = this.cal;
    const payload = { rate: c.rate, duration_s: CAL_TEST_DURATION_S };
    const t = this.data.touch || {};
    if (t.calibration_factor != null) c.oldFactor = Number(t.calibration_factor);
    const sent = this.sendCommand("start_test_run", payload, btn);
    if (!sent) return;
    sent.then((ack) => {
      if (this.cal !== c || c.page !== 4) return;
      if (ack && ack.ok) {
        c.run = { seenActive: false, startedAt: Date.now(), duration: CAL_TEST_DURATION_S, rate: null };
        this.calStore({ startMl: c.startMl, rate: c.rate, oldFactor: c.oldFactor, at: Date.now() });
        this.calwizGo(5);
        this.renderCalwizLive();
      } else {
        c.error = (ack && ack.message) || "The test did not start";
        this.setText("calwiz-error", c.error);
      }
    });
  }

  calwizSetFactor(btn) {
    const c = this.cal;
    if (!c.result || !c.result.ok) return;
    const value = c.result.newFactor;
    const sent = this.sendCommand("last_calibration_factor", value, btn);
    if (!sent) return;
    sent.then((ack) => {
      if (this.cal !== c) return;
      if (ack && ack.ok) {
        c.saved = value;
        this.calStore(null);
        this.renderCalwiz();
      } else {
        c.error = (ack && ack.message) || "The calibration factor was not set";
        this.setText("calwiz-error", c.error);
      }
    });
  }

  calwizAction(act, el) {
    const c = this.cal;
    if (!c) return;
    const pump = this.calPump() || {};
    if (act === "manual") {
      // The existing manual entry, unchanged: the wizard steps aside.
      this.calwizClose();
      this.openCalKeypad(this.$("touch-cal"));
    } else if (act === "edit-start") {
      this.keypadOpen({
        owner: "calwiz",
        title: "Site glass mL",
        value: c.startMl,
        min: null,
        max: null,
        rangeText: "Must be more than 0 mL",
        decimals: 1,
        unit: "mL",
        validate: validateStartMl,
        onSubmit: (value) => {
          c.startMl = value;
          if (c.finalMl != null && validateFinalMl(c.finalMl, value)) c.finalMl = null;
          this.renderCalwiz();
        },
      });
    } else if (act === "edit-rate") {
      this.keypadOpen({
        owner: "calwiz",
        title: "Test rate",
        value: c.rate,
        min: pump.min_rate,
        max: pump.max_rate,
        decimals: 2,
        unit: this.units.rate,
        validate: (v) => validateTestRate(v, pump.min_rate, pump.max_rate),
        onSubmit: (value) => {
          c.rate = value;
          this.renderCalwiz();
        },
      });
    } else if (act === "edit-final") {
      this.keypadOpen({
        owner: "calwiz",
        title: "Final site glass mL",
        value: c.finalMl,
        min: null,
        max: null,
        rangeText: c.startMl != null ? `Less than the starting ${formatMl(c.startMl)} mL` : "Less than the starting reading",
        decimals: 1,
        unit: "mL",
        validate: (v) => validateFinalMl(v, c.startMl),
        onSubmit: (value) => {
          c.finalMl = value;
          this.renderCalwiz();
        },
      });
    } else if (act === "cancel") {
      const sent = this.sendCommand("cancel_test_run", null, el);
      if (sent) {
        sent.then((ack) => {
          if (this.cal === c && c.run && ack && ack.ok) {
            // The result arrives with the tags; this one is fresh.
            c.run.seenActive = true;
            this.renderCalwizLive();
          }
        });
      }
    }
  }

  calStore(value) {
    try {
      const store = this.root.ownerDocument.defaultView.localStorage;
      if (value) store.setItem(CAL_STORE_KEY, JSON.stringify(value));
      else store.removeItem(CAL_STORE_KEY);
    } catch {
      // no storage: a reload then asks for the starting reading again
    }
  }

  calLoad() {
    try {
      const store = this.root.ownerDocument.defaultView.localStorage;
      const v = JSON.parse(store.getItem(CAL_STORE_KEY) || "null");
      if (!v || typeof v !== "object" || !(Date.now() - Number(v.at) < CAL_STORE_MAX_AGE_MS)) return null;
      return v;
    } catch {
      return null;
    }
  }

  // Per payload: follow the controller's test run, and keep the wizard in
  // step with it (reattach, countdown, end of the run).
  renderCalwizLive() {
    if (!this.touch || !this.data.calibration) {
      if (this.cal) this.calwizClose(true);
      return;
    }
    const tr = this.calTestRun();
    if (!this.cal) {
      if (tr.active) this.calwizReattach(tr);
      return;
    }
    const c = this.cal;
    if (c.page !== 5) {
      // Started from another screen while this one was on pages 1 to 4.
      if (tr.active && [1, 2, 3, 4].includes(c.page)) {
        c.run = { seenActive: true, startedAt: Date.now(), duration: tr.duration_s || CAL_TEST_DURATION_S, rate: tr.rate };
        this.calwizGo(5);
      } else {
        this.renderCalwizActions();
        return;
      }
    }
    const run = c.run;
    if (tr.active) {
      run.seenActive = true;
      if (tr.rate != null) run.rate = tr.rate;
      if (tr.duration_s) run.duration = tr.duration_s;
    } else if (
      tr.result &&
      (run.seenActive || Date.now() - run.startedAt > (run.duration + 30) * 1000)
    ) {
      if (tr.result === "completed") {
        c.elapsedS = tr.elapsed_s;
        c.testRate = run.rate != null ? run.rate : tr.rate != null ? tr.rate : c.rate;
        this.calwizGo(6);
      } else {
        const pump = this.calPump() || {};
        c.ended = {
          result: tr.result,
          reason: tr.result === "faulted" ? pump.fault_reason || "the pump tripped" : "",
          elapsedS: tr.elapsed_s,
        };
        this.calStore(null);
        this.calwizGo("ended");
      }
      return;
    }
    this.renderCalwizRunning();
  }

  renderCalwizRunning() {
    const tr = this.calTestRun();
    const c = this.cal;
    if (!c || c.page !== 5 || !tr) return;
    const duration = (c.run && c.run.duration) || CAL_TEST_DURATION_S;
    const remaining = tr.active && tr.remaining_s != null ? tr.remaining_s : duration;
    this.setText("calwiz-countdown", String(Math.max(0, Math.ceil(remaining - 1e-6))));
    const fill = this.$("calwiz-progress");
    if (fill) fill.style.width = `${Math.max(0, Math.min(1, 1 - remaining / duration)) * 100}%`;
    const pump = this.calPump();
    this.setText("calwiz-flow", pump ? this.fmt(pump.flow_rate, 2) : "--");
    const rate = c.run && c.run.rate != null ? c.run.rate : c.rate;
    this.setText("calwiz-run-rate", rate != null ? this.fmt(rate, 2) : "--");
  }

  renderCalwiz() {
    const c = this.cal;
    const body = this.$("calwiz-body");
    if (!c || !body) return;
    const u = escapeHtml(this.units.rate);
    const pump = this.calPump() || {};
    const field = (act, label, value, unit, note) =>
      `<button type="button" class="calwiz-field" data-act="${act}" data-id="calwiz-field-${act.slice(5)}">` +
      `<span class="calwiz-field-label">${label}</span>` +
      `<span class="calwiz-field-value${value == null ? " empty" : ""}">${value == null ? "Tap to enter" : escapeHtml(value)}` +
      `${value == null || !unit ? "" : `<span class="calwiz-unit">${unit}</span>`}</span>` +
      (note ? `<span class="calwiz-field-note">${note}</span>` : "") +
      `</button>`;
    const row = (label, value, unit = "", id = "") =>
      `<div class="calwiz-row"${id ? ` data-id="${id}"` : ""}><span class="calwiz-row-label">${label}</span>` +
      `<span class="calwiz-row-value">${value}${unit ? ` <span class="calwiz-unit">${unit}</span>` : ""}</span></div>`;
    const ml = (v) => (v == null ? "--" : formatMl(v));
    const steps = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, ended: 5, 6: 6, 7: 7 };
    this.setText("calwiz-step", `Step ${steps[c.page]} of 7`);
    let html = "";
    switch (c.page) {
      case 1:
        html =
          `<p class="calwiz-text calwiz-lead">Please confirm the tank valve is shut off and the site glass is open</p>` +
          `<button type="button" class="calwiz-link" data-act="manual" data-id="calwiz-manual">Set factor manually</button>`;
        break;
      case 2:
        html =
          field("edit-start", "Site glass mL", c.startMl == null ? null : formatMl(c.startMl), "mL", "Read the site glass before the test.");
        break;
      case 3:
        html = field(
          "edit-rate",
          "Test rate",
          c.rate == null ? null : this.fmt(c.rate, 2),
          u,
          pump.min_rate != null && pump.max_rate != null
            ? `Range ${this.fmt(pump.min_rate, 2)} to ${this.fmt(pump.max_rate, 2)} ${u}`
            : "",
        );
        break;
      case 4:
        html =
          `<div class="calwiz-rows">` +
          row("Start site glass", ml(c.startMl), "mL") +
          row("Test rate", this.fmt(c.rate, 2), u) +
          row("Duration", String(CAL_TEST_DURATION_S), "s") +
          `</div>` +
          `<p class="calwiz-note" data-id="calwiz-start-note">The pump will run for 1 minute at the test rate, then stop by itself.</p>`;
        break;
      case 5:
        html =
          `<div class="calwiz-run">` +
          `<div class="calwiz-count"><span class="calwiz-count-value" data-id="calwiz-countdown">--</span>` +
          `<span class="calwiz-count-unit">s remaining</span></div>` +
          `<div class="calwiz-progress"><div class="calwiz-progress-fill" data-id="calwiz-progress"></div></div>` +
          `<div class="calwiz-run-side">` +
          row("Flow rate", `<span data-id="calwiz-flow">--</span>`, u) +
          row("Test rate", `<span data-id="calwiz-run-rate">--</span>`, u) +
          `<button type="button" class="key calwiz-cancel" data-act="cancel" data-id="calwiz-cancel">Cancel</button>` +
          `</div></div>`;
        break;
      case "ended": {
        const e = c.ended || {};
        const what = e.result === "faulted"
          ? `The test stopped because the pump faulted: ${escapeHtml(e.reason)}.`
          : "The test was cancelled and the pump stopped.";
        html =
          `<p class="calwiz-text calwiz-lead calwiz-ended" data-id="calwiz-ended">${what}</p>` +
          `<p class="calwiz-note">No calibration factor was changed. Go back to read the site glass and run the test again.</p>`;
        break;
      }
      case 6:
        html =
          (c.reattached && c.startMl == null
            ? field("edit-start", "Site glass mL at the start", null, "mL", "Not known on this screen: enter it.")
            : "") +
          field("edit-final", "Final site glass mL", c.finalMl == null ? null : formatMl(c.finalMl), "mL",
            `Start was ${ml(c.startMl)} mL. Test ran ${c.elapsedS != null ? this.fmt(c.elapsedS, 1) : "--"} s.`);
        break;
      case 7: {
        const r = c.result;
        const clampNote = r.clamped
          ? `<p class="calwiz-note calwiz-warn" data-id="calwiz-clamped">Calculated ${this.fmt(r.rawFactor, 2)} is outside 0.3 to 1.7, so it is limited to ${this.fmt(r.newFactor, 2)}. Check the readings and the pump.</p>`
          : "";
        const saved = c.saved != null
          ? `<p class="calwiz-note calwiz-ok" data-id="calwiz-saved">Calibration factor set to ${this.fmt(c.saved, 2)}.</p>`
          : "";
        html =
          `<div class="calwiz-rows calwiz-results">` +
          row("Delivered volume", formatMl(r.deliveredMl), "mL", "calwiz-delivered") +
          row("Measured flow rate", this.fmt(r.measuredRate, 2), u, "calwiz-measured") +
          row("Target flow rate", this.fmt(r.targetRate, 2), u, "calwiz-target") +
          row("Calibration factor", `${this.fmt(r.oldFactor, 2)} \u2192 <strong data-id="calwiz-new-factor">${this.fmt(r.newFactor, 2)}</strong>`, "", "calwiz-factor") +
          `</div>` + clampNote + saved;
        break;
      }
      default:
        html = "";
    }
    body.innerHTML = html;
    body.setAttribute("data-page", String(c.page));
    this.setText("calwiz-error", c.error || "");
    this.renderCalwizActions();
    if (c.page === 5) this.renderCalwizRunning();
  }

  renderCalwizActions() {
    const c = this.cal;
    if (!c) return;
    const back = this.$("calwiz-back");
    const next = this.$("calwiz-next");
    const discard = this.$("calwiz-discard");
    const close = this.$("calwiz-close");
    const running = c.page === 5;
    this.toggle(back, !running);
    this.toggle(close, !running);
    this.toggle(next, !running);
    this.toggle(discard, c.page === 7 && c.saved == null);
    if (!next) return;
    const labels = { 1: "Confirm", 2: "Confirm", 3: "Confirm", 4: "Start Test", 6: "Confirm", 7: "Set calibration factor", ended: "Close" };
    next.textContent = c.page === 7 && c.saved != null ? "Close" : labels[c.page] || "Confirm";
    next.classList.toggle("calwiz-go", c.page === 4 || (c.page === 7 && c.saved == null));
    const pump = this.calPump() || {};
    let disabled = false;
    if (c.page === 2) disabled = !!validateStartMl(c.startMl);
    if (c.page === 3) disabled = !!validateTestRate(c.rate, pump.min_rate, pump.max_rate);
    if (c.page === 4) disabled = !!(pump.fault || pump.running || pump.state === "pumping");
    if (c.page === 6) disabled = !!(validateStartMl(c.startMl) || validateFinalMl(c.finalMl, c.startMl));
    next.disabled = disabled;
    if (c.page === 4) {
      const note = this.$("calwiz-start-note");
      if (note) {
        note.textContent = pump.fault
          ? "The pump is faulted: reset the fault first."
          : pump.running || pump.state === "pumping"
            ? "The pump is running: stop it first."
            : "The pump will run for 1 minute at the test rate, then stop by itself.";
        note.classList.toggle("calwiz-warn", disabled);
      }
    }
  }

  renderVsd(vsd) {
    const section = this.$("vsd-section");
    const line = this.$("pump-drive-line");
    this.vsdShown = !!vsd;
    this.renderVsdGear();
    if (!vsd) {
      this.hide(section);
      this.hide(line);
      return;
    }
    this.show(section);
    this.show(line);
    this.setText("pump-rpm", vsd.pump_rpm != null ? this.fmt(vsd.pump_rpm, 0) : "--");
    this.setText("motor-hz", vsd.motor_hz != null ? this.fmt(vsd.motor_hz, 1) : "--");
    const st = this.root.querySelector('[data-id="vsd-status"] .state-value');
    if (st) {
      st.textContent = vsd.tripped ? "Tripped" : "OK";
      st.className = "state-value " + (vsd.tripped ? "vsd-tripped" : "vsd-ok");
    }
    let trip = "";
    if (vsd.tripped) {
      trip = vsd.trip_description || "Drive tripped";
      if (vsd.trip_code != null) trip += ` (code ${vsd.trip_code})`;
    }
    this.setText("vsd-trip", trip);
  }

  // -- VSD commissioning panel ------------------------------------------------
  // Gear on the VSD tile (only with a VSD AND VSD Commissioning on), a
  // popover with live diagnostics (polled every VSD_POLL_MS while open) and
  // the drive parameters; a writable one opens the keypad, then a
  // confirmation (old -> new), then write_parameter and its read-back.
  // The RPCs are the injected opts.vsdPanel (lib/vsdPanel.ts).

  setVsdPanel(access) {
    this.vsdAccess = {
      enabled: !!(access && access.enabled),
      canWrite: !!(access && access.canWrite),
      writeBlockedReason: (access && access.writeBlockedReason) || "",
    };
    this.renderVsdGear();
    if (this.vsdOpen) this.renderParameters();
  }

  vsdAvailable() {
    return this.vsdAccess.enabled && this.vsdShown && !!this.opts.vsdPanel;
  }

  renderVsdGear() {
    const gear = this.$("vsd-gear");
    const section = this.$("vsd-section");
    const on = this.vsdAvailable();
    this.toggle(gear, on);
    if (section) section.classList.toggle("has-gear", on);
    if (!on && this.vsdOpen) this.vsdPanelClose();
  }

  vsdPanelOpen() {
    if (!this.vsdAvailable() || this.vsdOpen) return;
    this.vsdOpen = true;
    const gen = ++this.vsdGen;
    this.vsdDiag = null;
    this.vsdParams = null;
    this.vsdParamState = {};
    this.renderDiagnostics(null, "Reading the drive\u2026");
    this.renderParameters("Reading parameters\u2026");
    this.renderVsdReset();
    this.show(this.$("vsd-panel"));
    const close = this.$("vsd-panel-close");
    if (close && close.focus) close.focus();
    this.vsdPoll(gen);
    this.vsdLoadParameters(gen);
  }

  vsdPanelClose() {
    if (!this.vsdOpen) return;
    this.vsdOpen = false;
    this.vsdGen++; // stops the poll loop and drops answers still in flight
    if (this.keypadIsOpen() && this.keypadOpts.owner === "vsd") this.keypadClose();
    if (this.confirmOwner === "vsd") this.confirmClose();
    this.hide(this.$("vsd-panel"));
  }

  vsdLive(gen) {
    return !this.destroyed && this.vsdOpen && gen === this.vsdGen;
  }

  // One diagnostics read, then the next VSD_POLL_MS after it answers (never
  // overlapping, so a slow drive cannot pile requests up).
  vsdPoll(gen) {
    if (!this.vsdLive(gen)) return;
    Promise.resolve()
      .then(() => this.opts.vsdPanel.diagnostics())
      .catch((e) => ({ ok: false, message: String((e && e.message) || e) }))
      .then((ack) => {
        if (!this.vsdLive(gen)) return;
        if (ack && ack.ok) {
          this.vsdDiag = ack.result || null;
          this.renderDiagnostics(this.vsdDiag, "");
        } else {
          this.renderDiagnostics(this.vsdDiag, (ack && ack.message) || "No answer from the drive", true);
        }
        this.later(() => this.vsdPoll(gen), VSD_POLL_MS);
      });
  }

  vsdLoadParameters(gen) {
    Promise.resolve()
      .then(() => this.opts.vsdPanel.parameters())
      .catch((e) => ({ ok: false, message: String((e && e.message) || e) }))
      .then((ack) => {
        if (!this.vsdLive(gen)) return;
        if (ack && ack.ok) {
          this.vsdParams = ack.result || [];
          this.renderParameters(this.vsdParams.length ? "" : "The drive reported no parameters.");
        } else {
          this.vsdParams = null;
          this.renderParameters((ack && ack.message) || "Could not read the parameters.", true);
        }
      });
  }

  renderDiagnostics(d, message, isError = false) {
    for (const [field] of DIAG_FIELDS) {
      const cell = this.root.querySelector(`[data-diag="${field}"]`);
      if (!cell) continue;
      const n = cell.querySelector(".diag-number");
      if (n) n.textContent = formatDiagnostic(d, field);
      let tone = "";
      if (field === "comms_ok" && d) tone = d.comms_ok === false ? "bad" : d.comms_ok ? "good" : "";
      if (field === "trip" && d) tone = d.trip_code || d.trip_description ? "bad" : "";
      cell.classList.toggle("bad", tone === "bad");
      cell.classList.toggle("good", tone === "good");
    }
    const box = this.$("vsd-diag");
    if (box) box.classList.toggle("stale", isError && !!d);
    let text = message;
    if (!text && d) text = d.source === "status" ? "Live \u00b7 basic status (older motor app)" : "Live";
    const status = this.$("vsd-diag-status");
    if (status) {
      status.textContent = text || "";
      status.classList.toggle("error", isError);
    }
  }

  renderVsdReset() {
    const b = this.$("vsd-panel-reset");
    if (!b) return;
    b.disabled = !this.touch;
    b.title = this.touch ? "" : "Reset is available in HMI Control Mode Touch";
  }

  renderParameters(message, isError = false) {
    const list = this.$("vsd-params");
    if (!list) return;
    const note = this.$("vsd-params-note");
    if (note) note.textContent = this.vsdAccess.canWrite ? "Tap a value to change it" : this.vsdAccess.writeBlockedReason;
    const doc = this.root.ownerDocument;
    list.textContent = "";
    if (!this.vsdParams || message) {
      const p = doc.createElement("div");
      p.className = "vsd-params-message" + (isError ? " error" : "");
      p.textContent = message || "";
      list.appendChild(p);
      if (isError) {
        const retry = doc.createElement("button");
        retry.type = "button";
        retry.className = "action-btn vsd-params-retry";
        retry.setAttribute("data-id", "vsd-params-retry");
        retry.textContent = "Retry";
        retry.addEventListener("click", () => {
          this.renderParameters("Reading parameters\u2026");
          this.vsdLoadParameters(this.vsdGen);
        });
        list.appendChild(retry);
      }
      if (!this.vsdParams) return;
    }
    for (const p of this.vsdParams) list.appendChild(this.parameterRow(p));
  }

  parameterRow(p) {
    const doc = this.root.ownerDocument;
    const editable = p.writable && this.vsdAccess.canWrite;
    const row = doc.createElement(editable ? "button" : "div");
    if (editable) row.type = "button";
    row.className = "vsd-param" + (editable ? " editable" : " locked");
    row.setAttribute("role", "listitem");
    row.setAttribute("data-param", p.id);
    const units = p.units ? ` ${escapeHtml(p.units)}` : "";
    const range = p.min != null && p.max != null
      ? `${formatParameter(p, p.min)} to ${formatParameter(p, p.max)}${units}`
      : EMPTY_VALUE;
    const tag = !p.writable ? "Read only" : p.stop_required ? "Stopped only" : "";
    const st = this.vsdParamState[p.id] || {};
    row.innerHTML =
      `<span class="param-name"><span class="param-id">${escapeHtml(p.id)}</span>` +
      `<span class="param-label">${escapeHtml(p.name)}</span></span>` +
      `<span class="param-value"><span class="param-number">${formatParameter(p)}</span>` +
      `<span class="param-units">${escapeHtml(p.units || "")}</span></span>` +
      `<span class="param-range">${range}</span>` +
      `<span class="param-state">${tag ? `<span class="param-tag">${tag}</span>` : ""}` +
      `<span class="param-note" data-note>${escapeHtml(st.note || "")}</span></span>`;
    if (p.description) row.title = p.description;
    if (st.state) row.classList.add(st.state);
    return row;
  }

  setParamState(id, state, note) {
    this.vsdParamState[id] = { state, note };
    const list = this.$("vsd-params");
    const old = list && list.querySelector(`[data-param="${CSS_ESCAPE(id)}"]`);
    const p = (this.vsdParams || []).find((x) => x.id === id);
    if (old && p) old.replaceWith(this.parameterRow(p));
  }

  vsdEditParameter(id, row) {
    const p = (this.vsdParams || []).find((x) => x.id === id);
    if (!p || !p.writable) return;
    if (!this.vsdAccess.canWrite) {
      this.showToast(this.vsdAccess.writeBlockedReason || "Changes are not allowed here", "error");
      return;
    }
    if (row && row.classList.contains("pending")) return;
    const dp = stepDp(p.step);
    this.keypadOpen({
      owner: "vsd",
      title: `${p.id} ${p.name}`,
      value: p.value,
      min: p.min,
      max: p.max,
      decimals: dp,
      unit: p.units || "",
      onSubmit: (value) => {
        const units = p.units ? ` ${p.units}` : "";
        const stop = p.stop_required ? " The drive must be stopped." : "";
        this.confirmAsk(
          `Change ${p.id} ${p.name} from ${formatParameter(p)} \u2192 ${formatParameter(p, value)}${units}?${stop}`,
          () => this.vsdWrite(p, value),
          "vsd",
        );
      },
    });
  }

  vsdWrite(p, value) {
    const gen = this.vsdGen;
    this.setParamState(p.id, "pending", "Writing\u2026");
    Promise.resolve()
      .then(() => this.opts.vsdPanel.write(p, value))
      .catch((e) => ({ ok: false, message: String((e && e.message) || e) }))
      .then((ack) => {
        if (this.destroyed || gen !== this.vsdGen) return;
        const readBack = ack && ack.result ? ack.result.value : undefined;
        if (readBack !== undefined && readBack !== null) p.value = readBack;
        if (ack && ack.ok) {
          const units = p.units ? ` ${p.units}` : "";
          this.setParamState(p.id, "ok", `Saved \u00b7 drive reads ${formatParameter(p)}${units}`);
          this.showToast(`${p.id} set to ${formatParameter(p)}${units}`, "ok");
        } else {
          const msg = (ack && ack.message) || "Write failed";
          this.setParamState(p.id, "error", msg);
          this.showToast(`${p.id}: ${msg}`, "error");
        }
      });
  }

  // -- helpers ------------------------------------------------------------------
  fmt(v, dp) {
    const n = v != null ? Number(v) : 0;
    return isNaN(n) ? "0" : n.toFixed(dp);
  }

  setValue(id, value, unit) {
    const c = this.$(id);
    if (!c) return;
    const v = c.querySelector(".value");
    if (v) v.textContent = value;
    if (unit !== undefined) {
      const u = c.querySelector(".unit");
      if (u) u.textContent = unit;
    }
  }

  setText(id, text) {
    const e = this.$(id);
    if (e) e.textContent = text;
  }

  setConnection(connected, linkOk) {
    const e = this.$("connection-status");
    if (!e) return;
    if (!connected) {
      e.className = "status-disconnected";
      e.textContent = "● Disconnected";
    } else if (linkOk === false) {
      e.className = "status-disconnected status-warning";
      e.textContent = "● No controller";
    } else {
      e.className = "status-connected";
      e.textContent = "● Connected";
    }
  }

  setLastUpdate(ts) {
    const t = ts ? new Date(ts) : new Date();
    if (isNaN(t.getTime())) return;
    this.setText(
      "last-update",
      t.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
    );
  }

  setBar(id, pct) {
    const e = this.$(id);
    if (!e) return;
    e.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    e.className = "progress-fill" + (pct < 5 ? " low" : pct < 25 ? " medium" : "");
  }

  show(e) {
    if (e) e.classList.remove("hidden");
  }

  toggle(e, visible) {
    if (visible) this.show(e);
    else this.hide(e);
  }

  hide(e) {
    if (e) e.classList.add("hidden");
  }

  destroy() {
    this.destroyed = true;
    this.vsdOpen = false;
    if (this.onKey) this.root.ownerDocument.removeEventListener("keydown", this.onKey);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.root.innerHTML = "";
    this.root.classList.remove("sia-hmi", "kiosk", "embedded");
  }
}

/**
 * Mount the HMI into `root`.
 *
 * opts: {
 *   layout: "kiosk" | "embedded",
 *   sendCommand(cmd, value): Promise<{ok, code?, message?}>,
 *   hostLabel?: string,          // header badge, e.g. "Local panel"
 *   title?: string,              // header title (default "SIA Remote Command")
 *   logos?: {remoteCommand?, doover?}  // data URIs
 *   vsdPanel?: {diagnostics(), parameters(), write(param, value)}
 *                                // VSD commissioning RPCs (lib/vsdPanel.ts);
 *                                // the gear also needs setVsdPanel(access)
 * }
 */
export function createHmi(root, opts) {
  const hmi = new Hmi(root, opts);
  return {
    update: (data, status) => hmi.update(data, status),
    notify: (message, level) => hmi.showToast(message, level),
    setVsdPanel: (access) => hmi.setVsdPanel(access),
    destroy: () => hmi.destroy(),
    /** For tests: the underlying instance. */
    _hmi: hmi,
  };
}
