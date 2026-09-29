// Touchscreen render tests: run with `node --test tests/js` (or via pytest,
// tests/test_dashboard_js.py). No npm dependencies.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isHidden, loadDashboard, snapshot } from "./harness.mjs";
import { LEGACY_PAYLOADS, NEW_ONLY_IDS } from "./payloads.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, "..", "..", "src", "sia_local_control_ui");
const HTML = path.join(pkg, "templates", "dashboard.html");
const JS = path.join(pkg, "static", "js", "dashboard.js");
const BASELINE = JSON.parse(
  fs.readFileSync(path.join(here, "legacy_render.json"), "utf8")
);

const load = () => loadDashboard(HTML, JS);
const byId = (d, id) => d.document.getElementById(id);

// --- backward compatibility -------------------------------------------------

for (const [name, payload] of Object.entries(LEGACY_PAYLOADS)) {
  test(`legacy payload "${name}" renders exactly as before`, () => {
    const d = load();
    d.socket.fire("data_update", payload);
    // Every pre-existing element: same classes, text and bar widths.
    assert.deepEqual(snapshot(d.root, NEW_ONLY_IDS), BASELINE[name].tree);
    // Every new element stays hidden.
    for (const id of NEW_ONLY_IDS) {
      assert.ok(isHidden(byId(d, id)), `${id} should be hidden`);
    }
    // And the screen sends nothing to the controller.
    assert.deepEqual(d.socket.emits, BASELINE[name].emits);
  });
}

// --- new features ----------------------------------------------------------

const TOUCH = {
  calibration_factor: 1.0,
  calibration_min: 0.3,
  calibration_max: 1.7,
};

const withFeatures = (over = {}) => ({
  ...LEGACY_PAYLOADS.running,
  touch: TOUCH,
  vsd: {
    tripped: false,
    trip_code: null,
    trip_description: null,
    motor_hz: 42.5,
    pump_rpm: 61,
  },
  ...over,
});

test("no control mode switch: control priority is fixed by the controller", () => {
  const d = load();
  // Even if a payload carried a stray `control` key, nothing renders or sends.
  d.socket.fire("data_update", withFeatures({ control: { mode: "dcs" } }));
  assert.equal(byId(d, "mode-section"), null);
  assert.equal(d.document.querySelector(".mode-btn"), null);
  for (const b of d.document.querySelectorAll("button")) b.click();
  const sent = d.socket.emits
    .filter(([e]) => e === "command")
    .map(([, p]) => p.cmd);
  assert.ok(!sent.includes("set_control_mode"));
  assert.ok(
    !/set_control_mode|mode-switch/.test(fs.readFileSync(JS, "utf8") + fs.readFileSync(HTML, "utf8"))
  );
});

test("VSD card, drive line and trip description", () => {
  const d = load();
  d.socket.fire(
    "data_update",
    withFeatures({
      vsd: {
        tripped: true,
        trip_code: 3,
        trip_description: "Over current",
        motor_hz: 0,
        pump_rpm: 0,
      },
    })
  );
  assert.ok(!isHidden(byId(d, "vsd-section")));
  assert.ok(!isHidden(byId(d, "pump-drive-line")));
  assert.equal(byId(d, "vsd-trip").textContent, "Over current (code 3)");
  assert.equal(
    d.document.querySelector("#vsd-status .state-value").textContent,
    "Tripped"
  );
  assert.equal(byId(d, "motor-hz").textContent, "0.0");
});

test("Reset Fault appears once: VSD card has only Reset VSD, bar has Reset Fault", () => {
  const d = load();
  d.socket.fire("data_update", withFeatures());
  const inCard = d.document
    .querySelectorAll(".vsd-actions button")
    .map((b) => b.id);
  assert.deepEqual(inCard, ["reset-vsd-btn"]);
  // Exactly one button in the page is labelled Reset Fault: the touch bar's.
  const buttons = fs
    .readFileSync(HTML, "utf8")
    .match(/<button[^>]*>[\s\S]*?<\/button>/g);
  const resetFaults = buttons.filter((b) => /Reset\s+Fault/.test(b.replace(/<[^>]+>/g, " ")));
  assert.equal(resetFaults.length, 1);
  assert.match(resetFaults[0], /id="touch-reset"/);
  byId(d, "reset-vsd-btn").click();
  byId(d, "touch-reset").click();
  const commands = d.socket.emits.filter(([e]) => e === "command");
  assert.deepEqual(commands, [
    ["command", { cmd: "reset_vsd_fault", value: null }],
    ["command", { cmd: "reset_fault", value: null }],
  ]);
});

test("read only with a VSD shows no Reset Fault or Reset VSD button", () => {
  const d = load();
  d.socket.fire("data_update", withFeatures({ touch: undefined }));
  // .vsd-actions is hidden by CSS in read only (class on the row); the touch
  // bar holding Reset Fault is hidden outright.
  assert.ok(byId(d, "vsd-section").classList.contains("readonly"));
  assert.ok(isHidden(byId(d, "touch-reset")));
});

test("solar card hidden when no solar controllers are configured", () => {
  const d = load();
  d.socket.fire("data_update", LEGACY_PAYLOADS.running); // backend sends no `solar`
  assert.ok(isHidden(byId(d, "solar-section")));
  d.socket.fire("data_update", LEGACY_PAYLOADS.warning_with_peripherals);
  assert.ok(!isHidden(byId(d, "solar-section")));
});

test("denied command shows the operator message", () => {
  const d = load();
  d.socket.fire("data_update", withFeatures());
  d.socket.ackReply = {
    ok: false,
    code: "UNAVAILABLE",
    message: "VSD reset unavailable: no VSD is configured on this controller",
  };
  byId(d, "reset-vsd-btn").click();
  const toast = byId(d, "command-toast");
  assert.ok(!isHidden(toast));
  assert.ok(toast.classList.contains("error"));
  assert.equal(
    toast.textContent,
    "VSD reset unavailable: no VSD is configured on this controller"
  );
});

test("physical-button notice is shown", () => {
  const d = load();
  d.socket.fire("notice", {
    message: "Command refused by the pump controller: hmi may not start the pump",
    level: "error",
  });
  assert.equal(
    byId(d, "command-toast").textContent,
    "Command refused by the pump controller: hmi may not start the pump"
  );
});

test("features disappear again when the backend stops sending them", () => {
  const d = load();
  d.socket.fire("data_update", withFeatures());
  d.socket.fire("data_update", LEGACY_PAYLOADS.running);
  for (const id of NEW_ONLY_IDS) assert.ok(isHidden(byId(d, id)));
});

// --- HMI Control Mode ------------------------------------------------------

const commands = (d) =>
  d.socket.emits.filter(([e]) => e === "command").map(([, p]) => p);
const touchPayload = (over = {}) => ({
  ...LEGACY_PAYLOADS.running,
  touch: TOUCH,
  ...over,
});
const typeKeys = (d, keys) => {
  for (const k of keys) {
    d.document
      .querySelectorAll(".keypad-keys .key")
      .find((b) => b.getAttribute("data-key") === k)
      .click();
  }
};

test("read only: status cards show but no on-screen control sends anything", () => {
  const d = load();
  d.socket.fire("data_update", withFeatures({ touch: undefined }));
  assert.ok(isHidden(byId(d, "touch-bar")));
  assert.ok(byId(d, "vsd-section").classList.contains("readonly"));
  assert.ok(!isHidden(byId(d, "vsd-section")));
  for (const id of ["reset-vsd-btn", "touch-reset", "touch-start", "touch-stop"]) {
    byId(d, id).click();
  }
  assert.deepEqual(commands(d), []);
  // footer logo untouched in read only
  assert.ok(!isHidden(d.document.querySelector(".footer-logo")));
});

test("touch: bar renders with target, units and calibration factor", () => {
  const d = load();
  d.socket.fire("data_update", touchPayload());
  assert.ok(!isHidden(byId(d, "touch-bar")));
  assert.equal(byId(d, "touch-rate-value").textContent, "12.50");
  assert.equal(byId(d, "touch-rate-unit").textContent, "L/Hr");
  assert.equal(byId(d, "touch-cal-value").textContent, "1.00");
  assert.equal(byId(d, "touch-start").disabled, false);
});

test("touch: start, stop, step and reset send the controller RPCs", () => {
  const d = load();
  d.socket.fire("data_update", touchPayload());
  for (const id of ["touch-start", "touch-stop", "touch-rate-up", "touch-rate-down", "touch-reset"]) {
    byId(d, id).click();
  }
  assert.deepEqual(commands(d), [
    { cmd: "set_pump_state", value: "start" },
    { cmd: "set_pump_state", value: "stop" },
    { cmd: "nudge_rate", value: "+1" },
    { cmd: "nudge_rate", value: "-1" },
    { cmd: "reset_fault", value: null },
  ]);
});

test("touch: pending, success and error feedback on the control", () => {
  const d = load();
  d.socket.fire("data_update", touchPayload());
  d.socket.deferAcks = true;
  const start = byId(d, "touch-start");
  start.click();
  assert.ok(start.classList.contains("pending"));
  start.click(); // ignored while pending
  // Stop is still available while Start is pending.
  byId(d, "touch-stop").click();
  assert.deepEqual(commands(d).map((c) => c.value), ["start", "stop"]);
  d.socket.ackNext({
    ok: false,
    code: "REMOTE_DENIED",
    message: "Command refused by the pump controller: hmi may not start the pump",
  });
  assert.ok(start.classList.contains("error"));
  assert.equal(
    byId(d, "command-toast").textContent,
    "Command refused by the pump controller: hmi may not start the pump"
  );
  d.socket.ackNext({ ok: true });
  assert.ok(byId(d, "touch-stop").classList.contains("ok"));
});

test("touch: start disabled when faulted, with a hint; stop still enabled", () => {
  const d = load();
  d.socket.fire("data_update", {
    ...LEGACY_PAYLOADS.faulted,
    touch: TOUCH,
  });
  assert.equal(byId(d, "touch-start").disabled, true);
  assert.equal(byId(d, "touch-start-hint").textContent, "Reset fault first");
  assert.equal(byId(d, "touch-stop").disabled, false);
  byId(d, "touch-start").click();
  byId(d, "touch-stop").click();
  assert.deepEqual(commands(d), [{ cmd: "set_pump_state", value: "stop" }]);
});

test("touch: small keypad rate change is sent without confirmation", () => {
  const d = load();
  d.socket.fire("data_update", touchPayload());
  byId(d, "touch-rate").click();
  assert.ok(!isHidden(byId(d, "keypad")));
  assert.equal(byId(d, "keypad-range").textContent, "Range 2.00 to 92.16 L/Hr");
  typeKeys(d, ["1", "4"]);
  byId(d, "keypad-ok").click();
  assert.ok(isHidden(byId(d, "keypad")));
  assert.ok(isHidden(byId(d, "confirm")));
  assert.deepEqual(commands(d), [{ cmd: "set_target_rate", value: 14 }]);
});

test("touch: rate change over 20% asks first; cancel sends nothing", () => {
  const d = load();
  d.socket.fire("data_update", touchPayload());
  byId(d, "touch-rate").click();
  typeKeys(d, ["5", "0"]);
  byId(d, "keypad-ok").click();
  assert.ok(!isHidden(byId(d, "confirm")));
  assert.equal(
    byId(d, "confirm-message").textContent,
    "Change target rate from 12.50 to 50.00 L/Hr?"
  );
  byId(d, "confirm-cancel").click();
  assert.deepEqual(commands(d), []);

  byId(d, "touch-rate").click();
  typeKeys(d, ["5", "0"]);
  byId(d, "keypad-ok").click();
  byId(d, "confirm-ok").click();
  assert.deepEqual(commands(d), [{ cmd: "set_target_rate", value: 50 }]);
});

test("touch: out-of-range rate is rejected in the keypad", () => {
  const d = load();
  d.socket.fire("data_update", touchPayload());
  byId(d, "touch-rate").click();
  typeKeys(d, ["1", "0", "0"]);
  byId(d, "keypad-ok").click();
  assert.ok(!isHidden(byId(d, "keypad")));
  assert.match(byId(d, "keypad-error").textContent, /Out of range/);
  byId(d, "keypad-cancel").click();
  assert.ok(isHidden(byId(d, "keypad")));
  assert.deepEqual(commands(d), []);
});

test("touch: rate keypad unavailable until the controller publishes min/max", () => {
  const d = load();
  const pump = { ...LEGACY_PAYLOADS.running.pumps[0], min_rate: null, max_rate: null };
  d.socket.fire("data_update", touchPayload({ pumps: [pump] }));
  assert.equal(byId(d, "touch-rate").disabled, true);
});

test("touch: calibration factor always confirms and is range-checked", () => {
  const d = load();
  d.socket.fire("data_update", touchPayload());
  byId(d, "touch-cal").click();
  assert.equal(byId(d, "keypad-range").textContent, "Range 0.30 to 1.70");
  typeKeys(d, ["2"]);
  byId(d, "keypad-ok").click();
  assert.match(byId(d, "keypad-error").textContent, /Out of range/);
  typeKeys(d, ["clear", "1", ".", "0", "5"]);
  byId(d, "keypad-ok").click();
  assert.equal(
    byId(d, "confirm-message").textContent,
    "Change calibration factor from 1.00 to 1.05?"
  );
  byId(d, "confirm-ok").click();
  assert.deepEqual(commands(d), [
    { cmd: "last_calibration_factor", value: 1.05 },
  ]);
});

test("touch: VSD card keeps Reset VSD before Reset Fault when configured", () => {
  const d = load();
  d.socket.fire("data_update", withFeatures());
  assert.ok(!byId(d, "vsd-section").classList.contains("readonly"));
  byId(d, "reset-vsd-btn").click();
  assert.deepEqual(commands(d), [{ cmd: "reset_vsd_fault", value: null }]);
});

test("keypad input rules", () => {
  const { context } = load();
  const run = (keys) => keys.reduce((t, k) => context.keypadInput(t, k), "");
  assert.equal(run(["1", ".", "2", ".", "5"]), "1.25");
  assert.equal(run([".", "5"]), "0.5");
  assert.equal(run(["0", "7"]), "7");
  assert.equal(run(["1", "2", "back"]), "1");
  assert.equal(run(["1", "2", "clear"]), "");
  assert.equal(run(["9", "9", "9", "9", "9", "9", "9", "9", "9"]), "99999999");
});

test("keypad validation", () => {
  const { context } = load();
  const v = (t, min, max) =>
    JSON.parse(JSON.stringify(context.validateKeypadEntry(t, min, max)));
  assert.deepEqual(v("", 0.3, 1.7), { ok: false, error: "Enter a number" });
  assert.deepEqual(v(".", 0.3, 1.7), { ok: false, error: "Enter a number" });
  assert.deepEqual(v("0.2", 0.3, 1.7), {
    ok: false,
    error: "Out of range (0.3 to 1.7)",
  });
  assert.deepEqual(v("1.8", 0.3, 1.7).ok, false);
  assert.deepEqual(v("0.3", 0.3, 1.7), { ok: true, value: 0.3 });
  assert.deepEqual(v("1.7", 0.3, 1.7), { ok: true, value: 1.7 });
});

test("switching back to read only removes the touch bar", () => {
  const d = load();
  d.socket.fire("data_update", touchPayload());
  assert.ok(isHidden(d.document.querySelector(".footer-logo")));
  d.socket.fire("data_update", LEGACY_PAYLOADS.running);
  assert.ok(isHidden(byId(d, "touch-bar")));
  assert.ok(!isHidden(d.document.querySelector(".footer-logo")));
});

test("VSD card sits in the Tank row and scopes the compact layout", () => {
  const d = load();
  d.socket.fire("data_update", LEGACY_PAYLOADS.running);
  const container = d.document.querySelector(".dashboard-container");
  assert.ok(!container.classList.contains("has-vsd"));
  d.socket.fire("data_update", withFeatures());
  assert.ok(container.classList.contains("has-vsd"));
  assert.equal(byId(d, "vsd-section").parent, byId(d, "tank-section").parent);
  d.socket.fire("data_update", LEGACY_PAYLOADS.running);
  assert.ok(!container.classList.contains("has-vsd"));
  assert.ok(isHidden(byId(d, "vsd-section")));
});
