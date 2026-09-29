/**
 * SIA Remote Command touchscreen HMI.
 *
 * Renders controller status pushed over SocketIO (WP5 backend contract) into the
 * card-based "SIA Remote Command" layout. The physical panel pushbuttons (read
 * by the app backend as DI/AI) always work, whatever this screen shows.
 *
 * On-screen controls exist only in HMI Control Mode "Touch" (payload `touch`):
 * a bottom bar with Start / Stop / rate step + keypad / Reset Fault /
 * calibration factor, plus the VSD reset button (payload `vsd`). In "Read Only"
 * (the default) and "Button" (reserved) the screen is display-only: the VSD
 * card shows status but no button, and against an older controller it is
 * exactly as before. Control priority (local HMI > DCS > cloud) is fixed by the
 * controller and its config; it is not an option on this screen.
 *
 * Faults render as a non-blocking, in-flow banner between the header and the card
 * grid: it auto-shows when the backend reports active faults and auto-hides when
 * they clear, driven entirely by the live fault stream. It never overlays the
 * status cards and has no on-screen acknowledge, dismiss, or clear affordance —
 * faults clear only when the underlying condition clears.
 *
 * Backend socket contract (see dashboard.py / application.py):
 *   server -> client:  'data_update' {pumps:[], faults:[], link_ok, units:{rate,pressure},
 *                                     timestamp, solar?, tank?, skid?, selector?,
 *                                     vsd?: {tripped, trip_code,
 *                                     trip_description, motor_hz, pump_rpm},
 *                                     touch?: {calibration_factor, calibration_min,
 *                                     calibration_max}}
 *                      'heartbeat'   {timestamp}
 *                      'notice'      {message, level}  (e.g. a denied button press)
 *   client -> server:  'command'     {cmd, value} -> ack {ok, code?, message?}
 */

// Success toasts for the on-screen commands.
const COMMAND_DONE = {
    reset_vsd_fault: 'VSD reset. Now press Reset Fault.',
    reset_fault: 'Fault cleared',
    last_calibration_factor: 'Calibration factor updated',
};

// A keypad rate entry moving the target by more than this fraction asks first.
const RATE_CONFIRM_FRACTION = 0.2;
const KEYPAD_MAX_CHARS = 8;

// Pure keypad helpers (unit-tested): next entry text after a key press, and
// validation of an entry against an inclusive range.
function keypadInput(text, key) {
    text = text || '';
    if (key === 'clear') return '';
    if (key === 'back') return text.slice(0, -1);
    if (key === '.') {
        if (text.includes('.')) return text;
        return (text || '0') + '.';
    }
    if (!/^[0-9]$/.test(key)) return text;
    if (text.length >= KEYPAD_MAX_CHARS) return text;
    if (text === '0') return key;
    return text + key;
}

function validateKeypadEntry(text, min, max) {
    if (!text || text === '.' || !/^[0-9]*\.?[0-9]*$/.test(text)) {
        return { ok: false, error: 'Enter a number' };
    }
    const value = Number(text);
    if (!isFinite(value)) return { ok: false, error: 'Enter a number' };
    if ((min != null && value < min) || (max != null && value > max)) {
        return { ok: false, error: `Out of range (${min} to ${max})` };
    }
    return { ok: true, value };
}

// One reusable numeric keypad popover (#keypad).
class Keypad {
    constructor(root) {
        this.root = root;
        this.opts = null;
        this.text = '';
        if (!root) return;
        root.querySelectorAll('.keypad-keys .key').forEach((btn) => {
            btn.addEventListener('click', () => this.press(btn.getAttribute('data-key')));
        });
        const ok = document.getElementById('keypad-ok');
        if (ok) ok.addEventListener('click', () => this.submit());
        const cancel = document.getElementById('keypad-cancel');
        if (cancel) cancel.addEventListener('click', () => this.close());
    }

    // opts: {title, value, min, max, decimals, unit, onSubmit(value)}
    open(opts) {
        this.opts = opts;
        this.text = '';
        this.setText('keypad-title', opts.title || '');
        this.setText('keypad-unit', opts.unit || '');
        const dp = opts.decimals != null ? opts.decimals : 2;
        const unit = opts.unit ? ' ' + opts.unit : '';
        this.setText(
            'keypad-range',
            `Range ${Number(opts.min).toFixed(dp)} to ${Number(opts.max).toFixed(dp)}${unit}`
        );
        this.placeholder = opts.value != null ? Number(opts.value).toFixed(dp) : '';
        this.setError('');
        this.refresh();
        this.root.classList.remove('hidden');
    }

    close() {
        this.opts = null;
        if (this.root) this.root.classList.add('hidden');
    }

    isOpen() {
        return !!this.opts;
    }

    press(key) {
        this.text = keypadInput(this.text, key);
        this.setError('');
        this.refresh();
    }

    submit() {
        if (!this.opts) return;
        const res = validateKeypadEntry(this.text, this.opts.min, this.opts.max);
        if (!res.ok) {
            this.setError(res.error);
            return;
        }
        const done = this.opts.onSubmit;
        this.close();
        done(res.value);
    }

    refresh() {
        const entry = document.getElementById('keypad-entry');
        if (!entry) return;
        entry.textContent = this.text || this.placeholder;
        entry.classList.toggle('placeholder', !this.text);
    }

    setError(msg) {
        this.setText('keypad-error', msg);
    }

    setText(id, text) {
        const e = document.getElementById(id);
        if (e) e.textContent = text;
    }
}

// In-page confirmation (#confirm); no alert()/confirm() on a kiosk.
class ConfirmDialog {
    constructor(root) {
        this.root = root;
        this.onOk = null;
        const ok = document.getElementById('confirm-ok');
        if (ok) ok.addEventListener('click', () => {
            const fn = this.onOk;
            this.close();
            if (fn) fn();
        });
        const cancel = document.getElementById('confirm-cancel');
        if (cancel) cancel.addEventListener('click', () => this.close());
    }

    ask(message, onOk) {
        this.onOk = onOk;
        const m = document.getElementById('confirm-message');
        if (m) m.textContent = message;
        if (this.root) this.root.classList.remove('hidden');
    }

    close() {
        this.onOk = null;
        if (this.root) this.root.classList.add('hidden');
    }
}

class Dashboard {
    constructor() {
        this.socket = null;
        this.isConnected = false;
        this.data = {};
        this.units = { rate: 'L/Hr', pressure: 'psi' };

        this.el = {
            connection: document.getElementById('connection-status'),
            lastUpdate: document.getElementById('last-update'),
            loading: document.getElementById('loading-overlay'),
            faultBanner: document.getElementById('fault-banner'),
            faultList: document.getElementById('fault-message-list'),
            warningBanner: document.getElementById('warning-banner'),
            warningList: document.getElementById('warning-message-list'),
        };

        this.touch = false;
        this.toastTimer = null;
        this.keypad = new Keypad(document.getElementById('keypad'));
        this.confirm = new ConfirmDialog(document.getElementById('confirm'));
        this.initControls();
        this.initTouchControls();
        this.initSocket();
    }

    // -- on-screen controls (feature-gated; hidden until the backend reports them)
    initControls() {
        const vsd = document.getElementById('reset-vsd-btn');
        if (vsd) vsd.addEventListener('click', () => this.sendCommand('reset_vsd_fault', null, vsd));
    }

    // Touch-mode bar (#touch-bar). Controller RPC names, as the physical
    // buttons use: set_pump_state, nudge_rate, set_target_rate, reset_fault,
    // plus the controller's last_calibration_factor UI element.
    initTouchControls() {
        const on = (id, fn) => {
            const b = document.getElementById(id);
            if (b) b.addEventListener('click', () => fn(b));
        };
        on('touch-start', (b) => this.sendCommand('set_pump_state', 'start', b));
        // Stop acts immediately and is never disabled.
        on('touch-stop', (b) => this.sendCommand('set_pump_state', 'stop', b));
        on('touch-rate-up', (b) => this.sendCommand('nudge_rate', '+1', b));
        on('touch-rate-down', (b) => this.sendCommand('nudge_rate', '-1', b));
        on('touch-reset', (b) => this.sendCommand('reset_fault', null, b));
        on('touch-rate', (b) => this.openRateKeypad(b));
        on('touch-cal', (b) => this.openCalKeypad(b));
    }

    openRateKeypad(btn) {
        const pump = (this.data.pumps || [])[0];
        if (!this.touch || !pump || pump.min_rate == null || pump.max_rate == null) return;
        const current = pump.target_rate;
        this.keypad.open({
            title: 'Target rate',
            value: current,
            min: pump.min_rate,
            max: pump.max_rate,
            decimals: 2,
            unit: this.units.rate,
            onSubmit: (value) => {
                const send = () => this.sendCommand('set_target_rate', value, btn);
                const big =
                    current == null ||
                    Number(current) <= 0 ||
                    Math.abs(value - current) / Number(current) > RATE_CONFIRM_FRACTION;
                if (!big) return send();
                const from = current != null ? this.fmt(current, 2) : '--';
                this.confirm.ask(
                    `Change target rate from ${from} to ${this.fmt(value, 2)} ${this.units.rate}?`,
                    send
                );
            },
        });
    }

    openCalKeypad(btn) {
        const t = this.data.touch;
        if (!this.touch || !t) return;
        this.keypad.open({
            title: 'Calibration factor',
            value: t.calibration_factor,
            min: t.calibration_min,
            max: t.calibration_max,
            decimals: 2,
            unit: '',
            onSubmit: (value) => {
                const from = t.calibration_factor != null ? this.fmt(t.calibration_factor, 2) : '--';
                this.confirm.ask(
                    `Change calibration factor from ${from} to ${this.fmt(value, 2)}?`,
                    () => this.sendCommand('last_calibration_factor', value, btn)
                );
            },
        });
    }

    // Send one on-screen command with pending / success / error feedback on
    // the control that issued it. Only in Touch mode.
    sendCommand(cmd, value, btn) {
        if (!this.touch || !this.socket) return;
        if (btn && btn.classList.contains('pending')) return;
        this.setFeedback(btn, 'pending');
        this.socket.emit('command', { cmd, value }, (ack) => {
            if (ack && ack.ok) {
                this.setFeedback(btn, 'ok');
                if (COMMAND_DONE[cmd]) this.showToast(COMMAND_DONE[cmd], 'ok');
            } else {
                this.setFeedback(btn, 'error');
                this.showToast((ack && ack.message) || 'Command failed', 'error');
            }
            if (this.socket) this.socket.emit('request_data');
        });
    }

    setFeedback(btn, state) {
        if (!btn) return;
        btn.classList.remove('pending', 'ok', 'error');
        if (state) btn.classList.add(state);
        if (state === 'ok' || state === 'error') {
            setTimeout(() => btn.classList.remove(state), 2500);
        }
    }

    showToast(message, level) {
        const el = document.getElementById('command-toast');
        if (!el) return;
        el.textContent = message;
        el.className = 'command-toast' + (level ? ' ' + level : '');
        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => this.hide(el), level === 'error' ? 8000 : 3000);
    }

    // -- socket ------------------------------------------------------------
    initSocket() {
        this.socket = io();

        this.socket.on('connect', () => {
            this.isConnected = true;
            this.setConnection(true);
            this.hide(this.el.loading);
        });
        this.socket.on('disconnect', () => {
            this.isConnected = false;
            this.setConnection(false);
        });
        this.socket.on('connect_error', () => this.setConnection(false));
        this.socket.on('data_update', (data) => this.render(data));
        this.socket.on('heartbeat', (d) => this.setLastUpdate(d.timestamp));
        this.socket.on('notice', (n) => this.showToast(n.message, n.level));
    }

    // -- render ------------------------------------------------------------
    render(data) {
        this.data = data;
        if (data.units) this.units = data.units;

        this.setConnection(this.isConnected, data.link_ok);
        this.renderPump((data.pumps || [])[0]);
        this.renderFaults(data.faults || []);
        this.renderWarnings(data.warnings || []);
        this.renderSkid(data.skid);
        this.renderSolar(data.solar);
        this.renderTank(data.tank);
        this.renderValve(data.selector);
        this.renderTouch(data.touch, (data.pumps || [])[0]);
        this.renderVsd(data.vsd);
        this.setLastUpdate(data.timestamp);
    }

    renderPump(pump) {
        if (!pump) return;
        const rate = this.units.rate;
        const state = (pump.state || 'unknown');
        const stateClass = state.toLowerCase().replace(/[^a-z0-9]+/g, '-');

        this.setValue('target-rate', this.fmt(pump.target_rate, 2), rate);
        this.setValue('flow-rate', this.fmt(pump.flow_rate, 1), rate);
        this.setTotal(pump.total, this.volumeUnit(rate));
        this.renderFlowRange(pump);

        const st = document.querySelector('#pump-state .state-value');
        if (st) {
            st.textContent = state;
            st.className = 'state-value ' + stateClass + (pump.fault ? ' error' : '');
        }
    }

    // Total delivered volume shown as a smaller secondary line under Flow Rate.
    // The volume unit is derived from the rate units by dropping the /time part.
    setTotal(value, unit) {
        const el = document.getElementById('flow-total');
        if (!el) return;
        const v = el.querySelector('.secondary-value');
        if (v) v.textContent = this.fmt(value, 2);
        const u = el.querySelector('.secondary-unit');
        if (u) u.textContent = unit;
    }

    // "L/Day" -> "L", "Gal/Hr" -> "Gal": strip the time denominator.
    volumeUnit(rate) {
        return (rate || '').split('/')[0] || '';
    }

    // Linear min..target..max bar under the Target Rate readout: setpoint
    // feedback while the operator presses the flow up/down buttons. Hidden
    // whenever the controller hasn't published usable min/max deliverable
    // rates (null, or max <= min).
    renderFlowRange(pump) {
        const el = document.getElementById('flow-range');
        if (!el) return;
        const min = pump.min_rate;
        const max = pump.max_rate;
        if (
            min == null ||
            max == null ||
            max <= min ||
            pump.target_rate == null
        ) {
            this.hide(el);
            return;
        }
        this.show(el);
        const rate = this.units.rate;
        this.setText('flow-range-min', this.fmt(min, 2) + ' ' + rate);
        this.setText('flow-range-max', this.fmt(max, 2) + ' ' + rate);
        const target = Number(pump.target_rate);
        const frac = Math.max(0, Math.min(1, (target - min) / (max - min)));
        const fill = document.getElementById('flow-range-fill');
        if (fill) fill.style.width = `${frac * 100}%`;
    }

    renderFaults(faults) {
        if (!faults.length) {
            this.hide(this.el.faultBanner);
            this.el.faultList.textContent = '';
            return;
        }
        this.el.faultList.textContent = '';
        for (const f of faults) {
            const li = document.createElement('li');
            li.textContent = (f.pump ? `${f.pump}: ` : '') + (f.reason || 'Pump tripped');
            this.el.faultList.appendChild(li);
        }
        this.show(this.el.faultBanner);
    }

    // Warnings are non-trip conditions (e.g. no flow feedback): the pump keeps
    // running, the operator just sees the orange banner while they persist.
    renderWarnings(warnings) {
        if (!warnings.length) {
            this.hide(this.el.warningBanner);
            this.el.warningList.textContent = '';
            return;
        }
        this.el.warningList.textContent = '';
        for (const w of warnings) {
            const li = document.createElement('li');
            li.textContent = (w.pump ? `${w.pump}: ` : '') + (w.reason || 'Warning');
            this.el.warningList.appendChild(li);
        }
        this.show(this.el.warningBanner);
    }

    renderSkid(s) {
        const section = document.getElementById('skid-section');
        const row = document.getElementById('pump-skid-row');
        if (!s) {
            this.hide(section);
            if (row) row.classList.add('no-skid');
            return;
        }
        this.show(section);
        if (row) row.classList.remove('no-skid');
        if (s.skid_flow != null) this.setValue('skid-flow', this.fmt(s.skid_flow, 1), this.units.rate);
        if (s.skid_pressure != null) this.setValue('skid-pressure', this.fmt(s.skid_pressure, 1), this.units.pressure);
    }

    renderSolar(s) {
        // The backend sends a solar object (possibly empty) whenever solar
        // controllers are configured, so the card shows even before readings
        // arrive. Missing fields render as "--" rather than a fake "0.0".
        const section = document.getElementById('solar-section');
        if (!s) { this.hide(section); return; }
        this.show(section);
        this.setValue('battery-voltage', s.battery_voltage != null ? this.fmt(s.battery_voltage, 1) : '--');
        if (s.battery_percentage != null) {
            const pct = Math.round(s.battery_percentage);
            this.setValue('battery-percentage', pct);
            this.setBar('battery-progress', pct);
        } else {
            this.setValue('battery-percentage', '--');
            this.setBar('battery-progress', 0);
        }
        this.setValue('panel-power', s.panel_power != null ? this.fmt(s.panel_power, 1) : '--');
        this.setValue('battery-ah', s.battery_ah != null ? this.fmt(s.battery_ah, 1) : '--');
    }

    renderTank(t) {
        const section = document.getElementById('tank-section');
        if (!t) { this.hide(section); return; }
        this.show(section);
        if (t.tank_level_mm != null) this.setValue('tank-level-mm', Math.round(t.tank_level_mm));
        if (t.tank_level_percent != null) {
            const pct = Math.round(t.tank_level_percent);
            this.setValue('tank-level-percent', pct);
            this.setBar('tank-progress', pct);
        }
    }

    renderValve(sel) {
        const section = document.getElementById('valve-section');
        if (!sel) { this.hide(section); return; }
        this.show(section);
        const map = { 0: 'None', 1: 'Pump 1', 2: 'Pump 2', 3: 'Valve' };
        const st = document.querySelector('#valve-state .state-value');
        if (st) st.textContent = map[sel.state] != null ? map[sel.state] : '--';
    }

    // Touch bar: only in HMI Control Mode "Touch" (backend sends `touch`).
    renderTouch(touch, pump) {
        this.touch = !!touch;
        const bar = document.getElementById('touch-bar');
        const container = document.querySelector('.dashboard-container');
        const footer = document.querySelector('.footer-logo');
        const vsdSection = document.getElementById('vsd-section');
        if (vsdSection) vsdSection.classList.toggle('readonly', !this.touch);
        if (!touch) {
            this.hide(bar);
            if (container) container.classList.remove('touch-mode');
            if (footer && footer.classList.contains('touch-hidden')) {
                footer.classList.remove('touch-hidden');
                this.show(footer);
            }
            if (this.keypad.isOpen()) this.keypad.close();
            this.confirm.close();
            return;
        }
        this.show(bar);
        if (container) container.classList.add('touch-mode');
        if (footer) {
            footer.classList.add('touch-hidden');
            this.hide(footer);
        }

        const faulted = !!(pump && pump.fault);
        const start = document.getElementById('touch-start');
        if (start) start.disabled = faulted || !pump;
        this.setText('touch-start-hint', faulted ? 'Reset fault first' : '');
        const reset = document.getElementById('touch-reset');
        if (reset) reset.classList.toggle('attention', faulted);

        const rateKnown = !!(pump && pump.min_rate != null && pump.max_rate != null);
        this.setText('touch-rate-value', pump && pump.target_rate != null ? this.fmt(pump.target_rate, 2) : '--');
        this.setText('touch-rate-unit', this.units.rate);
        const rateBtn = document.getElementById('touch-rate');
        if (rateBtn) rateBtn.disabled = !rateKnown;
        ['touch-rate-up', 'touch-rate-down'].forEach((id) => {
            const b = document.getElementById(id);
            if (b) b.disabled = !pump;
        });
        this.setText(
            'touch-cal-value',
            touch.calibration_factor != null ? this.fmt(touch.calibration_factor, 2) : '--'
        );
    }

    // VSD card + the Pump/Motor drive line: only when a VSD is configured.
    renderVsd(vsd) {
        const section = document.getElementById('vsd-section');
        const line = document.getElementById('pump-drive-line');
        // .has-vsd scopes the compact one-screen layout (Tank + VSD on one
        // row); without a VSD the legacy layout is untouched.
        const container = document.querySelector('.dashboard-container');
        if (container) container.classList.toggle('has-vsd', !!vsd);
        if (!vsd) {
            this.hide(section);
            this.hide(line);
            return;
        }
        this.show(section);
        this.show(line);
        this.setText('pump-rpm', vsd.pump_rpm != null ? this.fmt(vsd.pump_rpm, 0) : '--');
        this.setText('motor-hz', vsd.motor_hz != null ? this.fmt(vsd.motor_hz, 1) : '--');

        const st = document.querySelector('#vsd-status .state-value');
        if (st) {
            st.textContent = vsd.tripped ? 'Tripped' : 'OK';
            st.className = 'state-value ' + (vsd.tripped ? 'vsd-tripped' : 'vsd-ok');
        }
        let trip = '';
        if (vsd.tripped) {
            trip = vsd.trip_description || 'Drive tripped';
            if (vsd.trip_code != null) trip += ` (code ${vsd.trip_code})`;
        }
        this.setText('vsd-trip', trip);
    }

    // -- helpers -----------------------------------------------------------
    fmt(v, dp) {
        const n = (v != null ? Number(v) : 0);
        return isNaN(n) ? '0' : n.toFixed(dp);
    }

    setValue(containerId, value, unit) {
        const c = document.getElementById(containerId);
        if (!c) return;
        const v = c.querySelector('.value');
        if (v) v.textContent = value;
        if (unit !== undefined) {
            const u = c.querySelector('.unit');
            if (u) u.textContent = unit;
        }
    }

    setText(id, text) {
        const e = document.getElementById(id);
        if (e) e.textContent = text;
    }

    setConnection(connected, linkOk) {
        const e = this.el.connection;
        if (!e) return;
        if (!connected) {
            e.className = 'status-disconnected';
            e.innerHTML = '&#9679; Disconnected';
        } else if (linkOk === false) {
            e.className = 'status-disconnected status-warning';
            e.innerHTML = '&#9679; No controller';
        } else {
            e.className = 'status-connected';
            e.innerHTML = '&#9679; Connected';
        }
    }

    setLastUpdate(ts) {
        const t = ts ? new Date(ts) : new Date();
        if (isNaN(t.getTime())) return;
        this.el.lastUpdate.textContent = t.toLocaleTimeString('en-US', {
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        });
    }

    setBar(id, pct) {
        const e = document.getElementById(id);
        if (!e) return;
        e.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        e.className = 'progress-fill' + (pct < 5 ? ' low' : pct < 25 ? ' medium' : '');
    }

    show(e) { if (e) e.classList.remove('hidden'); }
    hide(e) { if (e) e.classList.add('hidden'); }
}

document.addEventListener('DOMContentLoaded', () => {
    window.dashboard = new Dashboard();
});
