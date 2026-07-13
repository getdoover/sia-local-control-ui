from pathlib import Path

from pydoover import ui

from .app_tags import SiaLocalControlUiTags as T


class SiaLocalControlUiUI(ui.UI):
    """Lean cloud view of what the local touchscreen is showing.

    The operator surface lives on the physical panel + touchscreen; this cloud
    UI is a read-only mirror of the primary controller's state (via the HMI's
    own mirrored tags), useful for remote observation.
    """

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


def export():
    SiaLocalControlUiUI(None, None, None).export(
        Path(__file__).parents[2] / "doover_config.json",
        "sia_local_control_ui",
    )
