from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

from claude_litter.screens.main import MainScreen


def _make_screen(list_teams, get_team, list_tasks):
    """Build a minimal object that supports _build_team_context without a full Textual app."""
    obj = MagicMock(spec=MainScreen)
    obj._team_service = MagicMock()
    obj._team_service.list_teams.return_value = list_teams
    obj._team_service.get_team.side_effect = get_team
    obj._team_service.list_tasks.side_effect = list_tasks
    # Bind the real method to our mock object
    obj._build_team_context = MainScreen._build_team_context.__get__(obj, type(obj))
    return obj


# ---------------------------------------------------------------------------
# _build_team_context
# ---------------------------------------------------------------------------


class TestBuildTeamContext:
    def test_no_teams_returns_empty_string(self):
        obj = _make_screen([], lambda name: None, lambda name: [])
        assert obj._build_team_context() == ""

    def test_team_with_no_config_skipped(self):
        # Team exists but has no config — skipped in the loop.
        # The wrapper tags are still emitted (one team, no config → empty team-context block).
        obj = _make_screen(["alpha"], lambda name: None, lambda name: [])
        result = obj._build_team_context()
        assert "<team-context>" in result
        assert "Team: alpha" not in result

    def test_team_with_empty_members(self):
        def get_team(name):
            return {"members": []}

        obj = _make_screen(["alpha"], get_team, lambda name: [])
        result = obj._build_team_context()
        assert "<team-context>" in result
        assert "Team: alpha (0/0 active)" in result
        assert "</team-context>" in result

    def test_team_with_active_member_counts(self):
        members = [
            {"name": "agent-1", "status": "active", "model": "opus"},
            {"name": "agent-2", "status": "idle", "model": "sonnet"},
        ]

        def get_team(name):
            return {"members": members}

        obj = _make_screen(["myteam"], get_team, lambda name: [])
        result = obj._build_team_context()
        assert "Team: myteam (1/2 active)" in result

    def test_member_line_includes_name_status_model(self):
        members = [
            {"name": "bob", "status": "active", "model": "haiku"},
        ]

        def get_team(name):
            return {"members": members}

        obj = _make_screen(["t"], get_team, lambda name: [])
        result = obj._build_team_context()
        assert "bob [active] model=haiku" in result

    def test_member_with_agent_type(self):
        members = [
            {"name": "worker", "status": "active", "model": "sonnet", "agentType": "researcher"},
        ]

        def get_team(name):
            return {"members": members}

        obj = _make_screen(["t"], get_team, lambda name: [])
        result = obj._build_team_context()
        assert "type=researcher" in result

    def test_member_without_agent_type_omits_type_field(self):
        members = [
            {"name": "worker", "status": "active", "model": "sonnet"},
        ]

        def get_team(name):
            return {"members": members}

        obj = _make_screen(["t"], get_team, lambda name: [])
        result = obj._build_team_context()
        assert "type=" not in result

    def test_member_cwd_replaces_home(self):
        home = str(Path.home())
        members = [
            {"name": "w", "status": "active", "model": "sonnet", "cwd": f"{home}/projects/foo"},
        ]

        def get_team(name):
            return {"members": members}

        obj = _make_screen(["t"], get_team, lambda name: [])
        result = obj._build_team_context()
        assert "cwd=~/projects/foo" in result
        assert home not in result

    def test_member_cwd_non_home_path_kept_as_is(self):
        members = [
            {"name": "w", "status": "active", "model": "sonnet", "cwd": "/tmp/work"},
        ]

        def get_team(name):
            return {"members": members}

        obj = _make_screen(["t"], get_team, lambda name: [])
        result = obj._build_team_context()
        assert "cwd=/tmp/work" in result

    def test_tasks_summary_included_when_tasks_exist(self):
        tasks = [
            {"status": "completed"},
            {"status": "in_progress"},
            {"status": "pending"},
            {"status": "pending"},
        ]

        def get_team(name):
            return {"members": []}

        obj = _make_screen(["t"], get_team, lambda name: tasks)
        result = obj._build_team_context()
        assert "Tasks: 1 done, 1 in progress, 2 pending" in result

    def test_tasks_summary_omitted_when_no_tasks(self):
        def get_team(name):
            return {"members": []}

        obj = _make_screen(["t"], get_team, lambda name: [])
        result = obj._build_team_context()
        assert "Tasks:" not in result

    def test_multiple_teams_all_appear(self):
        configs = {
            "team-a": {"members": [{"name": "x", "status": "active", "model": "s"}]},
            "team-b": {"members": []},
        }

        def get_team(name):
            return configs.get(name)

        obj = _make_screen(["team-a", "team-b"], get_team, lambda name: [])
        result = obj._build_team_context()
        assert "Team: team-a" in result
        assert "Team: team-b" in result

    def test_output_wrapped_in_team_context_tags(self):
        def get_team(name):
            return {"members": []}

        obj = _make_screen(["t"], get_team, lambda name: [])
        result = obj._build_team_context()
        assert result.startswith("<team-context>")
        assert result.endswith("</team-context>")


# ---------------------------------------------------------------------------
# _build_context_summary
# ---------------------------------------------------------------------------


def _make_screen_for_context_summary(member_info, team_service_get_team, projects_dir):
    """Build a minimal object for _build_context_summary tests."""
    obj = MagicMock(spec=MainScreen)
    obj._member_info = member_info
    obj._team_service = MagicMock()
    obj._team_service.get_team.side_effect = team_service_get_team
    obj._build_context_summary = MainScreen._build_context_summary.__get__(obj, type(obj))
    # Patch Path.home() indirectly by using a tmp projects dir — the method constructs the path
    # from Path.home() / ".claude" / "projects", so we can't easily redirect it.
    # Instead we'll test the cases where it returns early.
    return obj


class TestBuildContextSummary:
    def test_returns_empty_when_no_cwd(self):
        obj = _make_screen_for_context_summary(
            member_info={("t", "a"): {"model": "sonnet"}},
            team_service_get_team=lambda name: None,
            projects_dir=None,
        )
        result = obj._build_context_summary("t", "a")
        assert result == ""

    def test_returns_empty_when_cwd_empty_string(self):
        obj = _make_screen_for_context_summary(
            member_info={("t", "a"): {"cwd": ""}},
            team_service_get_team=lambda name: None,
            projects_dir=None,
        )
        result = obj._build_context_summary("t", "a")
        assert result == ""

    def test_returns_empty_when_project_dir_not_exists(self, tmp_path):
        # cwd is valid but projects dir doesn't have the matching sanitized path
        cwd = str(tmp_path / "nonexistent-project")
        obj = _make_screen_for_context_summary(
            member_info={("t", "a"): {"cwd": cwd}},
            team_service_get_team=lambda name: {"leadSessionId": "sess-123"},
            projects_dir=tmp_path / "projects",
        )
        # The method looks under Path.home() / ".claude" / "projects" — not tmp_path,
        # so this will return "" because that path won't exist in CI/test environments
        # unless we happen to have the exact directory. This is just an early-exit test.
        result = obj._build_context_summary("t", "a")
        assert result == ""

    def test_returns_context_from_jsonl(self, tmp_path, monkeypatch):
        """Full integration: write a JSONL transcript and verify extraction."""
        cwd = "/home/testuser/myproject"
        agent = "coder"
        team = "myteam"
        session_id = "sess-abc"

        # Build the directory structure the method expects:
        # <projects_dir>/<sanitized_cwd>/<session_id>/subagents/agent-*.jsonl
        sanitized = "".join(c if c.isalnum() else "-" for c in cwd)
        projects_dir = tmp_path / ".claude" / "projects"
        subagents_dir = projects_dir / sanitized / session_id / "subagents"
        subagents_dir.mkdir(parents=True)

        # Write a JSONL file where the first line has the agent's teammate_id
        jsonl_path = subagents_dir / "agent-coder.jsonl"
        lines = [
            json.dumps({"message": {"content": f'teammate_id="{agent}" some init', "role": "user"}}),
            json.dumps({"message": {"role": "assistant", "content": [{"type": "text", "text": "Hello from coder"}]}}),
            json.dumps({"message": {"role": "assistant", "content": [{"type": "text", "text": "Second message"}]}}),
        ]
        jsonl_path.write_text("\n".join(lines) + "\n")

        # Monkeypatch Path.home() in the main module so the method finds our tmp dir
        import claude_litter.screens.main as main_module

        monkeypatch.setattr(main_module.Path, "home", staticmethod(lambda: tmp_path))

        obj = _make_screen_for_context_summary(
            member_info={(team, agent): {"cwd": cwd}},
            team_service_get_team=lambda name: {"leadSessionId": session_id},
            projects_dir=projects_dir,
        )

        result = obj._build_context_summary(team, agent)
        assert "Context from the source agent's recent work:" in result
        assert "Hello from coder" in result
        assert "Second message" in result
