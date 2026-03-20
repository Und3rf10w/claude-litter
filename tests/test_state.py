"""Tests for StateManager."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from claude_litter.services.state import StateManager


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


def _team_config(name: str, **extra: object) -> dict:
    return {
        "name": name,
        "description": "Test team",
        "createdAt": 1000,
        "leadAgentId": "lead-uuid",
        "leadSessionId": "sess-1",
        "members": [],
        **extra,
    }


def _task_dict(task_id: str, subject: str = "Do something", status: str = "pending") -> dict:
    return {
        "id": task_id,
        "subject": subject,
        "description": "desc",
        "status": status,
        "blocks": [],
        "blockedBy": [],
    }


def _message_dict(msg_id: str, sender: str = "alice", text: str = "hello") -> dict:
    return {
        "id": msg_id,
        "from": sender,
        "text": text,
        "timestamp": "2026-01-01T00:00:00Z",
        "read": False,
    }


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def base(tmp_path: Path) -> Path:
    """Return a fake ~/.claude base directory."""
    return tmp_path / ".claude"


@pytest.fixture()
def sm(base: Path) -> StateManager:
    return StateManager(base_path=base)


# ---------------------------------------------------------------------------
# get_teams
# ---------------------------------------------------------------------------

class TestGetTeams:
    def test_no_dir(self, sm: StateManager) -> None:
        assert sm.get_teams() == []

    def test_empty_dir(self, base: Path, sm: StateManager) -> None:
        (base / "teams").mkdir(parents=True)
        assert sm.get_teams() == []

    def test_single_team(self, base: Path, sm: StateManager) -> None:
        _write_json(base / "teams" / "alpha" / "config.json", _team_config("alpha"))
        teams = sm.get_teams()
        assert len(teams) == 1
        assert teams[0].name == "alpha"

    def test_multiple_teams(self, base: Path, sm: StateManager) -> None:
        for name in ("alpha", "beta", "gamma"):
            _write_json(base / "teams" / name / "config.json", _team_config(name))
        teams = sm.get_teams()
        assert len(teams) == 3
        assert {t.name for t in teams} == {"alpha", "beta", "gamma"}

    def test_corrupt_config_skipped(self, base: Path, sm: StateManager) -> None:
        (base / "teams" / "bad").mkdir(parents=True)
        (base / "teams" / "bad" / "config.json").write_text("not json", encoding="utf-8")
        _write_json(base / "teams" / "ok" / "config.json", _team_config("ok"))
        teams = sm.get_teams()
        assert len(teams) == 1
        assert teams[0].name == "ok"

    def test_missing_required_field_skipped(self, base: Path, sm: StateManager) -> None:
        # Missing required "createdAt"
        _write_json(base / "teams" / "bad" / "config.json", {"name": "bad"})
        assert sm.get_teams() == []


# ---------------------------------------------------------------------------
# get_team
# ---------------------------------------------------------------------------

class TestGetTeam:
    def test_missing(self, sm: StateManager) -> None:
        assert sm.get_team("nope") is None

    def test_found(self, base: Path, sm: StateManager) -> None:
        _write_json(base / "teams" / "alpha" / "config.json", _team_config("alpha"))
        team = sm.get_team("alpha")
        assert team is not None
        assert team.name == "alpha"

    def test_corrupt(self, base: Path, sm: StateManager) -> None:
        (base / "teams" / "alpha").mkdir(parents=True)
        (base / "teams" / "alpha" / "config.json").write_text("{bad", encoding="utf-8")
        assert sm.get_team("alpha") is None


# ---------------------------------------------------------------------------
# get_tasks
# ---------------------------------------------------------------------------

class TestGetTasks:
    def test_no_dir(self, sm: StateManager) -> None:
        assert sm.get_tasks("alpha") == []

    def test_empty_dir(self, base: Path, sm: StateManager) -> None:
        (base / "tasks" / "alpha").mkdir(parents=True)
        assert sm.get_tasks("alpha") == []

    def test_single_task(self, base: Path, sm: StateManager) -> None:
        _write_json(base / "tasks" / "alpha" / "task-1.json", _task_dict("task-1"))
        tasks = sm.get_tasks("alpha")
        assert len(tasks) == 1
        assert tasks[0].id == "task-1"

    def test_multiple_tasks(self, base: Path, sm: StateManager) -> None:
        for i in range(3):
            _write_json(
                base / "tasks" / "alpha" / f"task-{i}.json",
                _task_dict(f"task-{i}"),
            )
        tasks = sm.get_tasks("alpha")
        assert len(tasks) == 3

    def test_corrupt_task_skipped(self, base: Path, sm: StateManager) -> None:
        (base / "tasks" / "alpha").mkdir(parents=True)
        (base / "tasks" / "alpha" / "bad.json").write_text("???", encoding="utf-8")
        _write_json(base / "tasks" / "alpha" / "ok.json", _task_dict("ok"))
        tasks = sm.get_tasks("alpha")
        assert len(tasks) == 1
        assert tasks[0].id == "ok"

    def test_non_json_files_ignored(self, base: Path, sm: StateManager) -> None:
        (base / "tasks" / "alpha").mkdir(parents=True)
        (base / "tasks" / "alpha" / "notes.txt").write_text("ignore me", encoding="utf-8")
        assert sm.get_tasks("alpha") == []


# ---------------------------------------------------------------------------
# get_task
# ---------------------------------------------------------------------------

class TestGetTask:
    def test_missing(self, sm: StateManager) -> None:
        assert sm.get_task("alpha", "xyz") is None

    def test_found(self, base: Path, sm: StateManager) -> None:
        _write_json(base / "tasks" / "alpha" / "task-1.json", _task_dict("task-1", "Buy milk"))
        task = sm.get_task("alpha", "task-1")
        assert task is not None
        assert task.subject == "Buy milk"

    def test_corrupt(self, base: Path, sm: StateManager) -> None:
        (base / "tasks" / "alpha").mkdir(parents=True)
        (base / "tasks" / "alpha" / "bad.json").write_text("not-json", encoding="utf-8")
        assert sm.get_task("alpha", "bad") is None


# ---------------------------------------------------------------------------
# get_inbox / get_unread_count
# ---------------------------------------------------------------------------

class TestGetInbox:
    def test_no_file(self, sm: StateManager) -> None:
        assert sm.get_inbox("alpha", "bot") == []

    def test_empty_inbox(self, base: Path, sm: StateManager) -> None:
        _write_json(base / "teams" / "alpha" / "inboxes" / "bot.json", [])
        assert sm.get_inbox("alpha", "bot") == []

    def test_single_message(self, base: Path, sm: StateManager) -> None:
        _write_json(
            base / "teams" / "alpha" / "inboxes" / "bot.json",
            [_message_dict("m1")],
        )
        msgs = sm.get_inbox("alpha", "bot")
        assert len(msgs) == 1
        assert msgs[0].from_agent == "alice"

    def test_multiple_messages(self, base: Path, sm: StateManager) -> None:
        inbox = [_message_dict(f"m{i}") for i in range(5)]
        _write_json(base / "teams" / "alpha" / "inboxes" / "bot.json", inbox)
        assert len(sm.get_inbox("alpha", "bot")) == 5

    def test_corrupt_inbox_returns_empty(self, base: Path, sm: StateManager) -> None:
        (base / "teams" / "alpha" / "inboxes").mkdir(parents=True)
        (base / "teams" / "alpha" / "inboxes" / "bot.json").write_text("{}", encoding="utf-8")
        # {} is a dict not a list → treated as empty
        assert sm.get_inbox("alpha", "bot") == []

    def test_unread_count_all_unread(self, base: Path, sm: StateManager) -> None:
        inbox = [_message_dict(f"m{i}") for i in range(3)]
        _write_json(base / "teams" / "alpha" / "inboxes" / "bot.json", inbox)
        assert sm.get_unread_count("alpha", "bot") == 3

    def test_unread_count_mixed(self, base: Path, sm: StateManager) -> None:
        inbox = [
            {**_message_dict("m0"), "read": True},
            {**_message_dict("m1"), "read": False},
            {**_message_dict("m2"), "read": True},
        ]
        _write_json(base / "teams" / "alpha" / "inboxes" / "bot.json", inbox)
        assert sm.get_unread_count("alpha", "bot") == 1

    def test_unread_count_no_file(self, sm: StateManager) -> None:
        assert sm.get_unread_count("alpha", "bot") == 0


# ---------------------------------------------------------------------------
# Async lifecycle (start/stop)
# ---------------------------------------------------------------------------

@pytest.mark.anyio
async def test_start_stop(sm: StateManager) -> None:
    """StateManager starts and stops without error."""
    await sm.start()
    await sm.stop()


@pytest.mark.anyio
async def test_start_idempotent(sm: StateManager) -> None:
    """Calling start() twice is safe."""
    await sm.start()
    await sm.start()
    await sm.stop()
