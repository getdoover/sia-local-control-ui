import "./styles.css";

import { useMemo } from "react";

import RemoteComponentWrapper from "customer_site/RemoteComponentWrapper";
import { useRemoteParams } from "customer_site/useRemoteParams";
import { useAgentChannel } from "doover-js/react";

import dooverLogo from "../../src/sia_local_control_ui/static/Doover Logo - Landscape - Frost White.svg?inline";
import siaLogo from "../../src/sia_local_control_ui/static/remote_command_logo.png?inline";
import {
  assembleDashboardData,
  type DashboardData,
  type JsonRecord,
  type PumpData,
} from "./lib/assembleDashboardData";

interface UiRemoteComponent {
  app_key?: string;
}

function formatNumber(value: number | undefined, precision: number): string {
  return Number.isFinite(value) ? Number(value).toFixed(precision) : "0";
}

function formatUpdated(value: unknown): string {
  const raw = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  if (!Number.isFinite(raw) || raw <= 0) return "--";
  const milliseconds = raw < 100_000_000_000 ? raw * 1000 : raw;
  return new Date(milliseconds).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function volumeUnit(rateUnit: string): string {
  return rateUnit.split("/")[0] || "";
}

function ValueCard({
  title,
  value,
  unit,
  children,
}: {
  title: string;
  value: string;
  unit?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="sia-hmi-card">
      <h3>{title}</h3>
      <div className="sia-hmi-value">
        <strong>{value}</strong>
        {unit && <span>{unit}</span>}
      </div>
      {children}
    </div>
  );
}

function RangeBar({ pump, unit }: { pump: PumpData; unit: string }) {
  if (pump.min_rate === null || pump.max_rate === null || pump.max_rate <= pump.min_rate) {
    return null;
  }
  const fraction = Math.max(
    0,
    Math.min(1, (pump.target_rate - pump.min_rate) / (pump.max_rate - pump.min_rate)),
  );
  return (
    <div className="sia-hmi-range" aria-label="Target rate range">
      <div className="sia-hmi-range-track">
        <span style={{ width: `${fraction * 100}%` }} />
      </div>
      <div className="sia-hmi-range-labels">
        <span>{formatNumber(pump.min_rate, 1)} {unit}</span>
        <span>{formatNumber(pump.max_rate, 1)} {unit}</span>
      </div>
    </div>
  );
}

function ProgressBar({ value }: { value: number }) {
  const bounded = Math.max(0, Math.min(100, value));
  const severity = bounded < 5 ? "low" : bounded < 25 ? "medium" : "normal";
  return (
    <div className="sia-hmi-progress" aria-hidden="true">
      <span className={severity} style={{ width: `${bounded}%` }} />
    </div>
  );
}

function Banner({
  kind,
  items,
}: {
  kind: "fault" | "warning";
  items: Array<{ pump: string; reason: string }>;
}) {
  if (!items.length) return null;
  return (
    <div className={`sia-hmi-banner ${kind}`} role={kind === "fault" ? "alert" : "status"}>
      <span aria-hidden="true">⚠</span>
      <strong>{kind}</strong>
      <ul>
        {items.map((item, index) => (
          <li key={`${item.pump}-${item.reason}-${index}`}>
            {item.pump}: {item.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Dashboard({ data, updated }: { data: DashboardData; updated: unknown }) {
  const pump = data.pumps[0];
  const selectorNames: Record<number, string> = {
    0: "None",
    1: "Pump 1",
    2: "Pump 2",
    3: "Valve",
  };

  return (
    <section className="sia-hmi">
      <header className="sia-hmi-header">
        <div className="sia-hmi-title">
          <img src={siaLogo} alt="SIA Remote Command" />
          <strong>SIA Remote Command</strong>
        </div>
        <div className="sia-hmi-meta">
          <span className={data.link_ok ? "connected" : "disconnected"}>
            ● {data.link_ok ? "Connected" : "No controller"}
          </span>
          <small>Last update: {formatUpdated(updated)}</small>
        </div>
      </header>

      <Banner kind="fault" items={data.faults} />
      <Banner kind="warning" items={data.warnings} />

      {!pump ? (
        <div className="sia-hmi-empty">No pump controller is configured.</div>
      ) : (
        <div className={`sia-hmi-row ${data.skid ? "with-skid" : ""}`}>
          <section className="sia-hmi-section pump">
            <h2>Pump Control</h2>
            <div className="sia-hmi-grid">
              <ValueCard
                title="Target Rate"
                value={formatNumber(pump.target_rate, 1)}
                unit={data.units.rate}
              >
                <RangeBar pump={pump} unit={data.units.rate} />
              </ValueCard>
              <ValueCard
                title="Flow Rate"
                value={formatNumber(pump.flow_rate, 1)}
                unit={data.units.rate}
              >
                <div className="sia-hmi-secondary">
                  <span>Total</span>
                  <strong>{formatNumber(pump.total, 2)}</strong>
                  <span>{volumeUnit(data.units.rate)}</span>
                </div>
              </ValueCard>
              <div className="sia-hmi-card">
                <h3>Pump State</h3>
                <div className={`sia-hmi-state ${pump.fault ? "fault" : pump.state.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>
                  {pump.state}
                </div>
              </div>
            </div>
          </section>

          {data.skid && (
            <section className="sia-hmi-section skid">
              <h2>Skid</h2>
              <div className="sia-hmi-grid">
                {data.skid.skid_flow !== undefined && (
                  <ValueCard title="Flow" value={formatNumber(data.skid.skid_flow, 1)} unit={data.units.rate} />
                )}
                {data.skid.skid_pressure !== undefined && (
                  <ValueCard title="Pressure" value={formatNumber(data.skid.skid_pressure, 1)} unit={data.units.pressure} />
                )}
              </div>
            </section>
          )}
        </div>
      )}

      <div className="sia-hmi-secondary-row">
        {data.selector && (
          <section className="sia-hmi-section selector">
            <h2>Valve</h2>
            <div className="sia-hmi-grid">
              <ValueCard title="Selector" value={selectorNames[data.selector.state] ?? "--"} />
            </div>
          </section>
        )}

        {data.solar && (
          <section className="sia-hmi-section solar">
            <h2>Solar System</h2>
            <div className="sia-hmi-grid">
              {data.solar.battery_voltage !== undefined && (
                <ValueCard title="Battery" value={formatNumber(data.solar.battery_voltage, 1)} unit="V" />
              )}
              {data.solar.battery_percentage !== undefined && (
                <ValueCard title="Charge" value={String(Math.round(data.solar.battery_percentage))} unit="%">
                  <ProgressBar value={data.solar.battery_percentage} />
                </ValueCard>
              )}
              {data.solar.panel_power !== undefined && (
                <ValueCard title="Panel" value={formatNumber(data.solar.panel_power, 1)} unit="W" />
              )}
              {data.solar.battery_ah !== undefined && (
                <ValueCard title="Capacity" value={formatNumber(data.solar.battery_ah, 1)} unit="Ah" />
              )}
            </div>
          </section>
        )}

        {data.tank && (
          <section className="sia-hmi-section tank">
            <h2>Tank</h2>
            <div className="sia-hmi-grid">
              {data.tank.tank_level_mm !== undefined && (
                <ValueCard title="Tank Level" value={String(Math.round(data.tank.tank_level_mm))} unit="mm" />
              )}
              {data.tank.tank_level_percent !== undefined && (
                <ValueCard title="Fill" value={String(Math.round(data.tank.tank_level_percent))} unit="%">
                  <ProgressBar value={data.tank.tank_level_percent} />
                </ValueCard>
              )}
            </div>
          </section>
        )}
      </div>

      <footer><img src={dooverLogo} alt="Doover" /></footer>
    </section>
  );
}

function SiaHmiInner({ uiElement }: { uiElement?: UiRemoteComponent }) {
  const params = useRemoteParams();
  const agentId = params?.agentId;
  const appKey = uiElement?.app_key ?? "sia_local_control";

  const deployment = useAgentChannel<JsonRecord>(agentId, "deployment_config");
  const tags = useAgentChannel<JsonRecord>(agentId, "tag_values");
  const data = useMemo(
    () => assembleDashboardData({
      appKey,
      deploymentConfig: deployment.data,
      tagValues: tags.data,
    }),
    [appKey, deployment.data, tags.data],
  );

  if (!agentId) return <div className="sia-hmi-state-message error">No agent selected.</div>;
  if (deployment.isLoading || tags.isLoading) {
    return <div className="sia-hmi-state-message">Loading HMI channels…</div>;
  }
  if (deployment.isError || tags.isError) {
    return <div className="sia-hmi-state-message error">Could not load HMI channels.</div>;
  }
  return <Dashboard data={data} updated={tags.last_updated} />;
}

export default function SiaHmiWidget(props: { uiElement?: UiRemoteComponent }) {
  return (
    <RemoteComponentWrapper>
      <SiaHmiInner {...props} />
    </RemoteComponentWrapper>
  );
}
