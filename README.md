# Doover Application Template

This repository serves as a template for creating Doover applications.

It provides a structured layout for application code, deployment configurations, simulators, and tests. The template is
designed to simplify the development and deployment of Doover-compatible applications.

The basic structure of the repository is as follows:

## Getting Started

```
README.md           <-- This file
pyproject.toml      <-- Python project configuration file (including dependencies)
Dockerfile          <-- Dockerfile for building the application image
doover_config.json  <-- Configuration file for doover

src/sia_local_control_ui/   <-- Application directory
  application.py    <-- Main application code
  app_config.py     <-- Config schema definition
  app_ui.py         <-- UI code (if applicable)
  app_state.py      <-- State machine (if applicable)

simulator/
  app_config.json   <-- Sample configuration for the simulator
  docker-compose.yml <-- Docker Compose file for the simulator
  
tests/
    test_imports.py  <-- Test file for the application
```

The `doover_config.json` file is the doover configuration file for the application. 

It defines all metadata about the application, including name, short and long description, 
dependent apps, image name, owner organisation, container registry and more.

### Prerequisites

- Docker and Docker Compose installed
- Python 3.11 or later (if running locally)
- Pipenv for managing Python dependencies

### Running Locally

1. Run the application:

```bash
doover app run
```

## Simulators

The `simulator/` directory contains tools for simulating application behavior. For example:

- `app_config.json`: Sample configuration file for the app.
- `docker-compose.yml`: Defines services for running the application.

You can find a sample simulator in the `simulator/sample/` directory. While it is fairly bare-bones, it shows
positioning of the simulator in the application structure, and how to start the simulator alongside your application.

## Testing

Run the tests using the following command:

```bash
pytest tests/
```

## Deployment

The `deployment/` directory contains deployment configurations, including a `docker-compose.yml` file for orchestrating
services.

## Customization

To create your own Doover application:

1. Modify the application logic in the appropriate directory.
2. Update the simulator and test configurations as needed.
3. Adjust deployment configurations to suit your requirements.

## HMI Control Mode (`hmi_control_mode`)

Config dropdown **HMI Control Mode**, first in the config editor:

- `Read Only` (default): the touchscreen is display-only, exactly as before.
- `Touch`: adds an on-screen bar fixed to the bottom of the screen with Start, Stop
  (always available), rate step down/up (`nudge_rate`), tap the rate for a keypad
  setpoint (`set_target_rate`, clamped to MinRate..MaxRate), Reset Fault, and the
  calibration factor (`last_calibration_factor`, 0.3 to 1.7). The VSD card's
  Reset VSD button is also live in this mode. Calibration changes and
  rate changes over 20% ask for confirmation first.
- `Button`: **reserved** for a future mode. It currently behaves exactly like Read Only.

The physical-button fields (`start_button`, `stop_button`, `flow_up_button`,
`flow_down_button`) are shown in the config editor only when this is `Button`. That is
done with a JSON-schema `allOf`/`if`/`then` branch in the exported schema
(`SiaLocalControlUiConfig.to_schema`), which the Doover config editor renders
conditionally while keeping saved values. It is editor visibility only: the physical
buttons always run from their saved values, so existing installs (e.g. Kuwait, which
default to Read Only) keep their wiring. A button with no saved config loads as
Disabled. The RUN/TRIP lamp pins stay visible in every mode.

Control priority (local HMI, then DCS, then cloud) is fixed by the injection
controller and its config; it is not an option on the HMI. If the controller
refuses a command, the screen shows the controller's own reason text.

This setting governs ON-SCREEN controls only. The physical Start/Stop/Flow Up/Flow
Down pushbuttons and the RUN/TRIP lamps work exactly as configured in every mode.
Every command carries `actor={"name": "Local HMI"}`.

Tests: `uv run pytest` (includes the touchscreen render tests in `tests/js`, run
with node's built-in test runner when node is installed).

### One-screen layout with a VSD

When the controller has a VSD configured, the VSD card sits to the right of the Tank
card on the same row and the page switches to a compact layout (`.has-vsd`), so every
tile fits on one screen with no scrolling at 800x480 and 1024x768, in Read Only and
Touch, including with fault and warning banners. Without a VSD (e.g. the Kuwait skids)
the layout is unchanged. `tests/test_layout_fit.py` checks both in headless Chrome
(skipped when Chrome isn't installed), including a geometry comparison against `main`
for the no-VSD case.
