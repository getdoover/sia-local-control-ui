"""Runs the touchscreen render tests (tests/js, node's built-in test runner).

They prove the rendered screen is unchanged for an older controller's payload
and that the new controls appear only when the backend reports them. Skipped
when node isn't installed (e.g. the device-base CI image).
"""

import shutil
import subprocess
from pathlib import Path

import pytest

JS_TESTS = Path(__file__).parent / "js"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_dashboard_js():
    result = subprocess.run(
        ["node", "--test", str(JS_TESTS / "dashboard.test.mjs")],
        capture_output=True,
        check=False,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stdout + result.stderr
