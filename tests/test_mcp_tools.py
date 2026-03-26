"""Tests for the team-overlord MCP server tools."""
from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest

# Add the server module to the import path
_SERVER_DIR = str(Path(__file__).parents[1] / "plugins" / "team-overlord" / "servers")
if _SERVER_DIR not in sys.path:
    sys.path.insert(0, _SERVER_DIR)


@pytest.fixture()
def mcp_server(tmp_path, monkeypatch):
    """Create a FastMCP server with CLAUDE_HOME pointing to tmp_path."""
    monkeypatch.setenv("CLAUDE_HOME", str(tmp_path))
    import team_tools

    importlib.reload(team_tools)
    return team_tools.mcp


async def _call(mcp_server, tool_name: str, args: dict | None = None):
    """Call a tool on the MCP server and return the parsed result."""
    result = await mcp_server._tool_manager.call_tool(tool_name, args or {})
    # FastMCP call_tool returns the raw function result (a string for our tools)
    return result


def _parse_json(result: str):
    """Parse a JSON string, handling both direct strings and MCP content wrappers."""
    if isinstance(result, str):
        return json.loads(result)
    # MCP may wrap in content objects
    if isinstance(result, list):
        text = "".join(item.text for item in result if hasattr(item, "text"))
        return json.loads(text)
    return result


# ---------------------------------------------------------------------------
# list_teams
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_list_teams_empty(mcp_server):
    result = await _call(mcp_server, "list_teams")
    data = _parse_json(result)
    assert data == []


@pytest.mark.anyio
async def test_create_team(mcp_server, tmp_path):
    result = await _call(mcp_server, "create_team", {"name": "alpha", "description": "Test team"})
    data = _parse_json(result)
    assert data["name"] == "alpha"
    assert data["description"] == "Test team"
    assert data["members"] == []

    # Verify on disk
    config_path = tmp_path / "teams" / "alpha" / "config.json"
    assert config_path.exists()
    on_disk = json.loads(config_path.read_text())
    assert on_disk["name"] == "alpha"

    # Inboxes directory is lazily created on first message send
    assert not (tmp_path / "teams" / "alpha" / "inboxes").exists()


@pytest.mark.anyio
async def test_create_team_idempotent(mcp_server):
    await _call(mcp_server, "create_team", {"name": "alpha"})
    result = await _call(mcp_server, "create_team", {"name": "alpha"})
    data = _parse_json(result)
    assert data["name"] == "alpha"


@pytest.mark.anyio
async def test_list_teams_after_create(mcp_server):
    await _call(mcp_server, "create_team", {"name": "alpha"})
    await _call(mcp_server, "create_team", {"name": "beta"})
    result = await _call(mcp_server, "list_teams")
    data = _parse_json(result)
    names = [t["name"] for t in data]
    assert "alpha" in names
    assert "beta" in names


@pytest.mark.anyio
async def test_get_team(mcp_server):
    await _call(mcp_server, "create_team", {"name": "alpha", "description": "A team"})
    result = await _call(mcp_server, "get_team", {"team": "alpha"})
    data = _parse_json(result)
    assert data["name"] == "alpha"
    assert data["description"] == "A team"


@pytest.mark.anyio
async def test_get_team_missing(mcp_server):
    result = await _call(mcp_server, "get_team", {"team": "nonexistent"})
    data = _parse_json(result)
    assert "error" in data


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_create_task(mcp_server, tmp_path):
    result = await _call(mcp_server, "create_task", {
        "team": "alpha",
        "subject": "Build auth",
        "description": "Implement JWT auth",
    })
    data = _parse_json(result)
    assert data["id"] == "1"
    assert data["subject"] == "Build auth"
    assert data["status"] == "pending"

    # Verify on disk
    task_path = tmp_path / "tasks" / "alpha" / "1.json"
    assert task_path.exists()


@pytest.mark.anyio
async def test_create_task_auto_increment(mcp_server):
    await _call(mcp_server, "create_task", {"team": "alpha", "subject": "Task 1"})
    result = await _call(mcp_server, "create_task", {"team": "alpha", "subject": "Task 2"})
    data = _parse_json(result)
    assert data["id"] == "2"


@pytest.mark.anyio
async def test_list_tasks(mcp_server):
    await _call(mcp_server, "create_task", {"team": "alpha", "subject": "Task 1"})
    await _call(mcp_server, "create_task", {"team": "alpha", "subject": "Task 2"})
    result = await _call(mcp_server, "list_tasks", {"team": "alpha"})
    data = _parse_json(result)
    assert len(data) == 2
    assert data[0]["subject"] == "Task 1"
    assert data[1]["subject"] == "Task 2"


@pytest.mark.anyio
async def test_list_tasks_empty(mcp_server):
    result = await _call(mcp_server, "list_tasks", {"team": "nonexistent"})
    data = _parse_json(result)
    assert data == []


@pytest.mark.anyio
async def test_list_tasks_status_filter(mcp_server):
    await _call(mcp_server, "create_task", {"team": "alpha", "subject": "Task 1"})
    await _call(mcp_server, "create_task", {"team": "alpha", "subject": "Task 2"})
    await _call(mcp_server, "update_task", {"team": "alpha", "task_id": "1", "status": "completed"})

    result = await _call(mcp_server, "list_tasks", {"team": "alpha", "status": "pending"})
    data = _parse_json(result)
    assert len(data) == 1
    assert data[0]["id"] == "2"

    result = await _call(mcp_server, "list_tasks", {"team": "alpha", "status": "completed"})
    data = _parse_json(result)
    assert len(data) == 1
    assert data[0]["id"] == "1"


@pytest.mark.anyio
async def test_get_task(mcp_server):
    await _call(mcp_server, "create_task", {"team": "alpha", "subject": "Task 1"})
    result = await _call(mcp_server, "get_task", {"team": "alpha", "task_id": "1"})
    data = _parse_json(result)
    assert data["subject"] == "Task 1"


@pytest.mark.anyio
async def test_get_task_missing(mcp_server):
    result = await _call(mcp_server, "get_task", {"team": "alpha", "task_id": "999"})
    data = _parse_json(result)
    assert "error" in data


@pytest.mark.anyio
async def test_update_task(mcp_server, tmp_path):
    await _call(mcp_server, "create_task", {"team": "alpha", "subject": "Task 1"})
    result = await _call(mcp_server, "update_task", {
        "team": "alpha",
        "task_id": "1",
        "status": "in_progress",
        "owner": "researcher",
    })
    data = _parse_json(result)
    assert data["status"] == "in_progress"
    assert data["owner"] == "researcher"

    # Verify on disk
    on_disk = json.loads((tmp_path / "tasks" / "alpha" / "1.json").read_text())
    assert on_disk["status"] == "in_progress"
    assert on_disk["owner"] == "researcher"


@pytest.mark.anyio
async def test_update_task_missing(mcp_server):
    result = await _call(mcp_server, "update_task", {"team": "alpha", "task_id": "999", "status": "completed"})
    data = _parse_json(result)
    assert "error" in data


@pytest.mark.anyio
async def test_update_task_no_fields(mcp_server):
    """update_task with no fields returns current task unchanged."""
    await _call(mcp_server, "create_task", {"team": "alpha", "subject": "Task 1"})
    result = await _call(mcp_server, "update_task", {"team": "alpha", "task_id": "1"})
    data = _parse_json(result)
    assert data["subject"] == "Task 1"
    assert data["status"] == "pending"


# ---------------------------------------------------------------------------
# Messaging
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_send_message(mcp_server, tmp_path):
    # Create team with a member for the inbox
    await _call(mcp_server, "create_team", {"name": "alpha"})
    result = await _call(mcp_server, "send_message", {
        "team": "alpha",
        "to": "researcher",
        "text": "Check the docs",
    })
    assert "sent" in result.lower() if isinstance(result, str) else True

    # Verify inbox on disk
    inbox_path = tmp_path / "teams" / "alpha" / "inboxes" / "researcher.json"
    assert inbox_path.exists()
    messages = json.loads(inbox_path.read_text())
    assert len(messages) == 1
    assert messages[0]["from"] == "tui"
    assert messages[0]["text"] == "Check the docs"
    assert messages[0]["read"] is False


@pytest.mark.anyio
async def test_read_inbox(mcp_server):
    await _call(mcp_server, "create_team", {"name": "alpha"})
    await _call(mcp_server, "send_message", {"team": "alpha", "to": "researcher", "text": "msg 1"})
    await _call(mcp_server, "send_message", {"team": "alpha", "to": "researcher", "text": "msg 2"})

    result = await _call(mcp_server, "read_inbox", {"team": "alpha", "agent": "researcher"})
    data = _parse_json(result)
    assert len(data) == 2
    assert data[0]["text"] == "msg 1"
    assert data[1]["text"] == "msg 2"


@pytest.mark.anyio
async def test_read_inbox_empty(mcp_server):
    result = await _call(mcp_server, "read_inbox", {"team": "alpha", "agent": "nobody"})
    data = _parse_json(result)
    assert data == []


@pytest.mark.anyio
async def test_broadcast_message(mcp_server, tmp_path):
    # Create a team with members
    await _call(mcp_server, "create_team", {"name": "alpha"})
    # Manually add members to the config
    config_path = tmp_path / "teams" / "alpha" / "config.json"
    config = json.loads(config_path.read_text())
    config["members"] = [
        {"agentId": "researcher@alpha", "name": "researcher"},
        {"agentId": "coder@alpha", "name": "coder"},
        {"agentId": "tui@alpha", "name": "tui"},  # should be skipped
    ]
    config_path.write_text(json.dumps(config))

    result = await _call(mcp_server, "broadcast_message", {
        "team": "alpha",
        "text": "Stand down",
    })
    assert "2" in (result if isinstance(result, str) else str(result))

    # Verify inboxes
    for agent in ("researcher", "coder"):
        inbox = tmp_path / "teams" / "alpha" / "inboxes" / f"{agent}.json"
        assert inbox.exists()
        msgs = json.loads(inbox.read_text())
        assert len(msgs) == 1
        assert msgs[0]["text"] == "Stand down"
        assert "[broadcast]" in msgs[0].get("summary", "")

    # tui should NOT have an inbox
    tui_inbox = tmp_path / "teams" / "alpha" / "inboxes" / "tui.json"
    assert not tui_inbox.exists()


@pytest.mark.anyio
async def test_broadcast_message_missing_team(mcp_server):
    result = await _call(mcp_server, "broadcast_message", {"team": "nonexistent", "text": "hello"})
    data = _parse_json(result)
    assert "error" in data


# ---------------------------------------------------------------------------
# CommandSubmitted handler
# ---------------------------------------------------------------------------


def test_command_submitted_handler_exists():
    """Verify MainScreen has an on_command_submitted handler."""
    from claude_litter.screens.main import MainScreen

    assert hasattr(MainScreen, "on_command_submitted")
    assert callable(getattr(MainScreen, "on_command_submitted"))
