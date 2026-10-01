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
 * Layouts: "kiosk" fills the viewport (the Doovit panel, 800x480, 1024x600
 * or 1024x768), less the cover-plate inset, with the touch bar pinned to the
 * bottom edge; "embedded" flows at
 * its natural height inside the cloud UI with the bar sticky at the bottom of
 * the widget. Same markup, same rules, same payload in both.
 */

import {
  CAL_TEST_DURATION_S,
  computeCalibration,
  formatMl,
  SITE_GLASS_MAX_ML,
  testRateRange,
  validateFinalMl,
  validateStartMl,
  validateTestRate,
} from "./calibration.js";
import {
  ALARM_DELAY_MISSING_TEXT,
  ALARM_FIELDS,
  ALARM_GROUPS,
  alarmDecimals,
  alarmRange,
  alarmValue,
  formatAlarmValue,
  isDelayField,
  validateAlarmValue,
} from "./alarms.js";
import {
  SENSOR_FIELDS,
  SENSOR_GROUPS,
  SENSOR_LOCKED_TEXT,
  SENSOR_RESET_COMMAND,
  formatSensorInput,
  formatSensorReading,
  formatSensorValue,
  sensorDecimals,
  sensorHint,
  sensorInputCaption,
  sensorLabel,
  sensorRange,
  sensorRangeText,
  sensorValue,
  validateSensorValue,
} from "./sensors.js";

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
// A command with no answer this long is reported and its button freed (the
// shell times out first, at the RPC timeout + 2 s; this is the backstop for
// a host whose RPC never settles, e.g. no gateway connection).
export const COMMAND_TIMEOUT_MS = 30_000;
export const NO_REPLY_TEXT = "No reply from the pump controller";

// A settings cell whose write is still out (alarm and sensor cells).
const WRITING_STATE = Object.freeze({ state: "pending", note: "Writing…" });

// Pure keypad helpers (unit-tested): next entry text after a key press, and
// validation of an entry against an inclusive range.
// "neg" (the \u00b1 key, shown only on a signed keypad) flips a leading minus.
export function keypadInput(text, key) {
  text = text || "";
  if (key === "clear") return "";
  if (key === "back") return text.slice(0, -1);
  if (key === "neg") return text.startsWith("-") ? text.slice(1) : "-" + text;
  const sign = text.startsWith("-") ? "-" : "";
  const body = text.slice(sign.length);
  if (key === ".") {
    if (body.includes(".")) return text;
    return sign + (body || "0") + ".";
  }
  if (!/^[0-9]$/.test(key)) return text;
  if (body.length >= KEYPAD_MAX_CHARS) return text;
  if (body === "0") return sign + key;
  return text + key;
}

export function validateKeypadEntry(text, min, max) {
  if (!text || /^-?\.?$/.test(text) || !/^-?[0-9]*\.?[0-9]*$/.test(text)) {
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

const UP_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 15l7-7 7 7"/></svg>`;
const DOWN_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9l7 7 7-7"/></svg>`;

const CLOSE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
// Two circular arrows: reload the screen.
const REFRESH_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4v5h-5"/><path d="M3 20v-5h5"/><path d="M20.1 9A8.5 8.5 0 0 0 5.6 6.3L3 9"/><path d="M3.9 15a8.5 8.5 0 0 0 14.5 2.7L21 15"/></svg>`;

// The kiosk's Refresh button asks this first (in-page, like every confirm).
export const RELOAD_CONFIRM_TEXT = "Reload the screen? Live data returns in a few seconds.";

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

// Up / down buttons beside a scroll area (no scrollbars on the panel): each
// moves about one visible page, disables at its end, and both hide when the
// content fits. Wired by Hmi.bindScroller(id).
function scrollRail(id) {
  return `<div class="scroll-rail hidden" data-id="${id}-rail">` +
    `<button type="button" class="scroll-btn" data-id="${id}-up" aria-label="Scroll up">${UP_ICON}</button>` +
    `<button type="button" class="scroll-btn" data-id="${id}-down" aria-label="Scroll down">${DOWN_ICON}</button>` +
    `</div>`;
}

/** Where a scroll area is (pure, unit-tested): 1 px tolerance for rounding. */
export function scrollState(el) {
  const max = Math.max(0, el.scrollHeight - el.clientHeight);
  return {
    overflow: max > 1,
    atTop: el.scrollTop <= 1,
    atBottom: el.scrollTop >= max - 1,
  };
}

/** One button press: most of a visible page, keeping a row of context. */
export function scrollPageStep(clientHeight) {
  return Math.max(40, Math.round(clientHeight * 0.85));
}

/** Millimetres to whole pixels at pxPerMm (pure): bad input is 0. */
export function mmToPx(mm, pxPerMm) {
  const m = Number(mm);
  const k = Number(pxPerMm);
  if (!Number.isFinite(m) || !Number.isFinite(k) || m <= 0 || k <= 0) return 0;
  return Math.round(m * k * 10) / 10;
}

/**
 * Set an element's text only when it changes. Data updates arrive every
 * second or so (more often when the host polls); rewriting unchanged text
 * replaces the text node, and WebKit drops a touch tap whose touchstart node
 * is replaced before touchend. So an update never touches what it need not.
 */
export function setNodeText(el, text) {
  if (!el) return;
  const t = String(text);
  if (el.textContent !== t) el.textContent = t;
}

// Guarded writes, for the same reason as setNodeText: each update rewrites
// every class, attribute and disabled flag it owns, and on the kiosk
// (software-composited WebKit) every write that lands runs the attribute
// change path and can cost a painted frame. These leave the DOM untouched
// when the value is already there.
function setClass(el, cls, on) {
  // A forced toggle is a no-op when the state already matches (DOM spec);
  // classList.add / remove rewrite the class attribute every time.
  if (el) el.classList.toggle(cls, !!on);
}
function setClassName(el, v) {
  if (el && el.className !== v) el.className = v;
}
function setAttr(el, name, v) {
  if (el && el.getAttribute(name) !== v) el.setAttribute(name, v);
}
function setProp(el, name, v) {
  if (el && el[name] !== v) el[name] = v;
}

/** A range limit as the controller holds it (e.g. 758.4 kPa, 100 %). */
function rangeNum(v) {
  const n = Number(v);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
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
  // Refresh (local kiosk only): a full page reload, the one sure recovery for
  // a wedged kiosk browser. Never in the cloud, where it would reload the
  // whole customer site.
  const reload = opts.reloadButton
    ? `<button type="button" class="icon-btn header-reload" data-id="reload-btn" aria-label="Refresh" title="Refresh">${REFRESH_ICON}</button>`
    : "";
  return `
<div class="dashboard-container" data-id="container">
  <div class="hmi-body">
    <header class="dashboard-header${reload ? " has-reload" : ""}">
      <h1>${logo}<span class="header-title">${escapeAttr(opts.title || "SIA Remote Command")}</span></h1>
      <div class="header-info">
        <div class="connection-status">
          <span data-id="connection-status" class="status-disconnected">&#9679; Disconnected</span>
        </div>
        <div class="timestamp">Last Update: <span data-id="last-update">--</span></div>
        <div class="host-badge" data-id="host-badge"></div>
      </div>
      ${reload}
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
        <section class="control-section pump-section" data-id="pump-section">
          <h2 class="section-head"><span>Pump Control</span>
            <button type="button" class="icon-btn section-gear hidden" data-id="flow-gear"
              aria-label="Flow alarms" title="Flow alarms">${GEAR_ICON}</button>
          </h2>
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
          <h2 class="section-head"><span>Skid</span>
            <button type="button" class="icon-btn section-gear hidden" data-id="pressure-gear"
              aria-label="Discharge pressure alarms" title="Discharge pressure alarms">${GEAR_ICON}</button>
          </h2>
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
          <h2 class="section-head"><span>Tank</span>
            <button type="button" class="icon-btn section-gear hidden" data-id="tank-gear"
              aria-label="Tank level alarms" title="Tank level alarms">${GEAR_ICON}</button>
          </h2>
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
    <div class="scroll-area vsd-params-area" data-id="vsd-params-area">
      <div class="vsd-params" data-id="vsd-params" role="list"></div>
      ${scrollRail("vsd-params")}
    </div>
  </div>
</div>

<div data-id="alarm-panel" class="modal-overlay alarm-panel-overlay hidden" role="dialog" aria-modal="true" aria-label="Alarm settings">
  <div class="alarm-panel" data-id="alarm-panel-box">
    <div class="vsd-panel-head">
      <h2 class="vsd-panel-title" data-id="alarm-panel-title">Alarm Settings</h2>
      <span class="vsd-panel-status alarm-panel-note" data-id="alarm-panel-note"></span>
      <button type="button" class="icon-btn vsd-panel-close" data-id="alarm-panel-close" aria-label="Close">${CLOSE_ICON}</button>
    </div>
    <div class="alarm-tabs hidden" data-id="alarm-tabs" role="tablist">
      <button type="button" class="alarm-tab" data-id="alarm-tab-alarms" role="tab" aria-selected="true">Alarms</button>
      <button type="button" class="alarm-tab" data-id="alarm-tab-sensor" role="tab" aria-selected="false">Sensor</button>
    </div>
    <div class="alarm-rows" data-id="alarm-rows" role="list"></div>
    <div class="sensor-pane hidden" data-id="sensor-pane">
      <div class="sensor-live">
        <div class="sensor-reading"><span class="alarm-caption" data-id="sensor-ma-caption">Loop current</span><span class="sensor-live-value" data-id="sensor-ma">${EMPTY_VALUE}</span></div>
        <div class="sensor-reading"><span class="alarm-caption" data-id="sensor-reading-caption">Reading</span><span class="sensor-live-value" data-id="sensor-reading">${EMPTY_VALUE}</span></div>
        <button type="button" class="action-btn sensor-reset" data-id="sensor-reset">Reset to configured values</button>
      </div>
      <div class="sensor-note hidden" data-id="sensor-note" role="note"></div>
      <div class="sensor-cells" data-id="sensor-cells" role="list"></div>
    </div>
  </div>
</div>

<div data-id="calwiz" class="modal-overlay calwiz-overlay hidden" role="dialog" aria-modal="true" aria-label="${CAL_TITLE}">
  <div class="calwiz" data-id="calwiz-box">
    <div class="calwiz-head">
      <button type="button" class="icon-btn cal-help-btn" data-id="calwiz-help" aria-label="What is the calibration factor?">?</button>
      <h2 class="calwiz-title">${CAL_TITLE}</h2>
      <span class="calwiz-step" data-id="calwiz-step"></span>
      <button type="button" class="icon-btn calwiz-close" data-id="calwiz-close" aria-label="Close">${CLOSE_ICON}</button>
    </div>
    <div class="calwiz-main">
      <div class="calwiz-body" data-id="calwiz-body"></div>
      <div class="calwiz-error" data-id="calwiz-error" role="alert"></div>
      <div class="calwiz-actions">
        <button type="button" class="key key-cancel calwiz-back" data-id="calwiz-back">Back</button>
        <button type="button" class="key calwiz-discard hidden" data-id="calwiz-discard">Discard</button>
        <button type="button" class="key key-ok calwiz-next" data-id="calwiz-next"><span class="btn-label" data-id="calwiz-next-label">Confirm</span></button>
      </div>
    </div>
  </div>
</div>

<div data-id="keypad" class="modal-overlay hidden" role="dialog" aria-modal="true">
  <div class="keypad">
    <div class="keypad-info">
      <div class="keypad-head">
        <button type="button" class="icon-btn cal-help-btn hidden" data-id="keypad-help" aria-label="What is the calibration factor?">?</button>
        <div class="keypad-title" data-id="keypad-title"></div>
      </div>
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
    <div class="keypad-keys" data-id="keypad-keys">
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
      <button type="button" class="key key-fn hidden" data-key="neg" data-id="keypad-neg" aria-label="Plus or minus">&plusmn;</button>
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

<div data-id="cal-help" class="modal-overlay hidden" role="dialog" aria-modal="true" aria-label="Calibration factor help">
  <div class="confirm-box cal-help-box">
    <div class="cal-help-head">
      <h2 class="cal-help-title">Calibration factor</h2>
      <button type="button" class="icon-btn" data-id="cal-help-close" aria-label="Close">${CLOSE_ICON}</button>
    </div>
    <p class="cal-help-text">Corrects the pump so the real flow matches the target rate.</p>
    <ul class="cal-help-list">
      <li><strong>1.00</strong> = no correction.</li>
      <li>Pump delivers <strong>less</strong> than the target: <strong>raise</strong> the factor.</li>
      <li>Pump delivers <strong>more</strong> than the target: <strong>lower</strong> the factor.</li>
    </ul>
    <p class="cal-help-text">The 1 minute calibration test works it out for you. Range 0.30 to 1.70.</p>
  </div>
</div>

<div data-id="command-toast" class="command-toast hidden" role="status"></div>

<!-- Warms the font fallback for the keypad's backspace glyph (hmi-core.css). -->
<span class="glyph-warm" aria-hidden="true">&#9003;</span>`;
}

// The open VSD panel re-reads diagnostics this long after each answer.

export const VSD_POLL_MS = 2000;

const CSS_ESCAPE = (id) => String(id).replace(/["\\]/g, "\\$&");

// Deeper than any payload nests: past it two values count as different, so
// a cyclic one takes a full render instead of overflowing the stack.
const SAME_VALUE_DEPTH = 32;

const isPlain = (o) => {
  const p = Object.getPrototypeOf(o);
  return p === Object.prototype || p === Array.prototype || p === null;
};

/** Deep equality of payload values: the same own keys, arrays compared by
 * index, Object.is on leaves (so -0 vs 0, or an undefined key vs a missing
 * one, counts as a change and errs toward a full render). Payloads are plain
 * JSON-shaped data: two distinct objects of any other kind (a Date, a Map,
 * a class instance) also count as a change, as does a cycle. */
function sameValue(a, b, depth = 0) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (depth >= SAME_VALUE_DEPTH || !isPlain(a) || !isPlain(b)) return false;
  const arr = Array.isArray(a);
  if (arr !== Array.isArray(b)) return false;
  if (arr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i], depth + 1)) return false;
    return true;
  }
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !sameValue(a[k], b[k], depth + 1)) return false;
  }
  return true;
}

/** Two payloads that differ at most in their top-level timestamp (pure,
 * unit-tested). Over half the live feed is exactly that: the controller
 * re-sends unchanged tags, and each event restamps the aggregate. */
export function samePayloadButTime(a, b) {
  if (!a || !b) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (k === "timestamp") {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(b, k) || !sameValue(a[k], b[k])) return false;
  }
  return true;
}

const MODE_LABELS = { read_only: "Read Only", touch: "Touch", button: "Button" };

// Alarm settings gears: [alarm group, gear, the tile section it sits on].
// Flow sits on Pump Control, beside the Flow Rate its alarms watch.
const ALARM_GEAR_SPECS = [
  ["tank", "tank-gear", "tank-section"],
  ["pressure", "pressure-gear", "skid-section"],
  ["flow", "flow-gear", "pump-section"],
];

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
    this.pendingSince = new Map();
    this.destroyed = false;
    // VSD commissioning panel (gear on the VSD tile).
    this.vsdAccess = { enabled: false, canWrite: false, writeBlockedReason: "" };
    this.vsdShown = false;
    this.vsdOpen = false;
    this.vsdGen = 0;
    this.vsdDiag = null;
    this.vsdParams = null;
    this.vsdParamState = {};
    // Alarm settings popovers (gears on the Tank / Skid / Pump Control tiles).
    this.alarmAccess = { enabled: false, canWrite: false, writeBlockedReason: "" };
    this.alarmOpen = null; // "tank" | "pressure" | "flow" while shown
    this.alarmState = {};
    // Writes still waiting for an answer (alarm field / sensor field or
    // "<group>:reset"). The double-tap guard and the cells' pending look
    // come from these, not from a cell's class: a tab switch or a reopen
    // rebuilds the cells while a write is still out.
    this.alarmInFlight = new Set();
    this.sensorInFlight = new Set();
    // Its Sensor tab (Tank / Skid pressure only), under sensor_settings_access.
    this.sensorAccess = { enabled: false, canWrite: false, writeBlockedReason: "" };
    this.alarmTab = "alarms"; // "alarms" | "sensor": the tab shown while open
    this.alarmTabsKey = ""; // the tabs on offer, as last drawn
    this.sensorState = {};
    // 1min Calibration Sequence wizard state while open (null when closed).
    // Invariant: set only while the calwiz popover is on screen; a session
    // without it is stale and is dropped (calwizDropStale).
    this.cal = null;
    this.resizeObserver = null;
    // The last payload fully rendered and the connection it was drawn with
    // (update's fast path); null until then, and after a null payload.
    this.rendered = null;
    // Elements found by $ / $in (an update looks up some 60 of them).
    this.els = new Map();
    // Last Update: the epoch second and UTC offset clockText was made for.
    this.clockSec = null;
    this.clockOff = null;
    this.clockText = "";

    root.classList.add("sia-hmi", this.opts.layout === "kiosk" ? "kiosk" : "embedded");
    root.innerHTML = template(this.opts);
    this.bind();
  }

  // Cached while the element is still in the page, instead of a selector
  // search of the whole widget per lookup. A rebuilt node (wizard body,
  // alarm rows, VSD Retry) replaces a now-disconnected one and is looked up
  // again; a miss is never cached. No data-id appears twice in the widget,
  // and nothing moves a node out of the root, so one still in the document
  // is still the one inside this.root.
  $(id) {
    const hit = this.els.get(id);
    if (hit && hit.isConnected) return hit;
    const el = this.root.querySelector(`[data-id="${id}"]`);
    if (el) this.els.set(id, el);
    else this.els.delete(id);
    return el;
  }

  // First match of sel inside [data-id=id], cached the same way.
  $in(id, sel) {
    const key = id + "\u0000" + sel;
    const hit = this.els.get(key);
    if (hit && hit.isConnected) return hit;
    const c = this.$(id);
    const el = c ? c.querySelector(sel) : null;
    if (el) this.els.set(key, el);
    else this.els.delete(key);
    return el;
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
    // The "?" on the wizard and on the calibration factor keypad: what the
    // factor does, over whichever is open; its X closes it.
    const calHelp = this.$("cal-help");
    on("calwiz-help", () => this.show(calHelp));
    on("keypad-help", () => this.show(calHelp));
    on("cal-help-close", () => this.hide(calHelp));
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
    // Not a control command: works in every HMI Control Mode.
    on("reload-btn", () => this.confirmAsk(RELOAD_CONFIRM_TEXT, () => this.reloadPage(), "reload"));

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
    on("tank-gear", () => this.alarmPanelOpen("tank"));
    on("pressure-gear", () => this.alarmPanelOpen("pressure"));
    on("flow-gear", () => this.alarmPanelOpen("flow"));
    on("alarm-panel-close", () => this.alarmPanelClose());
    const alarmOverlay = this.$("alarm-panel");
    if (alarmOverlay) {
      alarmOverlay.addEventListener("click", (e) => {
        if (e.target === alarmOverlay) this.alarmPanelClose();
      });
    }
    const alarmRows = this.$("alarm-rows");
    if (alarmRows) {
      alarmRows.addEventListener("click", (e) => {
        const row = e.target && e.target.closest ? e.target.closest("[data-alarm]") : null;
        if (row) this.alarmEdit(row.getAttribute("data-alarm"), row);
      });
    }
    on("alarm-tab-alarms", () => this.alarmTabSelect("alarms"));
    on("alarm-tab-sensor", () => this.alarmTabSelect("sensor"));
    on("sensor-reset", () => this.sensorReset());
    const sensorCells = this.$("sensor-cells");
    if (sensorCells) {
      sensorCells.addEventListener("click", (e) => {
        const c = e.target && e.target.closest ? e.target.closest("[data-sensor]") : null;
        if (c) this.sensorEdit(c.getAttribute("data-sensor"), c);
      });
    }
    this.bindScroller("vsd-params");
    this.onKey = (e) => {
      if (e.key !== "Escape") return;
      if (this.keypadIsOpen() || this.confirmOk) return;
      // The wizard on screen takes Escape (and keeps it on page 5, while the
      // pump runs); a stale session never blocks the VSD panel.
      if (this.cal && this.calwizShown()) this.calwizClose();
      else if (this.alarmOpen) this.alarmPanelClose();
      else if (this.vsdOpen) this.vsdPanelClose();
    };
    this.root.ownerDocument.addEventListener("keydown", this.onKey);
  }

  // -- scroll areas: no scrollbars, big up / down buttons ---------------------
  bindScroller(id) {
    const list = this.$(id);
    if (!list) return;
    const go = (dir) => {
      if (!scrollState(list).overflow) return;
      const max = list.scrollHeight - list.clientHeight;
      const top = list.scrollTop + dir * scrollPageStep(list.clientHeight);
      list.scrollTop = Math.max(0, Math.min(max, top));
      this.updateScroller(id);
    };
    const up = this.$(`${id}-up`);
    const down = this.$(`${id}-down`);
    if (up) up.addEventListener("click", () => go(-1));
    if (down) down.addEventListener("click", () => go(1));
    // Touch-drag still scrolls; the buttons follow it.
    list.addEventListener("scroll", () => this.updateScroller(id), { passive: true });
    const win = this.root.ownerDocument.defaultView;
    if (win && typeof win.ResizeObserver === "function") {
      this.resizeObserver = new win.ResizeObserver(() => this.updateScroller(id));
      this.resizeObserver.observe(list);
    }
  }

  updateScroller(id) {
    const list = this.$(id);
    if (!list) return;
    const st = scrollState(list);
    this.toggle(this.$(`${id}-rail`), st.overflow);
    const up = this.$(`${id}-up`);
    const down = this.$(`${id}-down`);
    setProp(up, "disabled", !st.overflow || st.atTop);
    setProp(down, "disabled", !st.overflow || st.atBottom);
  }

  // -- cover-plate insets (kiosk only) ------------------------------------------
  // kiosk_inset_mm pads the whole HMI (header, banners, tiles, touch bar);
  // popover_inset_mm keeps every popover that much further in. The embedded
  // (cloud) layout ignores both.
  setDisplay(display) {
    const d = display || {};
    const style = this.root.style;
    if (this.opts.layout !== "kiosk") {
      style.removeProperty("--hmi-kiosk-inset");
      style.removeProperty("--hmi-popover-inset");
      return;
    }
    style.setProperty("--hmi-kiosk-inset", `${mmToPx(d.kioskInsetMm, d.pxPerMm)}px`);
    style.setProperty("--hmi-popover-inset", `${mmToPx(d.popoverInsetMm, d.pxPerMm)}px`);
    this.updateScroller("vsd-params");
  }

  // -- keypad ---------------------------------------------------------------
  keypadOpen(opts) {
    this.keypadOpts = opts;
    this.keypadText = "";
    this.setText("keypad-title", opts.title || "");
    this.toggle(this.$("keypad-help"), !!opts.calHelp);
    // The \u00b1 key only where a value may be negative (sensor ranges).
    this.toggle(this.$("keypad-neg"), !!opts.signed);
    setClass(this.$("keypad-keys"), "signed", !!opts.signed);
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

  // Full page reload (the Refresh button). Injectable so tests need not
  // reload jsdom.
  reloadPage() {
    if (typeof this.opts.reloadPage === "function") return this.opts.reloadPage();
    const win = this.root.ownerDocument.defaultView;
    if (win) win.location.reload();
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
      calHelp: true,
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
  // Always answers (a promise of an ack) and never fails silently: a refused
  // or doubled press says why, and a command with no answer is reported and
  // its button freed after commandTimeoutMs().
  // `target` routes a Sensor tab write to that sensor app (the shell's
  // meta.target); `who` names the app that answers, for the still-waiting
  // and no-reply messages.
  sendCommand(cmd, value, btn, { requireTouch = true, target = null, who = "pump controller" } = {}) {
    const refuse = (message, level = "error") => {
      this.showToast(message, level);
      return Promise.resolve({ ok: false, code: "REFUSED", message });
    };
    if (requireTouch && !this.touch) return refuse("On-screen control is off (HMI Control Mode)");
    if (typeof this.opts.sendCommand !== "function") return refuse("Commands are not available from this screen");
    if (btn && btn.classList.contains("pending")) {
      const since = this.pendingSince.get(btn) || 0;
      if (Date.now() - since < this.commandTimeoutMs()) {
        return refuse(`Still waiting for the ${who} to answer`, "");
      }
      // A press whose answer never came: free the button and send again.
    }
    this.setFeedback(btn, "pending");
    if (btn) this.pendingSince.set(btn, Date.now());
    let result;
    try {
      result = Promise.resolve(
        target ? this.opts.sendCommand(cmd, value, { target }) : this.opts.sendCommand(cmd, value),
      );
    } catch (e) {
      result = Promise.resolve({ ok: false, message: String((e && e.message) || e) });
    }
    let watchdog = null;
    const noReply = new Promise((resolve) => {
      watchdog = this.later(
        () => resolve({ ok: false, code: "TIMEOUT", message: `No reply from the ${who}` }),
        this.commandTimeoutMs(),
      );
    });
    return Promise.race([
      result.catch((e) => ({ ok: false, message: String((e && e.message) || e) })),
      noReply,
    ])
      .then((ack) => {
        clearTimeout(watchdog);
        this.timers.delete(watchdog);
        if (btn) this.pendingSince.delete(btn);
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

  commandTimeoutMs() {
    const t = typeof this.opts.commandTimeoutMs === "function"
      ? this.opts.commandTimeoutMs()
      : this.opts.commandTimeoutMs;
    return Number(t) > 0 ? Number(t) : COMMAND_TIMEOUT_MS;
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
  // Always at the bottom of the screen. With a popover open (alarm, VSD,
  // calibration) the bar is under it, so the toast goes in the gap below the
  // popover, or on the bottom edge, over the popover's lowest row, when that
  // gap is not tall enough. It never takes taps (pointer-events: none), so
  // a row under it still works.
  placeToast(el) {
    el.style.bottom = "";
    el.style.top = "";
    const win = this.root.ownerDocument.defaultView;
    if (!win) return;
    const pop = ["alarm-panel", "vsd-panel", "calwiz"].find((id) => {
      const o = this.$(id);
      return o && !o.classList.contains("hidden");
    });
    if (pop) {
      const r = this.$(`${pop}-box`).getBoundingClientRect();
      const inset = parseFloat(win.getComputedStyle(this.root).getPropertyValue("--hmi-kiosk-inset")) || 0;
      const h = el.offsetHeight;
      const below = win.innerHeight - inset - r.bottom;
      if (below >= h + 8) {
        el.style.top = `${Math.round(r.bottom + (below - h) / 2)}px`;
        el.style.bottom = "auto";
      } else {
        el.style.bottom = `${Math.round(inset + 8)}px`;
      }
      return;
    }
    const bar = this.$("touch-bar");
    if (!bar || bar.classList.contains("hidden")) return;
    const r = bar.getBoundingClientRect();
    if (!r.height || r.top >= win.innerHeight) return;
    el.style.bottom = `${Math.max(24, win.innerHeight - r.top + 12)}px`;
  }

  // -- render -------------------------------------------------------------------
  // A payload must not be changed after it is passed in: the next one is
  // compared against it (the data adapter builds a new object every call).
  update(data, status) {
    if (status && typeof status.connected === "boolean") this.connected = status.connected;
    if (!data) {
      this.rendered = null;
      this.setConnection(this.connected, undefined);
      return;
    }
    const prev = this.rendered;
    if (prev && prev.connected === this.connected && samePayloadButTime(prev.data, data)) {
      // Same payload but for its timestamp: every render below would write
      // nothing, as each depends only on the payload and the connection, or
      // on state that redraws itself when it changes (alarm / VSD access).
      // Only the clock, the wizard's time-based steps (the wall-clock
      // backstop, a stale session, reattach) and the open alarm popover can
      // move: the command feedback timer takes a written row's Saved / error
      // ring off after FEEDBACK_MS, and each update puts it back from
      // alarmState (its writes are guarded, so an idle one writes nothing).
      this.data = data;
      if (data.units) this.units = data.units;
      if (this.alarmOpen) this.renderAlarmPanelValues();
      this.renderCalwizLive();
      this.setLastUpdate(data.timestamp);
      return;
    }
    // Cleared first: a render that throws part-way leaves no snapshot, so
    // the next payload (even one equal to the last good one) renders in full.
    this.rendered = null;
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
    this.renderAlarmGears();
    if (this.alarmOpen) this.renderAlarmPanelValues();
    this.renderTouch(data.touch, (data.pumps || [])[0]);
    this.renderCalwizLive();
    this.renderVsd(data.vsd);
    if (this.vsdOpen) this.renderVsdReset();
    this.setLastUpdate(data.timestamp);
    this.rendered = { data, connected: this.connected };
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
    const st = this.$in("pump-state", ".state-value");
    if (st) {
      setNodeText(st, state);
      setClassName(st, "state-value " + stateClass + (pump.fault ? " error" : ""));
    }
  }

  setTotal(value, unit) {
    if (!this.$("flow-total")) return;
    setNodeText(this.$in("flow-total", ".secondary-value"), this.fmt(value, 2));
    setNodeText(this.$in("flow-total", ".secondary-unit"), unit);
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
    // Rebuilt only when what is on screen differs, item by item: a banner
    // that stays up would otherwise repaint on every update. (Not a joined
    // signature: ["a\nb", "c"] and ["a", "b\nc"] join to the same text.)
    const texts = items.map((item) => (item.pump ? `${item.pump}: ` : "") + (item.reason || fallback));
    const shown = list.childNodes;
    let same = shown.length === texts.length;
    for (let i = 0; same && i < texts.length; i++) {
      const li = shown[i];
      same = li.nodeName === "LI" && li.textContent === texts[i];
    }
    if (!same) {
      list.textContent = "";
      const doc = this.root.ownerDocument;
      for (const t of texts) {
        const li = doc.createElement("li");
        li.textContent = t;
        list.appendChild(li);
      }
    }
    this.toggle(banner, texts.length > 0);
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
      setClass(row, "no-skid", true);
      return;
    }
    this.show(section);
    setClass(row, "no-skid", false);
    // Only the readings whose app is configured are shown. A configured app
    // with no value (null: sensor disconnected or out of range) keeps its card,
    // reading "--", so the gear stays reachable to calibrate the sensor.
    const has = (key) => key in s;
    const text = (v, dp) => (v == null ? "--" : this.fmt(v, dp));
    this.toggle(this.$("skid-flow-card"), has("skid_flow"));
    this.toggle(this.$("skid-pressure-card"), has("skid_pressure"));
    if (has("skid_flow")) this.setValue("skid-flow", text(s.skid_flow, 1), this.units.rate);
    if (has("skid_pressure")) this.setValue("skid-pressure", text(s.skid_pressure, 1), this.units.pressure);
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
      const u = this.$in("tank-level-mm", ".unit");
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
      setClass(container, "touch-mode", false);
      if (footer && footer.classList.contains("touch-hidden")) {
        footer.classList.remove("touch-hidden");
        this.show(footer);
      }
      // Only the touch controls' own keypad / confirmation: a VSD panel edit
      // is governed by VSD Commissioning, not HMI Control Mode.
      if (this.keypadIsOpen() && !["vsd", "alarm", "sensor"].includes(this.keypadOpts.owner)) this.keypadClose();
      if (this.confirmOwner === "touch") this.confirmClose();
      return;
    }
    this.show(bar);
    setClass(container, "touch-mode", true);
    if (footer && !footer.classList.contains("hidden")) {
      footer.classList.add("touch-hidden");
      this.hide(footer);
    }

    const faulted = !!(pump && pump.fault);
    const start = this.$("touch-start");
    setProp(start, "disabled", faulted || !pump);
    this.setText("touch-start-hint", faulted ? "Reset fault first" : "");
    const reset = this.$("touch-reset");
    if (reset) reset.classList.toggle("attention", faulted);

    const rateKnown = !!(pump && pump.min_rate != null && pump.max_rate != null);
    this.setText("touch-rate-value", pump && pump.target_rate != null ? this.fmt(pump.target_rate, 2) : "--");
    this.setText("touch-rate-unit", this.units.rate);
    const rateBtn = this.$("touch-rate");
    setProp(rateBtn, "disabled", !rateKnown);
    setProp(this.$("touch-rate-up"), "disabled", !pump);
    setProp(this.$("touch-rate-down"), "disabled", !pump);
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
      setAttr(tile, "aria-label", "Enter calibration factor");
      this.setText("touch-cal-caption", "Cal factor");
      this.setText("touch-cal-value", factor);
      this.setText("touch-cal-hint", "");
      tile.disabled = false;
      return;
    }
    const active = !!cal.test_run.active;
    const faulted = !!(pump && pump.fault);
    const running = !!(pump && (pump.running || pump.state === "pumping"));
    setAttr(tile, "aria-label", "Calibrate (1min Calibration Sequence)");
    this.setText("touch-cal-value", active ? "Testing" : "Calibrate");
    this.setText("touch-cal-caption", `Factor ${factor}`);
    const blocked = active ? "" : this.calwizBlocked();
    const hint = !blocked ? "" : faulted ? "Reset fault first" : running ? "Stop pump first" : "Waiting for data";
    this.setText("touch-cal-hint", hint);
    // Looks disabled but still takes the tap, so the operator is told why
    // (a disabled button would swallow it silently).
    tile.disabled = false;
    setAttr(tile, "aria-disabled", blocked ? "true" : "false");
    tile.classList.toggle("blocked", !!blocked);
  }

  // -- 1min Calibration Sequence ------------------------------------------------
  // Pages: "start" Run calibration / enter the factor manually, 1 valve shut
  // and level visible, 2 start mL, 3 test rate (capped by the site glass's
  // room above the start reading, calibration.js testRateRange), 4 summary
  // + Start Test (start_test_run), 5 running (countdown from the controller's
  // TestRunRemaining_s, Cancel = cancel_test_run), "ended" (cancelled or
  // faulted), 6 final mL, 7 results + Set calibration factor (closes) / Discard.
  // The controller times the run and stops the pump itself; the wizard only
  // follows its TestRun* tags, so a reload reattaches from TestRunActive.

  calTestRun() {
    const c = this.data.calibration;
    return c ? c.test_run : null;
  }

  calPump() {
    return (this.data.pumps || [])[0] || null;
  }

  /** Why the wizard cannot open now ("" when it can). Shown as a toast. */
  calwizBlocked() {
    if (!this.touch) return "Calibration needs HMI Control Mode Touch";
    if (!this.data.calibration) return "Waiting for pump controller data";
    const tr = this.calTestRun();
    if (tr && tr.active) return "";
    const pump = this.calPump();
    if (!pump || pump.state === "unknown") return "Waiting for pump controller data";
    if (pump.fault) return "Reset the fault first";
    if (pump.running || pump.state === "pumping") return "Stop the pump before calibrating";
    return "";
  }

  /** The wizard popover is on screen (shown and still in the page). */
  calwizShown() {
    const o = this.$("calwiz");
    return !!(o && o.isConnected && !o.classList.contains("hidden"));
  }

  // A session whose popover is not on screen is stale: nothing the operator
  // can see, finish or close, and it would block every later CALIBRATE tap.
  // Drop it through the close path; while the controller still runs the
  // test, keep the saved inputs so the wizard reattaches from its TestRun
  // tags on page 5 rather than starting over.
  calwizDropStale() {
    if (!this.cal || this.calwizShown()) return false;
    const tr = this.calTestRun();
    this.calwizClose(true, { keepStore: !!(tr && tr.active) });
    return true;
  }

  calwizOpen() {
    if (this.cal) {
      if (this.calwizShown()) return;
      this.calwizDropStale();
    }
    const blocked = this.calwizBlocked();
    if (blocked) {
      this.showToast(blocked, "error");
      return;
    }
    const tr = this.calTestRun();
    if (tr && tr.active) {
      this.calwizReattach(tr);
      return;
    }
    const t = this.data.touch || {};
    this.cal = {
      page: "start",
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
    this.calwizShow();
  }

  // Show the popover for the session just set up. A render error must not
  // leave a session behind with nothing on screen: close it and say so.
  calwizShow() {
    try {
      this.show(this.$("calwiz"));
      this.renderCalwiz();
    } catch (e) {
      this.calwizClose(true);
      this.showToast(`The calibration wizard could not open: ${(e && e.message) || e}`, "error");
    }
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
    this.calwizShow();
  }

  calwizClose(force = false, { keepStore = false } = {}) {
    if (!this.cal) return;
    if (this.cal.page === 5 && !force) return; // never while the pump runs
    this.cal = null;
    if (!keepStore) this.calStore(null);
    if (this.keypadIsOpen() && this.keypadOpts.owner === "calwiz") this.keypadClose();
    if (this.confirmOwner === "calwiz") this.confirmClose();
    this.hide(this.$("calwiz"));
  }

  calwizGo(page) {
    if (!this.cal) return;
    // Next is one key for every page: a press still waiting on another page
    // (Start Test whose ack never came) must not block this page's press.
    const next = this.$("calwiz-next");
    if (next && next.classList.contains("pending")) {
      next.classList.remove("pending");
      this.pendingSince.delete(next);
    }
    this.cal.page = page;
    this.cal.error = "";
    this.renderCalwiz();
  }

  calwizBack() {
    if (!this.cal) return;
    const back = { start: null, 1: "start", 2: 1, 3: 2, 4: 3, 6: 2, ended: 2 }[this.cal.page];
    if (back === undefined) return; // running, results: no back
    if (back === null) {
      this.calwizClose();
      return;
    }
    if (back === 2) {
      // A new test needs a new starting reading.
      this.cal.finalMl = null;
      this.cal.result = null;
    }
    this.calwizGo(back);
  }

  calwizNext(btn) {
    const c = this.cal;
    if (!c) {
      // A popover without a session: nothing to confirm; take it away.
      this.hide(this.$("calwiz"));
      return;
    }
    const fail = (msg) => {
      c.error = msg;
      this.setText("calwiz-error", msg);
    };
    switch (c.page) {
      case "start":
        return undefined; // its two choices are in the body
      case 1:
        return this.calwizGo(2);
      case 2: {
        const err = validateStartMl(c.startMl);
        if (err) return fail(err);
        if (c.rate == null) {
          const pump = this.calPump();
          if (pump && pump.target_rate != null) c.rate = Number(pump.target_rate);
        }
        this.calCapRate();
        return this.calwizGo(3);
      }
      case 3: {
        const err = validateTestRate(c.rate, ...this.calRateArgs());
        if (err) return fail(err);
        return this.calwizGo(4);
      }
      case 4: {
        const pump = this.calPump();
        const blocked = !pump || pump.state === "unknown"
          ? "Waiting for pump controller data"
          : pump.fault
            ? "Reset the fault first"
            : pump.running || pump.state === "pumping"
              ? "Stop the pump before calibrating"
              : "";
        if (blocked) {
          fail(blocked);
          this.showToast(blocked, "error");
          return undefined;
        }
        return this.calwizStart(btn);
      }
      case 6: {
        const err = validateStartMl(c.startMl) || validateFinalMl(c.finalMl, c.startMl);
        if (err) return fail(err);
        const res = this.calResult();
        if (!res.ok) return fail(res.error);
        c.result = res;
        return this.calwizGo(7);
      }
      case 7:
        return this.calwizSetFactor(btn);
      case "ended":
        return this.calwizClose();
      default:
        return undefined;
    }
  }

  /** `validateTestRate`'s range arguments: the pump's range, this start reading, the rate units. */
  calRateArgs() {
    const pump = this.calPump() || {};
    return [pump.min_rate, pump.max_rate, this.cal ? this.cal.startMl : null, this.units.rate];
  }

  /** The test rate's range now (calibration.js testRateRange). */
  calRateRange() {
    return testRateRange(...this.calRateArgs());
  }

  // Bring the test rate down to what the site glass has room for. The
  // default (the current target) is often above it, and a rate entered
  // before the start reading changed may be too; page 3 says what the
  // limit is and why.
  calCapRate() {
    const c = this.cal;
    if (!c || c.rate == null) return;
    const range = this.calRateRange();
    if (range.cappedByGlass && Number.isFinite(range.max) && c.rate > range.max) c.rate = range.max;
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
    sent.then((ack) => {
      if (this.cal !== c) return;
      if (ack && ack.ok) {
        // Set: the wizard is done (the toast says the factor was updated).
        this.calStore(null);
        this.calwizClose();
        // The "updated" toast was placed around the open wizard: with it
        // gone, back to the bottom of the screen (above the touch bar).
        const toast = this.$("command-toast");
        if (toast && !toast.classList.contains("hidden")) this.placeToast(toast);
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
        rangeText: "Before the test, usually near the top of the scale",
        decimals: 1,
        unit: "mL",
        validate: validateStartMl,
        onSubmit: (value) => {
          c.startMl = value;
          if (c.finalMl != null && validateFinalMl(c.finalMl, value)) c.finalMl = null;
          this.calCapRate();
          this.renderCalwiz();
        },
      });
    } else if (act === "run") {
      this.calwizGo(1);
    } else if (act === "edit-rate") {
      const range = this.calRateRange();
      // No keypad min/max: validateTestRate does the range, so a rate the
      // glass rules out is told why rather than "out of range".
      this.keypadOpen({
        owner: "calwiz",
        title: "Test rate",
        value: c.rate,
        min: null,
        max: null,
        rangeText: range.cappedByGlass
          ? `Range ${this.fmt(range.min, 2)} to ${this.fmt(range.max, 2)} ${this.units.rate} (site glass limit)`
          : `Range ${this.fmt(range.min, 2)} to ${this.fmt(range.max, 2)} ${this.units.rate}`,
        decimals: 2,
        unit: this.units.rate,
        validate: (v) => validateTestRate(v, ...this.calRateArgs()),
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
        rangeText: c.startMl != null ? `More than the starting ${formatMl(c.startMl)} mL` : "More than the starting reading",
        decimals: 1,
        unit: "mL",
        validate: (v) => validateFinalMl(v, c.startMl),
        onSubmit: (value) => {
          c.finalMl = value;
          this.renderCalwiz();
        },
      });
    } else if (act === "cancel") {
      this.sendCommand("cancel_test_run", null, el).then((ack) => {
        if (this.cal === c && c.run && ack && ack.ok) {
          // The result arrives with the tags; this one is fresh.
          c.run.seenActive = true;
          this.renderCalwizLive();
        }
      });
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
    // Self-heal: a session without its popover is dropped here too (and a
    // running test then reattaches just below).
    this.calwizDropStale();
    const tr = this.calTestRun();
    if (!this.cal) {
      if (tr.active) this.calwizReattach(tr);
      return;
    }
    const c = this.cal;
    if (c.page !== 5) {
      // Started from another screen while this one was on pages 1 to 4.
      if (tr.active && ["start", 1, 2, 3, 4].includes(c.page)) {
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
    this.setText("calwiz-step", steps[c.page] ? `Step ${steps[c.page]} of 7` : "");
    let html = "";
    switch (c.page) {
      case "start":
        html =
          `<button type="button" class="key key-ok calwiz-choice" data-act="run" data-id="calwiz-run">Run calibration</button>` +
          `<button type="button" class="key calwiz-choice calwiz-manual" data-act="manual" data-id="calwiz-manual">Enter calibration factor manually</button>`;
        break;
      case 1:
        html =
          `<p class="calwiz-text calwiz-lead">Make sure the tank valve is shut, AND make sure you can see the fluid level in the site glass.</p>` +
          `<p class="calwiz-note calwiz-lead-note">You may need to manually start the pump to bring the level down if the tank is over half full.</p>`;
        break;
      case 2:
        html =
          field("edit-start", "Site glass mL", c.startMl == null ? null : formatMl(c.startMl), "mL", "Read the site glass before the test.");
        break;
      case 3: {
        const range = this.calRateRange();
        const rangeNote = pump.min_rate != null && pump.max_rate != null
          ? `Range ${this.fmt(range.min, 2)} to ${this.fmt(range.max, 2)} ${u}`
          : "";
        html = field("edit-rate", "Test rate", c.rate == null ? null : this.fmt(c.rate, 2), u, rangeNote);
        if (range.glass) {
          const g = range.glass;
          const room = `Site glass: ${ml(c.startMl)} mL now, ${SITE_GLASS_MAX_ML} mL at the bottom of the scale, so ${formatMl(g.roomMl)} mL of room.`;
          const limit = range.cappedByGlass
            ? ` Over the ${CAL_TEST_DURATION_S} s test the rate is limited to ${this.fmt(range.max, 2)} ${u}: any faster and the level would drop below what the glass can measure.`
            : ` That is enough for the pump's full range over the ${CAL_TEST_DURATION_S} s test.`;
          html += `<p class="calwiz-note${range.cappedByGlass ? " calwiz-warn" : ""}" data-id="calwiz-glass-note">${room}${limit}</p>`;
        }
        break;
      }
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
        html =
          `<div class="calwiz-rows calwiz-results">` +
          row("Delivered volume", formatMl(r.deliveredMl), "mL", "calwiz-delivered") +
          row("Measured flow rate", this.fmt(r.measuredRate, 2), u, "calwiz-measured") +
          row("Target flow rate", this.fmt(r.targetRate, 2), u, "calwiz-target") +
          row("Calibration factor", `${this.fmt(r.oldFactor, 2)} \u2192 <strong data-id="calwiz-new-factor">${this.fmt(r.newFactor, 2)}</strong>`, "", "calwiz-factor") +
          `</div>` + clampNote;
        break;
      }
      default:
        html = "";
    }
    body.innerHTML = html;
    body.setAttribute("data-page", String(c.page));
    setAttr(this.$("calwiz-box"), "data-page", String(c.page));
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
    const choosing = c.page === "start";
    // The first page is its two choices, with the X to close: no Back, no
    // Next. The results page has no Back either: Set calibration factor or
    // Discard only.
    this.toggle(back, !running && !choosing && c.page !== 7);
    this.toggle(close, !running && c.page !== 7);
    this.toggle(next, !running && !choosing);
    this.toggle(discard, c.page === 7);
    if (!next) return;
    const labels = { 1: "Confirm", 2: "Confirm", 3: "Confirm", 4: "Start Test", 6: "Confirm", 7: "Set calibration factor", ended: "Close" };
    this.setText("calwiz-next-label", labels[c.page] || "Confirm");
    next.classList.toggle("calwiz-go", c.page === 4 || c.page === 7);
    const pump = this.calPump() || {};
    let disabled = false;
    if (c.page === 2) disabled = !!validateStartMl(c.startMl);
    if (c.page === 3) disabled = !!validateTestRate(c.rate, ...this.calRateArgs());
    if (c.page === 4) disabled = !!(pump.fault || pump.running || pump.state === "pumping");
    if (c.page === 6) disabled = !!(validateStartMl(c.startMl) || validateFinalMl(c.finalMl, c.startMl));
    // Looks disabled but takes the tap: calwizNext then says why (the
    // validation message, or the pump state on Start Test).
    next.disabled = false;
    setAttr(next, "aria-disabled", disabled ? "true" : "false");
    next.classList.toggle("blocked", disabled);
    if (c.page === 4) {
      const note = this.$("calwiz-start-note");
      if (note) {
        setNodeText(note, pump.fault
          ? "The pump is faulted: reset the fault first."
          : pump.running || pump.state === "pumping"
            ? "The pump is running: stop it first."
            : "The pump will run for 1 minute at the test rate, then stop by itself.");
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
    const st = this.$in("vsd-status", ".state-value");
    if (st) {
      setNodeText(st, vsd.tripped ? "Tripped" : "OK");
      setClassName(st, "state-value " + (vsd.tripped ? "vsd-tripped" : "vsd-ok"));
    }
    let trip = "";
    if (vsd.tripped) {
      trip = vsd.trip_description || "Drive tripped";
      if (vsd.trip_code != null) trip += ` (code ${vsd.trip_code})`;
    }
    this.setText("vsd-trip", trip);
  }

  // -- Alarm settings (gears on the Tank / Skid / Pump Control tiles) ---------
  // alarm_settings_access decides whether the gears show and whether this
  // host may change a setting (setAlarmAccess). Values come from the
  // controller's Setpoint* / Delay* tags (payload alarm_settings). One row
  // per alarm: its threshold and its delay side by side, each its own tap
  // target (data-alarm = the controller's element). A change is a keypad
  // (range-limited), a confirmation (old -> new), then the ui_cmds RPC named
  // after the element, with that cell's pending / saved / error state. Rows
  // are built once per open and updated in place.
  //
  // The Tank and Skid pressure popovers also have a Sensor tab (the sensor
  // app's operator calibration, core/sensors.js) under its own gate,
  // sensor_settings_access (setSensorAccess). With both on, two tabs,
  // Alarms | Sensor; with one, that one alone and no tab bar, so with the
  // Sensor gate Hidden (the default) the popover is exactly as before.

  setAlarmAccess(access) {
    const was = this.alarmAccess;
    this.alarmAccess = {
      enabled: !!(access && access.enabled),
      canWrite: !!(access && access.canWrite),
      writeBlockedReason: (access && access.writeBlockedReason) || "",
    };
    this.renderAlarmGears();
    if (this.alarmOpen && was.canWrite !== this.alarmAccess.canWrite) this.buildAlarmRows();
  }

  setSensorAccess(access) {
    const was = this.sensorAccess;
    this.sensorAccess = {
      enabled: !!(access && access.enabled),
      canWrite: !!(access && access.canWrite),
      writeBlockedReason: (access && access.writeBlockedReason) || "",
    };
    this.renderAlarmGears();
    if (this.alarmOpen && was.canWrite !== this.sensorAccess.canWrite) this.buildSensorPane();
  }

  alarmAvailable(group) {
    const a = this.data.alarm_settings;
    if (!this.alarmAccess.enabled || !a || !a[group]) return false;
    return this.alarmTileShown(group);
  }

  // The gear's tile is on screen (the gear lives on it).
  alarmTileShown(group) {
    if (group === "tank") return !!this.data.tank;
    // Flow: the payload has the group only with a controller flow meter.
    if (group === "flow") return !!(this.data.pumps && this.data.pumps.length);
    return !!(this.data.skid && "skid_pressure" in this.data.skid);
  }

  sensorAvailable(group) {
    const s = this.data.sensor_settings;
    if (!this.sensorAccess.enabled || !SENSOR_GROUPS[group] || !s || !s[group]) return false;
    return this.alarmTileShown(group);
  }

  // The popover's tabs for a gear, in order ("alarms", then "sensor").
  alarmTabs(group) {
    const tabs = [];
    if (this.alarmAvailable(group)) tabs.push("alarms");
    if (this.sensorAvailable(group)) tabs.push("sensor");
    return tabs;
  }

  renderAlarmGears() {
    for (const [group, id, section] of ALARM_GEAR_SPECS) {
      const on = this.alarmTabs(group).length > 0;
      this.toggle(this.$(id), on);
      const sec = this.$(section);
      if (sec) sec.classList.toggle("has-gear", on);
      if (this.alarmOpen === group) {
        if (!on) this.alarmPanelClose();
        else this.syncAlarmTabs();
      }
    }
  }

  alarmPanelOpen(group) {
    const tabs = this.alarmTabs(group);
    if (!tabs.length) {
      this.showToast("Alarm settings are not available here", "error");
      return;
    }
    if (this.alarmOpen) this.alarmPanelClose();
    this.alarmOpen = group;
    this.alarmTab = tabs[0];
    this.alarmTabsKey = "";
    this.alarmState = {};
    this.sensorState = {};
    this.syncAlarmTabs();
    this.show(this.$("alarm-panel"));
    const close = this.$("alarm-panel-close");
    if (close && close.focus) close.focus();
  }

  alarmPanelClose() {
    if (!this.alarmOpen) return;
    this.alarmOpen = null;
    this.alarmTabsKey = "";
    if (this.keypadIsOpen() && ["alarm", "sensor"].includes(this.keypadOpts.owner)) this.keypadClose();
    if (["alarm", "sensor"].includes(this.confirmOwner)) this.confirmClose();
    this.hide(this.$("alarm-panel"));
  }

  // The tab bar and the pane shown, for the tabs now on offer: redrawn only
  // when they change (access or the payload), keeping the tab shown where it
  // is still offered. A pane is built when it is shown.
  syncAlarmTabs() {
    const group = this.alarmOpen;
    if (!group) return;
    const tabs = this.alarmTabs(group);
    if (!tabs.length) return;
    const tab = tabs.includes(this.alarmTab) ? this.alarmTab : tabs[0];
    const key = `${tabs.join(",")}:${tab}`;
    if (key === this.alarmTabsKey) return;
    const paneChanged = !this.alarmTabsKey.endsWith(`:${tab}`);
    this.alarmTabsKey = key;
    this.alarmTab = tab;
    this.toggle(this.$("alarm-tabs"), tabs.length > 1);
    for (const t of ["alarms", "sensor"]) {
      const b = this.$(`alarm-tab-${t}`);
      setClass(b, "active", t === tab);
      setAttr(b, "aria-selected", t === tab ? "true" : "false");
    }
    this.toggle(this.$("alarm-rows"), tab === "alarms");
    this.toggle(this.$("sensor-pane"), tab === "sensor");
    if (paneChanged) {
      // A pane taken away under an open keypad / confirmation (its access
      // went) takes them with it.
      const gone = tab === "alarms" ? "sensor" : "alarm";
      if (this.keypadIsOpen() && this.keypadOpts.owner === gone) this.keypadClose();
      if (this.confirmOwner === gone) this.confirmClose();
      if (tab === "alarms") this.buildAlarmRows();
      else this.buildSensorPane();
    }
  }

  alarmTabSelect(tab) {
    if (!this.alarmOpen || tab === this.alarmTab) return;
    if (!this.alarmTabs(this.alarmOpen).includes(tab)) return;
    this.alarmTab = tab;
    this.syncAlarmTabs();
  }

  // The head for the tab shown: its title and what a tap does (or why not).
  renderAlarmHead() {
    const group = this.alarmOpen;
    if (!group) return;
    let editable;
    let reason;
    if (this.alarmTab === "sensor") {
      // Also locked while the sensor app has the feature off (the pane's
      // lock line says how to turn it on).
      const g = this.sensorGroupData();
      this.setText("alarm-panel-title", SENSOR_GROUPS[group].title);
      editable = this.sensorAccess.canWrite && !!(g && g.enabled);
      reason = this.sensorAccess.writeBlockedReason || (this.sensorAccess.canWrite ? "Locked" : "");
    } else {
      this.setText("alarm-panel-title", ALARM_GROUPS[group].title);
      editable = this.alarmAccess.canWrite;
      reason = this.alarmAccess.writeBlockedReason;
    }
    this.setText("alarm-panel-note", editable ? "Tap a value to change it" : reason || "View only");
    setClass(this.$("alarm-panel-note"), "error", !editable);
  }

  // Per payload while open: the pane shown, in place.
  renderAlarmPanelValues() {
    if (!this.alarmOpen) return;
    if (this.alarmTab === "sensor") this.renderSensorValues();
    else this.renderAlarmValues();
  }

  buildAlarmRows() {
    const list = this.$("alarm-rows");
    if (!list || !this.alarmOpen || this.alarmTab !== "alarms") return;
    const doc = this.root.ownerDocument;
    const editable = this.alarmAccess.canWrite;
    const group = ALARM_GROUPS[this.alarmOpen];
    this.renderAlarmHead();
    list.textContent = "";
    // A cell: caption (what the value is), the value, then its range or,
    // after a write, the write's note.
    const cell = (field, caption, kind) => {
      const c = doc.createElement(editable ? "button" : "div");
      if (editable) c.type = "button";
      c.className = `alarm-cell alarm-cell-${kind} ${editable ? "editable" : "locked"}`;
      c.setAttribute("data-alarm", field);
      c.setAttribute("data-id", `alarm-cell-${field}`);
      c.innerHTML =
        `<span class="alarm-caption">${escapeHtml(caption)}</span>` +
        `<span class="alarm-value" data-alarm-value></span>` +
        `<span class="alarm-range" data-alarm-range></span>` +
        `<span class="alarm-note" data-alarm-note></span>`;
      return c;
    };
    for (const field of group.fields) {
      const f = ALARM_FIELDS[field];
      const row = doc.createElement("div");
      row.className = `alarm-row alarm-${f.kind.toLowerCase()}`;
      row.setAttribute("role", "listitem");
      row.setAttribute("data-id", `alarm-row-${field}`);
      row.innerHTML =
        `<span class="alarm-head"><span class="alarm-label">${escapeHtml(f.label)}</span>` +
        `<span class="alarm-kind">${f.kind}</span></span>`;
      row.appendChild(cell(field, group.caption, "setpoint"));
      row.appendChild(cell(f.delay, "Delay", "delay"));
      list.appendChild(row);
    }
    this.renderAlarmValues();
  }

  // Per payload while open: text in place (no cell is replaced under a tap).
  renderAlarmValues() {
    const list = this.$("alarm-rows");
    if (!list || !this.alarmOpen || this.alarmTab !== "alarms") return;
    const settings = this.data.alarm_settings;
    for (const cell of list.querySelectorAll("[data-alarm]")) {
      const field = cell.getAttribute("data-alarm");
      const r = alarmRange(field, settings);
      const value = alarmValue(field, settings);
      setNodeText(cell.querySelector("[data-alarm-value]"), formatAlarmValue(field, value, settings, EMPTY_VALUE));
      const lo = r.offAllowed && r.min === 0 ? r.step : r.min;
      const zero = r.offAllowed ? " · 0 = off" : isDelayField(field) && r.min === 0 ? " · 0 = none" : "";
      setNodeText(cell.querySelector("[data-alarm-range]"), `${rangeNum(lo)} to ${rangeNum(r.max)} ${r.unit}${zero}`);
      const st = this.alarmInFlight.has(field) ? WRITING_STATE : this.alarmState[field] || {};
      setNodeText(cell.querySelector("[data-alarm-note]"), st.note || "");
      cell.classList.toggle("has-note", !!st.note);
      cell.classList.toggle("pending", st.state === "pending");
      cell.classList.toggle("ok", st.state === "ok");
      cell.classList.toggle("error", st.state === "error");
      cell.classList.toggle("off", value === 0 && !isDelayField(field));
      // A delay with no readback (a controller from before the per-alarm
      // delays): locked until its Delay* tag arrives; a tap says why.
      if (cell.tagName === "BUTTON") {
        const missing = isDelayField(field) && value == null;
        cell.classList.toggle("editable", !missing);
        cell.classList.toggle("locked", missing);
        setAttr(cell, "aria-disabled", missing ? "true" : "false");
      }
    }
  }

  alarmEdit(field, cell) {
    const f = ALARM_FIELDS[field];
    if (!f || !this.alarmOpen) return;
    if (!this.alarmAccess.canWrite) {
      this.showToast(this.alarmAccess.writeBlockedReason || "Alarm settings are view only here", "error");
      return;
    }
    if (this.alarmInFlight.has(field)) {
      this.showToast("Still waiting for the pump controller to answer");
      return;
    }
    if (isDelayField(field) && alarmValue(field, this.data.alarm_settings) == null) {
      this.showToast(ALARM_DELAY_MISSING_TEXT, "error");
      return;
    }
    const settings = () => this.data.alarm_settings;
    const r = alarmRange(field, settings());
    const dp = alarmDecimals(field, settings());
    const current = alarmValue(field, settings());
    const fmt = (v) => formatAlarmValue(field, v, settings(), EMPTY_VALUE);
    const max = `${rangeNum(r.max)} ${r.unit}`;
    let rangeText;
    if (isDelayField(field)) {
      rangeText = r.min === 0
        ? `0 = no delay (immediate), or up to ${max}, whole seconds`
        : `Range ${rangeNum(r.min)} to ${max}, whole seconds`;
    } else if (r.offAllowed) {
      rangeText = `0 = off, or up to ${max}${r.whole ? ", whole numbers" : ""}`;
    } else {
      rangeText = `Range ${rangeNum(r.min)} to ${max} (can't be off)`;
    }
    this.keypadOpen({
      owner: "alarm",
      title: `${f.label}`,
      value: current,
      min: r.offAllowed ? 0 : r.min,
      max: r.max,
      rangeText,
      decimals: dp,
      unit: r.unit,
      validate: (v) => validateAlarmValue(field, v, settings()) || null,
      onSubmit: (value) => {
        this.confirmAsk(
          `Change ${f.label} from ${fmt(current)} → ${fmt(value)}?`,
          () => this.alarmWrite(field, value),
          "alarm",
        );
      },
    });
  }

  alarmWrite(field, value) {
    const f = ALARM_FIELDS[field];
    const fmt = (v) => formatAlarmValue(field, v, this.data.alarm_settings, EMPTY_VALUE);
    // The cell's pending / ok / error look is drawn from the state (it may
    // be rebuilt while the write is out), so no button is handed over.
    this.alarmState[field] = WRITING_STATE;
    this.alarmInFlight.add(field);
    this.renderAlarmValues();
    return this.sendCommand(field, value, null, { requireTouch: false }).then((ack) => {
      this.alarmInFlight.delete(field);
      if (this.destroyed) return ack;
      if (ack && ack.ok) {
        this.alarmState[field] = { state: "ok", note: `Saved · ${fmt(value)}` };
        this.showToast(`${f.label} set to ${fmt(value)}`, "ok");
      } else {
        this.alarmState[field] = { state: "error", note: (ack && ack.message) || "Not saved" };
      }
      this.renderAlarmValues();
      return ack;
    });
  }

  // -- Sensor tab (Tank / Skid pressure popovers) ------------------------------
  // The sensor app's live loop current and corrected reading, one cell per
  // operator value (data-sensor = the sensor app's element) and "Reset to
  // configured values". Values come from the sensor app's own tags (payload
  // sensor_settings); a change is a keypad, a confirmation (old -> new), then
  // the ui_cmds RPC to the SENSOR app's key (sendCommand target), with the
  // same pending / saved / error cell states as the alarm cells. With the
  // app's Operator Sensor Calibration off (operator_calibration not true, or
  // an older app) the reading still shows but the cells are locked.

  sensorGroupData() {
    const s = this.data.sensor_settings;
    return (s && this.alarmOpen && s[this.alarmOpen]) || null;
  }

  // Changes allowed right now: access from this host, and the app has
  // Operator Sensor Calibration on. "" when allowed, else why not.
  sensorBlockedReason() {
    if (!this.sensorAccess.canWrite) {
      return this.sensorAccess.writeBlockedReason || "Sensor settings are view only here";
    }
    const g = this.sensorGroupData();
    return g && g.enabled ? "" : SENSOR_LOCKED_TEXT;
  }

  buildSensorPane() {
    const list = this.$("sensor-cells");
    const group = this.alarmOpen;
    if (!list || !group || this.alarmTab !== "sensor" || !SENSOR_GROUPS[group]) return;
    const doc = this.root.ownerDocument;
    const editable = this.sensorAccess.canWrite;
    this.renderAlarmHead();
    this.setText("sensor-reading-caption", SENSOR_GROUPS[group].reading);
    this.setText("sensor-ma-caption", sensorInputCaption(group, this.data.sensor_settings));
    list.textContent = "";
    for (const field of SENSOR_GROUPS[group].fields) {
      const c = doc.createElement(editable ? "button" : "div");
      if (editable) c.type = "button";
      c.className = `alarm-cell sensor-cell ${editable ? "editable" : "locked"}`;
      c.setAttribute("role", "listitem");
      c.setAttribute("data-sensor", field);
      c.setAttribute("data-id", `sensor-cell-${field}`);
      c.innerHTML =
        `<span class="alarm-caption">${escapeHtml(SENSOR_FIELDS[field].name)}</span>` +
        `<span class="alarm-value" data-sensor-value></span>` +
        `<span class="alarm-range" data-sensor-hint></span>` +
        `<span class="alarm-note" data-sensor-note></span>`;
      list.appendChild(c);
    }
    this.renderSensorValues();
  }

  // Per payload while open: text and lock state in place.
  renderSensorValues() {
    const list = this.$("sensor-cells");
    const group = this.alarmOpen;
    if (!list || !group || this.alarmTab !== "sensor") return;
    const settings = this.data.sensor_settings;
    const g = this.sensorGroupData();
    this.setText("sensor-ma-caption", sensorInputCaption(group, settings));
    this.setText("sensor-ma", formatSensorInput(group, settings, EMPTY_VALUE));
    this.setText("sensor-reading", formatSensorReading(group, settings, EMPTY_VALUE));
    const locked = !(g && g.enabled);
    this.renderAlarmHead();
    const note = this.$("sensor-note");
    this.setText("sensor-note", locked ? SENSOR_LOCKED_TEXT : "");
    this.toggle(note, locked);
    const reset = this.$("sensor-reset");
    const resetOff = !!this.sensorBlockedReason();
    setClass(reset, "locked", resetOff);
    setClass(reset, "pending", this.sensorInFlight.has(`${group}:reset`));
    setAttr(reset, "aria-disabled", resetOff ? "true" : "false");
    for (const cell of list.querySelectorAll("[data-sensor]")) {
      const field = cell.getAttribute("data-sensor");
      setNodeText(
        cell.querySelector("[data-sensor-value]"),
        formatSensorValue(field, sensorValue(field, settings), settings, EMPTY_VALUE),
      );
      setNodeText(cell.querySelector("[data-sensor-hint]"), sensorHint(field, settings));
      const st = this.sensorInFlight.has(field) ? WRITING_STATE : this.sensorState[field] || {};
      setNodeText(cell.querySelector("[data-sensor-note]"), st.note || "");
      cell.classList.toggle("has-note", !!st.note);
      cell.classList.toggle("pending", st.state === "pending");
      cell.classList.toggle("ok", st.state === "ok");
      cell.classList.toggle("error", st.state === "error");
      if (cell.tagName === "BUTTON") {
        cell.classList.toggle("editable", !locked);
        cell.classList.toggle("locked", locked);
        setAttr(cell, "aria-disabled", locked ? "true" : "false");
      }
    }
  }

  sensorEdit(field, cell) {
    const f = SENSOR_FIELDS[field];
    const group = this.alarmOpen;
    if (!f || !group || f.group !== group || this.alarmTab !== "sensor") return;
    const blocked = this.sensorBlockedReason();
    if (blocked) {
      this.showToast(blocked, "error");
      return;
    }
    if (this.sensorInFlight.has(field)) {
      this.showToast(`Still waiting for the ${SENSOR_GROUPS[group].who} to answer`);
      return;
    }
    const settings = () => this.data.sensor_settings;
    const r = sensorRange(field, settings());
    const current = sensorValue(field, settings());
    const fmt = (v) => formatSensorValue(field, v, settings(), EMPTY_VALUE);
    const label = sensorLabel(field, settings());
    this.keypadOpen({
      owner: "sensor",
      title: label,
      value: current,
      min: r.min,
      max: r.max,
      rangeText: sensorRangeText(field, settings()),
      decimals: sensorDecimals(field, current, settings()),
      unit: r.unit,
      signed: r.signed,
      validate: (v) => validateSensorValue(field, v, settings()) || null,
      onSubmit: (value) => {
        this.confirmAsk(
          `Change ${label} from ${fmt(current)} → ${fmt(value)}?`,
          () => this.sensorWrite(group, field, value),
          "sensor",
        );
      },
    });
  }

  sensorWrite(group, field, value) {
    const label = sensorLabel(field, this.data.sensor_settings);
    const fmt = (v) => formatSensorValue(field, v, this.data.sensor_settings, EMPTY_VALUE);
    // As the alarm cells: the look is drawn from the state, no button handed over.
    this.sensorState[field] = WRITING_STATE;
    this.sensorInFlight.add(field);
    this.renderSensorValues();
    return this.sendCommand(field, value, null, {
      requireTouch: false,
      target: group,
      who: SENSOR_GROUPS[group].who,
    }).then((ack) => {
      this.sensorInFlight.delete(field);
      if (this.destroyed) return ack;
      if (ack && ack.ok) {
        this.sensorState[field] = { state: "ok", note: `Saved · ${fmt(value)}` };
        this.showToast(`${label} set to ${fmt(value)}`, "ok");
      } else {
        this.sensorState[field] = { state: "error", note: (ack && ack.message) || "Not saved" };
      }
      this.renderSensorValues();
      return ack;
    });
  }

  // "Reset to configured values": the sensor app's reset_calibration clears
  // every operator value (back to its config), after a confirmation.
  sensorReset() {
    const group = this.alarmOpen;
    if (!group || this.alarmTab !== "sensor" || !SENSOR_GROUPS[group]) return;
    const blocked = this.sensorBlockedReason();
    if (blocked) {
      this.showToast(blocked, "error");
      return;
    }
    const g = SENSOR_GROUPS[group];
    const key = `${group}:reset`;
    if (this.sensorInFlight.has(key)) {
      this.showToast(`Still waiting for the ${g.who} to answer`);
      return;
    }
    const names = g.fields.map((f) => SENSOR_FIELDS[f].name.toLowerCase());
    const list = `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    this.confirmAsk(
      `Reset the ${g.title.toLowerCase()} to its configured values? The ${list} go back to the sensor app's config.`,
      () => {
        // The button is shared by both groups' panes: its pending look is
        // this group's reset (renderSensorValues), not handed to sendCommand.
        this.sensorInFlight.add(key);
        this.renderSensorValues();
        return this.sendCommand(SENSOR_RESET_COMMAND, null, null, {
          requireTouch: false,
          target: group,
          who: g.who,
        }).then((ack) => {
          this.sensorInFlight.delete(key);
          if (this.destroyed) return ack;
          if (ack && ack.ok) {
            this.sensorState = {};
            this.showToast(`${g.title} reset to its configured values`, "ok");
          }
          this.renderSensorValues();
          return ack;
        });
      },
      "sensor",
    );
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
    const params = this.$("vsd-params");
    if (params) params.scrollTop = 0;
    this.updateScroller("vsd-params");
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
      setNodeText(n, formatDiagnostic(d, field));
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
      setNodeText(status, text || "");
      status.classList.toggle("error", isError);
    }
  }

  renderVsdReset() {
    const b = this.$("vsd-panel-reset");
    if (!b) return;
    setProp(b, "disabled", !this.touch);
    // An attribute write, as the title property was: Touch mode keeps an
    // empty title="" rather than none.
    setAttr(b, "title", this.touch ? "" : "Reset is available in HMI Control Mode Touch");
  }

  renderParameters(message, isError = false) {
    const list = this.$("vsd-params");
    if (!list) return;
    const note = this.$("vsd-params-note");
    setNodeText(note, this.vsdAccess.canWrite ? "Tap a value to change it" : this.vsdAccess.writeBlockedReason);
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
      if (!this.vsdParams) {
        this.updateScroller("vsd-params");
        return;
      }
    }
    for (const p of this.vsdParams) list.appendChild(this.parameterRow(p));
    this.updateScroller("vsd-params");
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
    if (!this.$(id)) return;
    setNodeText(this.$in(id, ".value"), value);
    if (unit !== undefined) setNodeText(this.$in(id, ".unit"), unit);
  }

  setText(id, text) {
    setNodeText(this.$(id), text);
  }

  setConnection(connected, linkOk) {
    const e = this.$("connection-status");
    if (!e) return;
    if (!connected) {
      setClassName(e, "status-disconnected");
      setNodeText(e, "● Disconnected");
    } else if (linkOk === false) {
      setClassName(e, "status-disconnected status-warning");
      setNodeText(e, "● No controller");
    } else {
      setClassName(e, "status-connected");
      setNodeText(e, "● Connected");
    }
  }

  setLastUpdate(ts) {
    const t = ts ? new Date(ts) : new Date();
    const ms = t.getTime();
    if (isNaN(ms)) return;
    // The text depends only on the second and the UTC offset, so the
    // formatter (a new ICU formatter per call; ~55 us in JavaScriptCore)
    // runs once per second shown rather than once per update. Exact, time
    // zone changes included, where a cached Intl.DateTimeFormat would keep
    // the zone it was made in.
    const sec = Math.floor(ms / 1000);
    const off = t.getTimezoneOffset();
    if (sec !== this.clockSec || off !== this.clockOff) {
      this.clockSec = sec;
      this.clockOff = off;
      this.clockText = t.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
    }
    this.setText("last-update", this.clockText);
  }

  setBar(id, pct) {
    const e = this.$(id);
    if (!e) return;
    e.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    setClassName(e, "progress-fill" + (pct < 5 ? " low" : pct < 25 ? " medium" : ""));
  }

  show(e) {
    setClass(e, "hidden", false);
  }

  toggle(e, visible) {
    if (visible) this.show(e);
    else this.hide(e);
  }

  hide(e) {
    setClass(e, "hidden", true);
  }

  destroy() {
    this.destroyed = true;
    this.vsdOpen = false;
    if (this.onKey) this.root.ownerDocument.removeEventListener("keydown", this.onKey);
    if (this.resizeObserver) this.resizeObserver.disconnect();
    this.root.style.removeProperty("--hmi-kiosk-inset");
    this.root.style.removeProperty("--hmi-popover-inset");
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.els.clear();
    this.root.innerHTML = "";
    this.root.classList.remove("sia-hmi", "kiosk", "embedded");
  }
}

/**
 * Mount the HMI into `root`.
 *
 * opts: {
 *   layout: "kiosk" | "embedded",
 *   sendCommand(cmd, value, meta?): Promise<{ok, code?, message?}>,
 *                                // meta {target: "pressure" | "tank"}: a
 *                                // Sensor tab write for that sensor app
 *   hostLabel?: string,          // header badge, e.g. "Local panel"
 *   title?: string,              // header title (default "SIA Remote Command")
 *   logos?: {remoteCommand?, doover?}  // data URIs
 *   commandTimeoutMs?: number | () => number
 *                                // no-answer backstop (default 30 s)
 *   vsdPanel?: {diagnostics(), parameters(), write(param, value)}
 *                                // VSD commissioning RPCs (lib/vsdPanel.ts);
 *                                // the gear also needs setVsdPanel(access)
 *   reloadButton?: boolean,      // Refresh button in the header (local
 *                                // kiosk only; default off)
 *   reloadPage?: () => void      // what Refresh does after its confirmation
 *                                // (default window.location.reload())
 * }
 *
 * setDisplay({kioskInsetMm, popoverInsetMm, pxPerMm}): the cover-plate
 * insets, applied in the kiosk layout only.
 */
export function createHmi(root, opts) {
  const hmi = new Hmi(root, opts);
  return {
    update: (data, status) => hmi.update(data, status),
    notify: (message, level) => hmi.showToast(message, level),
    setVsdPanel: (access) => hmi.setVsdPanel(access),
    setDisplay: (display) => hmi.setDisplay(display),
    setAlarmAccess: (access) => hmi.setAlarmAccess(access),
    setSensorAccess: (access) => hmi.setSensorAccess(access),
    destroy: () => hmi.destroy(),
    /** For tests: the underlying instance. */
    _hmi: hmi,
  };
}
