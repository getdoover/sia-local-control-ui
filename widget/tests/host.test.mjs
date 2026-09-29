// Host detection and the RPC actor: the piece that keeps control authority
// (controller REQ-007) intact. The HMI actor may only ever come from the
// device's local widget host.
import assert from "node:assert/strict";
import test from "node:test";

import { DooverClient, LocalAgentClient } from "doover-js";

import {
  detectHost,
  HMI_ACTOR_NAME,
  isHmiActorName,
  LOCAL_HOST_CLIENT_ID,
  resolveActor,
} from "../src/lib/host.ts";
import { DDA_CAPABILITIES, fakeClient } from "./helpers.mjs";

const ALL_CAPS = [...DDA_CAPABILITIES, "users.me", "alarms.read"];

// The controller's classifier (authority.py classify), for end-to-end checks.
const controllerSource = (actor) =>
  actor && typeof actor.name === "string" && ["hmi", "local hmi"].includes(actor.name.trim().toLowerCase())
    ? "hmi"
    : "cloud";

test("device agent widget host (DdaDataClient) is local", () => {
  const client = fakeClient({ clientId: LOCAL_HOST_CLIENT_ID, capabilities: DDA_CAPABILITIES });
  assert.deepEqual(detectHost(client), { kind: "local", reason: "dda-client" });
});

test("doover-js LocalAgentClient (local:<host>:<port>) is local", () => {
  const client = new LocalAgentClient({
    baseUrl: "http://127.0.0.1:49100",
    disableBrowserLifecycleHooks: true,
  });
  assert.deepEqual(detectHost(client), { kind: "local", reason: "local-source" });
});

test("a client reporting local-dda-http only through its status is local", () => {
  const client = { getStatus: () => ({ clientId: LOCAL_HOST_CLIENT_ID }) };
  assert.equal(detectHost(client).kind, "local");
});

test("a client with RPC but no user identity is local", () => {
  const client = fakeClient({ clientId: "renamed-dda", capabilities: DDA_CAPABILITIES });
  assert.deepEqual(detectHost(client), { kind: "local", reason: "no-user-identity" });
});

test("the real doover-js cloud DooverClient is cloud", () => {
  const client = new DooverClient({
    dataRestUrl: "https://data.doover.com/api",
    controlApiUrl: "https://api.doover.com",
    dataWssUrl: "wss://data.doover.com/ws",
    token: "t",
    disableBrowserLifecycleHooks: true,
  });
  assert.deepEqual(detectHost(client), { kind: "cloud", reason: "cloud-client" });
});

test("fails safe: unknown, empty or throwing clients are cloud", () => {
  assert.equal(detectHost(undefined).kind, "cloud");
  assert.equal(detectHost(null).kind, "cloud");
  assert.equal(detectHost({}).kind, "cloud");
  assert.equal(detectHost({ clientId: "multiplex" }).kind, "cloud");
  assert.equal(
    detectHost({
      supports: () => {
        throw new Error("nope");
      },
    }).kind,
    "cloud",
  );
  assert.equal(
    detectHost({
      getStatus: () => {
        throw new Error("nope");
      },
    }).kind,
    "cloud",
  );
  assert.equal(detectHost(fakeClient({ capabilities: ALL_CAPS })).kind, "cloud");
});

test("the URL is not a signal: a cloud client on a /widget/ page is still cloud", () => {
  // Nothing in detectHost reads location; the client decides.
  const client = fakeClient({ clientId: "cloud", capabilities: ALL_CAPS });
  assert.equal(detectHost(client).kind, "cloud");
});

test("local actor is exactly {name: 'Local HMI'} and the controller classes it hmi", () => {
  const actor = resolveActor("local", { id: "1", name: "Someone", email: "a@b.c" });
  assert.deepEqual(actor, { name: HMI_ACTOR_NAME });
  assert.equal(controllerSource(actor), "hmi");
});

test("cloud actor is the signed-in user and the controller classes it cloud", () => {
  const actor = resolveActor("cloud", { id: "42", name: "Jane Operator", email: "jane@example.com" });
  assert.deepEqual(actor, { id: "42", name: "Jane Operator", email: "jane@example.com" });
  assert.equal(controllerSource(actor), "cloud");
});

test("cloud with no known user sends no actor (still classed cloud)", () => {
  assert.equal(resolveActor("cloud", null), undefined);
  assert.equal(resolveActor("cloud", {}), undefined);
  assert.equal(controllerSource(undefined), "cloud");
});

test("a cloud user named 'HMI' or 'Local HMI' cannot pose as the panel", () => {
  for (const name of ["HMI", "hmi", "Local HMI", " local hmi "]) {
    const actor = resolveActor("cloud", { id: "7", name });
    assert.ok(!isHmiActorName(actor.name), name);
    assert.equal(controllerSource(actor), "cloud", name);
  }
});

test("cloud user without a name falls back to email, then id", () => {
  assert.equal(resolveActor("cloud", { id: "9", email: "x@y.z" }).name, "x@y.z");
  assert.equal(resolveActor("cloud", { id: 9 }).name, "9");
});
