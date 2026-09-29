/**
 * Live-tag support for the cloud widget, the pure part. Ported from
 * petronash-hmi (widget/src/lib/liveTags.ts), minus its tank-volume model.
 *
 * Why this exists: the controller and sensor apps only publish their
 * `tag_values` aggregate to the cloud every 15 minutes unless *their own*
 * card is expanded on the device page (pydoover's presence-gated
 * `max_age_secs`). Expanding the SIA HMI card claims nothing on the peer apps'
 * behalf, so in the cloud the cards would render 15-minute-old readings.
 *
 * pydoover has a second, ephemeral path for exactly this: tags declared
 * `live=True` are re-sent every main-loop iteration as a one-shot message on
 * `tag_values` while some browser has claimed `"<app_key>.<tag_name>"` in the
 * device's `dv-ui-sub.live_tag_open` presence bucket. One-shots are never
 * persisted — no aggregate write, no message row, no alarm evaluation — so the
 * cloud copy keeps its 15-minute cadence while this widget sees fresh values.
 *
 * The React side (useLiveTags.ts) claims and listens; everything here is
 * hook-free and unit-tested (tests/liveTags.test.mjs).
 */

type JsonRecord = Record<string, unknown>;

/** Presence channel and bucket pydoover reads (`pydoover/tags/manager.py`). */
export const PRESENCE_CHANNEL = "dv-ui-sub";
export const PRESENCE_BUCKET = "live_tag_open";
/** The channel `flush_live_tags` publishes one-shots on (LIVE_TAG_CHANNEL_NAME). */
export const LIVE_CHANNEL = "tag_values";

/**
 * Re-stamp period for our claim. The device treats a stamp as gone at
 * exactly 120 s (`UI_SUB_FRESH_MS`); the customer-site's own presence
 * heartbeat re-stamps at 120 s plus jitter and so lapses briefly every cycle.
 * 50 s keeps us well inside the window even with a slow PATCH.
 */
export const RESTAMP_MS = 50_000;

/** Batch window for folding one-shot frames into React state. */
export const LIVE_FLUSH_MS = 250;

/**
 * The slot our claim lives under. The customer-site keys its own slots as
 * `<userId>:<gateway session id>` and a patch replaces the whole slot value,
 * so sharing that key would clobber e.g. a plot's live mode in the same tab.
 * pydoover iterates the bucket's values and never parses keys, so any
 * per-mount-unique key is fine.
 */
export function presenceSlotKey(userId: string, mountId: string): string {
  return `${userId}:sia-hmi-${mountId}`;
}

/** PATCH body that (re-)stamps our claim. */
export function presenceClaimBody(
  slotKey: string,
  tags: readonly string[],
  ts: number,
): JsonRecord {
  return { [PRESENCE_BUCKET]: { [slotKey]: { ts, tags: [...tags] } } };
}

/** PATCH body that drops our claim (null deletes the key on merge). */
export function presenceClearBody(slotKey: string): JsonRecord {
  return { [PRESENCE_BUCKET]: { [slotKey]: null } };
}

export interface LiveValue {
  value: unknown;
  /** Local clock time the one-shot arrived, for ordering against the aggregate. */
  at: number;
}

export type LiveValues = ReadonlyMap<string, LiveValue>;

function isPlainObject(value: unknown): value is JsonRecord {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Flatten a one-shot payload — the same nested `{ app_key: { tag: value } }`
 * shape as the aggregate — into dotted-path leaves stamped with arrival time.
 * Anything that is not a plain object yields nothing.
 */
export function collectOneShotValues(
  data: unknown,
  at: number,
  prefix: string[] = [],
): [string, LiveValue][] {
  if (!isPlainObject(data)) return [];
  const out: [string, LiveValue][] = [];
  for (const [key, value] of Object.entries(data)) {
    const path = [...prefix, key];
    if (isPlainObject(value)) {
      out.push(...collectOneShotValues(value, at, path));
    } else {
      out.push([path.join("."), { value, at }]);
    }
  }
  return out;
}

/** Fold a batch of one-shot leaves into the overlay, newest winning. */
export function applyLiveValues(
  prev: LiveValues,
  entries: readonly [string, LiveValue][],
): Map<string, LiveValue> {
  const next = new Map(prev);
  for (const [path, live] of entries) {
    const existing = next.get(path);
    if (!existing || live.at >= existing.at) next.set(path, live);
  }
  return next;
}

export interface OverlayResult {
  /** `tag_values` with live values written over the aggregate snapshot. */
  tagValues: JsonRecord | undefined;
  /** Arrival time of the newest live value applied, or null if none applied. */
  liveAt: number | null;
  /** Dotted paths that were actually written over the aggregate. */
  applied: Set<string>;
}

/**
 * Write live values over the aggregate snapshot. A live value only overrides
 * while it is at least as new as the aggregate we hold (`aggregateAt` is the
 * local time that aggregate object arrived): once streaming stops — claim
 * lapsed, app restarted, uplink down — the next 15-minute flush must win over
 * a frozen live value. Never mutates the input.
 */
export function overlayLiveValues(
  tagValues: JsonRecord | undefined,
  live: LiveValues,
  aggregateAt: number,
): OverlayResult {
  let out: JsonRecord | undefined;
  let liveAt: number | null = null;
  const applied = new Set<string>();
  for (const [path, entry] of live) {
    if (entry.at < aggregateAt) continue;
    const segments = path.split(".");
    if (segments.length < 2) continue;
    out ??= { ...(tagValues ?? {}) };
    let cursor: JsonRecord = out;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      const existing = cursor[seg];
      const copy: JsonRecord = isPlainObject(existing) ? { ...existing } : {};
      cursor[seg] = copy;
      cursor = copy;
    }
    cursor[segments[segments.length - 1]] = entry.value;
    applied.add(path);
    liveAt = liveAt === null ? entry.at : Math.max(liveAt, entry.at);
  }
  return { tagValues: out ?? tagValues, liveAt, applied };
}

/**
 * Feature-detect a doover-js cloud client. The device-agent local widget
 * host (the on-skid kiosk) injects its own `DdaDataClient` — `clientId`
 * "local-dda-http", a gateway with no event emitter or session, and stub
 * `users` — so there every live-tag step is skipped: the kiosk already
 * renders at loop rate from local state and cannot receive one-shots anyway.
 * (The local host DOES supply `uiElement.app_key`, so that is not a usable
 * signal.)
 */
export interface LiveCapableClient {
  clientId?: string;
  gateway: {
    on: (event: "oneShotMessage", listener: (event: OneShotEvent) => void) => unknown;
    off: (event: "oneShotMessage", listener: (event: OneShotEvent) => void) => unknown;
    getSession: () => unknown;
  };
  users: { getMe: () => Promise<{ id: string }> };
  aggregates: {
    patchAggregate: (
      id: { agentId: string; channelName: string },
      body: JsonRecord,
    ) => Promise<unknown>;
  };
}

export interface OneShotEvent {
  channel: { agent_id: string; name: string };
  data: unknown;
}

export const LOCAL_HOST_CLIENT_ID = "local-dda-http";

export function isLiveCapableClient(client: unknown): client is LiveCapableClient {
  const c = client as Partial<LiveCapableClient> | null | undefined;
  return (
    c?.clientId !== LOCAL_HOST_CLIENT_ID &&
    typeof c?.gateway?.on === "function" &&
    typeof c?.gateway?.off === "function" &&
    typeof c?.gateway?.getSession === "function" &&
    typeof c?.users?.getMe === "function" &&
    typeof c?.aggregates?.patchAggregate === "function"
  );
}
