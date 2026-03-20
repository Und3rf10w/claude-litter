"""Tests for dialog screens."""

from __future__ import annotations

import pytest
from textual.app import App

from litter_tui.screens.create_team import CreateTeamScreen, validate_team_name
from litter_tui.screens.spawn_agent import SpawnAgentScreen
from litter_tui.screens.task_detail import TaskDetailScreen
from litter_tui.screens.settings import SettingsScreen
from litter_tui.screens.duplicate_agent import DuplicateAgentScreen
from litter_tui.screens.configure_agent import ConfigureAgentScreen, _normalize_model
from litter_tui.screens.confirm import ConfirmScreen
from litter_tui.screens.rename_team import RenameTeamScreen
from litter_tui.screens.broadcast_message import BroadcastMessageScreen


# ---------------------------------------------------------------------------
# _normalize_model unit tests (no app needed)
# ---------------------------------------------------------------------------


def test_normalize_model_short_names():
    assert _normalize_model("haiku") == "haiku"
    assert _normalize_model("sonnet") == "sonnet"
    assert _normalize_model("opus") == "opus"


def test_normalize_model_full_bedrock_string():
    assert _normalize_model("bedrock:global.anthropic.claude-sonnet-4-5-20250929-v1:0") == "sonnet"
    assert _normalize_model("bedrock:global.anthropic.claude-opus-4-6-v1:0") == "opus"
    assert _normalize_model("bedrock:global.anthropic.claude-haiku-4-5-20251001-v1:0") == "haiku"


def test_normalize_model_api_model_ids():
    assert _normalize_model("claude-opus-4-6") == "opus"
    assert _normalize_model("claude-sonnet-4-6") == "sonnet"
    assert _normalize_model("claude-haiku-4-5-20251001") == "haiku"


def test_normalize_model_unknown_defaults_to_sonnet():
    assert _normalize_model("") == "sonnet"
    assert _normalize_model("some-unknown-model") == "sonnet"


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


# ---------------------------------------------------------------------------
# DuplicateAgentScreen
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_duplicate_agent_cancel_returns_none():
    app = _ModalApp(lambda: DuplicateAgentScreen(
        source_team="alpha", source_agent="worker-1",
        all_teams=["alpha", "beta"], source_model="sonnet",
    ))
    async with app.run_test(size=(120, 60)) as pilot:
        await pilot.pause()
        await pilot.click(_sq(app, "#cancel"))
        await pilot.pause()
    assert app.dismissed_values == [None]


@pytest.mark.anyio
async def test_duplicate_agent_prefilled_name():
    app = _ModalApp(lambda: DuplicateAgentScreen(
        source_team="alpha", source_agent="worker-1",
        all_teams=["alpha", "beta"], source_model="opus",
    ))
    async with app.run_test(size=(120, 60)) as pilot:
        await pilot.pause()
        name_input = _sq(app, "#agent-name")
        assert name_input.value == "worker-1-copy"


@pytest.mark.anyio
async def test_duplicate_agent_ok_returns_dict():
    app = _ModalApp(lambda: DuplicateAgentScreen(
        source_team="alpha", source_agent="worker-1",
        all_teams=["alpha", "beta"], source_model="sonnet",
    ))
    async with app.run_test(size=(120, 60)) as pilot:
        await pilot.pause()
        await pilot.click(_sq(app, "#ok"))
        await pilot.pause()
    assert len(app.dismissed_values) == 1
    result = app.dismissed_values[0]
    assert isinstance(result, dict)
    assert result["target_team"] == "beta"
    assert result["new_name"] == "worker-1-copy"
    assert result["model"] == "sonnet"
    assert result["color"] == ""  # default when no source_color
    assert result["agentType"] == "worker"  # default when no source_type
    assert result["copy_inbox"] is False
    assert result["copy_context"] is False


@pytest.mark.anyio
async def test_duplicate_agent_invalid_name_shows_error():
    app = _ModalApp(lambda: DuplicateAgentScreen(
        source_team="alpha", source_agent="worker-1",
        all_teams=["alpha", "beta"], source_model="sonnet",
    ))
    async with app.run_test(size=(120, 60)) as pilot:
        await pilot.pause()
        name_input = _sq(app, "#agent-name")
        name_input.value = ""
        await pilot.pause()
        await pilot.click(_sq(app, "#ok"))
        await pilot.pause()
        error_text = str(_sq(app, "#name-error").content)
        assert error_text
    assert app.dismissed_values == []


@pytest.mark.anyio
async def test_duplicate_agent_no_other_teams_disables_ok():
    app = _ModalApp(lambda: DuplicateAgentScreen(
        source_team="alpha", source_agent="worker-1",
        all_teams=["alpha"],  # only source team
        source_model="sonnet",
    ))
    async with app.run_test(size=(120, 60)) as pilot:
        await pilot.pause()
        ok_btn = _sq(app, "#ok")
        assert ok_btn.disabled


@pytest.mark.anyio
async def test_duplicate_agent_full_model_string():
    """DuplicateAgentScreen should handle full model strings like 'claude-opus-4-6'."""
    app = _ModalApp(lambda: DuplicateAgentScreen(
        source_team="alpha", source_agent="worker-1",
        all_teams=["alpha", "beta"],
        source_model="claude-opus-4-6",
    ))
    async with app.run_test(size=(120, 60)) as pilot:
        await pilot.pause()
        assert _sq(app, "#model").value == "opus"


@pytest.mark.anyio
async def test_duplicate_agent_bedrock_model_string():
    """DuplicateAgentScreen should handle Bedrock model strings."""
    app = _ModalApp(lambda: DuplicateAgentScreen(
        source_team="alpha", source_agent="worker-1",
        all_teams=["alpha", "beta"],
        source_model="bedrock:global.anthropic.claude-sonnet-4-5-20250929-v1:0",
    ))
    async with app.run_test(size=(120, 60)) as pilot:
        await pilot.pause()
        assert _sq(app, "#model").value == "sonnet"


@pytest.mark.anyio
async def test_duplicate_agent_inherits_color_and_type():
    """DuplicateAgentScreen should pre-fill color and agentType from source."""
    app = _ModalApp(lambda: DuplicateAgentScreen(
        source_team="alpha", source_agent="worker-1",
        all_teams=["alpha", "beta"], source_model="sonnet",
        source_color="green", source_type="tester",
    ))
    async with app.run_test(size=(120, 60)) as pilot:
        await pilot.pause()
        assert _sq(app, "#color").value == "green"
        assert _sq(app, "#agent-type").value == "tester"


@pytest.mark.anyio
async def test_duplicate_agent_unknown_color_defaults_to_none():
    """DuplicateAgentScreen should handle unknown color values."""
    app = _ModalApp(lambda: DuplicateAgentScreen(
        source_team="alpha", source_agent="worker-1",
        all_teams=["alpha", "beta"], source_model="sonnet",
        source_color="magenta",
    ))
    async with app.run_test(size=(120, 60)) as pilot:
        await pilot.pause()
        assert _sq(app, "#color").value == ""


@pytest.mark.anyio
async def test_duplicate_agent_unknown_type_defaults_to_worker():
    """DuplicateAgentScreen should handle unknown agentType values."""
    app = _ModalApp(lambda: DuplicateAgentScreen(
        source_team="alpha", source_agent="worker-1",
        all_teams=["alpha", "beta"], source_model="sonnet",
        source_type="custom-role",
    ))
    async with app.run_test(size=(120, 60)) as pilot:
        await pilot.pause()
        assert _sq(app, "#agent-type").value == "worker"


# ---------------------------------------------------------------------------
# ConfigureAgentScreen
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_configure_agent_cancel_returns_none():
    app = _ModalApp(lambda: ConfigureAgentScreen(
        team="alpha", agent_name="worker-1",
        current={"name": "worker-1", "model": "sonnet", "color": "blue", "agentType": "worker"},
    ))
    async with app.run_test(size=(120, 60)) as pilot:
        await pilot.pause()
        await pilot.click(_sq(app, "#cancel"))
        await pilot.pause()
    assert app.dismissed_values == [None]


@pytest.mark.anyio
async def test_configure_agent_prefilled_values():
    current = {"name": "worker-1", "model": "opus", "color": "green", "agentType": "tester"}
    app = _ModalApp(lambda: ConfigureAgentScreen(
        team="alpha", agent_name="worker-1", current=current,
    ))
    async with app.run_test(size=(120, 60)) as pilot:
        await pilot.pause()
        assert _sq(app, "#agent-name").value == "worker-1"
        assert _sq(app, "#model").value == "opus"
        assert _sq(app, "#color").value == "green"
        assert _sq(app, "#agent-type").value == "tester"


@pytest.mark.anyio
async def test_configure_agent_ok_returns_changed_fields():
    current = {"name": "worker-1", "model": "sonnet", "color": "", "agentType": "worker"}
    app = _ModalApp(lambda: ConfigureAgentScreen(
        team="alpha", agent_name="worker-1", current=current,
    ))
    async with app.run_test(size=(120, 60)) as pilot:
        await pilot.pause()
        await pilot.click(_sq(app, "#ok"))
        await pilot.pause()
    assert len(app.dismissed_values) == 1
    result = app.dismissed_values[0]
    assert isinstance(result, dict)
    assert result["name"] == "worker-1"
    assert result["model"] == "sonnet"
    assert "color" in result
    assert "agentType" in result


@pytest.mark.anyio
async def test_configure_agent_full_model_string():
    """ConfigureAgentScreen should handle full model strings like 'claude-opus-4-6'."""
    current = {"name": "worker-1", "model": "claude-opus-4-6", "color": "blue", "agentType": "worker"}
    app = _ModalApp(lambda: ConfigureAgentScreen(
        team="alpha", agent_name="worker-1", current=current,
    ))
    async with app.run_test(size=(120, 60)) as pilot:
        await pilot.pause()
        assert _sq(app, "#model").value == "opus"


@pytest.mark.anyio
async def test_configure_agent_bedrock_model_string():
    """ConfigureAgentScreen should handle Bedrock model strings."""
    current = {
        "name": "worker-1",
        "model": "bedrock:global.anthropic.claude-sonnet-4-5-20250929-v1:0",
        "color": "green",
        "agentType": "tester",
    }
    app = _ModalApp(lambda: ConfigureAgentScreen(
        team="alpha", agent_name="worker-1", current=current,
    ))
    async with app.run_test(size=(120, 60)) as pilot:
        await pilot.pause()
        assert _sq(app, "#model").value == "sonnet"


@pytest.mark.anyio
async def test_configure_agent_unknown_color_defaults_to_none():
    """ConfigureAgentScreen should handle unknown color values."""
    current = {"name": "worker-1", "model": "sonnet", "color": "magenta", "agentType": "worker"}
    app = _ModalApp(lambda: ConfigureAgentScreen(
        team="alpha", agent_name="worker-1", current=current,
    ))
    async with app.run_test(size=(120, 60)) as pilot:
        await pilot.pause()
        assert _sq(app, "#color").value == ""


@pytest.mark.anyio
async def test_configure_agent_unknown_type_defaults_to_worker():
    """ConfigureAgentScreen should handle unknown agentType values."""
    current = {"name": "worker-1", "model": "sonnet", "color": "", "agentType": "custom-role"}
    app = _ModalApp(lambda: ConfigureAgentScreen(
        team="alpha", agent_name="worker-1", current=current,
    ))
    async with app.run_test(size=(120, 60)) as pilot:
        await pilot.pause()
        assert _sq(app, "#agent-type").value == "worker"


# ---------------------------------------------------------------------------
# ConfirmScreen
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_confirm_screen_yes():
    app = _ModalApp(lambda: ConfirmScreen("Delete everything?"))
    async with app.run_test(size=(120, 50)) as pilot:
        await pilot.pause()
        await pilot.click(_sq(app, "#yes"))
        await pilot.pause()
    assert app.dismissed_values == [True]


@pytest.mark.anyio
async def test_confirm_screen_no():
    app = _ModalApp(lambda: ConfirmScreen("Delete everything?"))
    async with app.run_test(size=(120, 50)) as pilot:
        await pilot.pause()
        await pilot.click(_sq(app, "#no"))
        await pilot.pause()
    assert app.dismissed_values == [False]


@pytest.mark.anyio
async def test_confirm_screen_custom_labels():
    app = _ModalApp(lambda: ConfirmScreen("Sure?", yes_label="Do it", no_label="Nope"))
    async with app.run_test(size=(120, 50)) as pilot:
        await pilot.pause()
        yes_btn = _sq(app, "#yes")
        assert "Do it" in str(yes_btn.label)


# ---------------------------------------------------------------------------
# RenameTeamScreen
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_rename_team_cancel_returns_none():
    app = _ModalApp(lambda: RenameTeamScreen("old-team"))
    async with app.run_test(size=(120, 50)) as pilot:
        await pilot.pause()
        await pilot.click(_sq(app, "#cancel"))
        await pilot.pause()
    assert app.dismissed_values == [None]


@pytest.mark.anyio
async def test_rename_team_same_name_returns_none():
    """Submitting the same name should dismiss with None."""
    app = _ModalApp(lambda: RenameTeamScreen("old-team"))
    async with app.run_test(size=(120, 50)) as pilot:
        await pilot.pause()
        await pilot.click(_sq(app, "#ok"))
        await pilot.pause()
    assert app.dismissed_values == [None]


@pytest.mark.anyio
async def test_rename_team_valid_new_name():
    app = _ModalApp(lambda: RenameTeamScreen("old-team"))
    async with app.run_test(size=(120, 50)) as pilot:
        await pilot.pause()
        name_input = _sq(app, "#team-name")
        name_input.value = ""
        await pilot.pause()
        await pilot.click(name_input)
        await pilot.press("n", "e", "w")
        await pilot.click(_sq(app, "#ok"))
        await pilot.pause()
    assert len(app.dismissed_values) == 1
    assert app.dismissed_values[0] == "new"


@pytest.mark.anyio
async def test_rename_team_invalid_name_shows_error():
    app = _ModalApp(lambda: RenameTeamScreen("old-team"))
    async with app.run_test(size=(120, 50)) as pilot:
        await pilot.pause()
        name_input = _sq(app, "#team-name")
        name_input.value = ""
        await pilot.pause()
        await pilot.click(name_input)
        await pilot.press(".", ".", "b", "a", "d")
        await pilot.click(_sq(app, "#ok"))
        await pilot.pause()
        error_text = str(_sq(app, "#name-error").content)
        assert error_text
    assert app.dismissed_values == []


@pytest.mark.anyio
async def test_rename_team_prefilled():
    app = _ModalApp(lambda: RenameTeamScreen("my-team"))
    async with app.run_test(size=(120, 50)) as pilot:
        await pilot.pause()
        assert _sq(app, "#team-name").value == "my-team"


# ---------------------------------------------------------------------------
# BroadcastMessageScreen
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_broadcast_cancel_returns_none():
    app = _ModalApp(lambda: BroadcastMessageScreen("alpha"))
    async with app.run_test(size=(120, 50)) as pilot:
        await pilot.pause()
        await pilot.click(_sq(app, "#cancel"))
        await pilot.pause()
    assert app.dismissed_values == [None]


@pytest.mark.anyio
async def test_broadcast_empty_shows_error():
    app = _ModalApp(lambda: BroadcastMessageScreen("alpha"))
    async with app.run_test(size=(120, 50)) as pilot:
        await pilot.pause()
        await pilot.click(_sq(app, "#ok"))
        await pilot.pause()
        error_text = str(_sq(app, "#msg-error").content)
        assert error_text
    assert app.dismissed_values == []


@pytest.mark.anyio
async def test_broadcast_with_text():
    app = _ModalApp(lambda: BroadcastMessageScreen("alpha"))
    async with app.run_test(size=(120, 50)) as pilot:
        await pilot.pause()
        ta = _sq(app, "#broadcast-text")
        await pilot.click(ta)
        await pilot.press("H", "i", " ", "a", "l", "l")
        await pilot.click(_sq(app, "#ok"))
        await pilot.pause()
    assert len(app.dismissed_values) == 1
    assert app.dismissed_values[0] == "Hi all"


# ------------------------------------------------------------------ #
#  _format_inbox_text (MainScreen static method)
# ------------------------------------------------------------------ #


class TestFormatInboxText:
    """Test structured message formatting."""

    @staticmethod
    def _fmt(text: str) -> str:
        from litter_tui.screens.main import MainScreen
        return MainScreen._format_inbox_text(text)

    def test_plain_text_passthrough(self) -> None:
        assert self._fmt("Hello world") == "Hello world"

    def test_idle_notification_returns_empty(self) -> None:
        assert self._fmt('{"type":"idle_notification","from":"w1"}') == ""

    def test_task_assignment_formatted(self) -> None:
        msg = '{"type":"task_assignment","taskId":"10","subject":"Explore Jobs","description":"Deep exploration of Jobs system"}'
        result = self._fmt(msg)
        assert "[Task #10]" in result
        assert "Explore Jobs" in result
        assert "Deep exploration" in result

    def test_task_completed_formatted(self) -> None:
        msg = '{"type":"task_completed","taskId":"5","subject":"Done"}'
        result = self._fmt(msg)
        assert "Task #5 completed" in result

    def test_invalid_json_passthrough(self) -> None:
        assert self._fmt("{not json") == "{not json"

    def test_unknown_type_shows_json(self) -> None:
        result = self._fmt('{"type":"custom","data":"hello"}')
        assert "[custom]" in result
