from pathlib import Path

from pydoover import ui

from .app_tags import SiaLocalControlUiTags as T


# The widget's Module Federation names: `scope` = rsbuild `name`, `module` =
# its exposed key (widget/rsbuild.config.ts). Pinned by
# tests/test_widget_contract.py.
WIDGET_ELEMENT = "sia_hmi_widget"
WIDGET_SCOPE = "SiaHmiWidget"
WIDGET_MODULE = "./SiaHmiWidget"

# The legacy dashboard's cloud mirror (the HMI's own tags). Only published
# while the legacy dashboard runs, so hidden when it is off.
MIRROR_ELEMENTS = (
    "link_ok",
    "controller_state",
    "target_rate",
    "flow_rate",
    "fault",
    "fault_reason",
)


class SiaLocalControlUiUI(ui.UI):
    """Cloud UI: the SIA HMI widget, plus the legacy dashboard's mirror.

    The widget (widget/, built to one JS file and uploaded through the
    ``widget`` field of doover_config.json) is the HMI screen, both here and
    on the Doovit's panel: the platform injects ``dv_widget_url`` into this
    install's config and the device agent's local widget host serves the same
    bundle at ``/widget/<app_key>_widget``.

    The variables below are the older read-only mirror of the primary
    controller's state (via the HMI's own mirrored tags). They are kept while
    the legacy dashboard runs and hidden when ``local_dashboard_enabled`` is
    off, because nothing publishes those tags then.
    """

    hmi_widget = ui.RemoteComponent(
        "SIA HMI",
        "$config.app().dv_widget_url",
        name=WIDGET_ELEMENT,
        scope=WIDGET_SCOPE,
        module=WIDGET_MODULE,
        app_key="$config.app().APP_KEY",
    )

    link_ok = ui.BooleanVariable(
        "Controller Link OK",
        value=ui.bind_tag(T.LinkOk),
        name="link_ok",
    )
    controller_state = ui.TextVariable(
        "Pump State",
        value=ui.bind_tag(T.ControllerState),
        name="controller_state",
    )
    target_rate = ui.NumericVariable(
        "Target Rate",
        precision=2,
        value=ui.bind_tag(T.TargetRate),
        name="target_rate",
    )
    flow_rate = ui.NumericVariable(
        "Flow Rate",
        precision=2,
        value=ui.bind_tag(T.FlowRate),
        name="flow_rate",
    )
    fault = ui.BooleanVariable(
        "Fault",
        value=ui.bind_tag(T.Fault),
        name="fault",
    )
    fault_reason = ui.TextVariable(
        "Fault Reason",
        value=ui.bind_tag(T.FaultReason),
        name="fault_reason",
    )

    async def setup(self):
        ru = self.config.rate_units.value or "L/Hr"
        self.target_rate.display_name = f"Target Rate ({ru})"
        self.flow_rate.display_name = f"Flow Rate ({ru})"
        if not self.config.dashboard_enabled:
            for name in MIRROR_ELEMENTS:
                getattr(self, name).hidden = True


def export():
    SiaLocalControlUiUI(None, None, None).export(
        Path(__file__).parents[2] / "doover_config.json",
        "sia_local_control_ui",
    )
