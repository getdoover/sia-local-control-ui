# SIA HMI widget

This Module Federation remote replaces the local Flask/Socket.IO dashboard.
It follows the same device-local widget pattern as `tag_values_widget`:

- `tag_values` supplies pump, sensor, solar, tank, and selector values.
- `deployment_config` supplies app references, tag-name overrides, units, and
  feature gates.
- `uiElement.app_key` identifies this install's configuration/tag block.
- `RemoteComponentWrapper` shares the host's Doover client, gateway socket,
  React, and query cache.

The Python application is no longer in the browser data path. It remains only
for physical pushbuttons, RUN/TRIP lamps, and the analog selector. The selector
is published as this app's `SelectorState` tag because browsers cannot access
device pins.

## Commands

```bash
npm install
npm test
npm run typecheck
npm run build
```

The build produces the single deployable asset
`assets/SiaHmiWidget.js`. Scope/module values must stay aligned with
`SiaLocalControlUiUI` in `src/sia_local_control_ui/app_ui.py`.
