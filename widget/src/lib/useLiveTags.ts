/**
 * Live-tag support for the cloud widget — the React side.
 *
 * Claims the tiles' tags in the device's `dv-ui-sub.live_tag_open` presence
 * bucket and pools the one-shot `tag_values` frames the device streams back.
 * See lib/liveTags.ts for the why and the pure helpers.
 *
 * Runs only against a doover-js cloud client (`isLiveCapableClient`). On the
 * device-agent local widget host the injected client fails that check and
 * the hook is a no-op, and must be: a claim from the kiosk would make the
 * apps stream to a cloud audience of nobody.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { useDooverClient } from "doover-js/react";

import {
  applyLiveValues,
  collectOneShotValues,
  isLiveCapableClient,
  LIVE_CHANNEL,
  LIVE_FLUSH_MS,
  PRESENCE_CHANNEL,
  presenceClaimBody,
  presenceClearBody,
  presenceSlotKey,
  RESTAMP_MS,
  type LiveCapableClient,
  type LiveValues,
  type OneShotEvent,
} from "./liveTags.ts";

const EMPTY: LiveValues = new Map();

function randomId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function tabHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

export interface UseLiveTagsOptions {
  agentId: string | undefined;
  /** Qualified `<app_key>.<tag_name>` ids to claim (see liveTagIds). */
  tagIds: readonly string[];
}

/**
 * Returns the live overlay: dotted tag paths → newest one-shot value, each
 * stamped with local arrival time so the caller can rank it against the
 * aggregate (overlayLiveValues). Empty on the local host or before the first
 * frame arrives.
 */
export function useLiveTags({ agentId, tagIds }: UseLiveTagsOptions): LiveValues {
  const client = useDooverClient();
  const active = isLiveCapableClient(client) && !!agentId && tagIds.length > 0;
  // One slot per mount. RemoteHost may remount the lazy component; each
  // instance clears its own slot on unmount, and the device ages out any that
  // a hard tab close leaves behind (120 s).
  const mountId = useMemo(randomId, []);
  const tagsKey = tagIds.join(" ");
  // The claim effect reads the tag list through a ref so a changed list
  // (peer keys arriving with deployment_config) re-stamps the SAME slot
  // rather than clearing it and re-claiming after a fresh user lookup — that
  // gap would stop the stream for a round-trip every time.
  const tagsRef = useRef(tagsKey);
  tagsRef.current = tagsKey;
  const stampRef = useRef<(() => void) | null>(null);
  const [liveValues, setLiveValues] = useState<LiveValues>(EMPTY);

  // Claim + heartbeat.
  useEffect(() => {
    if (!active || !isLiveCapableClient(client)) return;
    const cloud: LiveCapableClient = client;
    const id = { agentId: agentId as string, channelName: PRESENCE_CHANNEL };
    let slotKey: string | null = null;
    let cancelled = false;
    let lookingUpUser = false;
    // The heartbeat NEVER stops on failure: a permission problem costs one
    // small rejected PATCH per tick, whereas latching off would turn a
    // 2-minute network blip into 15-minute-old readings for the rest of the
    // session. Failures only gate the console noise — one warning per
    // outage, silenced again by the next success.
    let warned = false;
    let lastStampAt = 0;

    const failed = (what: string, error: unknown) => {
      if (warned || cancelled) return;
      warned = true;
      console.warn(`sia-hmi: ${what}; live readings pause until it recovers`, error);
    };

    // An offline-cache-wrapped client can throw synchronously; fold that
    // into the rejection path so a tick never escapes into setInterval.
    const call = <T,>(fn: () => Promise<T>): Promise<T> => {
      try {
        return Promise.resolve(fn());
      } catch (error) {
        return Promise.reject(error);
      }
    };

    const stamp = () => {
      if (cancelled || tabHidden()) return;
      if (!slotKey) {
        // The user id is resolved lazily and retried on every tick, so a
        // transient /users/me failure costs one cycle, not the session.
        if (lookingUpUser) return;
        lookingUpUser = true;
        call(() => cloud.users.getMe())
          .then((me) => {
            lookingUpUser = false;
            if (cancelled || !me?.id) return;
            slotKey = presenceSlotKey(me.id, mountId);
            stamp();
          })
          .catch((error: unknown) => {
            lookingUpUser = false;
            failed("cannot resolve the current user for the live-tag claim", error);
          });
        return;
      }
      lastStampAt = Date.now();
      const tags = tagsRef.current.split(" ");
      const key = slotKey;
      call(() => cloud.aggregates.patchAggregate(id, presenceClaimBody(key, tags, Date.now())))
        .then(() => {
          warned = false;
        })
        .catch((error: unknown) => {
          failed("live-tag presence stamp failed (no write access on this device?)", error);
        });
    };
    stampRef.current = stamp;

    const onVisibility = () => {
      // Coming back from a hidden tab the previous stamp may have aged out;
      // re-stamp at once unless one went out moments ago (alt-tab churn).
      if (!tabHidden() && Date.now() - lastStampAt > RESTAMP_MS / 2) stamp();
    };

    const timer = setInterval(stamp, RESTAMP_MS);
    document.addEventListener("visibilitychange", onVisibility);
    stamp();

    return () => {
      cancelled = true;
      stampRef.current = null;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      if (slotKey) {
        const key = slotKey;
        call(() => cloud.aggregates.patchAggregate(id, presenceClearBody(key))).catch(() => {
          // Best effort; the device drops the claim itself after 120 s.
        });
      }
    };
  }, [active, agentId, client, mountId]);

  // A changed tag list re-stamps the existing slot (a claim replaces the
  // whole slot value, so no clear is needed). Skipped on the run that
  // follows the claim effect's own first stamp, so mount is one PATCH.
  const stampedTagsKey = useRef(tagsKey);
  useEffect(() => {
    if (stampedTagsKey.current === tagsKey) return;
    stampedTagsKey.current = tagsKey;
    stampRef.current?.();
  }, [tagsKey]);

  // One-shot listener. Frames are NOT delivered through the channel
  // subscription callbacks — they arrive as a separate gateway event; the
  // widget's existing tag_values subscription is what makes the gateway
  // forward them. Pooled for LIVE_FLUSH_MS so a burst is one render.
  useEffect(() => {
    if (!active || !isLiveCapableClient(client)) return;
    let pending: ReturnType<typeof collectOneShotValues> = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      const batch = pending;
      pending = [];
      if (batch.length > 0) setLiveValues((prev) => applyLiveValues(prev, batch));
    };
    const onOneShot = (event: OneShotEvent) => {
      if (event?.channel?.agent_id !== agentId || event.channel.name !== LIVE_CHANNEL) return;
      const entries = collectOneShotValues(event.data, Date.now());
      if (entries.length === 0) return;
      pending.push(...entries);
      if (flushTimer == null) flushTimer = setTimeout(flush, LIVE_FLUSH_MS);
    };
    client.gateway.on("oneShotMessage", onOneShot);
    return () => {
      client.gateway.off("oneShotMessage", onOneShot);
      if (flushTimer != null) clearTimeout(flushTimer);
      setLiveValues(EMPTY);
    };
  }, [active, agentId, client]);

  return liveValues;
}
