/**
 * Mock host: renders the real widget component with a mock data client, as
 * either host.
 *
 *   ?host=local|cloud        which host to imitate (the client identity)
 *   &mode=Touch|Read Only    HMI Control Mode
 *   &scenario=running|faulted|standby
 *   &control=local|dcs|cloud the mode the controller enforces
 *   &vsd=0                   controller without a VSD
 *   &warning=1               add a warning banner
 *   &solar=1                 configure a solar controller
 *   &tank=L,mm               tank primary,secondary reading (unset = defaults)
 *   &width=480               cloud card width (px)
 *   &click=touch-start       click a control after load (e.g. to show a denial)
 */
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DooverProvider } from "doover-js/react";

import SiaHmiWidget from "../src/SiaHmiWidget";
import { createMockClient, type MockOptions } from "./mockClient";

const q = new URLSearchParams(window.location.search);
const opts: MockOptions = {
  host: q.get("host") === "cloud" ? "cloud" : "local",
  mode: (q.get("mode") as MockOptions["mode"]) ?? "Touch",
  scenario: (q.get("scenario") as MockOptions["scenario"]) ?? "running",
  controlMode: (q.get("control") as MockOptions["controlMode"]) ?? "local",
  vsd: q.get("vsd") !== "0",
  warning: q.get("warning") === "1",
  solar: q.get("solar") === "1",
  tankPrimary: q.get("tank")?.split(",")[0] || undefined,
  tankSecondary: q.get("tank")?.split(",")[1] || undefined,
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
