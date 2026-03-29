"""Tests for _parse_change_path and _read_last_entry in state.py."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from claude_litter.services.state import (
    InboxUpdated,
    TaskUpdated,
    TeamUpdated,
    _parse_change_path,
    _read_last_entry,
)


# ---------------------------------------------------------------------------
# TestParseChangePath
# ---------------------------------------------------------------------------


class TestParseChangePath:
    @pytest.fixture()
    def dirs(self, tmp_path: Path) -> tuple[Path, Path]:
        """Return (teams_dir, tasks_dir) under a temp base."""
        base = tmp_path / ".claude"
        teams_dir = base / "teams"
        tasks_dir = base / "tasks"
        teams_dir.mkdir(parents=True)
        tasks_dir.mkdir(parents=True)
        return teams_dir, tasks_dir

    # ------------------------------------------------------------------
    # Team changes
    # ------------------------------------------------------------------

    def test_team_config_json(self, dirs: tuple[Path, Path]) -> None:
        teams_dir, tasks_dir = dirs
        changed = teams_dir / "alpha" / "config.json"
        result = _parse_change_path(changed, teams_dir, tasks_dir)
        assert isinstance(result, TeamUpdated)
        assert result.team_name == "alpha"

    def test_team_dir_itself(self, dirs: tuple[Path, Path]) -> None:
        teams_dir, tasks_dir = dirs
        changed = teams_dir / "alpha"
        result = _parse_change_path(changed, teams_dir, tasks_dir)
        assert isinstance(result, TeamUpdated)
        assert result.team_name == "alpha"

    def test_team_unknown_file_returns_none(self, dirs: tuple[Path, Path]) -> None:
        """Files at depth > 2 with unknown structure return None."""
        teams_dir, tasks_dir = dirs
        changed = teams_dir / "alpha" / "some" / "nested" / "file.json"
        result = _parse_change_path(changed, teams_dir, tasks_dir)
        assert result is None

    # ------------------------------------------------------------------
    # Task changes
    # ------------------------------------------------------------------

    def test_task_file(self, dirs: tuple[Path, Path]) -> None:
        teams_dir, tasks_dir = dirs
        changed = tasks_dir / "alpha" / "task-42.json"
        result = _parse_change_path(changed, teams_dir, tasks_dir)
        assert isinstance(result, TaskUpdated)
        assert result.team_name == "alpha"
        assert result.task_id == "task-42"

    def test_task_file_stem_stripped(self, dirs: tuple[Path, Path]) -> None:
        """task_id should be the stem (no .json extension)."""
        teams_dir, tasks_dir = dirs
        changed = tasks_dir / "beta" / "some-task.json"
        result = _parse_change_path(changed, teams_dir, tasks_dir)
        assert isinstance(result, TaskUpdated)
        assert result.task_id == "some-task"

    def test_task_dotfile_suppressed(self, dirs: tuple[Path, Path]) -> None:
        teams_dir, tasks_dir = dirs
        changed = tasks_dir / "alpha" / ".DS_Store"
        result = _parse_change_path(changed, teams_dir, tasks_dir)
        assert result is None

    def test_task_dotfile_with_extension_suppressed(self, dirs: tuple[Path, Path]) -> None:
        teams_dir, tasks_dir = dirs
        changed = tasks_dir / "alpha" / ".hidden.json"
        result = _parse_change_path(changed, teams_dir, tasks_dir)
        assert result is None

    def test_task_dir_only_returns_none(self, dirs: tuple[Path, Path]) -> None:
        """Only depth-2 paths (team/file) are valid; depth-1 returns None."""
        teams_dir, tasks_dir = dirs
        changed = tasks_dir / "alpha"
        result = _parse_change_path(changed, teams_dir, tasks_dir)
        assert result is None

    # ------------------------------------------------------------------
    # Inbox changes
    # ------------------------------------------------------------------

    def test_inbox_file(self, dirs: tuple[Path, Path]) -> None:
        teams_dir, tasks_dir = dirs
        changed = teams_dir / "alpha" / "inboxes" / "bot.json"
        result = _parse_change_path(changed, teams_dir, tasks_dir)
        assert isinstance(result, InboxUpdated)
        assert result.team_name == "alpha"
        assert result.agent_name == "bot"

    def test_inbox_stem_stripped(self, dirs: tuple[Path, Path]) -> None:
        """agent_name should be the stem (no .json extension)."""
        teams_dir, tasks_dir = dirs
        changed = teams_dir / "myteam" / "inboxes" / "worker-agent.json"
        result = _parse_change_path(changed, teams_dir, tasks_dir)
        assert isinstance(result, InboxUpdated)
        assert result.agent_name == "worker-agent"

    # ------------------------------------------------------------------
    # Non-team / unrelated paths
    # ------------------------------------------------------------------

    def test_unrelated_path_returns_none(self, dirs: tuple[Path, Path]) -> None:
        teams_dir, tasks_dir = dirs
        changed = teams_dir.parent / "projects" / "some_proj" / "chat.jsonl"
        result = _parse_change_path(changed, teams_dir, tasks_dir)
        assert result is None

    def test_completely_different_path_returns_none(self, tmp_path: Path, dirs: tuple[Path, Path]) -> None:
        teams_dir, tasks_dir = dirs
        changed = tmp_path / "unrelated" / "file.txt"
        result = _parse_change_path(changed, teams_dir, tasks_dir)
        assert result is None

    # ------------------------------------------------------------------
    # Special characters in team name
    # ------------------------------------------------------------------

    def test_team_name_with_spaces(self, dirs: tuple[Path, Path]) -> None:
        teams_dir, tasks_dir = dirs
        changed = teams_dir / "my team" / "config.json"
        result = _parse_change_path(changed, teams_dir, tasks_dir)
        assert isinstance(result, TeamUpdated)
        assert result.team_name == "my team"

    def test_team_name_with_special_chars(self, dirs: tuple[Path, Path]) -> None:
        teams_dir, tasks_dir = dirs
        changed = teams_dir / "team-alpha_01" / "config.json"
        result = _parse_change_path(changed, teams_dir, tasks_dir)
        assert isinstance(result, TeamUpdated)
        assert result.team_name == "team-alpha_01"

    def test_task_team_name_with_spaces(self, dirs: tuple[Path, Path]) -> None:
        teams_dir, tasks_dir = dirs
        changed = tasks_dir / "my team" / "task-1.json"
        result = _parse_change_path(changed, teams_dir, tasks_dir)
        assert isinstance(result, TaskUpdated)
        assert result.team_name == "my team"


# ---------------------------------------------------------------------------
# TestReadLastEntry
# ---------------------------------------------------------------------------


class TestReadLastEntry:
    """Tests for _read_last_entry(path) -> tuple[str, bool].

    Returns (tool_name, is_idle):
      - tool_name: name of the active tool, or "" when none
      - is_idle: True when the agent has finished its turn
    """

    def _write_jsonl(self, path: Path, lines: list[dict]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "\n".join(json.dumps(line) for line in lines) + "\n",
            encoding="utf-8",
        )

    def test_empty_file_returns_idle(self, tmp_path: Path) -> None:
        p = tmp_path / "transcript.jsonl"
        p.write_text("", encoding="utf-8")
        tool_name, is_idle = _read_last_entry(p)
        assert tool_name == ""
        assert is_idle is True

    def test_nonexistent_file_returns_not_idle(self, tmp_path: Path) -> None:
        # Can't open -> conservative: assume working (not idle)
        p = tmp_path / "missing.jsonl"
        tool_name, is_idle = _read_last_entry(p)
        assert tool_name == ""
        assert is_idle is False

    def test_assistant_end_turn_is_idle(self, tmp_path: Path) -> None:
        p = tmp_path / "transcript.jsonl"
        entry = {
            "type": "assistant",
            "message": {"stop_reason": "end_turn", "content": []},
        }
        self._write_jsonl(p, [entry])
        tool_name, is_idle = _read_last_entry(p)
        assert tool_name == ""
        assert is_idle is True

    def test_assistant_tool_use_returns_tool_name(self, tmp_path: Path) -> None:
        p = tmp_path / "transcript.jsonl"
        entry = {
            "type": "assistant",
            "message": {
                "stop_reason": "tool_use",
                "content": [
                    {"type": "text", "text": "Doing something..."},
                    {"type": "tool_use", "name": "Bash", "id": "tu_1"},
                ],
            },
        }
        self._write_jsonl(p, [entry])
        tool_name, is_idle = _read_last_entry(p)
        assert tool_name == "Bash"
        assert is_idle is False

    def test_assistant_tool_use_picks_last_block(self, tmp_path: Path) -> None:
        # Multiple tool_use blocks -- content is scanned in reverse, so last wins
        p = tmp_path / "transcript.jsonl"
        entry = {
            "type": "assistant",
            "message": {
                "stop_reason": "tool_use",
                "content": [
                    {"type": "tool_use", "name": "Read", "id": "tu_1"},
                    {"type": "tool_use", "name": "Edit", "id": "tu_2"},
                ],
            },
        }
        self._write_jsonl(p, [entry])
        tool_name, is_idle = _read_last_entry(p)
        assert tool_name == "Edit"
        assert is_idle is False

    def test_assistant_no_tool_use_not_idle(self, tmp_path: Path) -> None:
        # Streaming/thinking: assistant entry with content but no tool_use and no end_turn
        p = tmp_path / "transcript.jsonl"
        entry = {
            "type": "assistant",
            "message": {
                "content": [{"type": "text", "text": "Thinking..."}],
            },
        }
        self._write_jsonl(p, [entry])
        tool_name, is_idle = _read_last_entry(p)
        assert tool_name == ""
        assert is_idle is False

    def test_user_tool_result_not_idle(self, tmp_path: Path) -> None:
        p = tmp_path / "transcript.jsonl"
        entry = {
            "type": "user",
            "message": {
                "content": [
                    {"type": "tool_result", "tool_use_id": "tu_1", "content": "ok"},
                ]
            },
        }
        self._write_jsonl(p, [entry])
        tool_name, is_idle = _read_last_entry(p)
        assert tool_name == ""
        assert is_idle is False

    def test_user_text_not_idle(self, tmp_path: Path) -> None:
        p = tmp_path / "transcript.jsonl"
        entry = {
            "type": "user",
            "message": {"content": "Hello agent"},
        }
        self._write_jsonl(p, [entry])
        tool_name, is_idle = _read_last_entry(p)
        assert tool_name == ""
        assert is_idle is False

    def test_system_turn_duration_is_idle(self, tmp_path: Path) -> None:
        p = tmp_path / "transcript.jsonl"
        entry = {"type": "system", "subtype": "turn_duration", "duration_ms": 1234}
        self._write_jsonl(p, [entry])
        tool_name, is_idle = _read_last_entry(p)
        assert tool_name == ""
        assert is_idle is True

    def test_reads_only_last_line(self, tmp_path: Path) -> None:
        # Earlier lines should be ignored; only the last line determines state
        p = tmp_path / "transcript.jsonl"
        lines = [
            # First line: agent was using a tool
            {
                "type": "assistant",
                "message": {
                    "stop_reason": "tool_use",
                    "content": [{"type": "tool_use", "name": "Read", "id": "tu_1"}],
                },
            },
            # Last line: agent finished (end_turn -> idle)
            {
                "type": "assistant",
                "message": {"stop_reason": "end_turn", "content": []},
            },
        ]
        self._write_jsonl(p, lines)
        tool_name, is_idle = _read_last_entry(p)
        assert tool_name == ""
        assert is_idle is True

    def test_malformed_json_on_last_line_does_not_crash(self, tmp_path: Path) -> None:
        # Invalid JSON on the last line -> exception path -> ("", False)
        p = tmp_path / "transcript.jsonl"
        valid_line = json.dumps(
            {"type": "assistant", "message": {"stop_reason": "end_turn", "content": []}}
        )
        p.write_text(valid_line + "\n{this is not json\n", encoding="utf-8")
        tool_name, is_idle = _read_last_entry(p)
        assert tool_name == ""
        assert is_idle is False

    def test_unknown_type_not_idle(self, tmp_path: Path) -> None:
        p = tmp_path / "transcript.jsonl"
        entry = {"type": "some_unknown_type", "data": "whatever"}
        self._write_jsonl(p, [entry])
        tool_name, is_idle = _read_last_entry(p)
        assert tool_name == ""
        assert is_idle is False
