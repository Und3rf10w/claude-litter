"""Tests for MainScreen composition and basic handler logic."""
from __future__ import annotations

import sys
from unittest.mock import MagicMock

import pytest

# Prevent ImportError when production code does `import claude_agent_sdk`.
# The tests here never invoke SDK methods, so a bare MagicMock is enough.
_fake_sdk = MagicMock()
_fake_types = MagicMock()
_fake_sdk.types = _fake_types
sys.modules.setdefault("claude_agent_sdk", _fake_sdk)
sys.modules.setdefault("claude_agent_sdk.types", _fake_types)

from claude_litter.screens.main import MainScreen, AgentBuffer, _MAIN_CHAT_KEY  # noqa: E402
from claude_litter.services.agent_manager import AgentManager  # noqa: E402


# ---------------------------------------------------------------------------
# Composition test (skipped — requires full SDK connectivity)
# ---------------------------------------------------------------------------


@pytest.mark.skip(reason="Running MainScreen in a test app requires full SDK connectivity")
@pytest.mark.anyio
async def test_main_screen_composes_expected_widgets() -> None:
    pass


# ---------------------------------------------------------------------------
# AgentBuffer helpers
# ---------------------------------------------------------------------------


def test_agent_buffer_defaults() -> None:
    """AgentBuffer should initialise with empty collections and False flags."""
    buf = AgentBuffer()
    assert buf.history == []
    assert buf.stream_accumulator == []
    assert buf.stream_buffer == []
    assert buf.streaming_block_count == 0
    assert buf.streaming is False
    assert buf.sv_line_count == 0


def test_get_buf_creates_on_first_access() -> None:
    """_get_buf creates a new AgentBuffer if the key is absent."""
    screen = MainScreen.__new__(MainScreen)
    screen._agent_outputs = {}
    screen._active_agent_key = _MAIN_CHAT_KEY

    buf = screen._get_buf()
    assert isinstance(buf, AgentBuffer)
    assert _MAIN_CHAT_KEY in screen._agent_outputs


def test_get_buf_returns_same_instance_on_repeat() -> None:
    """_get_buf returns the same buffer for the same key."""
    screen = MainScreen.__new__(MainScreen)
    screen._agent_outputs = {}
    screen._active_agent_key = _MAIN_CHAT_KEY

    buf1 = screen._get_buf()
    buf2 = screen._get_buf()
    assert buf1 is buf2


def test_buf_flush_no_op_when_empty() -> None:
    """_buf_flush does nothing when stream_buffer is empty."""
    screen = MainScreen.__new__(MainScreen)
    buf = AgentBuffer()
    screen._buf_flush(buf, None)
    assert buf.stream_accumulator == []


def test_buf_flush_moves_data_to_accumulator() -> None:
    """_buf_flush transfers stream_buffer into stream_accumulator."""
    screen = MainScreen.__new__(MainScreen)
    buf = AgentBuffer()
    buf.stream_buffer = ["Hello ", "world"]

    screen._buf_flush(buf, None)

    assert buf.stream_accumulator == ["Hello ", "world"]
    assert buf.stream_buffer == []


def test_buf_finalize_commits_to_history() -> None:
    """_buf_finalize moves accumulated text into history and resets counters."""
    screen = MainScreen.__new__(MainScreen)
    buf = AgentBuffer()
    buf.stream_accumulator = ["Step A", " Step B"]
    buf.streaming_block_count = 1
    buf.sv_line_count = 3

    screen._buf_finalize(buf, None)

    assert buf.history == ["Step A Step B"]
    assert buf.stream_accumulator == []
    assert buf.streaming_block_count == 0
    assert buf.sv_line_count == 0


def test_buf_finalize_no_op_when_accumulator_empty() -> None:
    """_buf_finalize does nothing to history when there's nothing to commit."""
    screen = MainScreen.__new__(MainScreen)
    buf = AgentBuffer()

    screen._buf_finalize(buf, None)

    assert buf.history == []
    assert buf.streaming_block_count == 0


def test_buf_append_tool_adds_to_history() -> None:
    """_buf_append_tool appends tool chunk to buf.history."""
    screen = MainScreen.__new__(MainScreen)
    buf = AgentBuffer()
    chunk = {"type": "tool_done", "name": "bash", "input": {"command": "ls"}}

    screen._buf_append_tool(buf, chunk, None)

    assert buf.history == [chunk]


# ---------------------------------------------------------------------------
# _build_team_context
# ---------------------------------------------------------------------------


def test_build_team_context_empty_when_no_teams(tmp_path) -> None:
    """Returns empty string when no teams exist."""
    from claude_litter.services.team_service import TeamService

    screen = MainScreen.__new__(MainScreen)
    screen._team_service = TeamService(base_path=tmp_path)
    assert screen._build_team_context() == ""
