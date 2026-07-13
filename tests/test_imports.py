"""Basic import + schema smoke tests."""


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


def test_dashboard_importable():
    from sia_local_control_ui.dashboard import SiaDashboard

    dash = SiaDashboard(port=8099, command_handler=lambda cmd, val: {"ok": True})
    assert dash.app is not None
