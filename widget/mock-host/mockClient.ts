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
  /** Configure a solar controller. */
  solar?: boolean;
  /** tank_primary_reading / tank_secondary_reading (unset = app defaults). */
  tankPrimary?: string;
  tankSecondary?: string;
}

const CTRL = "sia_injection_controller_1";

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
      WarningReason: opts.warning ? "No stroke feedback: pump commanded but no stroke pulses" : null,
      CorrectionFactor: 1.0,
      ControlMode: opts.controlMode,
      ControlAuthorityActive: true,
      VsdConfigured: opts.vsd !== false,
      VsdTripCode: faulted ? 3 : 0,
      VsdTripDescription: faulted ? "Over current" : null,
      MotorOutputHz: faulted || standby ? 0 : 42.5,
      PumpRpm: faulted || standby ? 0 : 61,
      PressureUnits: "psi",
    },
    analog_level_sensor_1: { level_reading: 0.85, level_filled_percentage: 64, level_volume: 1284.6 },
    "4_20ma_sensor_2": { value: 350.2 },
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
  const patchTags = (patch: Json) => {
    const tags = aggregates.tag_values.data[CTRL] as Json;
    aggregates.tag_values = {
      data: { ...aggregates.tag_values.data, [CTRL]: { ...tags, ...patch } },
      last_updated: Date.now(),
    };
    push("tag_values");
  };

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
      send: async (_channel: unknown, req: { method: string; request: unknown; actor?: { name?: string } }) => {
        (client.posted as unknown[]).push(req);
        (window as unknown as { __rpcLog: unknown[] }).__rpcLog = client.posted as unknown[];
        return controller(req);
      },
    },
  };
  if (opts.host === "cloud") {
    client.users = { getMe: async () => ({ id: "42", name: "Jane Operator", email: "jane@example.com" }) };
  }
  return client;
}
