"""Tests for AgentManager and AgentSession (ClaudeSDKClient fully mocked)."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import AsyncIterator
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Minimal stubs that stand in for claude_agent_sdk before any import
# ---------------------------------------------------------------------------


class _TextBlock:
    def __init__(self, text: str) -> None:
        self.text = text


class _ToolUseBlock:
    def __init__(self, name: str, input: dict) -> None:  # noqa: A002
        self.name = name
        self.input = input


class _SystemMessage:
    def __init__(self, subtype: str = "init", session_id: str | None = None) -> None:
        self.subtype = subtype
        self.session_id = session_id


class _AssistantMessage:
    def __init__(self, content: list) -> None:
        self.content = content


class _ResultMessage:
    def __init__(self, result: str = "") -> None:
        self.result = result


class _ToolResultBlock:
    def __init__(self, tool_use_id: str, content=None, is_error=None) -> None:
        self.tool_use_id = tool_use_id
        self.content = content
        self.is_error = is_error


class _UserMessage:
    def __init__(self, content=None) -> None:
        self.content = content or []


class _StreamEvent:
    """Stub for StreamEvent used in the new streaming API."""

    def __init__(self, event: dict) -> None:
        self.event = event


class _ClaudeAgentOptions:
    def __init__(self, **kwargs) -> None:
        self.kwargs = kwargs


class _ClaudeSDKClient:
    def __init__(self, options: _ClaudeAgentOptions) -> None:
        self.options = options
        self._queued: str | None = None
        self._messages: list = []

    async def connect(self) -> None:
        pass

    async def disconnect(self) -> None:
        pass

    async def query(self, prompt) -> None:
        if isinstance(prompt, str):
            self._queued = prompt
        else:
            # Async iterable — consume it
            async for msg in prompt:
                self._queued = str(msg)

    async def interrupt(self) -> None:
        pass

    async def get_server_info(self) -> dict:
        return {"commands": []}

    async def receive_response(self) -> AsyncIterator:
        for msg in self._messages:
            yield msg


# Inject the fake module before any production import
_fake_sdk = MagicMock()
_fake_sdk.ClaudeSDKClient = _ClaudeSDKClient
_fake_sdk.ClaudeAgentOptions = _ClaudeAgentOptions
_fake_sdk.SystemMessage = _SystemMessage
_fake_sdk.AssistantMessage = _AssistantMessage
_fake_sdk.ResultMessage = _ResultMessage
_fake_sdk.TextBlock = _TextBlock
_fake_sdk.ToolUseBlock = _ToolUseBlock

# Also inject types submodule for StreamEvent and content block types
_fake_types = MagicMock()
_fake_types.StreamEvent = _StreamEvent
_fake_types.AssistantMessage = _AssistantMessage
_fake_types.TextBlock = _TextBlock
_fake_types.ToolResultBlock = _ToolResultBlock
_fake_types.ToolUseBlock = _ToolUseBlock
_fake_types.UserMessage = _UserMessage
_fake_sdk.types = _fake_types
sys.modules.setdefault("claude_agent_sdk", _fake_sdk)
sys.modules.setdefault("claude_agent_sdk.types", _fake_types)

# Now we can safely import production code
from litter_tui.services.agent_manager import AgentManager, AgentSession, AgentStatus  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_manager() -> AgentManager:
    return AgentManager()


# ---------------------------------------------------------------------------
# spawn_agent / get_session
# ---------------------------------------------------------------------------


@pytest.mark.anyio
@patch("litter_tui.services.agent_manager._read_user_model", return_value=None)
async def test_spawn_agent_creates_session(_mock_model) -> None:
    mgr = _make_manager()
    session = await mgr.spawn_agent("team-a", "worker-1")
    assert isinstance(session, AgentSession)
    assert session.team_name == "team-a"
    assert session.agent_name == "worker-1"
    assert session.model is None  # defaults to None when no settings.json
    assert session.status == AgentStatus.idle


@pytest.mark.anyio
async def test_spawn_agent_registers_in_sessions() -> None:
    mgr = _make_manager()
    await mgr.spawn_agent("team-a", "worker-1")
    assert ("team-a", "worker-1") in mgr.sessions


@pytest.mark.anyio
async def test_spawn_agent_with_initial_prompt() -> None:
    mgr = _make_manager()
    session = await mgr.spawn_agent("team-a", "worker-1", initial_prompt="hello")
    assert session._client is not None
    assert session._client._queued == "hello"  # type: ignore[union-attr]


@pytest.mark.anyio
async def test_get_session_returns_existing() -> None:
    mgr = _make_manager()
    spawned = await mgr.spawn_agent("team-a", "worker-1")
    result = mgr.get_session("team-a", "worker-1")
    assert result is spawned


@pytest.mark.anyio
async def test_get_session_returns_none_for_missing() -> None:
    mgr = _make_manager()
    assert mgr.get_session("team-x", "ghost") is None


# ---------------------------------------------------------------------------
# stop_agent / stop_team
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_stop_agent_removes_session() -> None:
    mgr = _make_manager()
    await mgr.spawn_agent("team-a", "worker-1")
    await mgr.stop_agent("team-a", "worker-1")
    assert ("team-a", "worker-1") not in mgr.sessions


@pytest.mark.anyio
async def test_stop_agent_sets_stopped_status() -> None:
    mgr = _make_manager()
    session = await mgr.spawn_agent("team-a", "worker-1")
    await mgr.stop_agent("team-a", "worker-1")
    assert session.status == AgentStatus.stopped


@pytest.mark.anyio
async def test_stop_agent_noop_for_missing() -> None:
    mgr = _make_manager()
    # Should not raise
    await mgr.stop_agent("team-x", "nobody")


@pytest.mark.anyio
async def test_stop_team_removes_all_members() -> None:
    mgr = _make_manager()
    await mgr.spawn_agent("team-a", "worker-1")
    await mgr.spawn_agent("team-a", "worker-2")
    await mgr.spawn_agent("team-b", "worker-3")  # different team — must survive
    await mgr.stop_team("team-a")
    assert ("team-a", "worker-1") not in mgr.sessions
    assert ("team-a", "worker-2") not in mgr.sessions
    assert ("team-b", "worker-3") in mgr.sessions


# ---------------------------------------------------------------------------
# duplicate_agent / move_agent
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_duplicate_agent_inherits_model() -> None:
    mgr = _make_manager()
    await mgr.spawn_agent("team-a", "worker-1", model="opus")
    dup = await mgr.duplicate_agent("team-a", "worker-1", "worker-2")
    assert dup.model == "opus"
    assert dup.agent_name == "worker-2"
    assert ("team-a", "worker-2") in mgr.sessions


@pytest.mark.anyio
@patch("litter_tui.services.agent_manager._read_user_model", return_value=None)
async def test_duplicate_agent_missing_source_uses_default(_mock_model) -> None:
    mgr = _make_manager()
    dup = await mgr.duplicate_agent("team-x", "ghost", "clone")
    assert dup.model is None  # no source → inherits from settings.json


@pytest.mark.anyio
async def test_move_agent_updates_team_name() -> None:
    mgr = _make_manager()
    original = await mgr.spawn_agent("team-a", "worker-1")
    moved = await mgr.move_agent("team-a", "worker-1", "team-b")
    assert moved is original
    assert moved.team_name == "team-b"
    assert ("team-a", "worker-1") not in mgr.sessions
    assert ("team-b", "worker-1") in mgr.sessions


@pytest.mark.anyio
async def test_move_agent_spawns_fresh_when_missing() -> None:
    mgr = _make_manager()
    session = await mgr.move_agent("team-x", "ghost", "team-b")
    assert isinstance(session, AgentSession)
    assert session.team_name == "team-b"
    assert ("team-b", "ghost") in mgr.sessions


# ---------------------------------------------------------------------------
# detach / reattach (file persistence)
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_detach_saves_to_disk(tmp_path: Path) -> None:
    mgr = _make_manager()
    mgr._detach_dir = tmp_path

    session = await mgr.spawn_agent("team-a", "worker-1", model="haiku")
    session.session_id = "sess-abc-123"

    await mgr.detach("team-a", "worker-1")

    detach_file = tmp_path / "detached-sessions.json"
    assert detach_file.exists()
    data = json.loads(detach_file.read_text())
    assert data["team-a"]["worker-1"]["session_id"] == "sess-abc-123"
    assert data["team-a"]["worker-1"]["model"] == "haiku"

    # Session must no longer be in memory
    assert ("team-a", "worker-1") not in mgr.sessions


@pytest.mark.anyio
async def test_detach_noop_for_missing(tmp_path: Path) -> None:
    mgr = _make_manager()
    mgr._detach_dir = tmp_path
    # Should not raise, should not create a file
    await mgr.detach("team-x", "nobody")
    assert not (tmp_path / "detached-sessions.json").exists()


@pytest.mark.anyio
async def test_reattach_restores_session(tmp_path: Path) -> None:
    mgr = _make_manager()
    mgr._detach_dir = tmp_path

    # Prepare a detached record
    session = await mgr.spawn_agent("team-a", "worker-1", model="haiku")
    session.session_id = "sess-abc-123"
    await mgr.detach("team-a", "worker-1")

    # Reattach
    restored = await mgr.reattach("team-a", "worker-1")
    assert restored is not None
    assert restored.session_id == "sess-abc-123"
    assert restored.model == "haiku"
    assert restored.status == AgentStatus.idle
    assert ("team-a", "worker-1") in mgr.sessions


@pytest.mark.anyio
async def test_reattach_removes_from_detached_file(tmp_path: Path) -> None:
    mgr = _make_manager()
    mgr._detach_dir = tmp_path

    session = await mgr.spawn_agent("team-a", "worker-1")
    session.session_id = "sess-abc"
    await mgr.detach("team-a", "worker-1")

    await mgr.reattach("team-a", "worker-1")

    data = json.loads((tmp_path / "detached-sessions.json").read_text())
    assert "team-a" not in data


@pytest.mark.anyio
async def test_reattach_returns_none_when_no_file(tmp_path: Path) -> None:
    mgr = _make_manager()
    mgr._detach_dir = tmp_path
    result = await mgr.reattach("team-a", "worker-1")
    assert result is None


@pytest.mark.anyio
async def test_reattach_returns_none_when_not_in_file(tmp_path: Path) -> None:
    mgr = _make_manager()
    mgr._detach_dir = tmp_path
    (tmp_path / "detached-sessions.json").write_text(json.dumps({"other-team": {}}))
    result = await mgr.reattach("team-a", "worker-1")
    assert result is None


# ---------------------------------------------------------------------------
# stream_response — streaming message type processing
# ---------------------------------------------------------------------------


@pytest.mark.anyio
async def test_stream_response_text_delta() -> None:
    mgr = _make_manager()
    session = await mgr.spawn_agent("team-a", "worker-1")
    session._client._messages = [  # type: ignore[union-attr]
        _StreamEvent({"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hello!"}}),
        _ResultMessage(),
    ]

    chunks = []
    async for chunk in session.stream_response():
        chunks.append(chunk)

    assert "Hello!" in chunks
    assert "Hello!" in session.output_buffer


@pytest.mark.anyio
async def test_stream_response_tool_use() -> None:
    mgr = _make_manager()
    session = await mgr.spawn_agent("team-a", "worker-1")
    session._client._messages = [  # type: ignore[union-attr]
        _StreamEvent({"type": "content_block_start", "content_block": {"type": "tool_use", "name": "bash"}}),
        _StreamEvent({"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": '{"command":'}}),
        _StreamEvent({"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": ' "ls"}'}}),
        _StreamEvent({"type": "content_block_stop"}),
        _ResultMessage(),
    ]

    chunks = []
    async for chunk in session.stream_response():
        chunks.append(chunk)

    # Should have tool_start, tool_done events
    tool_starts = [c for c in chunks if isinstance(c, dict) and c.get("type") == "tool_start"]
    tool_dones = [c for c in chunks if isinstance(c, dict) and c.get("type") == "tool_done"]
    assert len(tool_starts) == 1
    assert tool_starts[0]["name"] == "bash"
    assert len(tool_dones) == 1
    assert tool_dones[0]["input"] == {"command": "ls"}


@pytest.mark.anyio
async def test_stream_response_result_message_sets_idle() -> None:
    mgr = _make_manager()
    session = await mgr.spawn_agent("team-a", "worker-1")
    session.status = AgentStatus.active
    session._client._messages = [  # type: ignore[union-attr]
        _ResultMessage()
    ]

    async for _ in session.stream_response():
        pass

    assert session.status == AgentStatus.idle


@pytest.mark.anyio
async def test_stream_response_system_message_captures_session_id() -> None:
    mgr = _make_manager()
    session = await mgr.spawn_agent("team-a", "worker-1")
    session._client._messages = [  # type: ignore[union-attr]
        _SystemMessage(subtype="init", session_id="sess-xyz-999"),
        _ResultMessage(),
    ]

    async for _ in session.stream_response():
        pass

    assert session.session_id == "sess-xyz-999"


@pytest.mark.anyio
async def test_stream_response_no_client_yields_nothing() -> None:
    session = AgentSession(team_name="team-a", agent_name="worker-1")
    session._client = None

    chunks = []
    async for chunk in session.stream_response():
        chunks.append(chunk)

    assert chunks == []


@pytest.mark.anyio
async def test_stream_response_mixed_messages() -> None:
    mgr = _make_manager()
    session = await mgr.spawn_agent("team-a", "worker-1")
    session._client._messages = [  # type: ignore[union-attr]
        _SystemMessage(subtype="init", session_id="s-1"),
        _StreamEvent({"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Step 1"}}),
        _StreamEvent({"type": "content_block_start", "content_block": {"type": "tool_use", "name": "read_file"}}),
        _StreamEvent({"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": '{"path": "/x"}'}}),
        _StreamEvent({"type": "content_block_stop"}),
        _ResultMessage(),
    ]

    chunks = []
    async for chunk in session.stream_response():
        chunks.append(chunk)

    assert session.session_id == "s-1"
    assert any(c == "Step 1" for c in chunks if isinstance(c, str))
    tool_dones = [c for c in chunks if isinstance(c, dict) and c.get("type") == "tool_done"]
    assert len(tool_dones) == 1
    assert tool_dones[0]["name"] == "read_file"
    assert session.status == AgentStatus.idle


@pytest.mark.anyio
async def test_stream_response_todo_write_detection() -> None:
    """Verify TodoWrite tool calls are captured with correct input."""
    mgr = _make_manager()
    session = await mgr.spawn_agent("team-a", "worker-1")
    todo_json = json.dumps({"todos": [{"id": "1", "content": "Fix bug", "status": "pending"}]})
    session._client._messages = [  # type: ignore[union-attr]
        _StreamEvent({"type": "content_block_start", "content_block": {"type": "tool_use", "name": "TodoWrite"}}),
        _StreamEvent({"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": todo_json}}),
        _StreamEvent({"type": "content_block_stop"}),
        _ResultMessage(),
    ]

    chunks = []
    async for chunk in session.stream_response():
        chunks.append(chunk)

    tool_dones = [c for c in chunks if isinstance(c, dict) and c.get("type") == "tool_done"]
    assert len(tool_dones) == 1
    assert tool_dones[0]["name"] == "TodoWrite"
    assert tool_dones[0]["input"]["todos"][0]["content"] == "Fix bug"
