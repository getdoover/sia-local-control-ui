/**
 * SIA Remote Command touchscreen HMI.
 *
 * Renders controller status pushed over SocketIO (WP5 backend contract) into the
 * card-based "SIA Remote Command" layout. DISPLAY ONLY — all operator input comes
 * from the physical panel pushbuttons (read by the app backend as DI/AI), not from
 * this touchscreen. There are no on-screen controls.
 *
 * Faults render as a non-blocking, in-flow banner between the header and the card
 * grid: it auto-shows when the backend reports active faults and auto-hides when
 * they clear, driven entirely by the live fault stream. It never overlays the
 * status cards and has no on-screen acknowledge, dismiss, or clear affordance —
 * faults clear only when the underlying condition clears.
 *
 * Backend socket contract (see dashboard.py / application.py):
 *   server -> client:  'data_update' {pumps:[], faults:[], link_ok, units:{rate,pressure},
 *                                     timestamp, solar?, tank?, skid?, selector?}
 *                      'heartbeat'   {timestamp}
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
            faultBanner: document.getElementById('fault-banner'),
            faultList: document.getElementById('fault-message-list'),
        };

        this.initSocket();
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
}

document.addEventListener('DOMContentLoaded', () => {
    window.dashboard = new Dashboard();
});
