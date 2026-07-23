"""Basic import + schema and widget-contract smoke tests."""

import json
from pathlib import Path


def test_import_app():
    from sia_local_control_ui.application import SiaLocalControlUiApplication

    assert SiaLocalControlUiApplication
    assert SiaLocalControlUiApplication.config_cls is not None
    assert SiaLocalControlUiApplication.tags_cls is not None
    assert SiaLocalControlUiApplication.ui_cls is not None


def test_config_schema():
    from sia_local_control_ui.app_config import SiaLocalControlUiConfig

    schema = SiaLocalControlUiConfig.to_schema()
    assert isinstance(schema, dict)
    assert len(schema["properties"]) > 0
    # button mappings + controller list are present
    assert "start_button" in schema["properties"]
    assert "pump_controllers" in schema["properties"]


def test_tags():
    from sia_local_control_ui.app_tags import SiaLocalControlUiTags

    assert SiaLocalControlUiTags


def test_ui():
    from pydoover.ui import UI

    from sia_local_control_ui.app_ui import SiaLocalControlUiUI

    assert issubclass(SiaLocalControlUiUI, UI)


def test_ui_is_channel_native_widget():
    from sia_local_control_ui.app_ui import SiaLocalControlUiUI

    schema = SiaLocalControlUiUI(None, None, None).to_schema(resolve_config=False)
    assert set(schema["children"]) == {"sia_hmi_widget"}
    widget = schema["children"]["sia_hmi_widget"]
    assert widget["type"] == "uiRemoteComponent"
    assert widget["componentUrl"] == "$config.app().dv_widget_url"
    assert widget["scope"] == "SiaHmiWidget"
    assert widget["module"] == "./SiaHmiWidget"
    assert widget["app_key"] == "$config.app().APP_KEY"
    assert schema["position"] == "$config.app().dv_app_position:number:0"
    assert schema["defaultOpen"] == "$config.app().dv_app_default_open:boolean:true"


def test_widget_build_contract_exists():
    root = Path(__file__).parents[1]
    assert (root / "widget" / "src" / "SiaHmiWidget.tsx").is_file()
    assert (root / "widget" / "rsbuild.config.ts").is_file()


def test_publish_identity_is_separate_from_legacy_app():
    root = Path(__file__).parents[1]
    data = json.loads((root / "doover_config.json").read_text())
    assert set(data) == {"sia_local_control"}
    app = data["sia_local_control"]
    assert app["name"] == "sia_local_control"
    assert app["image_name"] == "ghcr.io/getdoover/sia-local-control-ui:widgets"
    # Publishing must never update the legacy sia_local_control_ui record.
    # A persisted identity is expected after the separate app has been created.
    assert app.get("id") != 202714802705972494
    assert app.get("key") != "c01f11da-53f8-4a22-ba00-8ffa1180cd92"
