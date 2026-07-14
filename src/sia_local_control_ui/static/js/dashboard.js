/**
 * SIA Remote Command touchscreen HMI.
 *
 * Renders controller status pushed over SocketIO (WP5 backend contract) into the
 * card-based "SIA Remote Command" layout, and turns operator actions into Doover
 * RPC commands (loading spinner + success/error toast).
 *
 * Backend socket contract (see dashboard.py / application.py):
 *   server -> client:  'data_update' {pumps:[], faults:[], link_ok, units:{rate,pressure},
 *                                     timestamp, solar?, tank?, skid?, selector?}
 *                      'heartbeat'   {timestamp}
 *   client -> server:  'command' {cmd, value}  -> ack {ok, code?, message?, result?}
 */

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
            cmdOverlay: document.getElementById('command-overlay'),
            cmdOverlayText: document.getElementById('command-overlay-text'),
            faultPopover: document.getElementById('fault-popover'),
            faultList: document.getElementById('fault-message-list'),
            toasts: document.getElementById('toast-container'),
            rateInput: document.getElementById('rate-input'),
        };

        this.initSocket();
        this.bindCommands();
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
    }

    // -- command dispatch --------------------------------------------------
    bindCommands() {
        document.querySelectorAll('.cmd-btn[data-cmd]').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.sendCommand(btn.getAttribute('data-cmd'), btn.getAttribute('data-value'));
            });
        });
        const rateBtn = document.getElementById('rate-set-btn');
        if (rateBtn) {
            rateBtn.addEventListener('click', () => {
                const v = parseFloat(this.el.rateInput.value);
                if (isNaN(v)) {
                    this.toast('error', 'Enter a rate value first');
                    return;
                }
                this.sendCommand('set_target_rate', v);
            });
        }
    }

    sendCommand(cmd, value) {
        if (!this.isConnected) {
            this.toast('error', 'Not connected to controller');
            return;
        }
        this.el.cmdOverlayText.textContent = this.commandLabel(cmd, value);
        this.show(this.el.cmdOverlay);

        let settled = false;
        const done = (resp) => {
            if (settled) return;
            settled = true;
            this.hide(this.el.cmdOverlay);
            if (resp && resp.ok) {
                this.toast('success', this.successLabel(cmd, value, resp.result));
            } else {
                const code = (resp && resp.code) || 'ERROR';
                const msg = (resp && resp.message) || 'Command failed';
                this.toast('error', `${code}: ${msg}`);
            }
        };
        // Ack callback carries the controller's result / RPC error.
        this.socket.emit('command', { cmd: cmd, value: value }, done);
        // Safety timeout in case no ack arrives.
        setTimeout(() => done({ ok: false, code: 'TIMEOUT', message: 'no response from controller' }), 35000);
    }

    commandLabel(cmd, value) {
        switch (cmd) {
            case 'set_pump_state': return value === 'start' ? 'Starting pump...' : 'Stopping pump...';
            case 'nudge_rate': return value === '+1' ? 'Increasing rate...' : 'Decreasing rate...';
            case 'set_target_rate': return 'Setting target rate...';
            case 'reset_fault': return 'Clearing fault...';
            default: return 'Sending command...';
        }
    }

    successLabel(cmd, value, result) {
        switch (cmd) {
            case 'set_pump_state': return `Pump ${result && result.state ? result.state : value}`;
            case 'nudge_rate':
            case 'set_target_rate':
                return `Target rate ${result && result.target_rate != null ? result.target_rate.toFixed(2) : ''} ${this.units.rate}`.trim();
            case 'reset_fault': return 'Fault cleared';
            default: return 'Command applied';
        }
    }

    // -- render ------------------------------------------------------------
    render(data) {
        this.data = data;
        if (data.units) this.units = data.units;

        this.setConnection(this.isConnected, data.link_ok);
        this.renderPump((data.pumps || [])[0]);
        this.renderFaults(data.faults || []);
        this.renderSkid(data.skid);
        this.renderSolar(data.solar);
        this.renderTank(data.tank);
        this.renderValve(data.selector);
        this.setLastUpdate(data.timestamp);
    }

    renderPump(pump) {
        if (!pump) return;
        const rate = this.units.rate;
        const state = (pump.state || 'unknown');
        const stateClass = state.toLowerCase().replace(/[^a-z0-9]+/g, '-');

        this.setValue('pump-control-label', pump.name || 'Pump', '');
        this.setValue('target-rate', this.fmt(pump.target_rate, 1), rate);
        this.setValue('flow-rate', this.fmt(pump.flow_rate, 1), rate);

        const st = document.querySelector('#pump-state .state-value');
        if (st) {
            st.textContent = state;
            st.className = 'state-value ' + stateClass + (pump.fault ? ' error' : '');
        }
        this.setLamp('lamp-run', pump.running);
        this.setLamp('lamp-trip', pump.fault);
    }

    renderFaults(faults) {
        if (!faults.length) {
            this.hide(this.el.faultPopover);
            this.el.faultList.innerHTML = '';
            return;
        }
        this.el.faultList.innerHTML = faults.map((f) => {
            const who = f.pump ? `${f.pump}: ` : '';
            return `<li>${who}${f.reason || 'Pump tripped'}</li>`;
        }).join('');
        this.show(this.el.faultPopover);
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
        const section = document.getElementById('solar-section');
        if (!s) { this.hide(section); return; }
        this.show(section);
        if (s.battery_voltage != null) this.setValue('battery-voltage', this.fmt(s.battery_voltage, 1));
        if (s.battery_percentage != null) {
            const pct = Math.round(s.battery_percentage);
            this.setValue('battery-percentage', pct);
            this.setBar('battery-progress', pct);
        }
        if (s.panel_power != null) this.setValue('panel-power', this.fmt(s.panel_power, 1));
        if (s.battery_ah != null) this.setValue('battery-ah', this.fmt(s.battery_ah, 1));
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

    setLamp(id, on) {
        const e = document.getElementById(id);
        if (e) e.classList.toggle('on', !!on);
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

    toast(kind, message) {
        const t = document.createElement('div');
        t.className = `toast toast-${kind}`;
        t.textContent = message;
        t.setAttribute('role', 'alert');
        this.el.toasts.appendChild(t);
        setTimeout(() => t.classList.add('show'), 10);
        setTimeout(() => {
            t.classList.remove('show');
            setTimeout(() => t.remove(), 300);
        }, kind === 'error' ? 6000 : 3500);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.dashboard = new Dashboard();
});
