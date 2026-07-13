/**
 * SIA Local Control touchscreen HMI.
 * Renders controller status pushed over SocketIO and turns operator actions
 * into Doover RPC commands (with a loading spinner + success/error toast).
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
            pumpCards: document.getElementById('pump-cards'),
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
                return `Target rate ${result && result.target_rate != null ? result.target_rate.toFixed(2) : ''} ${this.units.rate}`;
            case 'reset_fault': return 'Fault cleared';
            default: return 'Command applied';
        }
    }

    render(data) {
        this.data = data;
        if (data.units) {
            this.units = data.units;
            document.querySelectorAll('.skid-flow-unit').forEach((e) => (e.textContent = data.units.rate));
            document.querySelectorAll('.skid-pressure-unit').forEach((e) => (e.textContent = data.units.pressure));
        }
        this.setConnection(this.isConnected, data.link_ok);
        this.renderPumps(data.pumps || []);
        this.renderFaults(data.faults || []);
        this.renderAux('solar-card', data.solar, this.renderSolar.bind(this));
        this.renderAux('tank-card', data.tank, this.renderTank.bind(this));
        this.renderAux('skid-card', data.skid, this.renderSkid.bind(this));
        this.setLastUpdate(data.timestamp);
    }

    renderPumps(pumps) {
        const rate = this.units.rate;
        this.el.pumpCards.className = 'pump-cards' + (pumps.length > 1 ? ' multi' : '');
        this.el.pumpCards.innerHTML = pumps.map((p) => {
            const state = (p.state || 'unknown').toLowerCase();
            const target = (p.target_rate != null ? p.target_rate : 0).toFixed(2);
            const flow = (p.flow_rate != null ? p.flow_rate : 0).toFixed(2);
            return `
            <div class="pump-card state-${state}">
                <div class="pump-head">
                    <span class="pump-name">${p.name || 'Pump'}</span>
                    <span class="pump-state state-badge state-${state}">${p.state || 'unknown'}</span>
                </div>
                <div class="pump-metrics">
                    <div class="pump-metric">
                        <span class="pm-label">Target</span>
                        <span class="pm-value">${target}<span class="pm-unit">${rate}</span></span>
                    </div>
                    <div class="pump-metric">
                        <span class="pm-label">Flow</span>
                        <span class="pm-value">${flow}<span class="pm-unit">${rate}</span></span>
                    </div>
                </div>
                <div class="pump-lamps">
                    <span class="lamp lamp-run ${p.running ? 'on' : ''}">RUN</span>
                    <span class="lamp lamp-trip ${p.fault ? 'on' : ''}">TRIP</span>
                </div>
            </div>`;
        }).join('');
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

    renderAux(cardId, data, renderer) {
        const card = document.getElementById(cardId);
        if (!data) { card.classList.add('hidden'); return; }
        card.classList.remove('hidden');
        renderer(data);
    }

    renderSolar(s) {
        if (s.battery_voltage != null) this.setText('battery-voltage', s.battery_voltage.toFixed(1));
        if (s.battery_percentage != null) {
            const pct = Math.round(s.battery_percentage);
            this.setText('battery-percentage', pct);
            this.setBar('battery-progress', pct);
        }
        if (s.panel_power != null) this.setText('panel-power', s.panel_power.toFixed(1));
        if (s.battery_ah != null) this.setText('battery-ah', s.battery_ah.toFixed(1));
    }

    renderTank(t) {
        if (t.tank_level_mm != null) this.setText('tank-level-mm', Math.round(t.tank_level_mm));
        if (t.tank_level_percent != null) {
            const pct = Math.round(t.tank_level_percent);
            this.setText('tank-level-percent', pct);
            this.setBar('tank-progress', pct);
        }
    }

    renderSkid(s) {
        if (s.skid_flow != null) this.setText('skid-flow', s.skid_flow.toFixed(1));
        if (s.skid_pressure != null) this.setText('skid-pressure', s.skid_pressure.toFixed(1));
    }

    // -- helpers ----------------------------------------------------------
    setConnection(connected, linkOk) {
        const e = this.el.connection;
        if (!connected) {
            e.className = 'conn conn-down';
            e.innerHTML = '<span class="dot"></span> Disconnected';
        } else if (linkOk === false) {
            e.className = 'conn conn-warn';
            e.innerHTML = '<span class="dot"></span> No controller';
        } else {
            e.className = 'conn conn-up';
            e.innerHTML = '<span class="dot"></span> Connected';
        }
    }

    setLastUpdate(ts) {
        const t = ts ? new Date(ts) : new Date();
        if (isNaN(t.getTime())) return;
        this.el.lastUpdate.textContent = t.toLocaleTimeString('en-US', {
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        });
    }

    setText(id, v) { const e = document.getElementById(id); if (e) e.textContent = v; }
    setBar(id, pct) {
        const e = document.getElementById(id);
        if (!e) return;
        e.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        e.className = 'bar-fill' + (pct < 5 ? ' low' : pct < 25 ? ' medium' : '');
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
