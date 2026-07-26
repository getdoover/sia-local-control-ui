from pydoover.tags import Tag, Tags


class SiaLocalControlUiTags(Tags):
    """HMI-owned tags.

    The HMI is primarily a *consumer* of the controller's status tags (read via
    ``get_tag(name, app_key)``), but it publishes a small mirror of the primary
    controller's state plus a link-health flag so the cloud has a view of what
    the touchscreen is showing and whether the local RPC link is alive.
    """

    LinkOk = Tag("boolean", default=False, live=True)
    ControllerState = Tag("string", default="standby", live=True)
    # Mirror the controller's resolved target only; None means the controller
    # has not published its source-of-truth value yet.
    TargetRate = Tag("number", default=None, live=True)
    FlowRate = Tag("number", default=0.0, live=True)
    Fault = Tag("boolean", default=False, live=True)
    FaultReason = Tag("string", default=None, live=True)
    Warning = Tag("boolean", default=False, live=True)
    WarningReason = Tag("string", default=None, live=True)
    LastCommand = Tag("string", default=None, live=True)
