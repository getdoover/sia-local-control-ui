/**
 * Render cadence: hand the render core at most one update per RENDER_CADENCE_MS.
 *
 * Why this exists: on the Doovit the panel is composited in software (no GPU
 * for WebKitGTK), so every painted frame costs the kiosk tens of milliseconds
 * of CPU across the web process and the compositor, whatever changed. The
 * device streams a `tag_values` event every time any app publishes — about
 * 6–7 a second with the pump running, each moving a different reading (total,
 * pressure, tank, drive) — and rendering each one as it arrives made 10+
 * frames a second out of readings the controller only refreshes about once
 * a second. Measured on the CM4 this was ~60% of a core across the two kiosk
 * processes. Four frames a second balances responsiveness and paint cost.
 *
 * Rules:
 *   - Leading edge: a change that arrives after a quiet spell renders at once.
 *   - Within the cadence window the newest payload waits for the window to
 *     close, then renders (older ones are dropped: the payload is a complete
 *     snapshot, so nothing is lost).
 *   - A change of connection state renders immediately: "Disconnected" must
 *     not sit behind a timer, and neither must the buttons re-enabling.
 *
 * Hook-free and clock-injected so it is unit-tested with fake time
 * (tests/renderCadence.test.mjs).
 */

export const RENDER_CADENCE_MS = 250;

export interface RenderStatus {
  connected: boolean;
}

export interface RenderScheduler<T> {
  /** Offer the newest payload; renders now or when the window closes. */
  push(data: T, status: RenderStatus): void;
  /** Drop anything pending and stop the timer (unmount). */
  dispose(): void;
}

export interface RenderSchedulerOptions<T> {
  render: (data: T, status: RenderStatus) => void;
  cadenceMs?: number;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export function createRenderScheduler<T>(opts: RenderSchedulerOptions<T>): RenderScheduler<T> {
  const cadenceMs = opts.cadenceMs ?? RENDER_CADENCE_MS;
  const now = opts.now ?? (() => Date.now());
  const schedule = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let lastAt = -Infinity;
  let lastConnected: boolean | null = null;
  let pending: { data: T; status: RenderStatus } | null = null;
  let timer: unknown = null;

  const flush = () => {
    timer = null;
    const next = pending;
    pending = null;
    if (!next) return;
    lastAt = now();
    lastConnected = next.status.connected;
    opts.render(next.data, next.status);
  };

  return {
    push(data, status) {
      pending = { data, status };
      const connectionChanged = lastConnected !== null && status.connected !== lastConnected;
      const wait = lastAt + cadenceMs - now();
      if (connectionChanged || wait <= 0) {
        if (timer != null) cancel(timer);
        flush();
      } else if (timer == null) {
        timer = schedule(flush, wait);
      }
    },
    dispose() {
      if (timer != null) cancel(timer);
      timer = null;
      pending = null;
    },
  };
}
