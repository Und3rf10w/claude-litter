"""Tests for dialog screens."""

from __future__ import annotations

import pytest
from textual.app import App

from litter_tui.screens.create_team import CreateTeamScreen, validate_team_name
from litter_tui.screens.spawn_agent import SpawnAgentScreen
from litter_tui.screens.task_detail import TaskDetailScreen
from litter_tui.screens.settings import SettingsScreen


# ---------------------------------------------------------------------------
# validate_team_name unit tests (no app needed)
# ---------------------------------------------------------------------------


def test_validate_name_rejects_dotdot():
    assert validate_team_name("foo..bar") is not None


def test_validate_name_rejects_slash():
    assert validate_team_name("foo/bar") is not None


def test_validate_name_rejects_leading_dash():
    assert validate_team_name("-foo") is not None


def test_validate_name_rejects_too_long():
    assert validate_team_name("a" * 101) is not None


def test_validate_name_rejects_empty():
    assert validate_team_name("") is not None


def test_validate_name_accepts_valid():
    assert validate_team_name("my-team_1") is None


def test_validate_name_accepts_max_length():
    assert validate_team_name("a" * 100) is None


# ---------------------------------------------------------------------------
# Helper app that immediately pushes a screen on mount
# ---------------------------------------------------------------------------


class _ModalApp(App):
    def __init__(self, screen_factory, **kwargs):
        super().__init__(**kwargs)
        self._screen_factory = screen_factory
        self.dismissed_values: list = []

    def on_mount(self) -> None:
        screen = self._screen_factory()
        original_dismiss = screen.dismiss

        def _capture(result=None):
            self.dismissed_values.append(result)

        screen.dismiss = _capture  # type: ignore[method-assign]
        self.push_screen(screen)


def _sq(app: App, selector: str):
    """Query the active (top-most) screen."""
    return app.screen.query_one(selector)


# ---------------------------------------------------------------------------
# CreateTeamScreen
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_create_team_cancel_returns_none():
    app = _ModalApp(CreateTeamScreen)
    async with app.run_test(size=(120, 50)) as pilot:
        await pilot.pause()
        cancel_btn = _sq(app, "#cancel")
        await pilot.click(cancel_btn)
        await pilot.pause()
    assert app.dismissed_values == [None]


@pytest.mark.anyio
async def test_create_team_ok_without_name_shows_error():
    app = _ModalApp(CreateTeamScreen)
    async with app.run_test(size=(120, 50)) as pilot:
        await pilot.pause()
        ok_btn = _sq(app, "#ok")
        await pilot.click(ok_btn)
        await pilot.pause()
        error_text = str(_sq(app, "#name-error").content)
        assert error_text
    assert app.dismissed_values == []


@pytest.mark.anyio
async def test_create_team_invalid_name_shows_error():
    app = _ModalApp(CreateTeamScreen)
    async with app.run_test(size=(120, 50)) as pilot:
        await pilot.pause()
        await pilot.click(_sq(app, "#team-name"))
        await pilot.press("m", "y", "-", "t", "e", "a", "m")
        await pilot.click(_sq(app, "#ok"))
        await pilot.pause()
    assert len(app.dismissed_values) == 1
    result = app.dismissed_values[0]
    assert isinstance(result, dict)
    assert result["name"] == "my-team"
    assert "description" in result
    assert "auto_lead" in result
    assert "model" in result


@pytest.mark.anyio
async def test_create_team_invalid_name_shows_error():
    app = _ModalApp(CreateTeamScreen)
    async with app.run_test(size=(120, 50)) as pilot:
        await pilot.pause()
        await pilot.click(_sq(app, "#team-name"))
        await pilot.press(".", ".", "b", "a", "d")
        await pilot.click(_sq(app, "#ok"))
        await pilot.pause()
        error_text = str(_sq(app, "#name-error").content)
        assert error_text
    assert app.dismissed_values == []


# ---------------------------------------------------------------------------
# SpawnAgentScreen
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_spawn_agent_cancel_returns_none():
    app = _ModalApp(SpawnAgentScreen)
    async with app.run_test(size=(120, 50)) as pilot:
        await pilot.pause()
        await pilot.click(_sq(app, "#cancel"))
        await pilot.pause()
    assert app.dismissed_values == [None]


@pytest.mark.anyio
async def test_spawn_agent_ok_returns_dict():
    app = _ModalApp(SpawnAgentScreen)
    async with app.run_test(size=(120, 50)) as pilot:
        await pilot.pause()
        await pilot.click(_sq(app, "#agent-name"))
        await pilot.press("w", "o", "r", "k", "e", "r", "-", "1")
        await pilot.click(_sq(app, "#ok"))
        await pilot.pause()
    assert len(app.dismissed_values) == 1
    result = app.dismissed_values[0]
    assert isinstance(result, dict)
    assert result["name"] == "worker-1"
    assert "type" in result
    assert "model" in result
    assert "initial_prompt" in result


# ---------------------------------------------------------------------------
# TaskDetailScreen
# ---------------------------------------------------------------------------

_SAMPLE_TASK = {
    "id": "task-123",
    "subject": "Fix the bug",
    "description": "There is a bug",
    "status": "pending",
    "owner": "alice",
    "blocks": ["task-456"],
    "blockedBy": [],
}


@pytest.mark.anyio
async def test_task_detail_displays_task_data():
    app = _ModalApp(lambda: TaskDetailScreen(_SAMPLE_TASK))
    async with app.run_test(size=(120, 60)) as pilot:
        await pilot.pause()
        id_value = str(_sq(app, "#id-value").content)
        assert "task-123" in id_value


@pytest.mark.anyio
async def test_task_detail_cancel_returns_none():
    app = _ModalApp(lambda: TaskDetailScreen(_SAMPLE_TASK))
    async with app.run_test(size=(120, 60)) as pilot:
        await pilot.pause()
        await pilot.click(_sq(app, "#cancel"))
        await pilot.pause()
    assert app.dismissed_values == [None]


@pytest.mark.anyio
async def test_task_detail_save_returns_updated_dict():
    app = _ModalApp(lambda: TaskDetailScreen(_SAMPLE_TASK))
    async with app.run_test(size=(120, 60)) as pilot:
        await pilot.pause()
        await pilot.click(_sq(app, "#edit"))
        await pilot.pause()
        await pilot.click(_sq(app, "#subject-input"))
        # Select all and replace with new subject
        subject_widget = _sq(app, "#subject-input")
        subject_widget.value = ""  # type: ignore[attr-defined]
        await pilot.pause()
        await pilot.press("N", "e", "w", " ", "S", "u", "b", "j", "e", "c", "t")
        await pilot.click(_sq(app, "#save"))
        await pilot.pause()
    assert len(app.dismissed_values) == 1
    result = app.dismissed_values[0]
    assert isinstance(result, dict)
    assert result["subject"] == "New Subject"


# ---------------------------------------------------------------------------
# SettingsScreen
# ---------------------------------------------------------------------------


class _SettingsApp(App):
    def on_mount(self) -> None:
        self.push_screen(SettingsScreen())


@pytest.mark.anyio
async def test_settings_vim_toggle():
    app = _SettingsApp()
    async with app.run_test(size=(120, 50)) as pilot:
        await pilot.pause()
        switch = app.screen.query_one("#vim-mode")
        initial = switch.value
        await pilot.click(switch)
        await pilot.pause()
        assert switch.value != initial


# ---------------------------------------------------------------------------
# MainScreen._build_team_context
# ---------------------------------------------------------------------------


def test_build_team_context_no_teams(tmp_path):
    """_build_team_context returns empty string when no teams exist."""
    from litter_tui.screens.main import MainScreen
    from litter_tui.services.team_service import TeamService

    ts = TeamService(base_path=tmp_path)
    screen = MainScreen.__new__(MainScreen)
    screen._team_service = ts
    assert screen._build_team_context() == ""


def test_build_team_context_with_teams(tmp_path):
    """_build_team_context returns formatted team/agent info."""
    from litter_tui.screens.main import MainScreen
    from litter_tui.services.team_service import TeamService

    ts = TeamService(base_path=tmp_path)
    ts.create_team("alpha", "Test team")
    ts.add_member("alpha", {
        "agentId": "a1",
        "name": "backend",
        "model": "sonnet",
        "status": "active",
        "agentType": "worker",
        "cwd": "/tmp/project",
    })
    ts.add_member("alpha", {
        "agentId": "a2",
        "name": "frontend",
        "model": "haiku",
        "status": "idle",
    })

    # Add a task
    ts.create_task("alpha", "Fix bug", "Fix the login bug")

    screen = MainScreen.__new__(MainScreen)
    screen._team_service = ts

    ctx = screen._build_team_context()
    assert "<team-context>" in ctx
    assert "</team-context>" in ctx
    assert "Team: alpha" in ctx
    assert "backend" in ctx
    assert "frontend" in ctx
    assert "model=sonnet" in ctx
    assert "model=haiku" in ctx
    assert "type=worker" in ctx
    assert "pending" in ctx.lower()
