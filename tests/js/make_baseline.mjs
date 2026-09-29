// Regenerate legacy_render.json from the PRE-feature template + script:
//   git show <ref>:src/sia_local_control_ui/templates/dashboard.html > /tmp/b/dashboard.html
//   git show <ref>:src/sia_local_control_ui/static/js/dashboard.js > /tmp/b/dashboard.js
//   node tests/js/make_baseline.mjs /tmp/b
// The committed snapshot was made from main @ 7b0cc45 (before the
// control-mode / VSD features) and must not be regenerated from newer code.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadDashboard, snapshot } from "./harness.mjs";
import { LEGACY_PAYLOADS } from "./payloads.mjs";

const dir = process.argv[2];
const out = {};
for (const [name, payload] of Object.entries(LEGACY_PAYLOADS)) {
  const { root, socket } = loadDashboard(
    path.join(dir, "dashboard.html"),
    path.join(dir, "dashboard.js")
  );
  socket.fire("data_update", payload);
  out[name] = { tree: snapshot(root), emits: socket.emits };
}
const here = path.dirname(fileURLToPath(import.meta.url));
fs.writeFileSync(
  path.join(here, "legacy_render.json"),
  JSON.stringify(out, null, 1) + "\n"
);
