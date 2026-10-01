/**
 * Mock host: renders the real widget component with a mock data client, as
 * either host.
 *
 *   ?host=local|cloud        which host to imitate (the client identity)
 *   &mode=Touch|Read Only    HMI Control Mode
 *   &scenario=running|faulted|standby
 *   &control=local|dcs|cloud the mode the controller enforces
 *   &vsd=0                   controller without a VSD
 *   &warning=1               add a warning banner (warning=2: two at once)
 *   &solar=1                 configure a solar controller
 *   &tank=L,mm               tank primary,secondary reading (unset = defaults)
 *   &width=480               cloud card width (px)
 *   &click=touch-start       click a control after load (e.g. to show a denial)
 *   &commission=Local only   vsd_commissioning (Hidden / Local only / Local and cloud)
 *   &vsdapp=<key>            vsd_motor_app (default techtop_motor_controller_1
 *                            whenever commission is given)
 *   &legacy=1                an older Techtop app without get_diagnostics
 *   &cal=manual              controller CalibrationMethod "Manual (HMI)"
 *                            (cal=none / cal=auto publish "None" / "Auto")
 *   &calrun=42               a timed test already running, 42 s left
 *   &calspeed=20             run the mock test clock 20x faster
 *   &testrun=dcs             the DCS stops each test run 3 s in (TestRunResult
 *                            "cancelled", TestRunEndedBy "dcs"): the run
 *                            going at load (implies cal=manual and calrun=45
 *                            unless given) and each one started from the
 *                            wizard. testrun=cloud / hmi: stopped from
 *                            Doover / at the panel instead.
 *   &inset=2                 kiosk_inset_mm (cover plate)
 *   &popinset=10             popover_inset_mm
 *   &pxmm=5.8                kiosk_px_per_mm
 *   &alarms=Local only       alarm_settings_access (gears on Tank / Skid, and
 *                            Pump Control with flowmeter=1)
 *   &punits=kPa              the controller's PressureUnits (alarm ranges)
 *   &llreq=1                 controller tank_ll_validation_enabled (LL never off)
 *   &flowmeter=1             controller with a dedicated flow meter (flow
 *                            alarms: a gear on Pump Control)
 *   &sensors=Local only      sensor_settings_access (the Sensor tab on the
 *                            Tank / Skid pressure gears' popovers)
 *   &sensorcal=on|off|old    the sensor apps' Operator Sensor Calibration:
 *                            on (default), off (cells locked, RPCs refused),
 *                            old (an app without the feature: no tags)
 *   &dcs=on|off|old          DCS command pop-ups: on (dcs_connected, the
 *                            controller's DCS tags), off (the tags but
 *                            dcs_connected off), old (dcs_connected, an
 *                            older controller without the tags)
 *   &dcscmd=rate:15:13.1     the DCS sends this command 1.5 s after load
 *                            (mockClient.ts parseDcsCommand: start, stop,
 *                            run:7, rate:<req>[:<applied>], reset,
 *                            vsdreset, delay:<code 6..11>:<s>, each with an
 *                            optional /ok, /none or /refuse:<error>); any
 *                            time after: window.__dcsCommand("start")
 */
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DooverProvider } from "doover-js/react";

import SiaHmiWidget from "../src/SiaHmiWidget";
import { createMockClient, TECHTOP, type MockOptions } from "./mockClient";

const q = new URLSearchParams(window.location.search);
const testRunStoppedBy = (["dcs", "cloud", "hmi"] as const).find((s) => s === q.get("testrun"));
const opts: MockOptions = {
  host: q.get("host") === "cloud" ? "cloud" : "local",
  mode: (q.get("mode") as MockOptions["mode"]) ?? "Touch",
  scenario: (q.get("scenario") as MockOptions["scenario"]) ?? "running",
  controlMode: (q.get("control") as MockOptions["controlMode"]) ?? "local",
  vsd: q.get("vsd") !== "0",
  warning: q.get("warning") === "1" || q.get("warning") === "2",
  secondWarning: q.get("warning") === "2",
  solar: q.get("solar") === "1",
  tankPrimary: q.get("tank")?.split(",")[0] || undefined,
  tankSecondary: q.get("tank")?.split(",")[1] || undefined,
  commissioning: q.get("commission") ?? undefined,
  vsdMotorApp: q.get("vsdapp") ?? (q.get("commission") ? TECHTOP : undefined),
  legacyMotorApp: q.get("legacy") === "1",
  calibrationMethod: ({ manual: "Manual (HMI)", none: "None", auto: "Auto" } as Record<string, string>)[
    q.get("cal") ?? (testRunStoppedBy ? "manual" : "")
  ],
  testRunRemaining: q.get("calrun") != null ? Number(q.get("calrun")) : testRunStoppedBy ? 45 : undefined,
  testRunStoppedBy,
  testRunSpeed: q.get("calspeed") != null ? Number(q.get("calspeed")) : undefined,
  kioskInsetMm: q.get("inset") != null ? Number(q.get("inset")) : undefined,
  popoverInsetMm: q.get("popinset") != null ? Number(q.get("popinset")) : undefined,
  kioskPxPerMm: q.get("pxmm") != null ? Number(q.get("pxmm")) : undefined,
  alarmAccess: q.get("alarms") ?? undefined,
  pressureUnits: q.get("punits") ?? undefined,
  tankLlRequired: q.get("llreq") === "1",
  flowMeter: q.get("flowmeter") === "1",
  sensorAccess: q.get("sensors") ?? undefined,
  sensorCal: (q.get("sensorcal") as MockOptions["sensorCal"]) ?? undefined,
  dcs: (["on", "off", "old"] as const).find((v) => v === q.get("dcs")),
  dcsCommand: q.get("dcscmd") ?? undefined,
};
const client = createMockClient(opts);
const queryClient = new QueryClient();

document.body.className = opts.host;
const widget = <SiaHmiWidget uiElement={{ app_key: "sia_local_control_ui_1", name: "sia_hmi_widget" }} />;
const page =
  opts.host === "local" ? (
    <main>
      <section className="widget-stage">{widget}</section>
    </main>
  ) : (
    <div className="card" style={{ width: `${Number(q.get("width") ?? 480)}px` }}>
      <div className="card-title">SIA HMI</div>
      <div className="card-body">{widget}</div>
    </div>
  );

createRoot(document.getElementById("app")!).render(
  <QueryClientProvider client={queryClient}>
    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
    <DooverProvider client={client as any}>{page}</DooverProvider>
  </QueryClientProvider>,
);

const click = q.get("click");
if (click) {
  setTimeout(() => {
    (document.querySelector(`[data-id="${click}"]`) as HTMLElement | null)?.click();
  }, 600);
}
