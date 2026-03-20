"""Tests for claude_litter data models."""
from __future__ import annotations

import pytest
from claude_litter.models import Team, TeamMember, Task, TaskStatus, Message


# ── Fixtures: real-world JSON samples ──────────────────────────────────────

TEAM_JSON = {
    "name": "demo-team",
    "description": "Demo team for testing",
    "createdAt": 1770629583288,
    "leadAgentId": "team-lead@demo-team",
    "leadSessionId": "aa6632ae-1234-5678-abcd-ef0123456789",
    "members": [
        {
            "agentId": "team-lead@demo-team",
            "name": "team-lead",
            "agentType": "claude",
            "model": "claude-sonnet-4-5-20251001",
            "joinedAt": 1770629583288,
            "tmuxPaneId": "",
            "cwd": "/path/to/project",
            "subscriptions": [],
            "color": "red",
        }
    ],
}

TASK_JSON = {
    "id": "1",
    "subject": "Implement feature X",
    "description": "Detailed description of feature X",
    "status": "completed",
    "blocks": ["2", "3"],
    "blockedBy": [],
    "owner": "agent-name",
}

MESSAGE_JSON = {
    "from": "team-lead",
    "text": "Hello teammate, please start task 1.",
    "timestamp": "2026-03-08T22:12:55.329Z",
    "read": False,
    "color": "blue",
}


# ── TeamMember tests ────────────────────────────────────────────────────────

class TestTeamMember:
    def test_from_dict_required_fields(self):
        data = TEAM_JSON["members"][0]
        m = TeamMember.from_dict(data)
        assert m.agentId == "team-lead@demo-team"
        assert m.name == "team-lead"
        assert m.agentType == "claude"
        assert m.model == "claude-sonnet-4-5-20251001"
        assert m.joinedAt == 1770629583288
        assert m.tmuxPaneId == ""
        assert m.cwd == "/path/to/project"
        assert m.subscriptions == ()
        assert m.color == "red"

    def test_from_dict_optional_defaults(self):
        data = {
            "agentId": "x@team",
            "name": "x",
            "agentType": "claude",
            "model": "claude-sonnet-4-5",
            "joinedAt": 123456,
            "tmuxPaneId": "",
            "cwd": "/",
            "subscriptions": [],
        }
        m = TeamMember.from_dict(data)
        assert m.prompt is None
        assert m.color is None
        assert m.planModeRequired is None
        assert m.backendType is None

    def test_round_trip(self):
        data = TEAM_JSON["members"][0]
        m = TeamMember.from_dict(data)
        assert TeamMember.from_dict(m.to_dict()) == m

    def test_subscriptions_as_tuple(self):
        data = {**TEAM_JSON["members"][0], "subscriptions": ["task.update", "msg"]}
        m = TeamMember.from_dict(data)
        assert isinstance(m.subscriptions, tuple)
        assert m.subscriptions == ("task.update", "msg")

    def test_to_dict_omits_none_optionals(self):
        data = TEAM_JSON["members"][0].copy()
        m = TeamMember.from_dict(data)
        d = m.to_dict()
        assert "prompt" not in d
        assert "planModeRequired" not in d
        assert "backendType" not in d

    def test_frozen(self):
        m = TeamMember.from_dict(TEAM_JSON["members"][0])
        with pytest.raises((AttributeError, TypeError)):
            m.name = "hacked"  # type: ignore[misc]


# ── Team tests ──────────────────────────────────────────────────────────────

class TestTeam:
    def test_from_dict(self):
        t = Team.from_dict(TEAM_JSON)
        assert t.name == "demo-team"
        assert t.createdAt == 1770629583288
        assert t.leadAgentId == "team-lead@demo-team"
        assert len(t.members) == 1
        assert isinstance(t.members[0], TeamMember)

    def test_members_as_tuple(self):
        t = Team.from_dict(TEAM_JSON)
        assert isinstance(t.members, tuple)

    def test_round_trip(self):
        t = Team.from_dict(TEAM_JSON)
        assert Team.from_dict(t.to_dict()) == t

    def test_empty_members(self):
        data = {**TEAM_JSON, "members": []}
        t = Team.from_dict(data)
        assert t.members == ()

    def test_frozen(self):
        t = Team.from_dict(TEAM_JSON)
        with pytest.raises((AttributeError, TypeError)):
            t.name = "hacked"  # type: ignore[misc]


# ── TaskStatus tests ────────────────────────────────────────────────────────

class TestTaskStatus:
    def test_enum_values(self):
        assert TaskStatus.pending.value == "pending"
        assert TaskStatus.in_progress.value == "in_progress"
        assert TaskStatus.completed.value == "completed"

    def test_from_string(self):
        assert TaskStatus("pending") == TaskStatus.pending
        assert TaskStatus("in_progress") == TaskStatus.in_progress
        assert TaskStatus("completed") == TaskStatus.completed


# ── Task tests ──────────────────────────────────────────────────────────────

class TestTask:
    def test_from_dict(self):
        t = Task.from_dict(TASK_JSON)
        assert t.id == "1"
        assert t.subject == "Implement feature X"
        assert t.status == TaskStatus.completed
        assert t.blocks == ("2", "3")
        assert t.blockedBy == ()
        assert t.owner == "agent-name"

    def test_optional_defaults(self):
        data = {
            "id": "99",
            "subject": "Minimal task",
            "description": "",
            "status": "pending",
        }
        t = Task.from_dict(data)
        assert t.blocks == ()
        assert t.blockedBy == ()
        assert t.owner is None
        assert t.activeForm is None
        assert t.metadata is None

    def test_round_trip(self):
        t = Task.from_dict(TASK_JSON)
        t2 = Task.from_dict(t.to_dict())
        assert t2.id == t.id
        assert t2.subject == t.subject
        assert t2.status == t.status
        assert t2.blocks == t.blocks
        assert t2.owner == t.owner

    def test_invalid_status_defaults_to_pending(self):
        data = {**TASK_JSON, "status": "bogus_status"}
        t = Task.from_dict(data)
        assert t.status == TaskStatus.pending

    def test_enum_in_to_dict(self):
        t = Task.from_dict(TASK_JSON)
        d = t.to_dict()
        assert d["status"] == "completed"

    def test_blocks_as_tuple(self):
        t = Task.from_dict(TASK_JSON)
        assert isinstance(t.blocks, tuple)
        assert isinstance(t.blockedBy, tuple)

    def test_metadata_field(self):
        data = {**TASK_JSON, "metadata": {"key": "value", "count": 42}}
        t = Task.from_dict(data)
        assert t.metadata == {"key": "value", "count": 42}


# ── Message tests ───────────────────────────────────────────────────────────

class TestMessage:
    def test_from_dict(self):
        m = Message.from_dict(MESSAGE_JSON)
        assert m.from_agent == "team-lead"
        assert m.text == "Hello teammate, please start task 1."
        assert m.timestamp == "2026-03-08T22:12:55.329Z"
        assert m.read is False
        assert m.color == "blue"

    def test_from_key_aliasing(self):
        """'from' JSON key maps to from_agent attribute."""
        m = Message.from_dict(MESSAGE_JSON)
        assert m.from_agent == "team-lead"

    def test_to_dict_uses_from_key(self):
        """to_dict serializes from_agent back as 'from'."""
        m = Message.from_dict(MESSAGE_JSON)
        d = m.to_dict()
        assert "from" in d
        assert "from_agent" not in d
        assert d["from"] == "team-lead"

    def test_optional_defaults(self):
        data = {
            "from": "bot",
            "text": "hi",
            "timestamp": "2026-01-01T00:00:00Z",
            "read": True,
        }
        m = Message.from_dict(data)
        assert m.color is None
        assert m.summary is None

    def test_round_trip(self):
        m = Message.from_dict(MESSAGE_JSON)
        assert Message.from_dict(m.to_dict()) == m

    def test_frozen(self):
        m = Message.from_dict(MESSAGE_JSON)
        with pytest.raises((AttributeError, TypeError)):
            m.text = "hacked"  # type: ignore[misc]

    def test_omits_none_in_to_dict(self):
        data = {"from": "bot", "text": "hi", "timestamp": "ts", "read": False}
        m = Message.from_dict(data)
        d = m.to_dict()
        assert "color" not in d
        assert "summary" not in d
