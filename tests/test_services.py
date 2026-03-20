"""Tests for TeamService and KittyService."""
from __future__ import annotations

import concurrent.futures
import json
import os
from pathlib import Path

import pytest

from litter_tui.services.team_service import TeamService
from litter_tui.services.kitty import KittyService


# ------------------------------------------------------------------ #
#  TeamService tests
# ------------------------------------------------------------------ #


@pytest.fixture
def svc(tmp_path: Path) -> TeamService:
    return TeamService(base_path=tmp_path)


class TestTeamCRUD:
    def test_create_team(self, svc: TeamService) -> None:
        config = svc.create_team("alpha", description="Test team")
        assert config["name"] == "alpha"
        assert config["description"] == "Test team"
        assert config["members"] == []
        assert "createdAt" in config

        # Config file written to disk
        path = svc.teams_path / "alpha" / "config.json"
        assert path.exists()

    def test_create_team_idempotent(self, svc: TeamService) -> None:
        c1 = svc.create_team("alpha")
        c2 = svc.create_team("alpha")
        assert c1["createdAt"] == c2["createdAt"]

    def test_delete_team(self, svc: TeamService) -> None:
        svc.create_team("alpha")
        svc.delete_team("alpha")
        assert not (svc.teams_path / "alpha").exists()

    def test_delete_nonexistent_team(self, svc: TeamService) -> None:
        svc.delete_team("ghost")  # should not raise

    def test_get_team(self, svc: TeamService) -> None:
        svc.create_team("alpha")
        team = svc.get_team("alpha")
        assert team is not None
        assert team["name"] == "alpha"

    def test_get_missing_team(self, svc: TeamService) -> None:
        assert svc.get_team("missing") is None

    def test_list_teams(self, svc: TeamService) -> None:
        svc.create_team("alpha")
        svc.create_team("beta")
        teams = svc.list_teams()
        assert set(teams) == {"alpha", "beta"}


class TestMembers:
    def test_add_member(self, svc: TeamService) -> None:
        svc.create_team("alpha")
        member = {"name": "worker-1", "agentId": "uuid-1", "agentType": "worker"}
        svc.add_member("alpha", member)

        team = svc.get_team("alpha")
        assert team is not None
        assert len(team["members"]) == 1
        assert team["members"][0]["name"] == "worker-1"

    def test_add_member_no_duplicate(self, svc: TeamService) -> None:
        svc.create_team("alpha")
        member = {"name": "worker-1", "agentId": "uuid-1", "agentType": "worker"}
        svc.add_member("alpha", member)
        svc.add_member("alpha", member)  # duplicate

        team = svc.get_team("alpha")
        assert team is not None
        assert len(team["members"]) == 1

    def test_remove_member(self, svc: TeamService) -> None:
        svc.create_team("alpha")
        svc.add_member("alpha", {"name": "worker-1", "agentId": "uuid-1", "agentType": "worker"})
        svc.remove_member("alpha", "uuid-1")

        team = svc.get_team("alpha")
        assert team is not None
        assert team["members"] == []


class TestTasks:
    def test_create_task(self, svc: TeamService) -> None:
        svc.create_team("alpha")
        task = svc.create_task("alpha", "Do something", "Details here")
        assert task["id"] == "1"
        assert task["subject"] == "Do something"
        assert task["status"] == "pending"
        assert task["blocks"] == []
        assert task["blockedBy"] == []

    def test_task_auto_increment(self, svc: TeamService) -> None:
        svc.create_team("alpha")
        t1 = svc.create_task("alpha", "Task 1")
        t2 = svc.create_task("alpha", "Task 2")
        assert t1["id"] == "1"
        assert t2["id"] == "2"

    def test_get_task(self, svc: TeamService) -> None:
        svc.create_team("alpha")
        svc.create_task("alpha", "Task 1")
        task = svc.get_task("alpha", "1")
        assert task is not None
        assert task["subject"] == "Task 1"

    def test_get_missing_task(self, svc: TeamService) -> None:
        svc.create_team("alpha")
        assert svc.get_task("alpha", "99") is None

    def test_update_task(self, svc: TeamService) -> None:
        svc.create_team("alpha")
        svc.create_task("alpha", "Task 1")
        updated = svc.update_task("alpha", "1", status="in_progress", owner="worker-1")
        assert updated["status"] == "in_progress"
        assert updated["owner"] == "worker-1"

    def test_list_tasks(self, svc: TeamService) -> None:
        svc.create_team("alpha")
        svc.create_task("alpha", "T1")
        svc.create_task("alpha", "T2")
        tasks = svc.list_tasks("alpha")
        assert len(tasks) == 2
        assert tasks[0]["id"] == "1"
        assert tasks[1]["id"] == "2"

    def test_list_tasks_empty(self, svc: TeamService) -> None:
        svc.create_team("alpha")
        assert svc.list_tasks("alpha") == []


class TestMessaging:
    def test_send_message(self, svc: TeamService) -> None:
        svc.create_team("alpha")
        svc.send_message("alpha", "worker-1", "team-lead", "Hello!")
        inbox = svc.read_inbox("alpha", "worker-1")
        assert len(inbox) == 1
        assert inbox[0]["from"] == "team-lead"
        assert inbox[0]["text"] == "Hello!"
        assert inbox[0]["read"] is False
        assert "timestamp" in inbox[0]

    def test_send_multiple_messages(self, svc: TeamService) -> None:
        svc.create_team("alpha")
        svc.send_message("alpha", "worker-1", "team-lead", "Msg 1")
        svc.send_message("alpha", "worker-1", "team-lead", "Msg 2")
        inbox = svc.read_inbox("alpha", "worker-1")
        assert len(inbox) == 2

    def test_read_empty_inbox(self, svc: TeamService) -> None:
        svc.create_team("alpha")
        assert svc.read_inbox("alpha", "nobody") == []


class TestFileLocking:
    def test_no_corruption_under_concurrent_access(self, svc: TeamService) -> None:
        """Concurrent member adds should not corrupt state."""
        svc.create_team("concurrent")

        def add_member(i: int) -> None:
            member = {"name": f"worker-{i}", "agentId": f"uuid-{i}", "agentType": "worker"}
            svc.add_member("concurrent", member)

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            futs = [pool.submit(add_member, i) for i in range(20)]
            for f in concurrent.futures.as_completed(futs):
                f.result()  # re-raise any exception

        team = svc.get_team("concurrent")
        assert team is not None
        assert len(team["members"]) == 20


class TestUpdateMember:
    def test_update_member_changes_fields(self, svc: TeamService) -> None:
        svc.create_team("alpha")
        svc.add_member("alpha", {"name": "w1", "agentId": "uid-1", "model": "sonnet"})
        svc.update_member("alpha", "uid-1", model="opus", color="blue")
        team = svc.get_team("alpha")
        assert team is not None
        m = team["members"][0]
        assert m["model"] == "opus"
        assert m["color"] == "blue"

    def test_update_member_name_changes_agent_id(self, svc: TeamService) -> None:
        svc.create_team("alpha")
        svc.add_member("alpha", {"name": "old-name", "agentId": "old-name@alpha"})
        svc.update_member("alpha", "old-name@alpha", name="new-name")
        team = svc.get_team("alpha")
        assert team is not None
        m = team["members"][0]
        assert m["name"] == "new-name"
        assert m["agentId"] == "new-name@alpha"

    def test_update_member_name_renames_inbox(self, svc: TeamService) -> None:
        svc.create_team("alpha")
        svc.add_member("alpha", {"name": "old-name", "agentId": "old-name@alpha"})
        svc.send_message("alpha", "old-name", "lead", "hello")
        svc.update_member("alpha", "old-name@alpha", name="new-name")
        # Old inbox gone, new inbox has the messages
        assert svc.read_inbox("alpha", "old-name") == []
        inbox = svc.read_inbox("alpha", "new-name")
        assert len(inbox) == 1
        assert inbox[0]["text"] == "hello"

    def test_update_member_noop_when_not_found(self, svc: TeamService) -> None:
        svc.create_team("alpha")
        svc.add_member("alpha", {"name": "w1", "agentId": "uid-1"})
        # Should not raise, member not found
        svc.update_member("alpha", "uid-nonexistent", model="opus")
        team = svc.get_team("alpha")
        assert team is not None
        assert team["members"][0].get("model") is None  # unchanged


class TestCopyInbox:
    def test_copy_inbox_copies_all_messages(self, svc: TeamService) -> None:
        svc.create_team("src-team")
        svc.create_team("dst-team")
        svc.send_message("src-team", "agent-a", "lead", "msg1")
        svc.send_message("src-team", "agent-a", "lead", "msg2")
        count = svc.copy_inbox("src-team", "agent-a", "dst-team", "agent-b")
        assert count == 2
        inbox = svc.read_inbox("dst-team", "agent-b")
        assert len(inbox) == 2
        assert inbox[0]["text"] == "msg1"
        assert inbox[1]["text"] == "msg2"

    def test_copy_inbox_returns_zero_when_empty(self, svc: TeamService) -> None:
        svc.create_team("src-team")
        svc.create_team("dst-team")
        count = svc.copy_inbox("src-team", "nobody", "dst-team", "agent-b")
        assert count == 0

    def test_copy_inbox_appends_to_existing(self, svc: TeamService) -> None:
        svc.create_team("src-team")
        svc.create_team("dst-team")
        svc.send_message("src-team", "agent-a", "lead", "copied")
        svc.send_message("dst-team", "agent-b", "other", "existing")
        count = svc.copy_inbox("src-team", "agent-a", "dst-team", "agent-b")
        assert count == 1
        inbox = svc.read_inbox("dst-team", "agent-b")
        assert len(inbox) == 2
        assert inbox[0]["text"] == "existing"
        assert inbox[1]["text"] == "copied"


# ------------------------------------------------------------------ #
#  KittyService tests
# ------------------------------------------------------------------ #


class TestKittyDetect:
    def test_detect_kitty_false_in_test_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("TERM_PROGRAM", raising=False)
        svc = KittyService()
        assert svc.detect_kitty() is False

    def test_detect_kitty_true_when_env_set(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("TERM_PROGRAM", "kitty")
        svc = KittyService()
        assert svc.detect_kitty() is True


class TestKittySocket:
    def test_find_socket_env_override(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        socket_path = tmp_path / "kitty.sock"
        socket_path.touch()
        monkeypatch.setenv("KITTY_LISTEN_ON", f"unix:{socket_path}")
        svc = KittyService()
        assert svc.find_socket() == socket_path

    def test_find_socket_none_when_no_env_no_default(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("KITTY_LISTEN_ON", raising=False)
        monkeypatch.delenv("USER", raising=False)
        monkeypatch.delenv("LOGNAME", raising=False)
        svc = KittyService()
        result = svc.find_socket()
        # May be None or point to a non-existent path — just don't crash
        assert result is None or isinstance(result, Path)

    def test_validate_socket_false_for_nonexistent(self, tmp_path: Path) -> None:
        svc = KittyService()
        assert svc.validate_socket(tmp_path / "nosocket") is False


class TestKittyOpsNoopOutsideKitty:
    """All async kitty operations should be graceful no-ops outside kitty."""

    @pytest.fixture(autouse=True)
    def no_kitty_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("TERM_PROGRAM", raising=False)

    @pytest.mark.anyio
    async def test_kitten_cmd_returns_empty(self) -> None:
        svc = KittyService()
        result = await svc.kitten_cmd("ls")
        assert result == ""

    @pytest.mark.anyio
    async def test_list_windows_returns_empty(self) -> None:
        svc = KittyService()
        assert await svc.list_windows() == []

    @pytest.mark.anyio
    async def test_focus_window_noop(self) -> None:
        svc = KittyService()
        await svc.focus_window("id:1")  # should not raise

    @pytest.mark.anyio
    async def test_close_window_noop(self) -> None:
        svc = KittyService()
        await svc.close_window("id:1")

    @pytest.mark.anyio
    async def test_send_text_noop(self) -> None:
        svc = KittyService()
        await svc.send_text("id:1", "hello")

    @pytest.mark.anyio
    async def test_pop_out_agent_noop(self) -> None:
        svc = KittyService()
        await svc.pop_out_agent("team", "agent", mode="split")
