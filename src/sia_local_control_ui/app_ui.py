from pathlib import Path

from pydoover import ui


class SiaLocalControlUiUI(
    ui.UI,
    position="$config.app().dv_app_position:number:0",
    default_open="$config.app().dv_app_default_open:boolean:true",
):
    """Channel-native HMI rendered as a Module Federation widget."""

    hmi_widget = ui.RemoteComponent(
        "SIA Remote Command",
        "$config.app().dv_widget_url",
        name="sia_hmi_widget",
        scope="SiaHmiWidget",
        module="./SiaHmiWidget",
        # The widget uses this to find the correct config and selector tag
        # blocks when an install's app key is not the package's default name.
        app_key="$config.app().APP_KEY",
    )


def export():
    SiaLocalControlUiUI(None, None, None).export(
        Path(__file__).parents[2] / "doover_config.json",
        "sia_local_control",
    )
