"""Tests for MainScreen transcript loading methods."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from claude_litter.screens.main import MainScreen
from claude_litter.services.team_service import TeamService


def _make_screen(tmp_path: Path) -> MainScreen:
    """Return a bare MainScreen with _team_service and _member_info populated."""
    screen = MainScreen.__new__(MainScreen)
    screen._team_service = TeamService(base_path=tmp_path)
    screen._member_info = {}
    return screen


def _mock_sv() -> MagicMock:
    """Return a SessionView mock that records append_output calls."""
    sv = MagicMock()
    sv._output_history = []

    def _append(text: str):
        sv._output_history.append(text)

    sv.append_output.side_effect = _append
    return sv


def _make_jsonl_entry(role: str, content) -> str:
    return json.dumps({"message": {"role": role, "content": content}}) + "\n"


# ---------------------------------------------------------------------------
# _find_agent_transcript
# ---------------------------------------------------------------------------


class TestFindAgentTranscript:
    """Unit tests for the _find_agent_transcript method."""

    def test_meta_json_sidecar_matches_agent_name(self, tmp_path: Path) -> None:
        """Strategy 1: .meta.json sidecar with agentType == agent name."""
        subagents_dir = tmp_path / "subagents"
        subagents_dir.mkdir()

        jsonl = subagents_dir / "agent-abc.jsonl"
        jsonl.write_text("")
        (subagents_dir / "agent-abc.meta.json").write_text(json.dumps({"agentType": "backend"}))

        result = _make_screen(tmp_path)._find_agent_transcript(subagents_dir, "backend")

        assert result == jsonl

    def test_meta_json_sidecar_wrong_agent_returns_none(self, tmp_path: Path) -> None:
        """Sidecar with a different agentType does not match."""
        subagents_dir = tmp_path / "subagents"
        subagents_dir.mkdir()

        (subagents_dir / "agent-abc.jsonl").write_text("")
        (subagents_dir / "agent-abc.meta.json").write_text(json.dumps({"agentType": "frontend"}))

        result = _make_screen(tmp_path)._find_agent_transcript(subagents_dir, "backend")

        assert result is None

    def test_first_line_heuristic_you_are_pattern(self, tmp_path: Path) -> None:
        """Strategy 2: first line contains 'You are \"<agent>\"'."""
        subagents_dir = tmp_path / "subagents"
        subagents_dir.mkdir()

        jsonl = subagents_dir / "agent-xyz.jsonl"
        jsonl.write_text(
            json.dumps({"message": {"role": "user", "content": 'You are "worker" agent.'}}) + "\n"
        )

        result = _make_screen(tmp_path)._find_agent_transcript(subagents_dir, "worker")

        assert result == jsonl

    def test_first_line_heuristic_teammate_id_pattern(self, tmp_path: Path) -> None:
        """Strategy 2: first line contains teammate_id=\"<agent>\"."""
        subagents_dir = tmp_path / "subagents"
        subagents_dir.mkdir()

        jsonl = subagents_dir / "agent-xyz.jsonl"
        jsonl.write_text(
            json.dumps({"message": {"role": "user", "content": 'teammate_id="analyst" stuff'}}) + "\n"
        )

        result = _make_screen(tmp_path)._find_agent_transcript(subagents_dir, "analyst")

        assert result == jsonl

    def test_empty_jsonl_is_skipped(self, tmp_path: Path) -> None:
        """An empty JSONL file without a sidecar is skipped gracefully."""
        subagents_dir = tmp_path / "subagents"
        subagents_dir.mkdir()
        (subagents_dir / "agent-empty.jsonl").write_text("")

        result = _make_screen(tmp_path)._find_agent_transcript(subagents_dir, "some-agent")

        assert result is None

    def test_corrupt_first_line_is_skipped(self, tmp_path: Path) -> None:
        """A JSONL file with a corrupt first line is skipped without raising."""
        subagents_dir = tmp_path / "subagents"
        subagents_dir.mkdir()
        (subagents_dir / "agent-bad.jsonl").write_text("{not json at all\n")

        result = _make_screen(tmp_path)._find_agent_transcript(subagents_dir, "some-agent")

        assert result is None

    def test_most_recent_file_wins_for_meta_match(self, tmp_path: Path) -> None:
        """When multiple sidecars match, the newest file is returned."""
        subagents_dir = tmp_path / "subagents"
        subagents_dir.mkdir()

        old_jsonl = subagents_dir / "agent-old.jsonl"
        old_jsonl.write_text("")
        (subagents_dir / "agent-old.meta.json").write_text(json.dumps({"agentType": "backend"}))

        new_jsonl = subagents_dir / "agent-new.jsonl"
        new_jsonl.write_text("")
        (subagents_dir / "agent-new.meta.json").write_text(json.dumps({"agentType": "backend"}))

        now = time.time()
        os.utime(old_jsonl, (now - 100, now - 100))
        os.utime(new_jsonl, (now, now))

        result = _make_screen(tmp_path)._find_agent_transcript(subagents_dir, "backend")

        assert result == new_jsonl


# ---------------------------------------------------------------------------
# _load_transcript_history — helpers
# ---------------------------------------------------------------------------


def _setup_team_with_lead(
    team_root: Path,
    team: str,
    lead_session_id: str,
    lead_agent_id: str | None = None,
) -> None:
    """Create a team directory with leadSessionId patched into its config."""
    ts = TeamService(base_path=team_root)
    ts.create_team(team, "test team")
    config_path = team_root / "teams" / team / "config.json"
    config = json.loads(config_path.read_text())
    config["leadSessionId"] = lead_session_id
    config["leadAgentId"] = lead_agent_id or f"team-lead@{team}"
    config_path.write_text(json.dumps(config))


def _make_project_dir(fake_home: Path, cwd: str, lead_session_id: str) -> tuple[Path, Path]:
    """Build ~/.claude/projects/<sanitized_cwd>/<session>/subagents under fake_home.

    Returns (project_dir, subagents_dir).
    """
    sanitized_cwd = "".join(c if c.isalnum() else "-" for c in cwd)[:200]
    project_dir = fake_home / ".claude" / "projects" / sanitized_cwd
    subagents_dir = project_dir / lead_session_id / "subagents"
    subagents_dir.mkdir(parents=True)
    return project_dir, subagents_dir


# ---------------------------------------------------------------------------
# _load_transcript_history tests
# ---------------------------------------------------------------------------


@pytest.fixture
def fake_home(tmp_path: Path, monkeypatch):
    """Patch Path.home() to point at tmp_path for the duration of each test."""
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    return tmp_path


class TestLoadTranscriptHistory:
    """Tests for _load_transcript_history using a fake home directory."""

    def _make_transcript_screen(
        self, team_root: Path, team: str, agent: str, cwd: str
    ) -> MainScreen:
        screen = MainScreen.__new__(MainScreen)
        screen._team_service = TeamService(base_path=team_root)
        screen._member_info = {(team, agent): {"cwd": cwd}}
        return screen

    def test_returns_false_when_no_cwd(self, tmp_path: Path) -> None:
        """No cwd set in _member_info → returns False immediately."""
        result = _make_screen(tmp_path)._load_transcript_history(_mock_sv(), "myteam", "worker")
        assert result is False

    def test_returns_false_when_project_dir_missing(self, fake_home: Path) -> None:
        """cwd is set but the project directory doesn't exist → returns False."""
        screen = _make_screen(fake_home)
        screen._member_info = {("myteam", "worker"): {"cwd": "/nonexistent/project/xyz"}}

        result = screen._load_transcript_history(_mock_sv(), "myteam", "worker")

        assert result is False

    def test_meta_json_sidecar_strategy(self, fake_home: Path) -> None:
        """Transcript is found via .meta.json sidecar and content is loaded."""
        cwd = "/tmp/myproject"
        team = "alpha"
        agent = "backend"
        lead_session_id = "lead-session-001"
        team_root = fake_home / "teams_root"

        _setup_team_with_lead(team_root, team, lead_session_id)
        _, subagents_dir = _make_project_dir(fake_home, cwd, lead_session_id)

        jsonl = subagents_dir / "agent-111.jsonl"
        jsonl.write_text(_make_jsonl_entry("assistant", [{"type": "text", "text": "Hello from backend"}]))
        (subagents_dir / "agent-111.meta.json").write_text(json.dumps({"agentType": "backend"}))

        screen = self._make_transcript_screen(team_root, team, agent, cwd)
        sv = _mock_sv()
        result = screen._load_transcript_history(sv, team, agent)

        assert result is True
        assert "Hello from backend" in " ".join(sv._output_history)

    def test_team_lead_fallback(self, fake_home: Path) -> None:
        """Falls back to the main session JSONL for the team-lead agent."""
        cwd = "/tmp/leadproject"
        team = "beta"
        lead_session_id = "lead-session-002"
        agent = "team-lead"
        team_root = fake_home / "teams_root"

        _setup_team_with_lead(team_root, team, lead_session_id, f"team-lead@{team}")

        sanitized_cwd = "".join(c if c.isalnum() else "-" for c in cwd)[:200]
        project_dir = fake_home / ".claude" / "projects" / sanitized_cwd
        project_dir.mkdir(parents=True)
        (project_dir / f"{lead_session_id}.jsonl").write_text(
            _make_jsonl_entry("user", "You are the lead agent")
            + _make_jsonl_entry("assistant", [{"type": "text", "text": "Lead response"}])
        )

        screen = self._make_transcript_screen(team_root, team, agent, cwd)
        sv = _mock_sv()
        result = screen._load_transcript_history(sv, team, agent)

        assert result is True
        assert "Lead response" in " ".join(sv._output_history)

    def test_corrupt_jsonl_lines_are_skipped(self, fake_home: Path) -> None:
        """Lines that are not valid JSON are skipped; valid ones are still loaded."""
        cwd = "/tmp/corruptproject"
        team = "gamma"
        agent = "checker"
        lead_session_id = "lead-session-003"
        team_root = fake_home / "teams_root"

        _setup_team_with_lead(team_root, team, lead_session_id)
        _, subagents_dir = _make_project_dir(fake_home, cwd, lead_session_id)

        jsonl = subagents_dir / "agent-222.jsonl"
        jsonl.write_text(
            "{this is not valid json}\n"
            + _make_jsonl_entry("assistant", [{"type": "text", "text": "Valid content"}])
        )
        (subagents_dir / "agent-222.meta.json").write_text(json.dumps({"agentType": "checker"}))

        screen = self._make_transcript_screen(team_root, team, agent, cwd)
        sv = _mock_sv()
        result = screen._load_transcript_history(sv, team, agent)

        assert result is True
        assert "Valid content" in " ".join(sv._output_history)

    def test_truncation_at_200_messages(self, fake_home: Path) -> None:
        """Transcript loading stops after 200 messages."""
        cwd = "/tmp/bigproject"
        team = "delta"
        agent = "cruncher"
        lead_session_id = "lead-session-004"
        team_root = fake_home / "teams_root"

        _setup_team_with_lead(team_root, team, lead_session_id)
        _, subagents_dir = _make_project_dir(fake_home, cwd, lead_session_id)

        jsonl = subagents_dir / "agent-333.jsonl"
        jsonl.write_text("".join(
            _make_jsonl_entry("assistant", [{"type": "text", "text": f"Message {i}"}])
            for i in range(210)
        ))
        (subagents_dir / "agent-333.meta.json").write_text(json.dumps({"agentType": "cruncher"}))

        screen = self._make_transcript_screen(team_root, team, agent, cwd)
        sv = _mock_sv()
        result = screen._load_transcript_history(sv, team, agent)

        assert result is True
        assert "truncated at 200 messages" in " ".join(sv._output_history)
