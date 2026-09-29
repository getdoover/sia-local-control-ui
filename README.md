# SIA Local Control UI (SIA HMI)

The single operator HMI app for SIA chemical injection skids. One Doover app,
`sia_local_control_ui`, that is a **device (DEV) container and also ships a widget**:

- **The widget is the HMI screen** (`widget/`, Module Federation remote `SiaHmiWidget`).
  The same bundle renders on the Doovit's panel, served by the device agent's local
  widget host and shown by the **HMI Display Engine**, and in the **Doover cloud UI**
  as this app's card. All screen logic lives here, and only here.
- **The container** (`src/sia_local_control_ui/`) keeps two jobs:
  1. **Physical pushbuttons and RUN/TRIP lamps**: active whenever configured (source not
     Disabled / pin set), in every `hmi_control_mode`.
  2. **The legacy Flask dashboard** on port 8091, behind `local_dashboard_enabled`
     (default **on**). It is **frozen**; see [Legacy dashboard](#legacy-dashboard-frozen).

With the dashboard off and no buttons or lamps configured, the container idles: no web
server, no tag reads, one loop pass a minute.

Widget sources were merged from the standalone `sia-hmi` app, which this app replaces.

## Which screen a site uses

| Site | Panel shows | `local_dashboard_enabled` | Kiosk app |
| --- | --- | --- | --- |
| Kuwait (J5246, existing) | legacy Flask dashboard, `http://localhost:8091` | `true` (default, key absent) | `doover-kiosk` pointed at :8091, unchanged |
| Tamboran (new) | the widget | `false` | HMI Display Engine (`hmi_engine`) |

A Kuwait redeploy is a zero-change deploy: existing configs have no
`local_dashboard_enabled` (defaults on) and no `hmi_control_mode` (defaults Read Only),
every existing key keeps its name and value (`tests/test_config_visibility.py` loads the
deployed Kuwait config fixture), the buttons keep their DI1/DI2/DI3/AI0 wiring and the
lamps DO3/DO4, and the dashboard on 8091 is byte-for-byte the same screen
(`tests/js` legacy snapshot). The only visible addition is the widget card in the cloud UI.

## HMI Control Mode (`hmi_control_mode`)

First in the config editor. Governs **on-screen** controls only, identically in the widget
and the legacy dashboard:

- `Read Only` (default): display only.
- `Touch`: a bottom touch bar with Start, STOP (always available), rate step down/up
  (`nudge_rate`), tap the rate for a keypad setpoint (`set_target_rate`, within
  MinRate..MaxRate), Reset Fault, and the calibration factor (`last_calibration_factor`,
  0.3 to 1.7). The VSD card's Reset VSD is live. Calibration changes and rate changes over
  20% ask for confirmation first.
- `Button`: behaves exactly like Read Only on screen, and **reveals the physical-button
  config fields** in the config editor.

The physical-button fields (`start_button`, `stop_button`, `flow_up_button`,
`flow_down_button`) are shown in the editor only in `Button` mode (a JSON-schema
`allOf`/`if`/`then` branch in `SiaLocalControlUiConfig.to_schema`). That is editor
visibility only: the buttons always run from their saved values in every mode, and a
button with no saved config loads as Disabled. The RUN/TRIP lamp pins are visible in every
mode; set them to empty for a skid without lamps.

**No control mode.** Control priority (local HMI > DCS > cloud, last command wins) is
fixed by the injection controller; there is no Local/DCS/Cloud switch, no setting, and
nothing sends `set_control_mode`. A refused command shows the controller's own reason.

## Local vs cloud, and the RPC actor

Every command is an RPC on the device's `ui_cmds` channel targeting the first
`pump_controllers` entry. The controller classifies it by actor, so only the local panel
may send `actor={"name": "Local HMI"}`:

- physical buttons and the legacy dashboard (both on the device): always `Local HMI`;
- the widget decides from the **injected data client**, not the URL
  (`widget/src/lib/host.ts`): the device agent's `DdaDataClient` (`local-dda-http`) or a
  device-local client means the panel (`Local HMI`); anything else, including an
  unrecognised client, is the cloud and sends the signed-in user (or no actor). A cloud user
  named "HMI" / "Local HMI" is renamed so it cannot pose as the panel.

## Configuration

One config block, read by the container and, straight out of `deployment_config`, by the
widget (the widget has no config of its own; `tests/test_widget_contract.py` checks every
key it reads exists here). Runtime keys derive from the display names.

| Key | Default | Used by | Meaning |
| --- | --- | --- | --- |
| `hmi_control_mode` | `Read Only` | both | Read Only / Touch / Button (see above) |
| `pump_controllers` | required | both | Controller installs; the first is shown and commanded |
| `state_tag` ... `warning_reason_tag` | contract names | both | Controller status tag names |
| `start_button` / `stop_button` / `flow_up_button` / `flow_down_button` | Disabled | container | Physical buttons (shown in Button mode) |
| `run_lamp_pin` / `trip_lamp_pin` | `3` / `4` | container | RUN / TRIP lamp outputs; empty = no lamp |
| `enable_pumpvalve_selector`, selector pins, `enable_valve_card` | off | legacy dashboard | Legacy two-pump skids |
| `solar_controllers` | `[]` | both | Solar card (averaged battery / panel figures) |
| `low_battery_warning_` | `30` | both | Battery % warning, 0 = off ("Low Battery Warning (%)") |
| `low_battery_warning_v` | `0` | both | Battery V warning, 0 = off ("Low Battery Warning (V)") |
| `low_battery_clear_margin` | `5` | both | Hysteresis before a battery warning clears |
| `tank_level_app` / `flow_sensor_app` / `pressure_sensor_app` | unset | both | Tank and skid cards |
| `tank_primary_reading` | `mm` | widget | Large Tank Level reading: `mm` / `m` (tank app `level_reading`, metres), `L` (`level_volume`), `%` (`level_filled_percentage`) |
| `tank_secondary_reading` | `None` | widget | Smaller reading below the primary, same options; nothing shows for `None` or an unpublished tag |
| `rate_units` / `pressure_units` | `L/Hr` / `psi` | both | Labels; left at psi, the controller's `PressureUnits` is used |
| `local_dashboard_enabled` | `true` | container | Run the legacy dashboard on `dashboard_port` |
| `dashboard_port` / `dashboard_secret_key` | `8091` / ... | legacy dashboard | Flask server |
| `display_refresh_period_s` | `0.5` | container | Dashboard / lamp refresh |
| `rpc_timeout_s` | `20` | both | How long a command waits for the controller |

The two battery keys keep the (odd) names already deployed on the Kuwait skids.

Tank readings come straight from the analog level sensor app's tags; the HMI never
computes volume. `L` shows the tank app's `level_volume`, which it computes from its
**Volume Curve** (or, without one, **Max Volume** linear between Empty and Full Level) in
its **Volume Units** (default `L`): set those on the tank app, in litres, before choosing
`L`. The legacy dashboard ignores both keys and always shows mm.

## Architecture

```
src/sia_local_control_ui/      DEV container
  application.py               buttons + lamps; legacy dashboard when enabled; idle otherwise
  app_config.py                the one config schema (container + widget)
  app_ui.py                    cloud UI: the widget (uiRemoteComponent) + legacy mirror
  dashboard.py, templates/,    legacy Flask/SocketIO dashboard (FROZEN)
  static/
widget/                        the HMI screen (Module Federation remote, one .js file)
  src/SiaHmiWidget.tsx         React shell: reads channels, detects host, sends commands
  src/core/hmi-core.js/.css    framework-free render core
  src/lib/                     data adapter, commands, host/actor, app key, live tags
  tests/                       node --test suites (jsdom)
  mock-host/                   mock host for screenshots / checks (not shipped)
  layout/                      kiosk one-screen check + end-to-end command/actor check
tests/                         pytest (container, config, legacy dashboard, contract)
```

The widget reads `deployment_config` (this install's block), `tag_values` (controller and
sensor tags) and `ui_cmds` (saved calibration factor) through the host's `doover-js`
client. On the Doovit these come from the device agent, so the panel works offline. In the
cloud the widget claims the tags it renders for live streaming.

When the legacy dashboard is off, nothing publishes the container's mirror tags
(`LinkOk`, `ControllerState`, ...), so their cloud variables are hidden; the widget card
shows the same and more.

## One-screen layout

Every tile fits one screen with no scrolling at 800x480 and 1024x768, in Read Only and
Touch, with fault and warning banners; with a VSD the Tank and VSD cards share a row.
Checked for the widget by `npm --prefix widget run test:layout` (headless Chromium over
the mock host) and for the legacy dashboard by `tests/test_layout_fit.py` (headless
Chrome; the no-VSD geometry must match `main`).

## Development

```bash
uv run pytest -q                      # everything (runs the widget suites too when
                                      # widget/node_modules and chromium are installed)
uv run export-config && uv run export-ui   # regenerate doover_config.json schemas

npm --prefix widget ci                # node >= 22
npm --prefix widget test              # widget unit suites
npm --prefix widget run typecheck
npm --prefix widget run build         # -> widget/assets/SiaHmiWidget.js (one file)
npm --prefix widget run test:layout   # layout + command/actor checks (SHOTS=dir saves pngs)
```

Never hand-edit `config_schema` / `ui_schema` in `doover_config.json` (tests fail on
drift). The widget must stay one file (`chunkSplit: all-in-one`, inlined CSS and images,
`ConcatenatePlugin`), and its MF names are a contract with the ui schema:
`name: 'SiaHmiWidget'` = `scope`, `'./SiaHmiWidget'` = `module`.

**Mock host.** Serve `widget/mock-host/dist` and open e.g.
`index.html?host=local&mode=Touch` (kiosk) or `index.html?host=cloud&mode=Touch&control=dcs&width=480&click=touch-start`
(cloud card, showing a refusal). Parameters: `host`, `mode`, `scenario`
(`running`/`faulted`/`standby`), `control`, `vsd=0`, `warning=1`, `solar=1`, `width`, `click`.

## Publishing

`doover app publish` does both halves: it runs `build_widget_command`
(`npm --prefix widget run build`), uploads `widget` (`widget/assets/SiaHmiWidget.js`) as the
app's widget, then builds and pushes the container image. This is the same shape as the
DEV app `petronash_pump_controller`, which also ships a widget. On each deploy the platform
attaches the bundle to the install's `<install>_widget` channel and injects `dv_widget_url`
into its config; the cloud card loads it from there and the device agent serves the same
channel at `https://localhost:49100/widget/<install>_widget`.

## Deploying the widget on a panel (Tamboran)

1. Install `sia_local_control_ui` (install `sia_local_control_ui_1`) with:

   ```json
   {
     "hmi_control_mode": "Touch",
     "local_dashboard_enabled": false,
     "pump_controllers": ["sia_injection_controller_1"],
     "run_lamp_pin": null,
     "trip_lamp_pin": null
   }
   ```

   plus the skid's `pressure_sensor_app` / `tank_level_app` / `solar_controllers`. Leave
   the button keys out (they load as Disabled). With no buttons and no lamps the container
   only idles.
2. Install **HMI Display Engine** (`hmi_engine`) with `url = sia_local_control_ui_1`, which
   opens `https://localhost:49100/widget/sia_local_control_ui_1_widget?app_key=sia_local_control_ui_1`.
   Keep `ignore_tls_errors = true` and `hide_cursor = true`; set `mode` / `rotation` /
   `zoom` for the panel (designed for 800x480 and 1024x768 at zoom 1.0).
3. Do not install `doover-kiosk` (nothing listens on 8091).

`hmi_engine` is deliberately not in `depends_on`: Kuwait skids use `doover-kiosk`.

## Legacy dashboard (frozen)

`dashboard.py`, `templates/`, `static/` and `tests/js`, `tests/layout`,
`tests/test_layout_fit.py` exist **only for backward compatibility** with kiosks pointed at
`:8091` (the Kuwait skids). They are frozen: **no new features**. Every screen change goes
in the widget. Bug fixes only where a live site needs one.

**Retirement plan.** Once Kuwait moves to the widget:

1. Per skid: set `local_dashboard_enabled = false`, install `hmi_engine` with
   `url = <install>`, remove `doover-kiosk`; the buttons and lamps keep working unchanged.
2. When no install has the dashboard on, delete `dashboard.py`, `templates/`, `static/`,
   the Flask/SocketIO dependencies, the dashboard settings (`local_dashboard_enabled`,
   `dashboard_port`, `dashboard_secret_key`, selector/valve settings), the mirror tags and
   variables, and their tests. The container is then buttons + lamps only.
