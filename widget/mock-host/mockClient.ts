/**
 * A mock data client for the mock host: serves fixed aggregates, and answers
 * RPCs the way the injection controller does, including control authority
 * (authority.py: the HMI actor is always allowed; anything else only starts /
 * changes the rate in `cloud` mode). Screenshots and manual checks only; not
 * shipped in the widget bundle.
 */

type Json = Record<string, unknown>;
type Handlers = { onAggregate?: (aggregate: unknown) => void };

export type MockHost = "local" | "cloud";

export interface MockOptions {
  host: MockHost;
  mode: "Read Only" | "Touch" | "Button";
  scenario: "running" | "faulted" | "standby";
  controlMode: "local" | "dcs" | "cloud";
  /** Controller has a VSD (motor_controller_app). */
  vsd?: boolean;
  /** Raise a warning alongside the scenario. */
  warning?: boolean;
  /** A second concurrent warning, joined into WarningReason as the controller does. */
  secondWarning?: boolean;
  /** Configure a solar controller. */
  solar?: boolean;
  /** tank_primary_reading / tank_secondary_reading (unset = app defaults). */
  tankPrimary?: string;
  tankSecondary?: string;
  /** vsd_commissioning ("Hidden" / "Local only" / "Local and cloud"). */
  commissioning?: string;
  /** vsd_motor_app (defaults to the Techtop key when commissioning is set). */
  vsdMotorApp?: string;
  /** Imitate an older Techtop app without get_diagnostics. */
  legacyMotorApp?: boolean;
  /** Controller CalibrationMethod (e.g. "Manual (HMI)"); unset = not published. */
  calibrationMethod?: string;
  /** A timed test already running with this many seconds left (reattach). */
  testRunRemaining?: number;
  /** Speed-up for the mock test run clock (1 = real time). */
  testRunSpeed?: number;
  /**
   * Who stops every test run TEST_RUN_STOP_MS after it starts (the one
   * running at load, and each one started from the wizard): it ends
   * "cancelled" with this TestRunEndedBy, as the controller does when a
   * command from that source (a DCS stop over Modbus) interrupts it.
   */
  testRunStoppedBy?: "dcs" | "cloud" | "hmi";
  /** kiosk_inset_mm / popover_inset_mm / kiosk_px_per_mm (unset = app defaults). */
  kioskInsetMm?: number;
  popoverInsetMm?: number;
  kioskPxPerMm?: number;
  /** alarm_settings_access ("Hidden" / "Local only" / "Local and cloud"). */
  alarmAccess?: string;
  /** The controller's PressureUnits (default psi). */
  pressureUnits?: string;
  /** Controller tank_ll_validation_enabled with a tank_app. */
  tankLlRequired?: boolean;
  /** Controller has a dedicated flow meter (flow L / LL alarms). */
  flowMeter?: boolean;
  /** sensor_settings_access ("Hidden" / "Local only" / "Local and cloud"). */
  sensorAccess?: string;
  /**
   * The sensor apps' Operator Sensor Calibration: "on" (default; the
   * readback tags and RPCs work), "off" (operator_calibration false, no
   * values, RPCs refused UNAVAILABLE) or "old" (an app from before the
   * feature: no such tags, no handlers, so an RPC never answers).
   */
  sensorCal?: "on" | "off" | "old";
}

export const TECHTOP = "techtop_motor_controller_1";

/** How long into a test run the mock's `testRunStoppedBy` stops it (real time). */
export const TEST_RUN_STOP_MS = 3000;

/** Optidrive E3 parameters as the Techtop app's read_parameters reports them. */
function techtopParameters() {
  const p = (
    id: string, name: string, value: number, units: string, min: number, max: number,
    step: number, writable: boolean, stop_required: boolean, description: string,
  ) => ({ id, name, value, units, min, max, step, writable, stop_required, description });
  return [
    p("P-01", "Maximum frequency", 50.0, "Hz", 0, 100, 0.1, true, false, "Maximum output frequency (speed limit)."),
    p("P-02", "Minimum frequency", 10.0, "Hz", 0, 50, 0.1, true, false, "Minimum output frequency while running."),
    p("P-03", "Acceleration time", 5.0, "s", 0, 600, 0.01, true, false, "Ramp time from 0 to P-09."),
    p("P-04", "Deceleration time", 5.0, "s", 0, 600, 0.01, true, false, "Ramp time from P-09 to 0."),
    p("P-07", "Motor rated voltage", 400, "V", 0, 500, 1, true, true, "Motor nameplate voltage."),
    p("P-08", "Motor rated current", 3.4, "A", 0.9, 4.1, 0.1, true, true, "Motor nameplate current (sets overload)."),
    p("P-09", "Motor rated frequency", 50, "Hz", 25, 500, 1, true, true, "Motor nameplate frequency."),
    p("P-10", "Motor rated speed", 1440, "RPM", 0, 30000, 1, true, true, "Motor nameplate speed; 0 shows Hz."),
    p("P-12", "Primary command source", 4, "", 0, 13, 1, false, true, "Modbus RTU control. Read only: changing it breaks HMI control."),
    p("P-36", "Serial comms", 1, "", 0, 63, 1, false, true, "Drive address. Read only: changing it breaks comms."),
  ];
}

const CTRL = "sia_injection_controller_1";
export const PRESSURE_APP = "4_20ma_sensor_2";
export const TANK_APP = "analog_level_sensor_1";

// The sensor apps' config defaults (what "Reset to configured values" goes
// back to) and their fixed loop currents: 9.6032 mA = 350.2 psi on 0-1000,
// 10.8 mA = 0.85 m on 0-2 m.
const PRESSURE_DEFAULTS = { range_low: 0, range_high: 1000, offset: 0 };
const TANK_DEFAULTS = { zero_m: 0, span_m: 2, fluid_density: 1000 };
const PRESSURE_MA = 9.6032;
const TANK_MA = 10.8;

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** The pressure app's corrected reading from its loop current and values. */
function pressureReading(v: { range_low: number; range_high: number; offset: number }): number {
  return round4(((PRESSURE_MA - 4) / 16) * (v.range_high - v.range_low) + v.range_low + v.offset);
}

/**
 * The level app's level (m) from its loop current, zero / span and density
 * (common_app._level_reading: the density scales only the column above the
 * zero, which may be negative).
 */
function tankReading(v: { zero_m: number; span_m: number; fluid_density: number }): number {
  return round4(v.zero_m + ((TANK_MA - 4) / 16) * (v.span_m - v.zero_m) * (1000 / v.fluid_density));
}

/** One sensor app's tags for the Operator Sensor Calibration state. */
function sensorTags(cal: MockOptions["sensorCal"], defaults: Json, loopTag: string, loopMa: number): Json {
  if (cal === "old") return { [loopTag]: loopMa };
  if (cal === "off") return { [loopTag]: loopMa, operator_calibration: false };
  return { [loopTag]: loopMa, operator_calibration: true, ...defaults };
}

export function scenarioTags(opts: MockOptions): Json {
  const faulted = opts.scenario === "faulted";
  const standby = opts.scenario === "standby";
  return {
    [CTRL]: {
      StateString: faulted ? "fault" : standby ? "standby" : "pumping",
      TargetRate: 12.5,
      FlowRate: faulted || standby ? 0 : 11.9,
      Total: 345.6,
      MinRate: 2.0,
      MaxRate: 92.16,
      Running: !(faulted || standby),
      Fault: faulted,
      FaultReason: faulted ? "VSD trip: Over current (code 3)" : null,
      Warning: !!opts.warning,
      WarningReason: opts.warning
        ? ["No stroke feedback: pump commanded but no stroke pulses"]
            .concat(opts.secondWarning ? ["Tank level data stale - tank alarms held"] : [])
            .join("; ")
        : null,
      CorrectionFactor: 1.0,
      ControlMode: opts.controlMode,
      ControlAuthorityActive: true,
      VsdConfigured: opts.vsd !== false,
      VsdTripCode: faulted ? 3 : 0,
      VsdTripDescription: faulted ? "Over current" : null,
      MotorOutputHz: faulted || standby ? 0 : 42.5,
      PumpRpm: faulted || standby ? 0 : 61,
      PressureUnits: opts.pressureUnits ?? "psi",
      SetpointTankL: 20,
      SetpointTankLL: 10,
      SetpointPressureH: 0,
      SetpointPressureHH: opts.pressureUnits === "kPa" ? 6894.8 : opts.pressureUnits === "bar" ? 68.9 : 1000,
      // The controller publishes 0 for the flow thresholds without a meter.
      SetpointFlowL: opts.flowMeter ? 50 : 0,
      SetpointFlowLL: opts.flowMeter ? 20 : 0,
      // Each alarm's delay in effect (the controller's config defaults).
      DelayTankL: 600,
      DelayTankLL: 600,
      DelayPressureH: 0,
      DelayPressureHH: 0,
      DelayFlowL: 120,
      DelayFlowLL: 120,
      ...(opts.calibrationMethod ? { CalibrationMethod: opts.calibrationMethod } : {}),
      ...(opts.testRunRemaining != null
        ? {
            StateString: "pumping",
            Running: true,
            FlowRate: 12.1,
            TestRunActive: true,
            TestRunRemaining_s: opts.testRunRemaining,
            TestRunRate: 12.5,
            TestRunDuration_s: 60,
            TestRunElapsed_s: 60 - opts.testRunRemaining,
            TestRunResult: null,
            TestRunEndedBy: null,
          }
        : {}),
    },
    [TANK_APP]: {
      level_reading: 0.85,
      level_filled_percentage: 64,
      level_volume: 1284.6,
      ...sensorTags(opts.sensorCal, TANK_DEFAULTS, "raw_level_reading", TANK_MA),
    },
    [PRESSURE_APP]: {
      value: 350.2,
      ...sensorTags(opts.sensorCal, PRESSURE_DEFAULTS, "raw_value", PRESSURE_MA),
    },
    morningstar_prostar_app_1: { b_voltage: 25.4, b_percent: 81, panel_power: 120.5, remaining_ah: 200 },
  };
}

export function createMockClient(opts: MockOptions) {
  const now = Date.now();
  const aggregates: Record<string, { data: Json; last_updated: number }> = {
    deployment_config: {
      data: {
        applications: {
          sia_local_control_ui_1: {
            hmi_control_mode: opts.mode,
            pump_controllers: [CTRL],
            tank_level_app: "analog_level_sensor_1",
            pressure_sensor_app: "4_20ma_sensor_2",
            solar_controllers: opts.solar ? ["morningstar_prostar_app_1"] : [],
            rate_units: "L/Hr",
            ...(opts.tankPrimary ? { tank_primary_reading: opts.tankPrimary } : {}),
            ...(opts.tankSecondary ? { tank_secondary_reading: opts.tankSecondary } : {}),
            ...(opts.commissioning ? { vsd_commissioning: opts.commissioning } : {}),
            ...(opts.vsdMotorApp ? { vsd_motor_app: opts.vsdMotorApp } : {}),
            ...(opts.kioskInsetMm != null ? { kiosk_inset_mm: opts.kioskInsetMm } : {}),
            ...(opts.popoverInsetMm != null ? { popover_inset_mm: opts.popoverInsetMm } : {}),
            ...(opts.kioskPxPerMm != null ? { kiosk_px_per_mm: opts.kioskPxPerMm } : {}),
            ...(opts.alarmAccess ? { alarm_settings_access: opts.alarmAccess } : {}),
            ...(opts.sensorAccess ? { sensor_settings_access: opts.sensorAccess } : {}),
          },
          [PRESSURE_APP]: {
            min_range: PRESSURE_DEFAULTS.range_low,
            max_range: PRESSURE_DEFAULTS.range_high,
            measurement_units: opts.pressureUnits ?? "psi",
            operator_calibration_enabled: (opts.sensorCal ?? "on") === "on",
          },
          [TANK_APP]: {
            sensor_minimum_metres: TANK_DEFAULTS.zero_m,
            sensor_maximum_metres: TANK_DEFAULTS.span_m,
            fluid_density: TANK_DEFAULTS.fluid_density,
            // The Sensor tab's labels follow these (a Radar swaps zero / span).
            type: "Submersible",
            input_units: "mA",
            sensor_minimum_ma: 4,
            sensor_maximum_ma: 20,
            operator_calibration_enabled: (opts.sensorCal ?? "on") === "on",
          },
          [CTRL]: {
            pressure_units: opts.pressureUnits ?? "psi",
            ...(opts.tankLlRequired ? { tank_ll_validation_enabled: true, tank_app: "analog_level_sensor_1" } : {}),
            ...(opts.flowMeter ? { flow_meter_source: "DI", flow_meter_pin: 2, flow_meter_k_factor: 450 } : {}),
          },
        },
      },
      last_updated: now,
    },
    tag_values: { data: scenarioTags(opts), last_updated: now },
    ui_cmds: { data: { [CTRL]: { last_calibration_factor: 1.0 } }, last_updated: now },
  };
  const subs = new Map<string, Set<Handlers>>();
  const push = (name: string) => {
    for (const h of subs.get(name) ?? []) h.onAggregate?.(aggregates[name]);
  };
  const patchApp = (key: string, patch: Json) => {
    const tags = aggregates.tag_values.data[key] as Json;
    aggregates.tag_values = {
      data: { ...aggregates.tag_values.data, [key]: { ...tags, ...patch } },
      last_updated: Date.now(),
    };
    push("tag_values");
  };
  const patchTags = (patch: Json) => patchApp(CTRL, patch);

  // The controller's timed test run, on a (possibly sped-up) mock clock.
  let testTimer: ReturnType<typeof setInterval> | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  const endTest = (result: string, elapsed: number, endedBy: string | null) => {
    clearInterval(testTimer);
    clearTimeout(stopTimer);
    testTimer = undefined;
    patchTags({
      TestRunActive: false,
      TestRunRemaining_s: 0,
      TestRunElapsed_s: Math.round(elapsed * 100) / 100,
      TestRunResult: result,
      TestRunEndedBy: endedBy,
      StateString: "standby",
      Running: false,
      FlowRate: 0,
    });
  };
  const startTest = (rate: number, duration: number) => {
    const speed = opts.testRunSpeed ?? 1;
    const t0 = Date.now();
    const elapsed = () => ((Date.now() - t0) / 1000) * speed;
    patchTags({
      TestRunActive: true,
      TestRunRemaining_s: duration,
      TestRunRate: rate,
      TestRunDuration_s: duration,
      TestRunElapsed_s: 0,
      TestRunResult: null,
      TestRunEndedBy: null,
      StateString: "pumping",
      Running: true,
      FlowRate: Math.round(rate * 0.96 * 100) / 100,
    });
    testTimer = setInterval(() => {
      const e = elapsed();
      if (e >= duration) endTest("completed", duration, "deadline");
      else patchTags({ TestRunRemaining_s: Math.round((duration - e) * 10) / 10, TestRunElapsed_s: Math.round(e * 100) / 100 });
    }, 250);
    scheduleStop(elapsed);
    return elapsed;
  };
  // testRunStoppedBy: that source stops the run a few seconds in.
  const scheduleStop = (elapsed: () => number) => {
    const by = opts.testRunStoppedBy;
    if (by) stopTimer = setTimeout(() => endTest("cancelled", elapsed(), by), TEST_RUN_STOP_MS);
  };
  let testElapsed: (() => number) | undefined;
  if (opts.testRunRemaining != null) {
    // The run already going at load (calrun / testrun).
    const t0 = Date.now() - (60 - opts.testRunRemaining) * 1000;
    testElapsed = () => (Date.now() - t0) / 1000;
    scheduleStop(testElapsed);
  }

  const rpcError = (code: string, message: string) =>
    Object.assign(new Error(message), { status: { code: "error", message: { code, message } } });

  const controller = async (req: { method: string; request: unknown; actor?: { name?: string } }) => {
    const tags = aggregates.tag_values.data[CTRL] as Json;
    const name = (req.actor?.name ?? "").trim().toLowerCase();
    const source = name === "hmi" || name === "local hmi" ? "hmi" : "cloud";
    const mode = String(tags.ControlMode);
    const restricted = ["set_target_rate", "nudge_rate"].includes(req.method) ||
      (req.method === "set_pump_state" && req.request === "start");
    if (restricted && source !== "hmi" && mode !== "cloud") {
      throw rpcError(
        "REMOTE_DENIED",
        `cloud may not start the pump while the control mode is ${mode}`,
      );
    }
    await new Promise((r) => setTimeout(r, 400));
    switch (req.method) {
      case "set_pump_state":
        // Any pump command ends a running test (cancelled, by its source).
        if (tags.TestRunActive) endTest("cancelled", testElapsed ? testElapsed() : 0, source);
        patchTags(
          req.request === "start"
            ? { StateString: "pumping", Running: true, FlowRate: 11.9 }
            : { StateString: "standby", Running: false, FlowRate: 0 },
        );
        return { state: tags.StateString };
      case "nudge_rate": {
        const step = req.request === "+1" ? 4.608 : -4.608;
        const next = Math.min(92.16, Math.max(2, Number(tags.TargetRate) + step));
        patchTags({ TargetRate: Math.round(next * 1000) / 1000 });
        return { target_rate: next };
      }
      case "set_target_rate":
        patchTags({ TargetRate: Number(req.request) });
        return { target_rate: req.request };
      case "reset_vsd_fault":
        if (!tags.VsdTripCode) throw rpcError("NOT_TRIPPED", "the VSD is not tripped");
        patchTags({ VsdTripCode: 0, VsdTripDescription: null });
        return { vsd_tripped: false };
      case "reset_fault":
        if (tags.VsdTripCode) throw rpcError("NOT_CLEARABLE", String(tags.FaultReason));
        patchTags({ Fault: false, FaultReason: null, StateString: "standby" });
        return { fault: false };
      case "start_test_run": {
        if (tags.CalibrationMethod !== "Manual (HMI)") {
          throw rpcError("NOT_ENABLED", "the timed test run needs Calibration Method 'Manual (HMI)'");
        }
        if (tags.TestRunActive) throw rpcError("NOT_READY", "a test run is already running");
        if (tags.Fault) throw rpcError("NOT_READY", "the pump is faulted; reset the fault first");
        if (tags.Running) throw rpcError("NOT_READY", "the pump is pumping; stop it before a test run");
        const r = req.request as { rate: number; duration_s: number };
        testElapsed = startTest(Number(r.rate), Number(r.duration_s));
        return { active: true, rate: r.rate, duration_s: r.duration_s };
      }
      case "cancel_test_run":
        if (tags.TestRunActive) endTest("cancelled", testElapsed ? testElapsed() : 0, source);
        return { active: false, result: "cancelled" };
      case "low_tank_level":
      case "low_low_tank_level":
      case "high_pressure":
      case "high_high_pressure":
      case "low_flow_percent":
      case "low_low_flow_percent":
      case "tank_l_delay":
      case "tank_ll_delay":
      case "pressure_h_delay":
      case "pressure_hh_delay":
      case "flow_l_delay":
      case "flow_ll_delay": {
        const v = Number(req.request);
        if (req.method === "low_low_tank_level" && opts.tankLlRequired && !(v > 0)) {
          throw rpcError("INVALID", "the low-low tank level must be above 0 while a tank sensor is configured");
        }
        // Delays: whole seconds (rounded), tank 1 to 600, the rest 0 to 600.
        const delay = req.method.endsWith("_delay");
        const min = req.method.startsWith("tank_") ? 1 : 0;
        if (delay && !(v >= min && v <= 600)) {
          throw rpcError("INVALID", `the alarm delay must be ${min} to 600 seconds`);
        }
        const tag = {
          low_tank_level: "SetpointTankL",
          low_low_tank_level: "SetpointTankLL",
          high_pressure: "SetpointPressureH",
          high_high_pressure: "SetpointPressureHH",
          low_flow_percent: "SetpointFlowL",
          low_low_flow_percent: "SetpointFlowLL",
          tank_l_delay: "DelayTankL",
          tank_ll_delay: "DelayTankLL",
          pressure_h_delay: "DelayPressureH",
          pressure_hh_delay: "DelayPressureHH",
          flow_l_delay: "DelayFlowL",
          flow_ll_delay: "DelayFlowLL",
        }[req.method] as string;
        patchTags({ [tag]: delay ? Math.round(v) : v });
        return { [req.method]: v };
      }
      case "last_calibration_factor":
        aggregates.ui_cmds = {
          data: { [CTRL]: { last_calibration_factor: req.request } },
          last_updated: Date.now(),
        };
        push("ui_cmds");
        return {};
      default:
        return {};
    }
  };

  // The sensor apps' "Sensor Calibration" handlers on ui_cmds (their own
  // app keys), with the apps' validation (RPCError INVALID, value unchanged).
  const sensor = async (key: string, req: { method: string; request: unknown }) => {
    const cal = opts.sensorCal ?? "on";
    // An older app has no such handler: pydoover never answers.
    if (cal === "old") return new Promise(() => {});
    if (cal === "off") throw rpcError("UNAVAILABLE", "Operator Sensor Calibration is off on this sensor app");
    await new Promise((r) => setTimeout(r, 300));
    const tags = aggregates.tag_values.data[key] as Json;
    const pressure = key === PRESSURE_APP;
    const current: Record<string, number> = pressure
      ? { range_low: Number(tags.range_low), range_high: Number(tags.range_high), offset: Number(tags.offset) }
      : { zero_m: Number(tags.zero_m), span_m: Number(tags.span_m), fluid_density: Number(tags.fluid_density) };
    let next: Record<string, number>;
    if (req.method === "reset_calibration") {
      next = pressure ? { ...PRESSURE_DEFAULTS } : { ...TANK_DEFAULTS };
    } else {
      if (!(req.method in current)) throw rpcError("METHOD_NOT_FOUND", `unknown method ${req.method}`);
      const v = Number(req.request);
      if (typeof req.request !== "number" || !Number.isFinite(v)) throw rpcError("INVALID", "expected a number");
      next = { ...current, [req.method]: round4(v) };
      if (pressure) {
        const p = next as typeof PRESSURE_DEFAULTS;
        if (Math.abs(v) > 1e6) throw rpcError("INVALID", "value out of range (|value| <= 1e6)");
        if (!(p.range_high > p.range_low)) throw rpcError("INVALID", "range_high must be above range_low");
        if (Math.abs(p.offset) > p.range_high - p.range_low) throw rpcError("INVALID", "offset larger than the range");
      } else {
        const t = next as typeof TANK_DEFAULTS;
        if (!(t.zero_m >= -100 && t.zero_m < t.span_m && t.span_m > 0 && t.span_m <= 100)) {
          throw rpcError("INVALID", "need -100 <= zero_m < span_m, 0 < span_m <= 100");
        }
        if (!(t.fluid_density >= 500 && t.fluid_density <= 2500)) throw rpcError("INVALID", "fluid_density must be 500 to 2500");
      }
    }
    patchApp(
      key,
      pressure
        ? { ...next, value: pressureReading(next as typeof PRESSURE_DEFAULTS) }
        : { ...next, level_reading: tankReading(next as typeof TANK_DEFAULTS) },
    );
    return next;
  };

  // The Techtop motor controller app on dv-rpc (VSD commissioning panel).
  const params = techtopParameters();
  const techtop = async (req: { method: string; request: unknown }) => {
    const tags = aggregates.tag_values.data[CTRL] as Json;
    const running = Boolean(tags.Running);
    const tripped = Boolean(tags.VsdTripCode);
    await new Promise((r) => setTimeout(r, 150));
    switch (req.method) {
      case "get_diagnostics":
        if (opts.legacyMotorApp) throw rpcError("METHOD_NOT_FOUND", "unknown method get_diagnostics");
        return {
          output_hz: running ? 42.5 : 0,
          output_current_a: running ? 2.8 : 0,
          motor_rpm: running ? 1224 : 0,
          dc_bus_v: 562,
          heatsink_c: 38,
          drive_state: tripped ? "Tripped" : running ? "Running" : "Stopped",
          trip_code: tripped ? Number(tags.VsdTripCode) : 0,
          trip_description: tripped ? String(tags.VsdTripDescription) : null,
          run_hours: 1287,
          recent_trips: [3, 21],
          comms_ok: true,
        };
      case "get_status":
        return {
          comms_active: true,
          drive_state: tripped ? "tripped" : running ? "running" : "stopped",
          trip_code: tripped ? Number(tags.VsdTripCode) : null,
          trip_description: tripped ? String(tags.VsdTripDescription) : null,
          output_frequency_hz: running ? 42.5 : 0,
          motor_current_a: running ? 2.8 : 0,
          dc_bus_voltage_v: 562,
        };
      case "read_parameters":
        return { parameters: params };
      case "write_parameter": {
        const r = req.request as { parameter: string; value: number };
        const p = params.find((x) => x.id === r.parameter);
        if (!p || !p.writable) throw rpcError("NOT_ALLOWED", `${r.parameter} is not writable`);
        if (p.stop_required && running) throw rpcError("DRIVE_RUNNING", `${p.id} can only change while stopped`);
        if (r.value < p.min || r.value > p.max) throw rpcError("OUT_OF_RANGE", `${p.id} out of range`);
        p.value = r.value;
        return { parameter: p.id, value: p.value };
      }
      default:
        // pydoover answers nothing for an unknown method.
        return new Promise(() => {});
    }
  };

  const client: Json = {
    ...(opts.host === "local" ? { clientId: "local-dda-http" } : {}),
    posted: [] as unknown[],
    supports: (cap: string) => (opts.host === "local" ? cap !== "users.me" : true),
    getStatus: () => ({ clientId: opts.host === "local" ? "local-dda-http" : "cloud", connected: true }),
    onStatusChange: (listener: (s: unknown) => void) => {
      listener({ connected: true });
      return () => {};
    },
    channels: {
      getChannel: async ({ channelName }: { channelName: string }) => ({
        name: channelName,
        aggregate: aggregates[channelName],
      }),
    },
    aggregates: {
      getAggregate: async ({ channelName }: { channelName: string }) => aggregates[channelName],
      patchAggregate: async () => ({}),
    },
    gateway: {
      connect: () => {},
      disconnect: () => {},
      on: () => {},
      off: () => {},
      getSession: () => null,
      isConnected: () => true,
      subscribeToChannel: (channel: { name: string }, handlers: Handlers) => {
        const set = subs.get(channel.name) ?? new Set();
        set.add(handlers);
        subs.set(channel.name, set);
        return () => set.delete(handlers);
      },
    },
    rpc: {
      send: async (
        channel: { channelName?: string },
        req: { method: string; request: unknown; app_key?: string; actor?: { name?: string } },
      ) => {
        if (channel?.channelName === "dv-rpc") {
          const w = window as unknown as { __vsdLog?: unknown[] };
          (w.__vsdLog ??= []).push({ channel: channel.channelName, ...req });
          if (req.app_key !== (opts.vsdMotorApp ?? TECHTOP)) return new Promise(() => {});
          return techtop(req);
        }
        (client.posted as unknown[]).push(req);
        (window as unknown as { __rpcLog: unknown[] }).__rpcLog = client.posted as unknown[];
        if (req.app_key === PRESSURE_APP || req.app_key === TANK_APP) return sensor(req.app_key, req);
        return controller(req);
      },
    },
  };
  if (opts.host === "cloud") {
    client.users = { getMe: async () => ({ id: "42", name: "Jane Operator", email: "jane@example.com" }) };
  }
  return client;
}
