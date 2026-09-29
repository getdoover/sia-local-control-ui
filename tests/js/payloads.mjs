// Dashboard payloads as the backend builds them for an older controller (or a
// new one with every new feature off): no `control` / `vsd` keys.
const TS = "2026-09-28T01:02:03+00:00";
const UNITS = { rate: "L/Hr", pressure: "psi" };

const pump = (over = {}) => ({
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

export const LEGACY_PAYLOADS = {
  running: {
    pumps: [pump()],
    faults: [],
    warnings: [],
    link_ok: true,
    units: UNITS,
    timestamp: TS,
  },
  faulted: {
    pumps: [pump({ state: "fault", running: false, fault: true, fault_reason: "Tank level low-low" })],
    faults: [{ pump: "Pump", reason: "Tank level low-low" }],
    warnings: [],
    link_ok: true,
    units: UNITS,
    timestamp: TS,
  },
  warning_with_peripherals: {
    pumps: [pump({ warning: true, warning_reason: "No flow feedback — not receiving pulses from pump sensor" })],
    faults: [],
    warnings: [{ pump: "Pump", reason: "No flow feedback — not receiving pulses from pump sensor" }],
    link_ok: true,
    units: UNITS,
    timestamp: TS,
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
  },
};

export const NEW_ONLY_IDS = new Set([
  "pump-drive-line",
  "vsd-section",
  "command-toast",
  "touch-bar",
  "keypad",
  "confirm",
]);
