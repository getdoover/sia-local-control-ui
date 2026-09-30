/** Poll local snapshots without occupying long-lived browser connections.
 * The kiosk's browser can exhaust its per-origin connection pool with streams,
 * leaving subsequent command POSTs queued. Cloud hosts retain their gateway.
 */
export interface LocalAggregate {
  data?: Record<string, unknown>;
  last_updated?: number;
}
export interface LocalSnapshot {
  deploymentConfig: LocalAggregate;
  tagValues: LocalAggregate;
  uiCmds: LocalAggregate;
}
export interface LocalReader {
  aggregates: {
    getAggregate(channel: { agentId: string; channelName: string }): Promise<LocalAggregate>;
  };
}

export function pollLocalDashboard(
  client: LocalReader,
  agentId: string,
  onSnapshot: (snapshot: LocalSnapshot) => void,
  onError: () => void,
  intervalMs = 1000,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function poll() {
    try {
      const [deploymentConfig, tagValues, uiCmds] = await Promise.all(
        ["deployment_config", "tag_values", "ui_cmds"].map((channelName) =>
          client.aggregates.getAggregate({ agentId, channelName }),
        ),
      );
      if (!stopped) onSnapshot({ deploymentConfig, tagValues, uiCmds });
    } catch {
      if (!stopped) onError();
    } finally {
      if (!stopped) timer = setTimeout(poll, intervalMs);
    }
  }
  void poll();
  return () => { stopped = true; clearTimeout(timer); };
}
