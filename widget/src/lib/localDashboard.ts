/** Poll local snapshots without occupying long-lived browser connections.
 * The kiosk's browser can exhaust its per-origin connection pool with streams,
 * leaving subsequent command POSTs queued. Cloud hosts retain their gateway.
 *
 * Volume matters here, not just frequency. Every string in every reply goes
 * through the one TextDecoder that protobuf-es keeps for the page, and
 * WebKitGTK 2.48 (the kiosk) counts the bytes it has ever decoded and throws
 * RangeError "Bad value" past 2 GiB (WebKit bug 280593, fixed in 2.50): from
 * then on every read fails and the panel shows Disconnected until the page
 * reloads. deployment_config is ~75 KB of that per read, against ~9 KB for
 * tag_values and ui_cmds together, and it changes only on a deploy, so it is
 * read on its own slower clock: every DEPLOYMENT_CONFIG_INTERVAL_MS rather
 * than every poll. That takes the kiosk from ~7 h to ~2.5 days between hits,
 * and the widget host rotating its decoder removes the limit altogether.
 */
export const DEPLOYMENT_CONFIG_INTERVAL_MS = 30_000;

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

/**
 * Why a read failed, for the console: the error's name, message and (when
 * it has one) its stack, so "Disconnected" on a panel can be traced from
 * the kiosk's log rather than guessed at.
 */
export function describeReadError(reason: unknown): { head: string; full: string } {
  if (reason instanceof Error) {
    const head = `${reason.name}: ${reason.message}`;
    const stack = typeof reason.stack === "string" ? reason.stack : "";
    return { head, full: stack.startsWith(head) || !stack ? stack || head : `${head}\n${stack}` };
  }
  let head: string;
  try {
    head = JSON.stringify(reason) ?? String(reason);
  } catch {
    head = String(reason);
  }
  return { head, full: head };
}

export function pollLocalDashboard(
  client: LocalReader,
  agentId: string,
  onSnapshot: (snapshot: LocalSnapshot) => void,
  onError: (reason?: unknown) => void,
  intervalMs = 1000,
  log: (message: string) => void = (message) => console.error(message),
  configIntervalMs = DEPLOYMENT_CONFIG_INTERVAL_MS,
  now: () => number = () => Date.now(),
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The last deployment_config read and when: reused (same object, so the
  // config resolves once) until it is configIntervalMs old or a read fails.
  let config: { aggregate: LocalAggregate; at: number } | null = null;
  // One line per change of failure, not one per second: the first failure,
  // every later failure that reads differently, and the recovery.
  let failing: string | null = null;
  let failures = 0;
  async function poll() {
    let channel = "";
    const read = (channelName: string) =>
      client.aggregates.getAggregate({ agentId, channelName }).catch((reason: unknown) => {
        channel = channel || channelName;
        throw reason;
      });
    try {
      const t = now();
      const fresh = config !== null && t - config.at < configIntervalMs;
      const [deploymentConfig, tagValues, uiCmds] = await Promise.all([
        fresh ? Promise.resolve(config!.aggregate) : read("deployment_config"),
        read("tag_values"),
        read("ui_cmds"),
      ]);
      if (stopped) return;
      if (!fresh) config = { aggregate: deploymentConfig, at: t };
      if (failing !== null) {
        log(`Local dashboard: reads recovered after ${failures} failed poll${failures === 1 ? "" : "s"}`);
        failing = null;
        failures = 0;
      }
      onSnapshot({ deploymentConfig, tagValues, uiCmds });
    } catch (reason) {
      if (stopped) return;
      failures += 1;
      const { head, full } = describeReadError(reason);
      const key = `${channel || "aggregate"}: ${head}`;
      if (key !== failing) {
        failing = key;
        log(`Local dashboard: read failed (poll ${failures}), showing Disconnected: ${channel || "aggregate"}: ${full}`);
      }
      config = null; // a failed cycle re-reads everything once reads work again
      onError(reason);
    } finally {
      if (!stopped) timer = setTimeout(poll, intervalMs);
    }
  }
  void poll();
  return () => { stopped = true; clearTimeout(timer); };
}
