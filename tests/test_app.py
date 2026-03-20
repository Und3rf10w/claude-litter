"""Tests for LitterTuiApp, MainScreen, and Config."""
from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from litter_tui.app import LitterTuiApp
from litter_tui.config import Config
from litter_tui.screens.main import MainScreen
from litter_tui.services.agent_manager import AgentStatus
from litter_tui.widgets.session_view import SessionView
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
    assert "f2" in binding_keys
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
async def test_f2_binding_fires():
    """F2 should toggle the message panel."""
    app = LitterTuiApp()
    async with app.run_test(size=(120, 40)) as pilot:
        await pilot.pause(delay=0.2)
        msg_panel = app.screen.query_one(MessagePanel)
        assert "-visible" not in msg_panel.classes
        await pilot.press("f2")
        await pilot.pause(delay=0.1)
        assert "-visible" in msg_panel.classes


# ---------------------------------------------------------------------------
# End-to-end prompt flow test (mocked SDK)
# ---------------------------------------------------------------------------


class _FakeAgentSession:
    """Fake AgentSession that streams a predictable response."""

    def __init__(self):
        self.team_name = ""
        self.agent_name = "default"
        self.model = None
        self.session_id = "fake-session"
        self.status = AgentStatus.idle
        self.output_buffer: list[str] = []
        self.server_info: dict | None = {"commands": []}
        self._client = None
        self._connected = True
        self._prompt_text = ""

    async def start(self):
        self.status = AgentStatus.idle

    async def send_prompt(self, prompt, images=None):
        self._prompt_text = prompt
        self.status = AgentStatus.active

    async def stream_response(self):
        if self._prompt_text:
            yield "Hello "
            yield "from "
            yield "fake agent!\n"
            self._prompt_text = ""
            self.status = AgentStatus.idle

    async def interrupt(self):
        self.status = AgentStatus.idle

    async def stop(self):
        self.status = AgentStatus.stopped


@pytest.mark.anyio
async def test_prompt_e2e_type_submit_receive():
    """Full E2E: type text, press ctrl+j, verify agent response appears."""
    fake_session = _FakeAgentSession()

    with patch(
        "litter_tui.services.agent_manager.AgentManager.spawn_agent",
        new_callable=AsyncMock,
        return_value=fake_session,
    ):
        app = LitterTuiApp()
        async with app.run_test(size=(120, 40)) as pilot:
            # Wait for _connect_default_agent to complete
            await pilot.pause(delay=1.0)
            assert isinstance(app.screen, MainScreen)

            sv = app.screen.query_one("#session-view", SessionView)

            from textual.widgets import RichLog
            log = sv.query_one(RichLog)

            # Verify "Agent ready." appeared
            initial_text = "\n".join(str(line) for line in log.lines)
            assert "Agent ready" in initial_text

            # Type "hello" and submit with Ctrl+J
            await pilot.press("h", "e", "l", "l", "o")
            await pilot.pause(delay=0.2)
            await pilot.press("ctrl+j")
            await pilot.pause(delay=1.0)

            # Verify the prompt echo and agent response appeared
            final_text = "\n".join(str(line) for line in log.lines)
            assert "> hello" in final_text, f"Expected prompt echo in: {final_text}"
            assert "fake agent" in final_text, f"Expected agent response in: {final_text}"
