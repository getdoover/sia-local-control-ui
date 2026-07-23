from pydoover.tags import Tag, Tags


class SiaLocalControlUiTags(Tags):
    """HMI-owned tags.

    The widget does not consume these mirrors; it reads peer app blocks in
    ``tag_values`` directly. The historical primary-controller mirrors remain
    for API compatibility, while ``SelectorState`` exposes the one HMI value
    that originates from local hardware.
    """

    LinkOk = Tag("boolean", default=False, live=True)
    ControllerState = Tag("string", default="standby", live=True)
    TargetRate = Tag("number", default=0.0, live=True)
    FlowRate = Tag("number", default=0.0, live=True)
    Fault = Tag("boolean", default=False, live=True)
    FaultReason = Tag("string", default=None, live=True)
    Warning = Tag("boolean", default=False, live=True)
    WarningReason = Tag("string", default=None, live=True)
    # Physical selector state has no upstream application/channel. Publishing
    # it here lets the widget stay channel-native without a bespoke web bridge.
    SelectorState = Tag("number", default=0, live=True)
    LastCommand = Tag("string", default=None, live=True)
