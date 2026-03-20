"""Tests for LitterTuiApp, MainScreen, and Config."""
from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from litter_tui.app import LitterTuiApp
from litter_tui.config import Config
from litter_tui.screens.main import MainScreen
from litter_tui.widgets.task_panel import TaskPanel
from litter_tui.widgets.message_panel import MessagePanel


# ---------------------------------------------------------------------------
# Config tests (no app needed)
# ---------------------------------------------------------------------------


def test_config_defaults():
    cfg = Config()
    assert cfg.vim_mode is False
    assert cfg.theme == "dark"
    assert cfg.claude_home == Path.home() / ".claude"


def test_config_load_missing_file():
    """Loading from a nonexistent path should return defaults."""
    cfg = Config.load(Path("/nonexistent/path/config.json"))
    assert cfg.vim_mode is False
    assert cfg.theme == "dark"


def test_config_save_and_load_roundtrip():
    with tempfile.TemporaryDirectory() as tmpdir:
        path = Path(tmpdir) / "config.json"
        original = Config(vim_mode=True, theme="light")
        original.save(path)

        assert path.exists()
        loaded = Config.load(path)
        assert loaded.vim_mode is True
        assert loaded.theme == "light"


def test_config_save_creates_parent_dirs():
    with tempfile.TemporaryDirectory() as tmpdir:
        path = Path(tmpdir) / "nested" / "deep" / "config.json"
        cfg = Config()
        cfg.save(path)
        assert path.exists()


def test_config_load_corrupt_json():
    with tempfile.TemporaryDirectory() as tmpdir:
        path = Path(tmpdir) / "config.json"
        path.write_text("not valid json {{{")
        cfg = Config.load(path)
        assert cfg.vim_mode is False


def test_config_load_partial_fields():
    with tempfile.TemporaryDirectory() as tmpdir:
        path = Path(tmpdir) / "config.json"
        path.write_text(json.dumps({"vim_mode": True}))
        cfg = Config.load(path)
        assert cfg.vim_mode is True
        assert cfg.theme == "dark"  # default


def test_config_claude_home_roundtrip():
    with tempfile.TemporaryDirectory() as tmpdir:
        path = Path(tmpdir) / "config.json"
        custom_home = Path("/custom/claude/home")
        cfg = Config(claude_home=custom_home)
        cfg.save(path)
        loaded = Config.load(path)
        assert loaded.claude_home == custom_home


# ---------------------------------------------------------------------------
# App tests
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_app_mounts_successfully():
    """App should mount without errors."""
    app = LitterTuiApp()
    async with app.run_test(size=(120, 40)) as pilot:
        await pilot.pause(delay=0.2)
        assert app.is_running


@pytest.mark.anyio
async def test_app_title():
    """App title should be set correctly."""
    app = LitterTuiApp()
    async with app.run_test(size=(120, 40)) as pilot:
        await pilot.pause(delay=0.1)
        assert app.TITLE == "litter-tui"


@pytest.mark.anyio
async def test_app_pushes_main_screen():
    """App should push MainScreen on mount."""
    app = LitterTuiApp()
    async with app.run_test(size=(120, 40)) as pilot:
        await pilot.pause(delay=0.2)
        assert isinstance(app.screen, MainScreen)


@pytest.mark.anyio
async def test_app_has_bindings():
    """App should declare expected key bindings."""
    app = LitterTuiApp()
    binding_keys = {b.key for b in app.BINDINGS}
    assert "ctrl+q" in binding_keys
    assert "ctrl+t" in binding_keys
    assert "ctrl+m" in binding_keys
    assert "ctrl+n" in binding_keys
    assert "ctrl+s" in binding_keys
    assert "f1" in binding_keys


# ---------------------------------------------------------------------------
# MainScreen tests
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_main_screen_composes_sidebar():
    """MainScreen should compose a sidebar element."""
    app = LitterTuiApp()
    async with app.run_test(size=(120, 40)) as pilot:
        await pilot.pause(delay=0.2)
        sidebar = app.screen.query("#sidebar")
        assert len(sidebar) > 0


@pytest.mark.anyio
async def test_main_screen_composes_session_view():
    """MainScreen should compose a session view element."""
    app = LitterTuiApp()
    async with app.run_test(size=(120, 40)) as pilot:
        await pilot.pause(delay=0.2)
        session_view = app.screen.query("#session-view")
        assert len(session_view) > 0


@pytest.mark.anyio
async def test_main_screen_composes_input_bar():
    """MainScreen should compose an input bar element."""
    app = LitterTuiApp()
    async with app.run_test(size=(120, 40)) as pilot:
        await pilot.pause(delay=0.2)
        input_bar = app.screen.query("#input-bar")
        assert len(input_bar) > 0


@pytest.mark.anyio
async def test_main_screen_composes_tab_bar():
    """MainScreen should compose a tab bar element."""
    app = LitterTuiApp()
    async with app.run_test(size=(120, 40)) as pilot:
        await pilot.pause(delay=0.2)
        tab_bar = app.screen.query("#tab-bar")
        assert len(tab_bar) > 0


@pytest.mark.anyio
async def test_main_screen_has_task_panel():
    """MainScreen should include a TaskPanel widget."""
    app = LitterTuiApp()
    async with app.run_test(size=(120, 40)) as pilot:
        await pilot.pause(delay=0.2)
        panels = app.screen.query(TaskPanel)
        assert len(panels) > 0


@pytest.mark.anyio
async def test_main_screen_has_message_panel():
    """MainScreen should include a MessagePanel widget."""
    app = LitterTuiApp()
    async with app.run_test(size=(120, 40)) as pilot:
        await pilot.pause(delay=0.2)
        panels = app.screen.query(MessagePanel)
        assert len(panels) > 0


@pytest.mark.anyio
async def test_ctrl_t_binding_fires():
    """ctrl+t should toggle the task panel."""
    app = LitterTuiApp()
    async with app.run_test(size=(120, 40)) as pilot:
        await pilot.pause(delay=0.2)
        task_panel = app.screen.query_one(TaskPanel)
        # Initially not visible
        assert "-visible" not in task_panel.classes
        await pilot.press("ctrl+t")
        await pilot.pause(delay=0.1)
        # After toggle, should be visible
        assert "-visible" in task_panel.classes


@pytest.mark.anyio
async def test_ctrl_m_binding_fires():
    """ctrl+m should toggle the message panel."""
    app = LitterTuiApp()
    async with app.run_test(size=(120, 40)) as pilot:
        await pilot.pause(delay=0.2)
        msg_panel = app.screen.query_one(MessagePanel)
        assert "-visible" not in msg_panel.classes
        await pilot.press("ctrl+m")
        await pilot.pause(delay=0.1)
        assert "-visible" in msg_panel.classes
