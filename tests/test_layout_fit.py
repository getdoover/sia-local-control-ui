"""One-screen layout check in a real browser (headless Chrome).

With a VSD configured, every tile (header, banners, pump control, Tank + VSD
row, Touch bar) must fit 800x480 and 1024x768 with no vertical or horizontal
scroll, in Read Only and Touch, with and without a fault banner. Without a
VSD, the geometry must match main exactly (existing Kuwait skids).

Skipped when Chrome isn't installed (e.g. the device-base CI image).
"""

import shutil
import subprocess
from pathlib import Path

import pytest

from .layout.probe import LayoutServer, find_chrome, measure

CHROME = find_chrome()
pytestmark = pytest.mark.skipif(CHROME is None, reason="Chrome not installed")

ROOT = Path(__file__).parents[1]
PKG = ROOT / "src" / "sia_local_control_ui"
SIZES = [(800, 480), (1024, 768)]
TS = "2026-09-29T00:00:00+00:00"

PUMP = {
    "name": "Pump",
    "target_rate": 12.5,
    "flow_rate": 11.9,
    "total": 345.6,
    "min_rate": 2.0,
    "max_rate": 92.16,
    "state": "pumping",
    "running": True,
    "fault": False,
    "fault_reason": None,
    "warning": False,
    "warning_reason": None,
}
VSD_OK = {
    "tripped": False,
    "trip_code": None,
    "trip_description": None,
    "motor_hz": 42.5,
    "pump_rpm": 61.0,
}
VSD_TRIP = {
    "tripped": True,
    "trip_code": 3,
    "trip_description": "Over current",
    "motor_hz": 0.0,
    "pump_rpm": 0.0,
}
TOUCH = {"calibration_factor": 1.0, "calibration_min": 0.3, "calibration_max": 1.7}


def _payload(vsd=True, touch=False, faulted=False, solar=False):
    pump = dict(PUMP)
    data = {
        "pumps": [pump],
        "faults": [],
        "warnings": [],
        "link_ok": True,
        "units": {"rate": "L/Hr", "pressure": "kPa"},
        "tank": {"tank_level_mm": 850, "tank_level_percent": 64},
        "timestamp": TS,
    }
    if faulted:
        pump.update(state="fault", running=False, fault=True)
        reason = "VSD trip: Over current (code 3)" if vsd else "Tank level low-low"
        pump["fault_reason"] = reason
        data["faults"] = [{"pump": "Pump", "reason": reason}]
        data["warnings"] = [{"pump": "Pump", "reason": "Tank level low"}]
    if vsd:
        data["vsd"] = VSD_TRIP if faulted else VSD_OK
    if touch:
        data["touch"] = TOUCH
    if solar:
        data["solar"] = {
            "battery_voltage": 25.4,
            "battery_percentage": 81,
            "panel_power": 120.5,
            "battery_ah": 200,
        }
    return data


@pytest.fixture(scope="module")
def server():
    return LayoutServer()


def _assert_fits(m, width, height):
    assert m["doc"]["scrollH"] <= height, "page scrolls vertically"
    assert m["doc"]["scrollW"] <= width, "page scrolls horizontally"
    content = m["content"]
    assert content["scrollH"] <= content["clientH"], "content area scrolls"
    assert content["scrollW"] <= content["clientW"], "content area scrolls sideways"
    for section in m["sections"]:
        r = section["rect"]
        assert r["bottom"] <= m["obstacleTop"] + 0.5, f"{section['id']} hidden/cut"
        assert r["right"] <= width + 0.5, f"{section['id']} off-screen"
        assert r["top"] >= 0


@pytest.mark.parametrize("size", SIZES, ids=lambda s: f"{s[0]}x{s[1]}")
@pytest.mark.parametrize("touch", [False, True], ids=["read_only", "touch"])
@pytest.mark.parametrize("faulted", [False, True], ids=["ok", "fault_banner"])
def test_vsd_layout_fits_one_screen(server, size, touch, faulted):
    width, height = size
    m = measure(server, CHROME, _payload(touch=touch, faulted=faulted), width, height)
    assert m["hasVsd"] is True
    assert m["touch"] is touch
    _assert_fits(m, width, height)

    by_id = {s["id"]: s["rect"] for s in m["sections"]}
    tank, vsd = by_id["tank-section"], by_id["vsd-section"]
    assert abs(tank["top"] - vsd["top"]) < 1, "Tank and VSD not on one row"
    assert vsd["left"] >= tank["right"], "VSD not to the right of Tank"

    for target in m["targets"]:
        assert target["w"] >= 56 and target["h"] >= 56, target
    assert m["smallestFontPx"] >= 9.5, "text too small to read"


@pytest.mark.parametrize("size", SIZES, ids=lambda s: f"{s[0]}x{s[1]}")
def test_vsd_layout_with_solar_has_no_horizontal_scroll(server, size):
    width, height = size
    m = measure(server, CHROME, _payload(touch=True, solar=True), width, height)
    assert m["doc"]["scrollW"] <= width
    assert m["content"]["scrollW"] <= m["content"]["clientW"]


# ---------------------------------------------------------------------------
# no VSD: geometry identical to main
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def main_server(tmp_path_factory):
    if shutil.which("git") is None:
        pytest.skip("git not available")
    base = tmp_path_factory.mktemp("main")
    templates, static = base / "templates", base / "static"
    shutil.copytree(PKG / "static", static)
    templates.mkdir()
    files = {
        templates / "dashboard.html": "templates/dashboard.html",
        static / "css" / "dashboard.css": "static/css/dashboard.css",
        static / "js" / "dashboard.js": "static/js/dashboard.js",
    }
    for dest, rel in files.items():
        out = subprocess.run(
            ["git", "show", f"main:src/sia_local_control_ui/{rel}"],
            cwd=ROOT,
            capture_output=True,
            check=False,
        )
        if out.returncode != 0:
            pytest.skip("main branch not available (shallow checkout?)")
        dest.write_bytes(out.stdout)
    return LayoutServer(template_dir=templates, static_dir=static)


def _geometry(m):
    return [
        (s["id"], {k: round(v, 1) for k, v in s["rect"].items()}) for s in m["sections"]
    ] + [("footer", round(m["footerTop"], 1))]


@pytest.mark.parametrize("size", SIZES, ids=lambda s: f"{s[0]}x{s[1]}")
@pytest.mark.parametrize(
    "case",
    [
        {"faulted": False},
        {"faulted": True},
        {"faulted": False, "solar": True},
    ],
    ids=["ok", "fault_banner", "solar"],
)
def test_no_vsd_geometry_matches_main(server, main_server, size, case):
    width, height = size
    payload = _payload(vsd=False, **case)
    ours = measure(server, CHROME, payload, width, height)
    theirs = measure(main_server, CHROME, payload, width, height)
    assert ours["hasVsd"] is False
    assert _geometry(ours) == _geometry(theirs)
    assert ours["doc"] == theirs["doc"]
    assert ours["content"] == theirs["content"]
