import logging

from pydoover.docker import run_app

from .application import SiaLocalControlUiApplication


class PlatformLogFilter(logging.Filter):
    """Filter out the noisiest platform-interface log lines."""

    def filter(self, record):
        if getattr(record, "name", "") == "pydoover.docker.platform.platform":
            return record.levelno >= logging.WARNING
        return True


def main():
    """Run the application."""
    run_app(
        SiaLocalControlUiApplication(),
        log_filters=PlatformLogFilter(),
    )
