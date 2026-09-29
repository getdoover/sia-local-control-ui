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
          <h2>VSD</h2>
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
      <button type="button" class="touch-btn touch-value" data-id="touch-cal" aria-label="Enter calibration factor">
        <span class="touch-caption">Cal factor</span>
        <span class="touch-number" data-id="touch-cal-value">--</span>
      </button>
    </div>
  </div>
</div>

<div data-id="loading-overlay" class="loading-overlay">
  <div class="loading-spinner"><div class="spinner"></div><p>Connecting to controller...</p></div>
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
    this.destroyed = false;

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
    on("touch-cal", (b) => this.openCalKeypad(b));

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
      `Range ${Number(opts.min).toFixed(dp)} to ${Number(opts.max).toFixed(dp)}${unit}`
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
  confirmAsk(message, onOk) {
    this.confirmOk = onOk;
    this.setText("confirm-message", message);
    this.show(this.$("confirm"));
  }

  confirmClose() {
    this.confirmOk = null;
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
    this.renderVsd(data.vsd);
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
      if (this.keypadIsOpen()) this.keypadClose();
      this.confirmClose();
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
    this.setText(
      "touch-cal-value",
      touch.calibration_factor != null ? this.fmt(touch.calibration_factor, 2) : "--"
    );
  }

  renderVsd(vsd) {
    const section = this.$("vsd-section");
    const line = this.$("pump-drive-line");
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
 * }
 */
export function createHmi(root, opts) {
  const hmi = new Hmi(root, opts);
  return {
    update: (data, status) => hmi.update(data, status),
    notify: (message, level) => hmi.showToast(message, level),
    destroy: () => hmi.destroy(),
    /** For tests: the underlying instance. */
    _hmi: hmi,
  };
}
