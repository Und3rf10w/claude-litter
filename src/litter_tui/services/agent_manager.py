"""Agent Manager Service — wraps claude-agent-sdk for managing swarm agent sessions."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, AsyncIterator

if TYPE_CHECKING:
    pass


class AgentStatus(Enum):
    starting = "starting"
    active = "active"
    idle = "idle"
    stopped = "stopped"


@dataclass
class AgentSession:
    team_name: str
    agent_name: str
    model: str = "sonnet"
    session_id: str | None = None
    status: AgentStatus = AgentStatus.starting
    output_buffer: list[str] = field(default_factory=list)
    _client: object | None = field(default=None, repr=False)

    async def start(self) -> None:
        """Initialize ClaudeSDKClient for this session."""
        from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

        options = ClaudeAgentOptions(model=self.model)
        self._client = ClaudeSDKClient(options)
        self.status = AgentStatus.idle

    async def send_prompt(self, prompt: str) -> None:
        """Send a prompt to the agent."""
        if self._client is None:
            await self.start()
        self.status = AgentStatus.active
        self._client.query(prompt)  # type: ignore[union-attr]

    async def interrupt(self) -> None:
        """Interrupt the current agent operation."""
        if self._client is not None:
            self._client.interrupt()  # type: ignore[union-attr]
        self.status = AgentStatus.idle

    async def stop(self) -> None:
        """Stop the agent session."""
        if self._client is not None:
            try:
                self._client.interrupt()  # type: ignore[union-attr]
            except Exception:
                pass
            self._client = None
        self.status = AgentStatus.stopped

    async def stream_output(self) -> AsyncIterator[str]:
        """Stream output messages from the agent.

        Yields text content from AssistantMessages and result summaries from ResultMessages.
        Captures session_id from SystemMessage init events.
        Sets status to idle when a ResultMessage is received.
        """
        if self._client is None:
            return

        from claude_agent_sdk import AssistantMessage, ResultMessage, SystemMessage, TextBlock, ToolUseBlock

        async for msg in self._client.receive_response():  # type: ignore[union-attr]
            if isinstance(msg, SystemMessage):
                if getattr(msg, "subtype", None) == "init":
                    sid = getattr(msg, "session_id", None)
                    if sid is not None:
                        self.session_id = sid

            elif isinstance(msg, AssistantMessage):
                content = getattr(msg, "content", [])
                for block in content:
                    if isinstance(block, TextBlock):
                        text = block.text
                        self.output_buffer.append(text)
                        yield text
                    elif isinstance(block, ToolUseBlock):
                        tool_name = getattr(block, "name", "unknown")
                        tool_input = getattr(block, "input", {})
                        formatted = f"[Tool: {tool_name}] {json.dumps(tool_input)}"
                        self.output_buffer.append(formatted)
                        yield formatted

            elif isinstance(msg, ResultMessage):
                result_text = getattr(msg, "result", "")
                if result_text:
                    self.output_buffer.append(result_text)
                    yield result_text
                self.status = AgentStatus.idle


class AgentManager:
    """Manages a collection of AgentSession instances across teams."""

    def __init__(self) -> None:
        self.sessions: dict[tuple[str, str], AgentSession] = {}
        self._detach_dir = Path.home() / ".claude" / "litter-tui"

    async def spawn_agent(
        self,
        team_name: str,
        agent_name: str,
        model: str = "sonnet",
        initial_prompt: str = "",
    ) -> AgentSession:
        """Spawn a new agent session, optionally sending an initial prompt."""
        session = AgentSession(
            team_name=team_name,
            agent_name=agent_name,
            model=model,
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

    async def duplicate_agent(
        self,
        team_name: str,
        agent_name: str,
        new_name: str,
    ) -> AgentSession:
        """Create a new agent session with the same model as an existing one."""
        source = self.sessions.get((team_name, agent_name))
        model = source.model if source is not None else "sonnet"
        return await self.spawn_agent(team_name, new_name, model=model)

    async def move_agent(
        self,
        from_team: str,
        agent_name: str,
        to_team: str,
    ) -> AgentSession:
        """Move an agent session from one team to another.

        Updates the session's team_name and re-registers it under the new key.
        The old key is removed from the registry.
        """
        key = (from_team, agent_name)
        session = self.sessions.pop(key, None)

        if session is None:
            # Spawn fresh if no existing session
            return await self.spawn_agent(to_team, agent_name)

        session.team_name = to_team
        self.sessions[(to_team, agent_name)] = session
        return session

    async def detach(self, team_name: str, agent_name: str) -> None:
        """Detach an agent: save its session_id to disk then stop tracking it in memory.

        Persists to ~/.claude/litter-tui/detached-sessions.json.
        """
        key = (team_name, agent_name)
        session = self.sessions.get(key)
        if session is None:
            return

        self._detach_dir.mkdir(parents=True, exist_ok=True)
        detach_file = self._detach_dir / "detached-sessions.json"

        data: dict = {}
        if detach_file.exists():
            try:
                data = json.loads(detach_file.read_text())
            except (json.JSONDecodeError, OSError):
                data = {}

        data.setdefault(team_name, {})[agent_name] = {
            "session_id": session.session_id,
            "model": session.model,
        }
        detach_file.write_text(json.dumps(data, indent=2))

        # Stop the session but don't destroy persisted data
        await session.stop()
        del self.sessions[key]

    async def reattach(self, team_name: str, agent_name: str) -> AgentSession | None:
        """Reattach a previously detached agent using its saved session_id.

        Reads ~/.claude/litter-tui/detached-sessions.json to find stored metadata,
        spawns a new session, and sets the session_id so the SDK can resume it.
        Returns None if no detached record is found.
        """
        detach_file = self._detach_dir / "detached-sessions.json"
        if not detach_file.exists():
            return None

        try:
            data = json.loads(detach_file.read_text())
        except (json.JSONDecodeError, OSError):
            return None

        entry = data.get(team_name, {}).get(agent_name)
        if entry is None:
            return None

        session_id: str | None = entry.get("session_id")
        model: str = entry.get("model", "sonnet")

        from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

        resume_opts: dict = {"model": model}
        if session_id:
            resume_opts["resume"] = session_id

        options = ClaudeAgentOptions(**resume_opts)
        client = ClaudeSDKClient(options)

        session = AgentSession(
            team_name=team_name,
            agent_name=agent_name,
            model=model,
            session_id=session_id,
            status=AgentStatus.idle,
            _client=client,
        )
        self.sessions[(team_name, agent_name)] = session

        # Remove from detached records
        del data[team_name][agent_name]
        if not data[team_name]:
            del data[team_name]
        detach_file.write_text(json.dumps(data, indent=2))

        return session
