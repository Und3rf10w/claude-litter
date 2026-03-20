"""Agent Manager Service — wraps claude-agent-sdk for managing swarm agent sessions."""

from __future__ import annotations

import base64
import json
import logging
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import AsyncIterator

import anyio

_log = logging.getLogger("litter_tui.agent_manager")


from litter_tui.services.claude_settings import ClaudeSettings


def _read_user_model() -> str | None:
    """Read the ``model`` field from ``~/.claude/settings.json``.

    Returns the raw value (e.g. ``"opus[1m]"``, ``"sonnet"``) or *None*
    if the file is missing / unreadable / has no model key.
    """
    return ClaudeSettings.load().model


class AgentStatus(Enum):
    starting = "starting"
    active = "active"
    idle = "idle"
    stopped = "stopped"


@dataclass
class AgentSession:
    team_name: str
    agent_name: str
    model: str | None = None
    session_id: str | None = None
    status: AgentStatus = AgentStatus.starting
    output_buffer: list[str] = field(default_factory=list)
    server_info: dict | None = field(default=None, repr=False)
    _client: object | None = field(default=None, repr=False)
    _connected: bool = field(default=False, repr=False)

    async def start(self) -> None:
        """Initialize and connect ClaudeSDKClient for this session."""
        from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

        # Load env vars from settings.json so the CLI subprocess gets
        # ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, model aliases, etc.
        settings = ClaudeSettings.load()

        opts: dict = {
            "include_partial_messages": True,
            "env": settings.env,
        }
        if self.model:
            opts["model"] = self.model
        options = ClaudeAgentOptions(**opts)
        self._client = ClaudeSDKClient(options)

        # Log the exact CLI command for debugging
        _log.info("start: connecting with options model=%r, include_partial=%r",
                  self.model, getattr(options, 'include_partial_messages', None))

        await self._client.connect()
        self._connected = True

        # Log the command that was actually run
        try:
            query = getattr(self._client, '_query', None)
            if query:
                tp = getattr(query, 'transport', None)
                if tp and hasattr(tp, '_build_command'):
                    cmd = tp._build_command()
                    _log.info("start: CLI command = %s", ' '.join(cmd))
        except Exception:
            pass

        # Fetch available commands for autocomplete
        self.server_info = await self._client.get_server_info()
        self.status = AgentStatus.idle

    async def send_prompt(self, prompt: str, images: list[tuple[str, bytes]] | None = None) -> None:
        """Send a prompt (with optional images) and start a new turn."""
        if not self._connected:
                await self.start()

        if images:
            content: list[dict] = [{"type": "text", "text": prompt}]
            for media_type, data in images:
                content.append({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": base64.b64encode(data).decode(),
                    },
                })

            async def _single_message():
                yield {
                    "type": "user",
                    "message": {"role": "user", "content": content},
                }

            await self._client.query(_single_message())
        else:
            await self._client.query(prompt)

        _log.info("send_prompt: query() returned")
        self.status = AgentStatus.active

    async def stream_response(self) -> AsyncIterator[str | dict]:
        """Stream ONE turn's response.

        Yields:
            str — text deltas (token-by-token)
            dict — tool events: {"type": "tool_start", "name": ...}
                                {"type": "tool_done", "name": ..., "input": ...}

        Handles both streaming mode (StreamEvent messages with deltas) and
        non-streaming fallback (complete AssistantMessage with content blocks).

        Terminates after ResultMessage for this turn.
        """
        if self._client is None:
            _log.warning("stream_response: _client is None, returning immediately")
            return

        from claude_agent_sdk import ResultMessage, SystemMessage
        from claude_agent_sdk.types import (
            AssistantMessage,
            StreamEvent,
            TextBlock,
            ToolResultBlock,
            ToolUseBlock,
            UserMessage,
        )

        current_tool: str | None = None
        tool_input = ""
        got_stream_events = False  # Track whether we received streaming deltas

        _log.debug("stream_response: entering receive_response loop")
        _log.debug("stream_response: client=%r, connected=%s", self._client, self._connected)

        # Yield control to allow the event loop to process pending I/O
        # (ensures _read_messages background task has a chance to buffer messages)
        await anyio.sleep(0)

        async for msg in self._client.receive_response():
            _log.debug("stream_response: got msg type=%s repr=%.200s", type(msg).__name__, repr(msg))
            if isinstance(msg, SystemMessage):
                subtype = getattr(msg, "subtype", None)
                if subtype == "init":
                    self.session_id = getattr(msg, "session_id", self.session_id)
                elif subtype == "api_retry":
                    data = getattr(msg, "data", {})
                    attempt = data.get("attempt", "?")
                    error = data.get("error", "unknown")
                    status = data.get("error_status", "?")
                    _log.warning("stream_response: API retry #%s (HTTP %s: %s)", attempt, status, error)
                    yield {"type": "api_retry", "attempt": attempt, "error": error, "status": status}

            elif isinstance(msg, StreamEvent):
                event = msg.event
                etype = event.get("type")

                if etype == "content_block_start":
                    cb = event.get("content_block", {})
                    if cb.get("type") == "tool_use":
                        current_tool = cb.get("name")
                        tool_input = ""
                        yield {"type": "tool_start", "name": current_tool}

                elif etype == "content_block_delta":
                    delta = event.get("delta", {})
                    if delta.get("type") == "text_delta":
                        got_stream_events = True
                        text = delta.get("text", "")
                        self.output_buffer.append(text)
                        yield text
                    elif delta.get("type") == "input_json_delta":
                        got_stream_events = True
                        tool_input += delta.get("partial_json", "")

                elif etype == "content_block_stop":
                    if current_tool:
                        parsed = {}
                        try:
                            parsed = json.loads(tool_input)
                        except Exception:
                            pass
                        yield {"type": "tool_done", "name": current_tool, "input": parsed}
                        current_tool = None
                        tool_input = ""

            elif isinstance(msg, AssistantMessage):
                # The CLI sends a complete AssistantMessage after the streaming
                # deltas. Only use it as fallback if we got NO stream events.
                if got_stream_events:
                    _log.debug("stream_response: skipping AssistantMessage (already streamed)")
                else:
                    _log.info("stream_response: got AssistantMessage (non-streaming fallback), %d content blocks", len(msg.content))
                    for block in msg.content:
                        if isinstance(block, TextBlock) and block.text:
                            self.output_buffer.append(block.text)
                            yield block.text
                        elif isinstance(block, ToolUseBlock):
                            yield {"type": "tool_start", "name": block.name}
                            yield {"type": "tool_done", "name": block.name, "input": block.input}

            elif isinstance(msg, UserMessage):
                # Tool results come back as UserMessage with ToolResultBlock content
                if isinstance(msg.content, list):
                    for block in msg.content:
                        if isinstance(block, ToolResultBlock):
                            content = block.content
                            if isinstance(content, list):
                                text_parts = [
                                    b["text"]
                                    for b in content
                                    if isinstance(b, dict) and b.get("type") == "text"
                                ]
                                content = "\n".join(text_parts)
                            yield {
                                "type": "tool_result",
                                "tool_use_id": block.tool_use_id,
                                "content": content or "",
                                "is_error": block.is_error or False,
                            }

            elif isinstance(msg, ResultMessage):
                self.status = AgentStatus.idle
                _log.debug("stream_response: got ResultMessage, turn complete")

    async def interrupt(self) -> None:
        """Interrupt the current agent operation."""
        if self._client is not None:
            await self._client.interrupt()
        self.status = AgentStatus.idle

    async def stop(self) -> None:
        """Stop the agent session and disconnect."""
        if self._client is not None:
            try:
                await self._client.disconnect()
            except Exception:
                pass
            self._client = None
        self._connected = False
        self.status = AgentStatus.stopped


class AgentManager:
    """Manages a collection of AgentSession instances across teams."""

    def __init__(self) -> None:
        self.sessions: dict[tuple[str, str], AgentSession] = {}
        self._detach_dir = Path.home() / ".claude" / "litter-tui"
        self._default_model: str | None = _read_user_model()

    async def spawn_agent(
        self,
        team_name: str,
        agent_name: str,
        model: str | None = None,
        initial_prompt: str = "",
    ) -> AgentSession:
        """Spawn a new agent session, optionally sending an initial prompt."""
        session = AgentSession(
            team_name=team_name,
            agent_name=agent_name,
            model=model or self._default_model,
        )
        await session.start()
        self.sessions[(team_name, agent_name)] = session

        if initial_prompt:
            await session.send_prompt(initial_prompt)

        return session

    def get_session(self, team_name: str, agent_name: str) -> AgentSession | None:
        """Return an existing session or None."""
        return self.sessions.get((team_name, agent_name))

    async def stop_agent(self, team_name: str, agent_name: str) -> None:
        """Stop a specific agent and remove it from the registry."""
        key = (team_name, agent_name)
        session = self.sessions.get(key)
        if session is not None:
            await session.stop()
            del self.sessions[key]

    async def stop_team(self, team_name: str) -> None:
        """Stop all agents belonging to a team."""
        keys = [k for k in self.sessions if k[0] == team_name]
        for key in keys:
            await self.sessions[key].stop()
            del self.sessions[key]

    def rename_team(self, old_name: str, new_name: str) -> None:
        """Re-key all sessions from *old_name* to *new_name*."""
        for key in list(self.sessions):
            if key[0] == old_name:
                session = self.sessions.pop(key)
                session.team_name = new_name
                self.sessions[(new_name, key[1])] = session

    async def duplicate_agent(
        self,
        source_team: str,
        source_agent: str,
        target_team: str,
        new_name: str,
        model: str | None = None,
        initial_prompt: str = "",
    ) -> AgentSession:
        """Create a new agent session, optionally inheriting model from source."""
        if model is None:
            source = self.sessions.get((source_team, source_agent))
            model = source.model if source is not None else self._default_model
        return await self.spawn_agent(
            target_team, new_name, model=model, initial_prompt=initial_prompt,
        )

    async def move_agent(
        self,
        from_team: str,
        agent_name: str,
        to_team: str,
    ) -> AgentSession:
        """Move an agent session from one team to another."""
        key = (from_team, agent_name)
        session = self.sessions.pop(key, None)

        if session is None:
            return await self.spawn_agent(to_team, agent_name)

        session.team_name = to_team
        self.sessions[(to_team, agent_name)] = session
        return session

    async def detach(self, team_name: str, agent_name: str) -> None:
        """Detach an agent: save its session_id to disk then stop tracking it in memory."""
        key = (team_name, agent_name)
        session = self.sessions.get(key)
        if session is None:
            return

        detach_dir = anyio.Path(self._detach_dir)
        await detach_dir.mkdir(parents=True, exist_ok=True)
        detach_file = detach_dir / "detached-sessions.json"

        data: dict = {}
        if await detach_file.exists():
            try:
                data = json.loads(await detach_file.read_text())
            except (json.JSONDecodeError, OSError):
                data = {}

        data.setdefault(team_name, {})[agent_name] = {
            "session_id": session.session_id,
            "model": session.model,
        }
        await detach_file.write_text(json.dumps(data, indent=2))

        await session.stop()
        del self.sessions[key]

    async def reattach(self, team_name: str, agent_name: str) -> AgentSession | None:
        """Reattach a previously detached agent using its saved session_id."""
        detach_file = anyio.Path(self._detach_dir / "detached-sessions.json")
        if not await detach_file.exists():
            return None

        try:
            data = json.loads(await detach_file.read_text())
        except (json.JSONDecodeError, OSError):
            return None

        entry = data.get(team_name, {}).get(agent_name)
        if entry is None:
            return None

        session_id: str | None = entry.get("session_id")
        model: str | None = entry.get("model") or self._default_model

        from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

        settings = ClaudeSettings.load()
        resume_opts: dict = {
            "include_partial_messages": True,
            "env": settings.env,
        }
        if model:
            resume_opts["model"] = model
        if session_id:
            resume_opts["resume"] = session_id

        options = ClaudeAgentOptions(**resume_opts)
        client = ClaudeSDKClient(options)
        await client.connect()

        session = AgentSession(
            team_name=team_name,
            agent_name=agent_name,
            model=model,
            session_id=session_id,
            status=AgentStatus.idle,
            _client=client,
            _connected=True,
        )
        self.sessions[(team_name, agent_name)] = session

        # Remove from detached records
        del data[team_name][agent_name]
        if not data[team_name]:
            del data[team_name]
        await detach_file.write_text(json.dumps(data, indent=2))

        return session
