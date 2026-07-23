# SIA Local Control UI

A channel-native Doover HMI widget plus the device-local physical
operator-panel adapter for Solar Injection Australia chemical injection skids.

This branch publishes as the separate Doover application
`sia_local_control` using the container image
`ghcr.io/getdoover/sia-local-control-ui:widgets`; it does not update the legacy
`sia_local_control_ui` application record.

## Architecture

The HMI is a Module Federation remote component in `widget/`. It reads the
agent's standard Doover channels directly through `doover-js`:

- `tag_values`: controller state, target/flow/total, faults and warnings,
  optional skid sensors, solar data, tank data, and selector state.
- `deployment_config`: controller and sensor app keys, configurable tag names,
  feature gates, and display units.

There is no Flask server, Socket.IO bridge, bespoke REST endpoint, or mirrored
dashboard payload. The widget shares the host application's existing Doover
gateway connection, like the `tag_values_widget` reference implementation.

The Python container remains because browser code cannot safely access device
pins. Its responsibilities are limited to:

- converting physical Start/Stop/Flow Up/Flow Down button pulses into the
  pump controller's existing `ui_cmds` RPC surface;
- driving RUN/TRIP lamps from controller tags;
- reading the optional analog selector and publishing `SelectorState` into
  this app's `tag_values` block.

## Compatibility

The widget preserves the previous dashboard's pump state, target/flow/total,
min/max range, link indication, fault and warning banners, configurable units,
optional skid flow/pressure, aggregated solar figures, tank figures, and
selector card. The existing physical button and lamp behavior is unchanged.

The previous touchscreen was display-only, so the widget intentionally does
not add on-screen pump commands. Physical commands continue to receive the
controller RPC acknowledgement/error behavior.

## Development

Python checks:

```bash
uv run pytest
```

Widget checks and build:

```bash
npm --prefix widget install
npm --prefix widget test
npm --prefix widget run typecheck
npm --prefix widget run build
```

The deployable widget is generated at `widget/assets/SiaHmiWidget.js`.
