/**
 * Which host the widget is running in, and the RPC actor that follows from it.
 *
 * The same bundle runs in two hosts:
 *
 *  - **local**: the device agent's widget host on the Doovit
 *    (`https://<doovit>:49100/widget/<channel>`, shown on the panel by the HMI
 *    Display Engine). It injects its own `DdaDataClient` whose RPCs go through
 *    the device's local broker, so the panel works with no uplink.
 *  - **cloud**: the Doover cloud UI, which injects a doover-js `DooverClient`.
 *
 * The controller's control authority (REQ-007) classifies a command by its RPC
 * actor: `{"name": "Local HMI"}` is the local HMI and is always allowed; any
 * other actor is the cloud and may start / change the rate only in `cloud`
 * mode. The widget must therefore send the HMI actor ONLY from the local
 * host. Getting this wrong in the cloud would bypass authority, so detection
 * fails safe: anything not positively identified as the local host is the
 * cloud.
 *
 * The signal is the injected data client, not the URL: a URL can be served
 * from anywhere and reveals nothing about which broker a command reaches,
 * whereas the client IS the path the command takes. Pure module, unit-tested
 * (tests/host.test.mjs).
 */

export type HostKind = "local" | "cloud";

/** `DdaDataClient.clientId` in dda-agent/widget/src/dda-client.ts. */
export const LOCAL_HOST_CLIENT_ID = "local-dda-http";

/** doover-js `LocalAgentClient` source ids look like `local:<host>:<port>`. */
const LOCAL_SOURCE_PREFIX = "local:";

/** The actor the controller recognises as the local HMI (authority.py). */
export const HMI_ACTOR_NAME = "Local HMI";

/** Every actor name the controller treats as the HMI, compared lower-case. */
export const HMI_ACTOR_NAMES: readonly string[] = ["hmi", "local hmi"];

export interface HostInfo {
  kind: HostKind;
  /** Which signal decided it, for the header badge and the tests. */
  reason:
    | "dda-client"
    | "local-source"
    | "no-user-identity"
    | "cloud-client"
    | "unknown-client";
}

interface ClientLike {
  clientId?: unknown;
  getStatus?: () => { clientId?: unknown } | undefined;
  supports?: (capability: string) => boolean;
}

function statusClientId(client: ClientLike): string | undefined {
  if (typeof client.getStatus !== "function") return undefined;
  try {
    const id = client.getStatus()?.clientId;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Identify the host from the data client it injected.
 *
 * 1. `clientId === "local-dda-http"`: the device agent's widget host.
 * 2. Its status reports that id, or a doover-js `LocalAgentClient` source
 *    (`local:<host>:<port>`): a device-local client.
 * 3. It advertises RPC but no user identity (`users.me`): only a device-local
 *    client lacks a signed-in user, the cloud client always has one.
 * 4. Otherwise: the cloud. This includes a client we cannot identify at all.
 */
export function detectHost(client: unknown): HostInfo {
  if (!client || typeof client !== "object") {
    return { kind: "cloud", reason: "unknown-client" };
  }
  const c = client as ClientLike;
  if (c.clientId === LOCAL_HOST_CLIENT_ID) {
    return { kind: "local", reason: "dda-client" };
  }
  const statusId = statusClientId(c);
  if (
    statusId === LOCAL_HOST_CLIENT_ID ||
    (typeof statusId === "string" && statusId.startsWith(LOCAL_SOURCE_PREFIX))
  ) {
    return { kind: "local", reason: "local-source" };
  }
  if (typeof c.supports === "function") {
    let rpc = false;
    let user = true;
    try {
      rpc = c.supports("rpc.send");
      user = c.supports("users.me");
    } catch {
      // A throwing capability check tells us nothing: stay on the safe side.
    }
    if (rpc && !user) return { kind: "local", reason: "no-user-identity" };
    return { kind: "cloud", reason: "cloud-client" };
  }
  return { kind: "cloud", reason: "unknown-client" };
}

export interface RpcActor {
  id?: string;
  name: string;
  email?: string;
}

export interface CloudUser {
  id?: unknown;
  name?: unknown;
  email?: unknown;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** True when the controller would classify this actor name as the HMI. */
export function isHmiActorName(name: unknown): boolean {
  return typeof name === "string" && HMI_ACTOR_NAMES.includes(name.trim().toLowerCase());
}

/**
 * The RPC actor for a command from this host.
 *
 * - local: `{name: "Local HMI"}`, exactly what the controller matches.
 * - cloud: the signed-in user (`{id, name, email}`) so the command is
 *   attributed in the cloud UI's history, or no actor at all when the user is
 *   unknown. A cloud user whose display name happens to be "HMI" or
 *   "Local HMI" is renamed, so a name can never promote a cloud command to
 *   the HMI's authority.
 */
export function resolveActor(
  host: HostKind,
  user?: CloudUser | null,
): RpcActor | undefined {
  if (host === "local") return { name: HMI_ACTOR_NAME };
  if (!user) return undefined;
  const id = text(user.id) ?? (typeof user.id === "number" ? String(user.id) : undefined);
  const email = text(user.email);
  let name = text(user.name) ?? email ?? id;
  if (!name) return undefined;
  if (isHmiActorName(name)) name = `${name} (cloud)`;
  return {
    ...(id ? { id } : {}),
    name,
    ...(email ? { email } : {}),
  };
}

/**
 * Whether the header shows the Refresh button (a full page reload, the
 * recovery for a wedged kiosk browser). The local kiosk only: in the cloud it
 * would reload the whole customer site. Fails safe like detectHost.
 */
export function showsReloadButton(host: HostKind): boolean {
  return host === "local";
}

/** Short label for the header badge. */
export function hostLabel(host: HostKind): string {
  return host === "local" ? "Local panel" : "Cloud";
}
