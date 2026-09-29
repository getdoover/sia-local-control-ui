"""The app <-> widget contract: one app (DEV container + widget), one config.

- doover_config.json ships the widget the way every widget app does
  (petronash-hmi, and the DEV app petronash_pump_controller): ``widget`` is
  the single built file, ``build_widget_command`` builds it, and the
  ui_schema carries one ``uiRemoteComponent`` whose ``componentUrl`` is the
  platform-injected ``dv_widget_url``.
- The Module Federation names match the widget build.
- Every config key the widget reads exists in this app's schema (the widget
  has no config of its own), and no key is duplicated under a second name.
"""

import json
import re
from pathlib import Path

from sia_local_control_ui.app_config import SiaLocalControlUiConfig
from sia_local_control_ui.app_ui import (
    WIDGET_ELEMENT,
    WIDGET_MODULE,
    WIDGET_SCOPE,
    SiaLocalControlUiUI,
)

ROOT = Path(__file__).parents[1]
WIDGET = ROOT / "widget"
ADAPTER = WIDGET / "src" / "lib" / "assembleDashboardData.ts"


def _app_record() -> dict:
    return json.loads((ROOT / "doover_config.json").read_text())["sia_local_control_ui"]


def _schema_keys() -> set[str]:
    schema = SiaLocalControlUiConfig.to_schema()
    keys = set(schema["properties"])
    for branch in schema.get("allOf", []):
        keys |= set(branch["then"]["properties"])
    return keys


def _widget_config_keys() -> set[str]:
    """Keys resolveConfig() reads: ``c.<key>`` plus the STATUS_TAG_KEYS table."""
    src = ADAPTER.read_text()
    body = src[src.index("export function resolveConfig") :]
    body = body[: body.index("\n}\n")]
    keys = set(re.findall(r"\bc\.([a-z0-9_]+)", body))
    start = src.index("const STATUS_TAG_KEYS")
    table = src[start : src.index("];", start)]
    keys |= set(re.findall(r'\["([a-z0-9_]+)",', table))
    return keys


# ---------------------------------------------------------------------------
# app record
# ---------------------------------------------------------------------------


def test_one_dev_app_that_also_ships_the_widget():
    rec = _app_record()
    assert rec["name"] == "sia_local_control_ui"
    assert rec["type"] == "DEV"  # still the device container...
    assert rec["image_name"] == "ghcr.io/getdoover/sia-local-control-ui:main"
    # ...that also ships a widget, referenced exactly as petronash-hmi does.
    assert rec["widget"] == "widget/assets/SiaHmiWidget.js"
    assert rec["build_widget_command"] == "npm --prefix widget run build"


def test_widget_fields_match_the_reference_widget_apps():
    """Same two fields, same shapes, as the existing widget apps."""
    petronash_hmi = {
        "build_widget_command": "npm --prefix widget run build",
        "widget": "widget/assets/PetronashHmiWidget.js",
    }
    rec = _app_record()
    for field, reference in petronash_hmi.items():
        ours = rec[field]
        assert type(ours) is type(reference)
        if field == "widget":
            assert ours.startswith("widget/assets/") and ours.endswith("Widget.js")
        else:
            assert ours == reference


def test_ui_schema_has_the_remote_component():
    ui = _app_record()["ui_schema"]
    widget = ui["children"][WIDGET_ELEMENT]
    assert widget["type"] == "uiRemoteComponent"
    assert widget["componentUrl"] == "$config.app().dv_widget_url"
    assert widget["app_key"] == "$config.app().APP_KEY"
    assert widget["scope"] == WIDGET_SCOPE == "SiaHmiWidget"
    assert widget["module"] == WIDGET_MODULE == "./SiaHmiWidget"
    assert widget["hidden"] is False
    # The widget is the screen: first child.
    first = min(ui["children"].values(), key=lambda c: c["position"])
    assert first["name"] == WIDGET_ELEMENT


def test_exported_ui_schema_is_current(tmp_path):
    fp = tmp_path / "doover_config.json"
    SiaLocalControlUiUI(None, None, None).export(fp, "sia_local_control_ui")
    fresh = json.loads(fp.read_text())["sia_local_control_ui"]["ui_schema"]
    assert _app_record()["ui_schema"] == fresh


def test_mf_names_match_the_widget_build():
    rsbuild = (WIDGET / "rsbuild.config.ts").read_text()
    assert f"name: '{WIDGET_SCOPE}'" in rsbuild
    assert f"'{WIDGET_MODULE}': './src/SiaHmiWidget'" in rsbuild
    # ConcatenatePlugin writes the one file doover_config.json uploads.
    out = Path(_app_record()["widget"]).name
    assert f"name: '{out}'" in rsbuild
    assert "destination: './assets'" in rsbuild


def test_resolve_app_key_ignores_the_static_element_name():
    """The local host may name the element after the widget channel
    (``<app_key>_widget``); the static ui_schema name must not be taken for
    an install key."""
    src = (WIDGET / "src" / "lib" / "appKey.ts").read_text()
    assert f'name !== "{WIDGET_ELEMENT}"' in src
    adapter = ADAPTER.read_text()
    assert 'DEFAULT_APP_KEY = "sia_local_control_ui_1"' in adapter


# ---------------------------------------------------------------------------
# config: one set of keys, shared
# ---------------------------------------------------------------------------


def test_every_key_the_widget_reads_is_in_the_app_schema():
    widget_keys = _widget_config_keys()
    assert {"hmi_control_mode", "pump_controllers", "rpc_timeout_s"} <= widget_keys
    missing = widget_keys - _schema_keys()
    assert not missing, f"widget reads keys the app does not have: {missing}"


def test_battery_keys_are_the_deployed_ones_not_duplicates():
    keys = _schema_keys()
    widget_keys = _widget_config_keys()
    for deployed in ("low_battery_warning_", "low_battery_warning_v"):
        assert deployed in keys and deployed in widget_keys
    for duplicate in ("low_battery_warning_percent", "low_battery_warning_voltage"):
        assert duplicate not in keys and duplicate not in widget_keys


def test_widget_reads_the_configurable_tag_names():
    assert {
        "state_tag",
        "target_rate_tag",
        "flow_rate_tag",
        "total_tag",
        "min_rate_tag",
        "max_rate_tag",
        "running_tag",
        "fault_tag",
        "fault_reason_tag",
        "warning_tag",
        "warning_reason_tag",
    } <= _widget_config_keys()


def test_no_control_mode_anywhere():
    """Control priority is fixed by the controller: no option, no command."""
    for key in _schema_keys() | _widget_config_keys():
        if key == "hmi_control_mode":
            continue
        assert "control_mode" not in key and "authority" not in key, key
    for path in (WIDGET / "src").rglob("*"):
        if path.suffix in (".ts", ".tsx", ".js"):
            assert "set_control_mode" not in path.read_text(), path


def test_built_widget_is_one_file_when_present():
    built = ROOT / _app_record()["widget"]
    if not built.exists():
        return  # built by `doover app publish` (build_widget_command)
    text = built.read_text()
    assert WIDGET_SCOPE in text
    # Single file: nothing else next to it to upload.
    assert [p.name for p in built.parent.iterdir()] == [built.name]


def test_tank_reading_options_match_the_widget():
    """Same options in the config editor and the widget, defaults = old card."""
    from sia_local_control_ui.app_config import TANK_NONE, TANK_READINGS

    props = SiaLocalControlUiConfig.to_schema()["properties"]
    assert props["tank_primary_reading"]["enum"] == ["mm", "m", "L", "%"]
    assert props["tank_primary_reading"]["default"] == "mm"
    assert props["tank_secondary_reading"]["enum"] == ["None", "mm", "m", "L", "%"]
    assert props["tank_secondary_reading"]["default"] == TANK_NONE == "None"
    src = ADAPTER.read_text()
    ts = re.search(r"TANK_READINGS = \[([^\]]*)\] as const", src).group(1)
    assert tuple(re.findall(r'"([^"]+)"', ts)) == TANK_READINGS
    assert f'TANK_NONE = "{TANK_NONE}"' in src
    # Each option reads a tag the analog level sensor app really publishes.
    for tag in ("level_reading", "level_volume", "level_filled_percentage"):
        assert f'tag: "{tag}"' in src
    assert {"tank_primary_reading", "tank_secondary_reading"} <= _widget_config_keys()
