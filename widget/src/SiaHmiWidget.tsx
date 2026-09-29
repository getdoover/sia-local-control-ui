import "./core/hmi-core.css";

// Inlined as data URIs (see globals.d.ts / rsbuild.config.ts): the widget
// ships as ONE .js file, so nothing may be emitted as a separate asset.
import remoteCommandLogo from "./assets/remote_command_logo.png?inline";
import dooverLogo from "./assets/doover_logo_frost_white.svg?inline";

import { useEffect, useMemo, useRef, useState } from "react";

import RemoteComponentWrapper from "customer_site/RemoteComponentWrapper";
import { useRemoteParams } from "customer_site/useRemoteParams";

import { useAgentChannel, useDooverClient } from "doover-js/react";

import { createHmi, type HmiHandle } from "./core/hmi-core.js";
import {
  assembleDashboardData,
  createFeatureMemory,
  liveTagIds,
  resolveConfig,
} from "./lib/assembleDashboardData.ts";
import { checkTouchCommand, explainRpcError, sendCommand, type Ack } from "./lib/commands.ts";
import { resolveAppKey, type UiRemoteComponent } from "./lib/appKey.ts";
import { detectHost, hostLabel, resolveActor, type CloudUser } from "./lib/host.ts";
import { overlayLiveValues } from "./lib/liveTags.ts";
import { useLiveTags } from "./lib/useLiveTags.ts";
import { createVsdPanelApi, vsdPanelAccess } from "./lib/vsdPanel.ts";

/**
 * SIA HMI widget: one bundle for the Doovit's local widget host and the
 * Doover cloud UI.
 *
 * A thin React shell around the framework-free render core
 * (core/hmi-core.js): doover-js hooks keep `deployment_config`, `tag_values`
 * and `ui_cmds` live through whichever client the host injected, the data
 * adapter (lib/assembleDashboardData.ts) builds the dashboard payload, and
 * on-screen commands go out as controller RPCs on `ui_cmds`
 * (lib/commands.ts) through `client.rpc`.
 *
 * Host differences are confined to three things, all decided by
 * `detectHost(client)` (lib/host.ts):
 *   - the RPC actor: `{name: "Local HMI"}` only on the local host, the
 *     signed-in user (or none) in the cloud, so control authority holds;
 *   - the layout: full-screen kiosk vs natural height in the cloud column;
 *   - the VSD commissioning panel: `vsd_commissioning` "Local only" allows
 *     drive parameter writes from the local host only (lib/vsdPanel.ts);
 *   - live tags: the cloud claims the tags it renders so they stream in
 *     seconds rather than every 15 minutes; the local host already reads the
 *     device's own state and skips it.
 */

interface StatusClient {
  getStatus?: () => { connected?: boolean } | undefined;
  onStatusChange?: (listener: (status: { connected?: boolean }) => void) => () => void;
  isConnected?: () => boolean;
}

/** Connection state from the injected client, tolerant of older clients. */
function useConnected(client: unknown): boolean {
  const c = client as StatusClient;
  const read = () => {
    try {
      const s = c.getStatus?.();
      if (s && typeof s.connected === "boolean") return s.connected;
      if (typeof c.isConnected === "function") return c.isConnected();
    } catch {
      // fall through
    }
    return true;
  };
  const [connected, setConnected] = useState(read);
  useEffect(() => {
    setConnected(read());
    if (typeof c.onStatusChange !== "function") return;
    try {
      return c.onStatusChange((s) => {
        if (s && typeof s.connected === "boolean") setConnected(s.connected);
      });
    } catch {
      return undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);
  return connected;
}

/** The signed-in cloud user, for the RPC actor. Never looked up locally. */
function useCloudUser(client: unknown, isCloud: boolean): CloudUser | null {
  const [user, setUser] = useState<CloudUser | null>(null);
  useEffect(() => {
    if (!isCloud) return;
    const users = (client as { users?: { getMe?: () => Promise<CloudUser> } }).users;
    if (typeof users?.getMe !== "function") return;
    let cancelled = false;
    Promise.resolve()
      .then(() => users.getMe!())
      .then((me) => {
        if (!cancelled && me) setUser(me);
      })
      .catch(() => {
        // No user: cloud commands go without an actor (still classed cloud).
      });
    return () => {
      cancelled = true;
    };
  }, [client, isCloud]);
  return user;
}

function SiaHmiInner({ uiElement }: { uiElement?: UiRemoteComponent }) {
  const params = useRemoteParams();
  const agentId = params?.agentId;
  const client = useDooverClient();
  const host = useMemo(() => detectHost(client), [client]);
  const appKey = resolveAppKey(
    uiElement,
    typeof window !== "undefined" ? window.location.search : undefined,
  );

  const { data: deploymentConfig } = useAgentChannel(agentId, "deployment_config");
  const { data: tagValues, last_updated } = useAgentChannel(agentId, "tag_values");
  const { data: uiCmds } = useAgentChannel(agentId, "ui_cmds");

  const cfg = useMemo(
    () => resolveConfig(appKey, deploymentConfig as Record<string, unknown> | undefined),
    [appKey, deploymentConfig],
  );

  // Cloud only (a no-op on the local host, see useLiveTags).
  const tagIds = useMemo(() => liveTagIds(cfg), [cfg]);
  const liveValues = useLiveTags({ agentId, tagIds });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const aggregateAt = useMemo(() => Date.now(), [tagValues]);

  const memory = useRef(createFeatureMemory());
  const connected = useConnected(client);
  const user = useCloudUser(client, host.kind === "cloud");
  const actor = useMemo(() => resolveActor(host.kind, user), [host.kind, user]);
  const vsdAccess = useMemo(
    () => vsdPanelAccess(cfg.vsdCommissioning, host.kind, cfg.vsdMotorApp),
    [cfg.vsdCommissioning, cfg.vsdMotorApp, host.kind],
  );

  const data = useMemo(() => {
    if (tagValues === undefined) return null;
    const live = overlayLiveValues(
      tagValues as Record<string, unknown> | undefined,
      liveValues,
      aggregateAt,
    );
    return assembleDashboardData({
      appKey,
      deploymentConfig: deploymentConfig as Record<string, unknown> | undefined,
      tagValues: live.tagValues,
      uiCmds: uiCmds as Record<string, unknown> | undefined,
      lastUpdated: live.liveAt ?? (last_updated as number | null | undefined),
      memory: memory.current,
    });
  }, [appKey, deploymentConfig, tagValues, liveValues, aggregateAt, uiCmds, last_updated]);

  // The render core is mounted once; the command handler reads the latest
  // render state through this ref.
  const latest = useRef({ cfg, actor, agentId, client, vsdAccess });
  latest.current = { cfg, actor, agentId, client, vsdAccess };

  const rootRef = useRef<HTMLDivElement | null>(null);
  const hmiRef = useRef<HmiHandle | null>(null);

  useEffect(() => {
    if (!rootRef.current) return;
    const run = async (cmd: string, value: unknown): Promise<Ack> => {
      const now = latest.current;
      const refused = checkTouchCommand(now.cfg.touchEnabled, cmd, value);
      if (refused) return refused;
      const key = now.cfg.controllers[0] ?? null;
      const ack = await sendCommand({
        client: now.client,
        agentId: now.agentId,
        appKey: key,
        cmd,
        value,
        actor: now.actor,
        timeoutMs: now.cfg.rpcTimeoutMs,
      });
      if (ack.ok) return ack;
      return explainRpcError(ack.code ?? "ERROR", ack.message ?? "");
    };
    // VSD commissioning: straight to the Techtop app (vsd_motor_app) on
    // dv-rpc, with the same actor as every other command.
    const vsdPanel = createVsdPanelApi(() => {
      const now = latest.current;
      return {
        client: now.client,
        agentId: now.agentId,
        appKey: now.cfg.vsdMotorApp,
        actor: now.actor,
        timeoutMs: now.cfg.rpcTimeoutMs,
        access: now.vsdAccess,
      };
    });
    hmiRef.current = createHmi(rootRef.current, {
      layout: host.kind === "local" ? "kiosk" : "embedded",
      hostLabel: hostLabel(host.kind),
      sendCommand: run,
      logos: { remoteCommand: remoteCommandLogo, doover: dooverLogo },
      vsdPanel,
    });
    hmiRef.current.setVsdPanel(latest.current.vsdAccess);
    return () => {
      hmiRef.current?.destroy();
      hmiRef.current = null;
    };
  }, [host.kind]);

  useEffect(() => {
    hmiRef.current?.update(data, { connected });
  }, [data, connected]);

  useEffect(() => {
    hmiRef.current?.setVsdPanel(vsdAccess);
  }, [vsdAccess]);

  return <div ref={rootRef} />;
}

const SiaHmiWidget = (props: { uiElement?: UiRemoteComponent }) => (
  <RemoteComponentWrapper>
    <SiaHmiInner {...props} />
  </RemoteComponentWrapper>
);

export { SiaHmiInner };
export default SiaHmiWidget;
