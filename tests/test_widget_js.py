"""Runs the widget's own suites from pytest when the toolchain is present.

- ``npm test``: data adapter, config keys, host/actor, commands, render core
  (node's built-in runner + jsdom).
- ``npm run test:layout``: kiosk one-screen layout at 800x480 / 1024x768 and
  the end-to-end command/actor check, in headless Chromium over the mock host.

Skipped when node or widget/node_modules is missing (e.g. the device-base CI
image); CI runs them in their own job (.github/workflows/run-tests.yml).
"""

import shutil
import subprocess
from pathlib import Path

import pytest

WIDGET = Path(__file__).parents[1] / "widget"

pytestmark = pytest.mark.skipif(
    shutil.which("npm") is None or not (WIDGET / "node_modules").is_dir(),
    reason="node / widget node_modules not installed (npm --prefix widget ci)",
)


def _npm(*args, timeout=600):
    result = subprocess.run(
        ["npm", "--prefix", str(WIDGET), *args],
        capture_output=True,
        check=False,
        text=True,
        timeout=timeout,
    )
    assert result.returncode == 0, result.stdout[-4000:] + result.stderr[-4000:]
    return result.stdout


def test_widget_unit_suite():
    _npm("test")


def test_widget_typecheck():
    _npm("run", "typecheck")


def _chromium_installed() -> bool:
    probe = subprocess.run(
        [
            "node",
            "-e",
            (
                "const {chromium}=require('playwright');"
                "process.exit(require('fs').existsSync(chromium.executablePath())?0:1)"
            ),
        ],
        cwd=WIDGET,
        capture_output=True,
        check=False,
    )
    return probe.returncode == 0


def test_widget_layout_and_commands_in_a_browser():
    if not _chromium_installed():
        pytest.skip(
            "playwright chromium not installed (npx playwright install chromium)"
        )
    _npm("run", "test:layout")
