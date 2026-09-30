// Refresh button: a full page reload from the kiosk header, the one sure
// recovery for a wedged kiosk browser (WebKit TextDecoder 2 GiB bug). Local
// host only; in the cloud it would reload the whole customer site. Layout
// (inside the header, top right, >= 44 px) is checked by
// layout/layout.check.mjs.
import assert from "node:assert/strict";
import test from "node:test";

import { RELOAD_CONFIRM_TEXT } from "../src/core/hmi-core.js";
import { detectHost, LOCAL_HOST_CLIENT_ID, showsReloadButton } from "../src/lib/host.ts";
import { DDA_CAPABILITIES, fakeClient, flush, isHidden, LEGACY_PAYLOADS, mountHmi, touchPayload } from "./helpers.mjs";

const localClient = () => fakeClient({ clientId: LOCAL_HOST_CLIENT_ID, capabilities: DDA_CAPABILITIES });
const cloudClient = () =>
  fakeClient({ capabilities: [...DDA_CAPABILITIES, "users.me"], withUser: { name: "Operator" } });

/** Mount as the shell does for this client's host, recording reloads. */
function mountFor(client, payload = touchPayload()) {
  const kind = detectHost(client).kind;
  const reloads = [];
  const m = mountHmi({
    layout: kind === "local" ? "kiosk" : "embedded",
    reloadButton: showsReloadButton(kind),
    reloadPage: () => reloads.push(Date.now()),
  });
  m.render(payload);
  return { ...m, reloads };
}

test("host gating: the Refresh button is for the local host only", () => {
  assert.equal(showsReloadButton("local"), true);
  assert.equal(showsReloadButton("cloud"), false);
});

test("shown on the local host, in the header, labelled Refresh", () => {
  const m = mountFor(localClient());
  const btn = m.byId("reload-btn");
  assert.ok(btn, "reload button rendered");
  assert.ok(!isHidden(btn));
  assert.equal(btn.getAttribute("aria-label"), "Refresh");
  assert.ok(btn.classList.contains("icon-btn"));
  assert.ok(btn.querySelector("svg"), "inline icon");
  assert.equal(btn.closest("header"), m.root.querySelector(".dashboard-header"));
  // Right of the connection status block.
  const info = m.root.querySelector(".header-info");
  assert.equal(info.nextElementSibling, btn);
});

test("absent in the cloud (and by default)", () => {
  const cloud = mountFor(cloudClient());
  assert.equal(cloud.byId("reload-btn"), null);
  assert.ok(!cloud.root.querySelector(".dashboard-header").classList.contains("has-reload"));
  const plain = mountHmi();
  assert.equal(plain.byId("reload-btn"), null);
});

test("tap asks first; Confirm reloads the page", async () => {
  const m = mountFor(localClient());
  m.click("reload-btn");
  assert.ok(!isHidden(m.byId("confirm")), "confirmation shown");
  assert.equal(m.byId("confirm-message").textContent, RELOAD_CONFIRM_TEXT);
  assert.equal(RELOAD_CONFIRM_TEXT, "Reload the screen? Live data returns in a few seconds.");
  assert.equal(m.reloads.length, 0, "no reload before confirming");
  m.click("confirm-ok");
  await flush();
  assert.equal(m.reloads.length, 1);
  assert.ok(isHidden(m.byId("confirm")));
  assert.equal(m.state.sent.length, 0, "no controller command");
});

test("Cancel does not reload", async () => {
  const m = mountFor(localClient());
  m.click("reload-btn");
  m.click("confirm-cancel");
  await flush();
  assert.equal(m.reloads.length, 0);
  assert.ok(isHidden(m.byId("confirm")));
});

test("works in Read Only mode (not a control command)", async () => {
  const m = mountFor(localClient(), LEGACY_PAYLOADS.running);
  assert.ok(!isHidden(m.byId("reload-btn")));
  m.click("reload-btn");
  // A read-only update does not close it (only touch confirmations close).
  m.render({ ...LEGACY_PAYLOADS.running, timestamp: "2026-09-28T01:02:09+00:00" });
  assert.ok(!isHidden(m.byId("confirm")));
  m.click("confirm-ok");
  await flush();
  assert.equal(m.reloads.length, 1);
  assert.equal(m.state.sent.length, 0);
});

test("default reload is window.location.reload()", () => {
  const m = mountHmi({ reloadButton: true });
  let called = 0;
  // jsdom's Location is unforgeable; stand in a window whose reload we see.
  Object.defineProperty(m.document, "defaultView", {
    configurable: true,
    value: { location: { reload: () => called++ } },
  });
  m.click("reload-btn");
  m.click("confirm-ok");
  assert.equal(called, 1);
});
