"""MainScreen — primary application screen."""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

from textual import work
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.screen import Screen
from textual.timer import Timer
from textual.widgets import Footer, Header, LoadingIndicator, Static

from claude_litter.models.task import TodoItem
from claude_litter.screens.configure_agent import _normalize_model
from claude_litter.services.agent_manager import AgentManager, PermissionRequest
from claude_litter.services.state import InboxUpdated, StateManager, TaskUpdated, TeamUpdated, TranscriptActivity
from claude_litter.services.team_service import TeamService
from claude_litter.utils import COLOR_MAP
from claude_litter.widgets.context_menu import ContextMenu
from claude_litter.widgets.input_bar import CommandSubmitted, InputBar, PermissionResponse, PromptSubmitted
from claude_litter.widgets.message_panel import MessageComposed, MessagePanel
from claude_litter.widgets.session_view import SessionView, TodoWriteDetected, _format_tool_input
from claude_litter.widgets.sidebar import TeamSidebar
from claude_litter.widgets.status_bar import StatusBar
from claude_litter.widgets.tab_bar import SessionTabBar
from claude_litter.widgets.task_panel import TaskPanel, TaskSelected

_log = logging.getLogger("claude_litter.main_screen")


_WELCOME_TEXT = """\
[bold]Welcome to claude-litter[/bold]

No teams found. Get started:

  [bold cyan]Ctrl+N[/bold cyan]  Create a new team
  [bold cyan]Ctrl+S[/bold cyan]  Spawn an agent
  [bold cyan]Ctrl+T[/bold cyan]  Toggle task panel
  [bold cyan]F2[/bold cyan]      Toggle message panel
  [bold cyan]F1[/bold cyan]      About

Teams are read from [dim]~/.claude/teams/[/dim]
"""

# Key used for the main (default) chat session
_MAIN_CHAT_KEY = ("", "Litter Overlord")

# Team-overlord plugin path and config
_PLUGIN_PATH = str(Path(__file__).resolve().parents[3] / "plugins" / "team-overlord")
_PLUGIN_CONFIG: list[dict] = [{"type": "local", "path": _PLUGIN_PATH}]


@dataclass
class AgentBuffer:
    """Per-agent output accumulator. Source of truth for an agent's display history."""

    history: list[str | dict] = field(default_factory=list)
    stream_accumulator: list[str] = field(default_factory=list)
    stream_buffer: list[str] = field(default_factory=list)
    streaming_block_count: int = 0
    streaming: bool = False
    sv_line_count: int = 0  # RichLog lines occupied by current streaming block


class MainScreen(Screen):
    """The main application screen with sidebar, session view, and panels."""

    DEFAULT_CSS = """
    MainScreen #welcome-message {
        width: 1fr;
        height: 1fr;
        content-align: center middle;
        text-align: center;
        color: $text-muted;
        padding: 2 4;
    }

    MainScreen #layout {
        height: 1fr;
    }

    MainScreen #main-content {
        width: 1fr;
    }

    MainScreen #input-bar {
        dock: bottom;
    }
    """

    def __init__(self, agent_manager: AgentManager | None = None, **kwargs) -> None:
        super().__init__(**kwargs)
        self._agent_manager = agent_manager or AgentManager()
        self._team_service = TeamService()
        self._agent_outputs: dict[tuple[str, str], AgentBuffer] = {}
        self._active_agent_key: tuple[str, str] | None = _MAIN_CHAT_KEY
        # Cache of full member dicts from config.json, keyed by (team, agent)
        self._member_info: dict[tuple[str, str], dict] = {}
        # Pending permission requests per agent, keyed by (team, agent)
        self._pending_permissions: dict[tuple[str, str], PermissionRequest] = {}
        self._sidebar_refresh_timer: Timer | None = None

    # ------------------------------------------------------------------
    # Per-agent buffer helpers
    # ------------------------------------------------------------------

    def _get_buf(self, key: tuple[str, str] | None = None) -> AgentBuffer:
        """Get or create the AgentBuffer for the given key (default: active agent)."""
        if key is None:
            key = self._active_agent_key or _MAIN_CHAT_KEY
        return self._agent_outputs.setdefault(key, AgentBuffer())

    def _buf_flush(self, buf: AgentBuffer, sv: SessionView | None) -> None:
        """Flush buf.stream_buffer into the accumulator and update the view.

        On the view, the entire streaming turn is shown as a single block
        that gets replaced in-place on each flush, so text renders at full width.
        """
        if not buf.stream_buffer:
            return
        buf.stream_accumulator.extend(buf.stream_buffer)
        buf.stream_buffer.clear()
        if sv is None:
            return
        # Render the full accumulated text as one block on the view
        full_text = "".join(buf.stream_accumulator)
        if not full_text:
            return
        try:
            from claude_litter.widgets.session_view import SelectableLog

            log = sv.query_one(SelectableLog)
            if buf.streaming_block_count > 0:
                # Replace: remove previous streaming lines, rewrite
                if buf.sv_line_count > 0:
                    del log.lines[-buf.sv_line_count :]
                if sv._output_history:
                    sv._output_history.pop()
                if sv._render_items:
                    sv._render_items.pop()
            else:
                buf.streaming_block_count = 1
            renderable = sv._render_markdown(full_text)
            old_count = len(log.lines)
            log.write(renderable, expand=True)
            buf.sv_line_count = len(log.lines) - old_count
            sv._output_history.append(full_text)
            sv._render_items.append(renderable)
            log.virtual_size = log.virtual_size.with_height(len(log.lines))
            if not sv._user_scrolled_up:
                log.scroll_end(animate=False)
        except Exception:
            pass

    def _buf_finalize(self, buf: AgentBuffer, sv: SessionView | None) -> None:
        """Consolidate streaming turn: commit accumulated text to buf.history."""
        if not buf.stream_accumulator:
            buf.streaming_block_count = 0
            buf.sv_line_count = 0
            return
        full_text = "".join(buf.stream_accumulator)
        buf.stream_accumulator.clear()
        buf.history.append(full_text)
        buf.streaming_block_count = 0
        buf.sv_line_count = 0

    def _buf_append_tool(self, buf: AgentBuffer, chunk: dict, sv: SessionView | None) -> None:
        """Record a tool event in buf.history and optionally render to sv."""
        buf.history.append(chunk)
        if sv is not None:
            sv.render_tool_chunk(chunk)

    def _replay_buffer_to_sv(self, buf: AgentBuffer, sv: SessionView) -> None:
        """Replay a buffer into a freshly-cleared SessionView."""
        sv.clear_output()
        for entry in buf.history:
            if isinstance(entry, str):
                sv.append_output(entry)
            elif isinstance(entry, dict):
                sv.render_tool_chunk(entry)
        # If there's an in-progress streaming turn, render it too
        if buf.stream_accumulator:
            partial = "".join(buf.stream_accumulator)
            if partial:
                from claude_litter.widgets.session_view import SelectableLog

                try:
                    log = sv.query_one(SelectableLog)
                    renderable = sv._render_markdown(partial)
                    old_count = len(log.lines)
                    log.write(renderable, expand=True)
                    buf.sv_line_count = len(log.lines) - old_count
                    buf.streaming_block_count = 1
                    sv._output_history.append(partial)
                    sv._render_items.append(renderable)
                    log.virtual_size = log.virtual_size.with_height(len(log.lines))
                    log.scroll_end(animate=False)
                except Exception:
                    pass
        else:
            # Reset so next flush starts clean
            buf.sv_line_count = 0
            buf.streaming_block_count = 0

    def get_selected_text(self) -> str:
        """Return the currently selected text from the active SessionView, or empty string."""
        try:
            from claude_litter.widgets.session_view import SelectableLog

            sv = self.query_one("#session-view", SessionView)
            if not sv.display:
                return ""
            log = sv.query_one(SelectableLog)
            selection = log.text_selection
            if selection is None:
                return ""
            result = log.get_selection(selection)
            if result is None:
                return ""
            return result[0]
        except Exception:
            return ""

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal(id="layout"):
            yield TeamSidebar(id="sidebar")
            with Vertical(id="main-content"):
                yield SessionTabBar(id="tab-bar")
                yield Static(_WELCOME_TEXT, id="welcome-message", markup=True)
                yield SessionView(id="session-view")
                yield InputBar(id="input-bar")
                yield StatusBar(id="status-bar")
        yield TaskPanel(id="task-panel", classes="slide-panel")
        yield MessagePanel(id="message-panel", classes="slide-panel")
        from claude_litter.widgets.swarm_panel import SwarmPanel

        yield SwarmPanel(id="swarm-panel")
        yield ContextMenu(id="context-menu")
        yield Footer()

    async def on_mount(self) -> None:
        # Start the filesystem watcher for live updates
        self._state_manager = StateManager()
        self._state_manager.set_app(self)
        await self._state_manager.start()
        self._update_swarm_project_roots()

        # Skip the welcome screen — go straight to a live session
        self.show_session()
        sv = self.query_one("#session-view", SessionView)
        sv.append_output("[dim]Connecting to agent...[/dim]\n")
        self._connect_default_agent()
        # Add the permanent "Litter Overlord" tab
        tab_bar = self.query_one("#tab-bar", SessionTabBar)
        tab_bar.add_tab("", "Litter Overlord")
        # Focus the input bar so the user can start typing immediately
        self.query_one("#prompt-input").focus()
        # Populate the sidebar with any existing teams
        self._refresh_sidebar()

    # ------------------------------------------------------------------
    # Prompt handling
    # ------------------------------------------------------------------

    @work(exclusive=True, group="connect")
    async def _connect_default_agent(self) -> None:
        """Pre-spawn the default agent session so it's ready when the user types."""
        sv = self.query_one("#session-view", SessionView)
        try:
            session = await self._agent_manager.spawn_agent("", "default", plugins=_PLUGIN_CONFIG)
            self._wire_permission_callback(session, _MAIN_CHAT_KEY)
            # Populate autocomplete with CC commands from server_info
            if session.server_info:
                cc_commands = {c["name"]: c.get("description", "") for c in session.server_info.get("commands", [])}
                self.query_one("#input-bar", InputBar).update_commands(cc_commands)
            sv.clear_output()
        except Exception as exc:
            sv.append_output(
                f"\n[red]Failed to connect to agent: {exc}[/red]\n"
                "[dim]Make sure Claude Code is available and claude-agent-sdk is installed.[/dim]\n"
            )

    def on_prompt_submitted(self, event: PromptSubmitted) -> None:
        """Handle prompt submission: reuse session, stream response.

        Dispatches to a @work task so the UI stays responsive.
        """
        _log.info("on_prompt_submitted fired, text=%r", event.text)
        self.show_session()
        sv = self.query_one("#session-view", SessionView)
        line = f"\n[bold cyan]> {event.text.replace('[', '\\[')}[/bold cyan]\n"
        buf = self._get_buf()
        buf.history.append(line)
        sv.append_output(line, as_markup=True)
        self._dispatch_prompt(event.text, event.images)

    def on_command_submitted(self, event: CommandSubmitted) -> None:
        """Handle /command submissions from InputBar."""
        cmd = event.command
        args = event.args

        # TUI-native commands that need AgentManager (not in MCP)
        if cmd == "spawn":
            if self._active_agent_key and self._active_agent_key != _MAIN_CHAT_KEY:
                self._team_spawn_agent(self._active_agent_key[0])
            else:
                from claude_litter.screens.spawn_agent import SpawnAgentScreen

                self.app.push_screen(SpawnAgentScreen(), lambda r: None)
            return

        if cmd == "kill" and args:
            parts = args.split(None, 1)
            if len(parts) >= 2:
                self._kill_agent(parts[0], parts[1])
                return

        if cmd == "detach":
            if self._active_agent_key and self._active_agent_key != _MAIN_CHAT_KEY:
                self._detach_agent(*self._active_agent_key)
            return

        # Everything else -> forward as slash command to the agent session.
        # This includes plugin commands (/team, /task, /msg, /broadcast)
        # and CC native commands (/help, /compact, /config, etc.)
        full_cmd = f"/{cmd} {args}".strip() if args else f"/{cmd}"
        self.show_session()
        sv = self.query_one("#session-view", SessionView)
        line = f"\n[bold cyan]{full_cmd.replace('[', '\\[')}[/bold cyan]\n"
        buf = self._get_buf()
        buf.history.append(line)
        sv.append_output(line)
        self._dispatch_prompt(full_cmd, None)

    def _build_team_context(self) -> str:
        """Build a context block describing active teams and agents for Litter Overlord Chat."""
        team_names = self._team_service.list_teams()
        if not team_names:
            return ""

        lines: list[str] = ["<team-context>"]
        for name in team_names:
            config = self._team_service.get_team(name)
            if config is None:
                continue
            members = config.get("members", [])
            active = [m for m in members if m.get("status") == "active"]
            lines.append(f"Team: {name} ({len(active)}/{len(members)} active)")
            for m in members:
                status = m.get("status", "unknown")
                model = m.get("model", "sonnet")
                agent_type = m.get("agentType", "")
                agent_name = m.get("name", "?")
                parts = [f"  - {agent_name} [{status}] model={model}"]
                if agent_type:
                    parts.append(f"type={agent_type}")
                cwd = m.get("cwd", "")
                if cwd:
                    home = str(Path.home())
                    display = cwd.replace(home, "~") if cwd.startswith(home) else cwd
                    parts.append(f"cwd={display}")
                lines.append(" ".join(parts))

            # Include tasks summary
            tasks = self._team_service.list_tasks(name)
            if tasks:
                done = sum(1 for t in tasks if t.get("status") == "completed")
                in_prog = sum(1 for t in tasks if t.get("status") == "in_progress")
                pending = sum(1 for t in tasks if t.get("status") == "pending")
                lines.append(f"  Tasks: {done} done, {in_prog} in progress, {pending} pending")

        lines.append("</team-context>")
        return "\n".join(lines)

    def _dispatch_prompt(self, text: str, images: list[tuple[str, bytes]] | None) -> None:
        """Dispatch a prompt to a per-agent worker so concurrent agents don't cancel each other."""
        key = self._active_agent_key or _MAIN_CHAT_KEY
        group = f"prompt-{key[0]}-{key[1]}"
        self.run_worker(
            self._run_prompt_async(text, images, key),
            exclusive=True,
            group=group,
        )

    async def _run_prompt_async(self, text: str, images: list[tuple[str, bytes]] | None, key: tuple[str, str]) -> None:
        """Background worker: send prompt to session, then stream response inline."""
        _log.info("_run_prompt worker started, text=%r", text)
        sv = self.query_one("#session-view", SessionView)
        streaming_key = key
        buf = self._get_buf(streaming_key)
        try:
            # Inject team context for Main Chat prompts
            if streaming_key == _MAIN_CHAT_KEY:
                context = self._build_team_context()
                if context:
                    text = f"{context}\n\n{text}"

            # Resolve session for this specific agent
            if streaming_key != _MAIN_CHAT_KEY:
                team, agent = streaming_key
                session = self._agent_manager.get_session(team, agent)
                if session is None:
                    member = self._member_info.get(streaming_key, {})
                    model = member.get("model", "sonnet")
                    session = await self._agent_manager.spawn_agent(
                        team,
                        agent,
                        model=model,
                    )
                self._wire_permission_callback(session, streaming_key)
            else:
                session = self._agent_manager.get_session("", "default")
                if session is None:
                    session = await self._agent_manager.spawn_agent("", "default", plugins=_PLUGIN_CONFIG)
                    if session.server_info:
                        cc_commands = {
                            c["name"]: c.get("description", "") for c in session.server_info.get("commands", [])
                        }
                        self.query_one("#input-bar", InputBar).update_commands(cc_commands)
                self._wire_permission_callback(session, _MAIN_CHAT_KEY)

            _log.info("_run_prompt: calling send_prompt")
            await session.send_prompt(text, images=images)
            _log.info("_run_prompt: send_prompt done, starting inline stream")

            buf.streaming = True
            sv._set_active()
            sv._streaming = True
            await self._stream_to_buffer(session, buf, sv, streaming_key)
            _log.info("_run_prompt: stream ended")
        except Exception as exc:
            _log.exception("_run_prompt: exception: %s", exc)
            err = (
                f"\n[red]Failed to connect to agent: {exc}[/red]\n"
                "[dim]Make sure Claude Code is available and claude-agent-sdk is installed.[/dim]\n"
            )
            buf.history.append(err)
            if self._active_agent_key == streaming_key:
                sv.append_output(err)

    async def _stream_to_buffer(
        self, session, buf: AgentBuffer, sv: SessionView, streaming_key: tuple[str, str]
    ) -> None:
        """Stream response chunks from an agent session into the buffer and view."""
        last_flush = time.monotonic()
        try:
            async for chunk in session.stream_response():
                active_sv = sv if self._active_agent_key == streaming_key else None
                if isinstance(chunk, str) and chunk:
                    buf.stream_buffer.append(chunk)
                    now = time.monotonic()
                    if now - last_flush >= SessionView._FLUSH_INTERVAL:
                        self._buf_flush(buf, active_sv)
                        last_flush = now
                elif isinstance(chunk, dict):
                    self._buf_flush(buf, active_sv)
                    self._buf_finalize(buf, active_sv)
                    self._buf_append_tool(buf, chunk, active_sv)
        finally:
            active_sv = sv if self._active_agent_key == streaming_key else None
            self._buf_flush(buf, active_sv)
            self._buf_finalize(buf, active_sv)
            buf.streaming = False
            if active_sv is not None:
                sv._set_idle()
                sv._streaming = False

    # ------------------------------------------------------------------
    # Todo handling
    # ------------------------------------------------------------------

    def on_todo_write_detected(self, event: TodoWriteDetected) -> None:
        """Handle TodoWrite tool calls by updating the task panel."""
        todos = [TodoItem.from_dict(t) for t in event.todos]
        self.query_one("#task-panel", TaskPanel).update_todos(todos)

    # ------------------------------------------------------------------
    # Permission prompt handling
    # ------------------------------------------------------------------

    def _wire_permission_callback(self, session: object, key: tuple[str, str]) -> None:
        """Attach the permission callback to an AgentSession so it notifies the TUI."""
        from claude_litter.services.agent_manager import AgentSession

        if isinstance(session, AgentSession):
            session._permission_callback = lambda sess, req: self._on_permission_request(key, req)

    def _on_permission_request(self, key: tuple[str, str], req: PermissionRequest) -> None:
        """Called from the SDK's internal task when a tool needs permission.

        Must be thread-safe — the SDK callback may run on a different thread.
        """
        self.app.call_from_thread(self._show_permission_request, key, req)

    def _show_permission_request(self, key: tuple[str, str], req: PermissionRequest) -> None:
        """Show the permission prompt in the TUI (runs on the main thread)."""
        self._pending_permissions[key] = req
        if self._active_agent_key == key:
            sv = self.query_one("#session-view", SessionView)
            sv.render_permission_request(req.tool_name, req.tool_input)
            input_bar = self.query_one("#input-bar", InputBar)
            summary = _format_tool_input(req.tool_name, req.tool_input)
            input_bar.enter_permission_mode(req.tool_name, summary)

    def on_permission_response(self, event: PermissionResponse) -> None:
        """Handle the user's Allow/Deny/Always response to a permission prompt."""
        from claude_agent_sdk.types import (
            PermissionResultAllow,
            PermissionResultDeny,
        )

        key = self._active_agent_key
        if key is None:
            return
        req = self._pending_permissions.pop(key, None)
        if req is None:
            return

        if event.allow:
            updated_permissions = None
            if event.always and req.suggestions:
                updated_permissions = req.suggestions
            result = PermissionResultAllow(updated_permissions=updated_permissions)
        else:
            result = PermissionResultDeny(message="User denied in TUI")

        req.resolve(result)
        self.query_one("#input-bar", InputBar).exit_permission_mode()

    # ------------------------------------------------------------------
    # View switching
    # ------------------------------------------------------------------

    def show_session(self) -> None:
        """Switch from welcome message to a session view."""
        self.query_one("#welcome-message", Static).display = False
        self.query_one("#session-view", SessionView).display = True

    def show_welcome(self) -> None:
        """Switch back to the welcome message."""
        self.query_one("#welcome-message", Static).display = True
        self.query_one("#session-view", SessionView).display = False

    def _resolve_active_team(self) -> str | None:
        """Return the team dir_name for the currently selected agent, or the first available team."""
        if self._active_agent_key and self._active_agent_key != _MAIN_CHAT_KEY:
            return self._active_agent_key[0]
        teams = self._team_service.list_teams()
        return teams[0] if teams else None

    def _display_name(self, dir_name: str) -> str:
        """Resolve a team directory name to its display name from config.json."""
        config = self._team_service.get_team(dir_name)
        if config:
            return config.get("name", dir_name)
        return dir_name

    def _team_label(self, dir_name: str) -> str:
        """Return a user-friendly team label: description if available, else display name."""
        config = self._team_service.get_team(dir_name)
        if config:
            desc = config.get("description", "")
            if desc:
                return desc
            return config.get("name", dir_name)
        return dir_name

    def toggle_tasks(self) -> None:
        """Show/hide the task panel."""
        panel = self.query_one("#task-panel", TaskPanel)
        panel.toggle()
        if panel._visible:
            team = self._resolve_active_team()
            if team:
                tasks = self._team_service.list_tasks(team)
                panel.update_tasks(tasks)

    def toggle_messages(self) -> None:
        """Show/hide the message panel."""
        panel = self.query_one("#message-panel", MessagePanel)
        panel.toggle()
        if panel._visible:
            if self._active_agent_key and self._active_agent_key != _MAIN_CHAT_KEY:
                team, agent = self._active_agent_key
                self._update_message_panel(team, agent)
            else:
                team = self._resolve_active_team()
                if team:
                    config = self._team_service.get_team(team)
                    if config and config.get("members"):
                        agent = config["members"][0].get("name", "")
                        if agent:
                            self._update_message_panel(team, agent)

    def toggle_swarm(self) -> None:
        """Show/hide the swarm-loop panel."""
        try:
            from claude_litter.widgets.swarm_panel import SwarmPanel

            panel = self.query_one("#swarm-panel", SwarmPanel)
            panel.toggle()
            if panel._visible:
                self._refresh_swarm_panel()
        except Exception:
            pass

    def _refresh_swarm_panel(self) -> None:
        """Push fresh swarm state into the panel."""
        if not hasattr(self, "_state_manager"):
            return
        instances = self._state_manager.get_swarm_instances()
        try:
            from claude_litter.widgets.swarm_panel import SwarmPanel

            self.query_one("#swarm-panel", SwarmPanel).update_instances(instances)
        except Exception:
            pass
        try:
            from claude_litter.widgets.sidebar import TeamSidebar

            self.query_one("#sidebar", TeamSidebar).update_swarm_instances(instances)
        except Exception:
            pass

    def _update_swarm_project_roots(self) -> None:
        """Collect project roots from team member cwds + own CWD."""
        roots: set[str] = set()
        roots.add(str(Path.cwd()))
        for _key, info in self._member_info.items():
            cwd = info.get("cwd", "")
            if cwd:
                roots.add(cwd)
        if hasattr(self, "_state_manager"):
            self._state_manager.set_swarm_project_roots(roots)

    def _update_message_panel(self, team: str, agent: str) -> None:
        """Populate the message panel with the agent's inbox messages."""
        panel = self.query_one("#message-panel", MessagePanel)
        panel.set_agent(team, agent)

        # Set known agents from the team config
        config = self._team_service.get_team(team)
        if config:
            agent_names = [m.get("name", "") for m in config.get("members", []) if m.get("name")]
            panel.set_known_agents(agent_names)

        # Load all inbox messages (including read ones)
        messages = self._team_service.read_inbox(team, agent)
        # Format structured JSON messages; split into inbox vs broadcast
        formatted: list[dict] = []
        broadcast: list[dict] = []
        for msg in messages:
            text = msg.get("text", "")
            display_text = self._format_inbox_text(text, truncate=False)
            if display_text == "":  # skip idle notifications
                continue
            entry = {**msg, "text": display_text}
            summary = msg.get("summary", "")
            if summary.startswith("[broadcast]"):
                broadcast.append(entry)
            else:
                formatted.append(entry)
        panel.update_messages(formatted)
        panel.update_messages(broadcast, broadcast=True)

    def on_message_composed(self, event: MessageComposed) -> None:
        """Handle message sent from the message panel compose form."""
        if not self._active_agent_key or self._active_agent_key == _MAIN_CHAT_KEY:
            return
        team, agent = self._active_agent_key
        if event.broadcast:
            count = self._team_service.broadcast_message(team, agent, event.text)
            self.notify(f"Broadcast sent to {count} agent(s)")
        else:
            self._team_service.send_message(team, event.to, agent, event.text)
        # Refresh the panel to show the sent message
        self._update_message_panel(team, agent)

    # ------------------------------------------------------------------
    # Team management
    # ------------------------------------------------------------------

    def create_team(self, result: dict) -> None:
        """Create a team from the dialog result and refresh the sidebar."""
        name = result["name"]
        description = result.get("description", "")
        config = self._team_service.create_team(name, description)
        dir_name = config.get("dir_name", name)
        _log.info("create_team: created team %r (dir=%r)", name, dir_name)
        self._refresh_sidebar()

        if result.get("auto_lead"):
            model = result.get("model", "sonnet")
            brief = f'You are the team lead for team "{name}".'
            if description:
                brief += f"\n\nTeam description:\n{description}"
            brief += (
                "\n\nYou have access to team management tools via the team-overlord MCP plugin. "
                "Use these to create tasks, spawn agents, assign work, and coordinate the team. "
                "Start by breaking down the work into tasks and spawning the agents you need."
            )
            self._execute_team_spawn(
                dir_name,
                {
                    "name": "team-lead",
                    "model": model,
                    "type": "team-lead",
                    "initial_prompt": brief,
                },
            )

    def _refresh_sidebar(self) -> None:
        """Debounced sidebar refresh — coalesces rapid calls into one rebuild."""
        if self._sidebar_refresh_timer is not None:
            self._sidebar_refresh_timer.stop()
        self._sidebar_refresh_timer = self.set_timer(0.3, self._do_refresh_sidebar)

    def _do_refresh_sidebar(self) -> None:
        """Actually kick off the sidebar worker."""
        self._sidebar_refresh_timer = None
        self._refresh_sidebar_worker()

    @work(exclusive=True, group="sidebar-refresh")
    async def _refresh_sidebar_worker(self) -> None:
        """Background worker: read team data from disk and push to the sidebar."""
        team_names = self._team_service.list_teams()
        teams: list[dict] = []
        member_info: dict = {}
        for name in team_names:
            config = self._team_service.get_team(name)
            if config is not None:
                agents = []
                known_names: set[str] = set()
                for m in config.get("members", []):
                    agent_name = m.get("name", "?")
                    known_names.add(agent_name)
                    try:
                        inbox = self._team_service.read_inbox(name, agent_name)
                        unread = sum(1 for msg in inbox if not msg.get("read", False))
                    except Exception:
                        unread = 0
                    agent_dict = {
                        "name": agent_name,
                        "model": _normalize_model(m.get("model", "sonnet")),
                        "agentType": m.get("agentType", ""),
                        "color": m.get("color", ""),
                        "cwd": m.get("cwd", ""),
                        "unread": unread,
                    }
                    agents.append(agent_dict)
                    # Cache full member info for header display
                    member_info[(name, agent_name)] = m

                # Discover agents from team-lead inbox idle_notifications
                # that aren't in config.json (spawned in later iterations)
                lead_name = ""
                if config.get("members"):
                    lead_name = config["members"][0].get("name", "")
                if lead_name:
                    try:
                        lead_inbox = self._team_service.read_inbox(name, lead_name)
                        for msg in lead_inbox:
                            text = msg.get("text", "")
                            if "idle_notification" not in text:
                                continue
                            try:
                                inner = json.loads(text)
                                from_agent = inner.get("from", "")
                                if from_agent and from_agent not in known_names:
                                    known_names.add(from_agent)
                                    agents.append(
                                        {
                                            "name": from_agent,
                                            "model": "",
                                            "agentType": "",
                                            "color": "",
                                            "cwd": config["members"][0].get("cwd", "") if config.get("members") else "",
                                            "unread": 0,
                                        }
                                    )
                                    member_info[(name, from_agent)] = {
                                        "name": from_agent,
                                        "cwd": config["members"][0].get("cwd", "") if config.get("members") else "",
                                    }
                            except json.JSONDecodeError, TypeError:
                                continue
                    except Exception:
                        pass
                has_active = any(m.get("status") == "active" for m in config.get("members", []))
                # If no member has an explicit status, infer from team-level status
                # or treat as active when members exist (swarm-spawned agents
                # don't always write a per-member status field).
                if not has_active and config.get("members"):
                    all_missing_status = all("status" not in m for m in config.get("members", []))
                    if all_missing_status:
                        has_active = True
                team_status = config.get("status", "active" if has_active else "inactive")
                teams.append(
                    {
                        "name": config.get("name", name),
                        "dir_name": name,
                        "status": team_status,
                        "agents": agents,
                    }
                )
        # Compute task counts while still in the worker (avoids extra disk read in apply)
        task_counts: dict[str, tuple[int, int]] = {}
        for t in teams:
            t_tasks = self._team_service.list_tasks(t["dir_name"])
            task_counts[t["dir_name"]] = (len(t_tasks), sum(1 for tk in t_tasks if tk.get("status") == "completed"))
        self._apply_sidebar_data(teams, member_info, task_counts)

    def _apply_sidebar_data(
        self, teams: list[dict], member_info: dict, task_counts: dict[str, tuple[int, int]]
    ) -> None:
        """Apply the sidebar data computed by the worker to the UI."""
        self._member_info.clear()
        self._member_info.update(member_info)
        self._last_teams: list[dict] = teams
        self._last_task_counts: dict[str, tuple[int, int]] = task_counts
        self.query_one("#sidebar", TeamSidebar).update_teams(teams)
        self._update_status_bar(teams, task_counts)
        self._update_swarm_project_roots()

    def _update_status_bar(self, teams: list[dict], task_counts: dict[str, tuple[int, int]]) -> None:
        """Refresh the StatusBar with current team/task summary."""
        active_team = ""
        if self._active_agent_key and self._active_agent_key != _MAIN_CHAT_KEY:
            active_team = self._active_agent_key[0]
        elif teams:
            active_team = teams[0].get("dir_name", teams[0]["name"])

        agent_count = 0
        active_count = 0
        display_name = active_team
        for t in teams:
            t_dir = t.get("dir_name", t["name"])
            if not active_team or t_dir == active_team:
                display_name = t["name"]
                agent_count += len(t.get("agents", []))
                for ag in t.get("agents", []):
                    if self._agent_manager.get_session(t_dir, ag["name"]) is not None:
                        active_count += 1

        task_total, task_done = task_counts.get(active_team, (0, 0))
        vim_mode = getattr(self.app.config, "vim_mode", False)

        swarm_active = False
        swarm_phase = ""
        swarm_iteration = 0
        if hasattr(self, "_state_manager"):
            try:
                instances = self._state_manager.get_swarm_instances()
                if instances:
                    active = instances[0]
                    swarm_active = True
                    swarm_phase = active.phase
                    swarm_iteration = active.iteration
            except Exception:
                pass

        try:
            sb = self.query_one(StatusBar)
            sb.update_status(
                team_name=display_name,
                agent_count=agent_count,
                active_count=active_count,
                task_total=task_total,
                task_done=task_done,
                vim_mode=vim_mode,
                swarm_active=swarm_active,
                swarm_phase=swarm_phase,
                swarm_iteration=swarm_iteration,
            )
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Main Chat navigation
    # ------------------------------------------------------------------

    def on_team_sidebar_main_chat_selected(self, event: TeamSidebar.MainChatSelected) -> None:
        """Switch back to the main default chat."""
        self._switch_to_main_chat()

    def on_team_sidebar_team_selected(self, event: TeamSidebar.TeamSelected) -> None:
        """Team node clicked — refresh task and message panels for this team."""
        team = event.team
        # Update task panel with this team's tasks
        task_panel = self.query_one("#task-panel", TaskPanel)
        tasks = self._team_service.list_tasks(team)
        task_panel.update_tasks(tasks)

        # Update message panel — if we have an active agent in this team, use it;
        # otherwise pick the first member
        agent = None
        if self._active_agent_key and self._active_agent_key[0] == team:
            agent = self._active_agent_key[1]
        else:
            config = self._team_service.get_team(team)
            if config and config.get("members"):
                agent = config["members"][0].get("name")
        if agent:
            self._update_message_panel(team, agent)

        self._refresh_swarm_panel()

    def _switch_to_main_chat(self) -> None:
        """Restore the main chat session view."""
        sv = self.query_one("#session-view", SessionView)
        tab_bar = self.query_one("#tab-bar", SessionTabBar)
        key = _MAIN_CHAT_KEY

        if self._active_agent_key == key:
            return

        # Detach the view from any streaming agent (loop will see active_sv=None)
        if sv._streaming:
            sv._streaming = False
            sv._set_idle()

        # Activate the Main Chat tab
        tab_bar.add_tab("", "Litter Overlord")
        self._active_agent_key = key

        # Replay main chat buffer
        sv.update_header()  # Reset to default "Session" header
        if key in self._agent_outputs:
            self._replay_buffer_to_sv(self._agent_outputs[key], sv)
            if self._agent_outputs[key].streaming:
                sv._set_active()
                sv._streaming = True
        else:
            sv.clear_output()

        self.show_session()

        # Handle permission mode transitions
        input_bar = self.query_one("#input-bar", InputBar)
        if key in self._pending_permissions:
            req = self._pending_permissions[key]
            summary = _format_tool_input(req.tool_name, req.tool_input)
            input_bar.enter_permission_mode(req.tool_name, summary)
        elif input_bar._permission_mode:
            input_bar.exit_permission_mode()

    # ------------------------------------------------------------------
    # Agent click-to-view + tab switching
    # ------------------------------------------------------------------

    def on_team_sidebar_agent_selected(self, event: TeamSidebar.AgentSelected) -> None:
        """Left-click on an agent node -> switch view to that agent."""
        self._switch_to_agent(event.team, event.agent)
        self._refresh_swarm_panel()

    def on_session_tab_bar_tab_activated(self, event: SessionTabBar.TabActivated) -> None:
        """Tab bar click -> switch view to the selected agent or main chat."""
        if (event.team, event.agent) == _MAIN_CHAT_KEY:
            self._switch_to_main_chat()
        else:
            self._switch_to_agent(event.team, event.agent)

    def on_session_tab_bar_tab_closed(self, event: SessionTabBar.TabClosed) -> None:
        """Tab closed -> if we were viewing that agent, go back to main chat."""
        key = (event.team, event.agent)
        # Clean up saved output
        self._agent_outputs.pop(key, None)
        if self._active_agent_key == key:
            self._switch_to_main_chat()

    def _switch_to_agent(self, team: str, agent: str) -> None:
        """Swap to *agent*'s view by replaying from its buffer."""
        sv = self.query_one("#session-view", SessionView)
        tab_bar = self.query_one("#tab-bar", SessionTabBar)
        key = (team, agent)

        # No-op if already viewing this agent
        if self._active_agent_key == key:
            return

        # Detach the view from any streaming agent (loop will see active_sv=None)
        if sv._streaming:
            sv._streaming = False
            sv._set_idle()

        # Add tab (no-op if already exists), switch session reference
        tab_bar.add_tab(team, agent)
        self._active_agent_key = key

        # Update session header with agent metadata
        member = self._member_info.get(key, {})
        sv.update_header(
            agent_name=agent,
            team=self._team_label(team),
            model=member.get("model", ""),
            cwd=member.get("cwd", ""),
            agent_type=member.get("agentType", ""),
            color=member.get("color", ""),
        )

        # Replay from buffer or load history from disk
        if key in self._agent_outputs:
            self._replay_buffer_to_sv(self._agent_outputs[key], sv)
            if self._agent_outputs[key].streaming:
                sv._set_active()
                sv._streaming = True
        else:
            sv.clear_output()
            self._load_agent_history(team, agent)

        self.show_session()

        # Update message panel with this agent's inbox
        self._update_message_panel(team, agent)

        # Update task panel with this team's tasks
        tasks = self._team_service.list_tasks(team)
        self.query_one("#task-panel", TaskPanel).update_tasks(tasks)

        # Handle permission mode transitions
        input_bar = self.query_one("#input-bar", InputBar)
        if key in self._pending_permissions:
            req = self._pending_permissions[key]
            summary = _format_tool_input(req.tool_name, req.tool_input)
            input_bar.enter_permission_mode(req.tool_name, summary)
        elif input_bar._permission_mode:
            input_bar.exit_permission_mode()

    def _load_agent_history(self, team: str, agent: str) -> None:
        """Schedule loading chat history from inbox messages and JSONL transcripts."""
        agent_key = f"{team}-{agent}"
        self.run_worker(
            self._load_agent_history_async(team, agent),
            exclusive=True,
            group=f"history-{agent_key}",
        )

    async def _load_agent_history_async(self, team: str, agent: str) -> None:
        """Load chat history from inbox messages and JSONL transcripts."""
        sv = self.query_one("#session-view", SessionView)

        # 1. Try loading from inbox (messages sent TO this agent)
        inbox_loaded = self._load_inbox_history(sv, team, agent)

        # 2. Try loading from JSONL transcript
        transcript_loaded = self._load_transcript_history(sv, team, agent)

        if not inbox_loaded and not transcript_loaded:
            sv.append_output(f"[dim]No history found for {agent}[/dim]\n")

    @staticmethod
    def _format_inbox_text(text: str, *, truncate: bool = True) -> str:
        """Parse structured JSON messages into readable text; pass plain text through."""
        if not text.startswith("{"):
            return text
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError, TypeError:
            return text
        msg_type = parsed.get("type", "")
        if msg_type == "idle_notification":
            return ""  # sentinel: skip entirely
        if msg_type == "task_assignment":
            subj = parsed.get("subject", "")
            desc = parsed.get("description", "")
            tid = parsed.get("taskId", "")
            if truncate:
                preview = (desc[:200] + "...") if len(desc) > 200 else desc
            else:
                preview = desc
            return f"[Task #{tid}] {subj}\n  {preview}"
        if msg_type == "task_completed":
            return f"Task #{parsed.get('taskId', '?')} completed: {parsed.get('subject', '')}"
        if msg_type == "shutdown_request":
            return f"Shutdown requested: {parsed.get('reason', '')}"
        if msg_type == "shutdown_response":
            approved = parsed.get("approve", False)
            return f"Shutdown {'approved' if approved else 'rejected'}: {parsed.get('reason', '')}"
        # Fallback: show type + content
        content = json.dumps(parsed, indent=2)
        if truncate and len(content) > 300:
            content = content[:300] + "..."
        safe_type = (msg_type or "json").replace("[", "\\[")
        safe_content = content.replace("[", "\\[")
        return f"[{safe_type}] {safe_content}"

    def _load_inbox_history(self, sv: SessionView, team: str, agent: str) -> bool:
        """Load inbox messages for the agent. Returns True if any were loaded."""
        try:
            messages = self._team_service.read_inbox(team, agent)
            if not messages:
                return False

            sv.append_output(f"[bold]Inbox ({len(messages)} messages)[/bold]\n")
            for msg in messages:
                sender = msg.get("from", "?")
                text = msg.get("text", "")
                color = msg.get("color", "")
                summary = msg.get("summary", "")
                read = msg.get("read", False)

                # Format structured JSON messages into readable text
                display_text = self._format_inbox_text(text)
                if display_text == "":  # skip idle notifications
                    continue

                rich_color = COLOR_MAP.get(color, "dim")
                read_marker = "" if read else " [bold yellow]*[/bold yellow]"

                # Show sender with color badge
                safe_sender = sender.replace("[", "\\[")
                sv.append_output(f"[{rich_color}]{safe_sender}[/{rich_color}]{read_marker}\n")

                # Show summary if available, else formatted text
                safe_display = (
                    summary or (display_text[:200] + "..." if len(display_text) > 200 else display_text)
                ).replace("[", "\\[")
                sv.append_output(f"  {safe_display}\n\n")

            return True
        except Exception as exc:
            _log.debug("Failed to load inbox for %s/%s: %s", team, agent, exc)
            return False

    def _find_agent_transcript(self, subagents_dir: Path, agent: str) -> Path | None:
        """Find the most recent JSONL transcript for an agent in the subagents dir."""
        target_jsonl = None
        best_mtime = 0.0
        for jsonl_path in subagents_dir.glob("agent-*.jsonl"):
            try:
                # Strategy 1: .meta.json sidecar (agentType == agent name)
                meta_path = jsonl_path.with_suffix(".meta.json")
                if meta_path.exists():
                    meta = json.loads(meta_path.read_text())
                    if meta.get("agentType") == agent:
                        mtime = jsonl_path.stat().st_mtime
                        if mtime > best_mtime:
                            target_jsonl = jsonl_path
                            best_mtime = mtime
                    continue

                # Strategy 2: check first line content for agent name patterns
                with open(jsonl_path) as f:
                    first_line = f.readline().strip()
                    if not first_line:
                        continue
                    entry = json.loads(first_line)
                    content = entry.get("message", {}).get("content", "")
                    if isinstance(content, str) and (
                        f'You are "{agent}"' in content
                        or f"You are the {agent} agent" in content
                        or f'teammate_id="{agent}"' in content
                    ):
                        mtime = jsonl_path.stat().st_mtime
                        if mtime > best_mtime:
                            target_jsonl = jsonl_path
                            best_mtime = mtime
            except Exception:
                continue
        return target_jsonl

    def _load_transcript_history(self, sv: SessionView, team: str, agent: str) -> bool:
        """Try to find and load JSONL transcript. Returns True if loaded."""
        member = self._member_info.get((team, agent), {})
        cwd = member.get("cwd", "")
        if not cwd:
            return False

        # Build the sanitized project path
        projects_dir = Path.home() / ".claude" / "projects"
        sanitized_cwd = "".join(c if c.isalnum() else "-" for c in cwd)
        # Truncate if too long (matching CC's mM() function)
        if len(sanitized_cwd) > 200:
            sanitized_cwd = sanitized_cwd[:200]
        project_dir = projects_dir / sanitized_cwd
        if not project_dir.exists():
            return False

        # Find the team's lead session ID to locate subagent transcripts
        config = self._team_service.get_team(team)
        if not config:
            return False

        lead_session_id = config.get("leadSessionId", "")
        if not lead_session_id:
            return False

        subagents_dir = project_dir / lead_session_id / "subagents"

        target_jsonl = None
        if subagents_dir.exists():
            target_jsonl = self._find_agent_transcript(subagents_dir, agent)

        # Fallback for team-lead: use the main session JSONL
        if not target_jsonl:
            lead_jsonl = project_dir / f"{lead_session_id}.jsonl"
            if lead_jsonl.exists() and agent in ("team-lead", config.get("leadAgentId", "").split("@")[0]):
                target_jsonl = lead_jsonl

        if not target_jsonl:
            return False

        # Parse the JSONL transcript
        try:
            msg_count = 0
            sv.append_output("[bold]Transcript[/bold]\n")
            with open(target_jsonl) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    msg = entry.get("message", {})
                    role = msg.get("role", "")
                    content = msg.get("content", "")

                    if role == "user" and isinstance(content, str):
                        # Strip <teammate-message> wrapper if present
                        stripped = re.sub(r"<teammate-message[^>]*>\s*", "", content)
                        stripped = stripped.replace("</teammate-message>", "").strip()
                        if not stripped:
                            continue
                        # Truncate long prompts
                        if len(stripped) > 500:
                            stripped = stripped[:300] + "\n..."
                        # Use markup=False via escaping brackets to avoid Rich parse errors
                        safe = stripped.replace("[", "\\[")
                        sv.append_output(f"[bold cyan]> {safe}[/bold cyan]\n\n", as_markup=True)
                        msg_count += 1
                    elif role == "user" and isinstance(content, list):
                        # Skip tool_result blocks
                        continue
                    elif role == "assistant":
                        blocks = content if isinstance(content, list) else []
                        for block in blocks:
                            if not isinstance(block, dict):
                                continue
                            if block.get("type") == "text":
                                text = block["text"]
                                if len(text) > 2000:
                                    text = text[:1000] + "\n[dim]... (truncated)[/dim]"
                                safe = text.replace("[", "\\[")
                                sv.append_output(safe + "\n")
                                msg_count += 1
                            elif block.get("type") == "tool_use":
                                name = block.get("name", "?")
                                inp = block.get("input", {})
                                # Show a brief summary of tool input
                                summary = ""
                                if isinstance(inp, dict):
                                    if "command" in inp:
                                        summary = f": {inp['command'][:80]}"
                                    elif "file_path" in inp:
                                        summary = f": {inp['file_path']}"
                                    elif "pattern" in inp:
                                        summary = f": {inp['pattern']}"
                                sv.append_output(f"[dim]\\[{name}{summary}][/dim]\n")

                    # Limit to avoid flooding
                    if msg_count > 200:
                        sv.append_output("[dim]... (truncated at 200 messages)[/dim]\n")
                        break

            return msg_count > 0
        except Exception as exc:
            _log.debug("Failed to load transcript for %s/%s: %s", team, agent, exc)
            return False

    # ------------------------------------------------------------------
    # Right-click context menu
    # ------------------------------------------------------------------

    def on_team_sidebar_agent_context_menu_requested(self, event: TeamSidebar.AgentContextMenuRequested) -> None:
        menu = self.query_one("#context-menu", ContextMenu)
        menu.show_at(event.team, event.agent, event.screen_x, event.screen_y)

    def on_team_sidebar_team_context_menu_requested(self, event: TeamSidebar.TeamContextMenuRequested) -> None:
        config = self._team_service.get_team(event.team)
        is_suspended = config.get("status") == "suspended" if config else False
        menu = self.query_one("#context-menu", ContextMenu)
        menu.show_team_menu_at(
            event.team,
            event.screen_x,
            event.screen_y,
            is_suspended=is_suspended,
        )

    def on_session_tab_bar_tab_context_menu_requested(self, event: SessionTabBar.TabContextMenuRequested) -> None:
        menu = self.query_one("#context-menu", ContextMenu)
        menu.show_tab_menu_at(event.team, event.agent, event.screen_x, event.screen_y)

    def on_context_menu_action_selected(self, event: ContextMenu.ActionSelected) -> None:
        if event.action == "view":
            self._switch_to_agent(event.team, event.agent)
        elif event.action == "kill":
            self._kill_agent(event.team, event.agent)
        elif event.action == "detach":
            self._detach_agent(event.team, event.agent)
        elif event.action == "duplicate":
            self._duplicate_agent(event.team, event.agent)
        elif event.action == "configure":
            self._configure_agent(event.team, event.agent)
        # Tab context menu actions
        elif event.action == "tab_close":
            tab_bar = self.query_one("#tab-bar", SessionTabBar)
            tab_bar.remove_tab(event.team, event.agent)
        elif event.action == "tab_close_others":
            tab_bar = self.query_one("#tab-bar", SessionTabBar)
            tab_bar.close_others(event.team, event.agent)
        elif event.action == "tab_close_right":
            tab_bar = self.query_one("#tab-bar", SessionTabBar)
            tab_bar.close_to_right(event.team, event.agent)
        elif event.action == "tab_close_all":
            tab_bar = self.query_one("#tab-bar", SessionTabBar)
            tab_bar.close_all()
        # Team context menu actions
        elif event.action == "team_spawn":
            self._team_spawn_agent(event.team)
        elif event.action == "team_broadcast":
            self._team_broadcast(event.team)
        elif event.action == "team_rename":
            self._team_rename(event.team)
        elif event.action == "team_suspend":
            self._team_suspend(event.team)
        elif event.action == "team_kill_all":
            self._team_kill_all(event.team)
        elif event.action == "team_delete":
            self._team_delete(event.team)
        elif event.action == "message":
            self._switch_to_agent(event.team, event.agent)
            panel = self.query_one("#message-panel", MessagePanel)
            if not panel._visible:
                self.toggle_messages()

    @work(exclusive=True, group="agent-action")
    async def _kill_agent(self, team: str, agent: str) -> None:
        await self._agent_manager.stop_agent(team, agent)
        self._refresh_sidebar()
        self.notify(f"Stopped agent {agent}")

    @work(exclusive=True, group="agent-action")
    async def _detach_agent(self, team: str, agent: str) -> None:
        await self._agent_manager.detach(team, agent)
        self.notify(f"Detached agent {agent}")

    def _duplicate_agent(self, team: str, agent: str) -> None:
        """Open the DuplicateAgentScreen dialog."""
        from claude_litter.screens.duplicate_agent import DuplicateAgentScreen

        all_teams = self._team_service.list_teams()
        member = self._member_info.get((team, agent), {})
        source_model = member.get("model", "sonnet")
        source_color = member.get("color", "")
        source_type = member.get("agentType", "worker")

        def _on_result(result: dict | None) -> None:
            if result is not None:
                self._execute_duplicate(team, agent, result)

        self.app.push_screen(
            DuplicateAgentScreen(
                source_team=team,
                source_agent=agent,
                all_teams=all_teams,
                source_model=source_model,
                source_color=source_color,
                source_type=source_type,
            ),
            _on_result,
        )

    @work(exclusive=True, group="agent-action")
    async def _execute_duplicate(
        self,
        source_team: str,
        source_agent: str,
        opts: dict,
    ) -> None:
        """Perform the cross-team duplication after dialog confirms."""
        target_team = opts["target_team"]
        new_name = opts["new_name"]
        model = opts["model"]
        copy_inbox = opts.get("copy_inbox", False)
        copy_context = opts.get("copy_context", False)

        # Build context summary if requested
        initial_prompt = ""
        if copy_context:
            initial_prompt = self._build_context_summary(source_team, source_agent)

        # Register the new member in the target team
        member_dict = {
            "agentId": f"{new_name}@{target_team}",
            "name": new_name,
            "model": model,
            "agentType": opts.get("agentType", "worker"),
            "color": opts.get("color", ""),
            "status": "active",
        }
        self._team_service.add_member(target_team, member_dict)

        # Copy inbox if requested
        if copy_inbox:
            self._team_service.copy_inbox(
                source_team,
                source_agent,
                target_team,
                new_name,
            )

        # Spawn the agent session
        await self._agent_manager.duplicate_agent(
            source_team,
            source_agent,
            target_team,
            new_name,
            model=model,
            initial_prompt=initial_prompt,
        )

        self._refresh_sidebar()
        self.notify(f"Duplicated {source_agent} -> {new_name} in {self._display_name(target_team)}")

    def _build_context_summary(self, team: str, agent: str) -> str:
        """Extract recent assistant text from JSONL transcript for context."""
        member = self._member_info.get((team, agent), {})
        cwd = member.get("cwd", "")
        if not cwd:
            return ""

        projects_dir = Path.home() / ".claude" / "projects"
        sanitized_cwd = "".join(c if c.isalnum() else "-" for c in cwd)
        if len(sanitized_cwd) > 200:
            sanitized_cwd = sanitized_cwd[:200]
        project_dir = projects_dir / sanitized_cwd
        if not project_dir.exists():
            return ""

        config = self._team_service.get_team(team)
        if not config:
            return ""
        lead_session_id = config.get("leadSessionId", "")
        if not lead_session_id:
            return ""

        subagents_dir = project_dir / lead_session_id / "subagents"
        if not subagents_dir.exists():
            return ""

        target_jsonl = None
        for jsonl_path in subagents_dir.glob("agent-*.jsonl"):
            try:
                with open(jsonl_path) as f:
                    first_line = f.readline().strip()
                    if not first_line:
                        continue
                    entry = json.loads(first_line)
                    content = entry.get("message", {}).get("content", "")
                    if isinstance(content, str) and f'teammate_id="{agent}"' in content:
                        target_jsonl = jsonl_path
                        break
            except Exception:
                continue

        if not target_jsonl:
            return ""

        # Collect recent assistant text blocks
        summaries: list[str] = []
        try:
            with open(target_jsonl) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    msg = entry.get("message", {})
                    if msg.get("role") != "assistant":
                        continue
                    blocks = msg.get("content", [])
                    if not isinstance(blocks, list):
                        continue
                    for block in blocks:
                        if isinstance(block, dict) and block.get("type") == "text":
                            text = block["text"]
                            if len(text) > 500:
                                text = text[:500] + "..."
                            summaries.append(text)
        except Exception:
            return ""

        if not summaries:
            return ""

        # Take last 5 assistant messages as context
        recent = summaries[-5:]
        return "Context from the source agent's recent work:\n\n" + "\n---\n".join(recent)

    def _configure_agent(self, team: str, agent: str) -> None:
        """Open the ConfigureAgentScreen dialog."""
        from claude_litter.screens.configure_agent import ConfigureAgentScreen

        member = self._member_info.get((team, agent), {})

        def _on_result(result: dict | None) -> None:
            if result is not None:
                agent_id = member.get("agentId", f"{agent}@{team}")
                self._execute_configure(team, agent_id, agent, result)

        self.app.push_screen(
            ConfigureAgentScreen(
                team=team,
                agent_name=agent,
                current=member,
            ),
            _on_result,
        )

    @work(exclusive=True, group="agent-action")
    async def _execute_configure(
        self,
        team: str,
        agent_id: str,
        old_name: str,
        opts: dict,
    ) -> None:
        """Apply configuration changes to the member."""
        self._team_service.update_member(team, agent_id, **opts)
        self._refresh_sidebar()

        # Update session header if currently viewing this agent
        new_name = opts.get("name", old_name)
        if self._active_agent_key == (team, old_name):
            sv = self.query_one("#session-view", SessionView)
            sv.update_header(
                agent_name=new_name,
                team=self._team_label(team),
                model=opts.get("model", ""),
                agent_type=opts.get("agentType", ""),
                color=opts.get("color", ""),
            )

        self.notify(f"Updated configuration for {new_name}")

    # ------------------------------------------------------------------
    # Team context menu actions
    # ------------------------------------------------------------------

    def _team_spawn_agent(self, team: str) -> None:
        """Open SpawnAgentScreen pre-targeted to this team."""
        from claude_litter.screens.spawn_agent import SpawnAgentScreen

        def _on_result(result: dict | None) -> None:
            if result is not None:
                self._execute_team_spawn(team, result)

        self.app.push_screen(SpawnAgentScreen(team_name=team), _on_result)

    @work(exclusive=True, group="team-action")
    async def _execute_team_spawn(self, team: str, opts: dict) -> None:
        """Add member to team and spawn agent session."""
        name = opts["name"]
        model = opts.get("model", "sonnet")
        initial_prompt = opts.get("initial_prompt", "")
        member_dict = {
            "agentId": f"{name}@{team}",
            "name": name,
            "model": model,
            "agentType": opts.get("type", "worker"),
            "status": "active",
        }
        self._team_service.add_member(team, member_dict)
        session = await self._agent_manager.spawn_agent(
            team,
            name,
            model=model,
            initial_prompt=initial_prompt,
        )
        self._wire_permission_callback(session, (team, name))
        self._refresh_sidebar()
        self.notify(f"Spawned {name} in {self._display_name(team)}")

        # If there was an initial prompt, switch to the agent and stream the response
        if initial_prompt and session:
            self._switch_to_agent(team, name)
            sv = self.query_one("#session-view", SessionView)
            streaming_key = (team, name)
            buf = self._get_buf(streaming_key)
            safe_preview = initial_prompt[:200].replace("[", "\\[")
            prompt_line = f"\n[bold cyan]> {safe_preview}{'...' if len(initial_prompt) > 200 else ''}[/bold cyan]\n"
            buf.history.append(prompt_line)
            sv.append_output(prompt_line, as_markup=True)
            buf.streaming = True
            sv._set_active()
            sv._streaming = True
            await self._stream_to_buffer(session, buf, sv, streaming_key)

    def _team_broadcast(self, team: str) -> None:
        """Open BroadcastMessageScreen for this team."""
        from claude_litter.screens.broadcast_message import BroadcastMessageScreen

        def _on_result(text: str | None) -> None:
            if text is not None:
                self._execute_team_broadcast(team, text)

        self.app.push_screen(BroadcastMessageScreen(team), _on_result)

    @work(thread=True, group="team-action")
    def _execute_team_broadcast(self, team: str, text: str) -> None:
        """Send broadcast message off the main thread (avoids blocking _acquire_lock)."""
        count = self._team_service.broadcast_message(team, "tui", text)
        self.call_from_thread(
            self.notify,
            f"Broadcast sent to {count} agent(s) in {self._display_name(team)}",
        )

    def _team_rename(self, team: str) -> None:
        """Open RenameTeamScreen for this team."""
        from claude_litter.screens.rename_team import RenameTeamScreen

        def _on_result(new_name: str | None) -> None:
            if new_name is not None:
                self._execute_team_rename(team, new_name)

        self.app.push_screen(RenameTeamScreen(team), _on_result)

    @work(exclusive=True, group="team-action")
    async def _execute_team_rename(self, old_name: str, new_name: str) -> None:
        """Rename team on disk and update references."""
        self._team_service.rename_team(old_name, new_name)
        # Update AgentManager session keys
        self._agent_manager.rename_team(old_name, new_name)
        # Update active key if viewing an agent in the renamed team
        if self._active_agent_key and self._active_agent_key[0] == old_name:
            agent = self._active_agent_key[1]
            self._active_agent_key = (new_name, agent)
        # Re-key saved outputs
        for key in list(self._agent_outputs):
            if key[0] == old_name:
                self._agent_outputs[(new_name, key[1])] = self._agent_outputs.pop(key)
        # Re-key member info cache
        for key in list(self._member_info):
            if key[0] == old_name:
                self._member_info[(new_name, key[1])] = self._member_info.pop(key)
        self._refresh_sidebar()
        self.notify(f"Renamed {old_name} -> {new_name}")

    def _team_suspend(self, team: str) -> None:
        """Toggle suspend/resume for a team."""
        config = self._team_service.get_team(team)
        if not config:
            return
        is_suspended = config.get("status") == "suspended"
        if is_suspended:
            # Resume
            self._execute_team_resume(team)
        else:
            # Suspend
            self._execute_team_suspend(team)

    @work(thread=True, group="team-action")
    def _execute_team_resume(self, team: str) -> None:
        """Resume a suspended team off the main thread (avoids blocking _acquire_lock)."""
        self._team_service.update_team_status(team, "active")
        self.call_from_thread(self._refresh_sidebar)
        self.call_from_thread(
            self.notify,
            f"Resumed team {self._display_name(team)}",
        )

    @work(exclusive=True, group="team-action")
    async def _execute_team_suspend(self, team: str) -> None:
        """Suspend team: stop all agents and mark as suspended."""
        await self._agent_manager.stop_team(team)
        self._team_service.update_team_status(team, "suspended")
        self._refresh_sidebar()
        self.notify(f"Suspended team {self._display_name(team)}")

    def _team_kill_all(self, team: str) -> None:
        """Confirm and kill all agents in a team."""
        from claude_litter.screens.confirm import ConfirmScreen

        def _on_result(confirmed: bool | None) -> None:
            if confirmed:
                self._execute_team_kill_all(team)

        self.app.push_screen(
            ConfirmScreen(f"Kill all agents in [bold]{self._display_name(team)}[/bold]?"),
            _on_result,
        )

    @work(exclusive=True, group="team-action")
    async def _execute_team_kill_all(self, team: str) -> None:
        """Stop all agent sessions for a team."""
        await self._agent_manager.stop_team(team)
        self._refresh_sidebar()
        self.notify(f"Killed all agents in {self._display_name(team)}")

    def _team_delete(self, team: str) -> None:
        """Confirm and delete a team."""
        from claude_litter.screens.confirm import ConfirmScreen

        def _on_result(confirmed: bool | None) -> None:
            if confirmed:
                self._execute_team_delete(team)

        self.app.push_screen(
            ConfirmScreen(
                f"Delete team [bold]{self._display_name(team)}[/bold]? This cannot be undone.",
                yes_label="Delete",
            ),
            _on_result,
        )

    @work(exclusive=True, group="team-action")
    async def _execute_team_delete(self, team: str) -> None:
        """Stop agents, delete team data, close affected tabs."""
        await self._agent_manager.stop_team(team)
        self._team_service.delete_team(team)
        # Close tabs belonging to deleted team
        tab_bar = self.query_one("#tab-bar", SessionTabBar)
        for key in list(self._agent_outputs):
            if key[0] == team:
                tab_bar.remove_tab(key[0], key[1])
                self._agent_outputs.pop(key, None)
        # If currently viewing an agent from this team, go back to main chat
        if self._active_agent_key and self._active_agent_key[0] == team:
            self._switch_to_main_chat()
        # Clean member info cache
        for key in list(self._member_info):
            if key[0] == team:
                del self._member_info[key]
        self._refresh_sidebar()
        self.notify(f"Deleted team {self._display_name(team)}")

    # ------------------------------------------------------------------
    # Task detail
    # ------------------------------------------------------------------

    def on_task_panel_task_selected(self, message: TaskSelected) -> None:
        """Handle task click: open TaskDetailScreen for view/edit."""
        from claude_litter.screens.task_detail import TaskDetailScreen

        team = (
            self._active_agent_key[0] if self._active_agent_key and self._active_agent_key != _MAIN_CHAT_KEY else None
        )
        if team:
            task = self._team_service.get_task(team, message.task_id)
            if task:
                self.app.push_screen(TaskDetailScreen(task), callback=self._on_task_detail_dismiss)

    def _on_task_detail_dismiss(self, result: dict | None) -> None:
        """Apply edits from TaskDetailScreen and refresh the task panel."""
        if result and self._active_agent_key and self._active_agent_key != _MAIN_CHAT_KEY:
            team = self._active_agent_key[0]
            self._team_service.update_task(team, result["id"], **result)
            self._update_task_panel()

    def _update_task_panel(self) -> None:
        """Refresh the task panel with the current team's tasks."""
        if self._active_agent_key and self._active_agent_key != _MAIN_CHAT_KEY:
            team = self._active_agent_key[0]
            tasks = self._team_service.list_tasks(team)
            self.query_one("#task-panel", TaskPanel).update_tasks(tasks)

    # ------------------------------------------------------------------
    # Interrupt handling
    # ------------------------------------------------------------------

    def on_input_bar_interrupt_requested(self, _message: object) -> None:
        """Handle Ctrl+C interrupt from InputBar: cancel the active stream."""
        key = self._active_agent_key
        if key is None:
            return
        buf = self._agent_outputs.get(key)
        if buf and buf.streaming:
            buf.streaming = False
            try:
                sv = self.query_one(SessionView)
                sv._set_idle()
                sv._streaming = False
            except Exception:
                pass

    # ------------------------------------------------------------------
    # StateManager live-update handlers
    # ------------------------------------------------------------------

    def on_team_updated(self, message: TeamUpdated) -> None:
        """Refresh the sidebar when a team config changes on disk."""
        self._refresh_sidebar()
        self._update_swarm_project_roots()
        # Rebuild transcript index to pick up new agents, then restart watcher
        if hasattr(self, "_state_manager"):
            self._state_manager.build_transcript_index()
            self.run_worker(self._state_manager.restart(), exclusive=True, group="watcher-restart")

    def on_swarm_updated(self, message) -> None:
        """Handle filesystem change in a swarm-loop instance directory."""
        if hasattr(self, "_state_manager"):
            # Watcher already called _refresh_single_instance; no full rescan needed
            instances = self._state_manager.get_swarm_instances()
            # Always update sidebar badge
            try:
                from claude_litter.widgets.sidebar import TeamSidebar

                self.query_one("#sidebar", TeamSidebar).update_swarm_instances(instances)
            except Exception:
                pass
            # Update panel if visible
            try:
                from claude_litter.widgets.swarm_panel import SwarmPanel

                panel = self.query_one("#swarm-panel", SwarmPanel)
                if panel._visible:
                    panel.update_instances(instances)
            except Exception:
                pass
            self._update_status_bar(
                getattr(self, "_last_teams", []),
                getattr(self, "_last_task_counts", {}),
            )

    def on_swarm_panel_refresh_requested(self, _event) -> None:
        """Handle manual refresh from swarm panel keyboard shortcut."""
        if hasattr(self, "_state_manager"):
            self._state_manager._rescan_swarm_instances()
        self._refresh_swarm_panel()

    def on_swarm_panel_data_load_requested(self, event) -> None:
        """Handle async data load request from swarm panel."""
        self._load_swarm_data_worker(event.instance_id, event.instance_dir)

    @work(exclusive=True, group="swarm-data-load")
    async def _load_swarm_data_worker(self, instance_id: str, instance_dir: Path) -> None:
        """Read log.md and progress.jsonl off the UI thread."""
        import asyncio

        from claude_litter.widgets.swarm_panel import _LOG_LINE_CAP, SwarmPanel

        loop = asyncio.get_event_loop()

        def _read_log():
            log_path = instance_dir / "log.md"
            try:
                lines = log_path.read_text(encoding="utf-8").splitlines()
                truncated = len(lines) > _LOG_LINE_CAP
                if truncated:
                    lines = lines[-_LOG_LINE_CAP:]
                return lines, truncated
            except Exception:
                return [], False

        def _read_progress():
            p_path = instance_dir / "progress.jsonl"
            entries: list[dict] = []
            try:
                for raw in p_path.read_text(encoding="utf-8").splitlines():
                    raw = raw.strip()
                    if not raw:
                        continue
                    try:
                        entries.append(json.loads(raw))
                    except Exception:
                        continue
            except Exception:
                pass
            return entries

        log_lines, truncated = await loop.run_in_executor(None, _read_log)
        progress_entries = await loop.run_in_executor(None, _read_progress)

        try:
            panel = self.query_one("#swarm-panel", SwarmPanel)
            panel.post_message(SwarmPanel.LogDataReady(instance_id, log_lines, progress_entries, truncated))
        except Exception:
            pass

    def on_team_sidebar_swarm_selected(self, event) -> None:
        """Clicking swarm instance in sidebar opens the swarm panel focused on that instance."""
        try:
            from claude_litter.widgets.swarm_panel import SwarmPanel

            panel = self.query_one("#swarm-panel", SwarmPanel)
            for i, inst in enumerate(panel._instances):
                if inst.instance_id == event.instance_id:
                    panel._selected_idx = i
                    panel._refresh_display()
                    break
            if not panel._visible:
                self.toggle_swarm()
        except Exception:
            pass

    def on_task_updated(self, message: TaskUpdated) -> None:
        """Refresh the task panel when a task file changes on disk."""
        task_panel = self.query_one("#task-panel", TaskPanel)
        if task_panel._visible:
            tasks = self._team_service.list_tasks(message.team_name)
            task_panel.update_tasks(tasks)
        # Update task counts in the status bar without full sidebar rebuild
        t_tasks = self._team_service.list_tasks(message.team_name)
        task_counts = getattr(self, "_last_task_counts", {})
        task_counts[message.team_name] = (
            len(t_tasks),
            sum(1 for tk in t_tasks if tk.get("status") == "completed"),
        )
        self._last_task_counts = task_counts
        self._update_status_bar(getattr(self, "_last_teams", []), task_counts)

    def on_inbox_updated(self, message: InboxUpdated) -> None:
        """Refresh the message panel when an agent inbox changes on disk."""
        msg_panel = self.query_one("#message-panel", MessagePanel)
        if msg_panel._visible and self._active_agent_key and self._active_agent_key != _MAIN_CHAT_KEY:
            team, agent = self._active_agent_key
            self._update_message_panel(team, agent)
        # Update just the unread badge for this agent
        try:
            inbox = self._team_service.read_inbox(message.team_name, message.agent_name)
            unread = sum(1 for msg in inbox if not msg.get("read", False))
        except Exception:
            unread = 0
        self.query_one("#sidebar", TeamSidebar).update_unread(message.team_name, message.agent_name, unread)

    def on_transcript_activity(self, message: TranscriptActivity) -> None:
        """Update sidebar and session view with agent activity from transcript."""
        sidebar = self.query_one("#sidebar", TeamSidebar)
        sidebar.refresh_agent(
            message.team_name,
            message.agent_name,
            working=not message.is_idle,
            tool=message.tool_name,
        )
        # If viewing this agent, update the session status
        if self._active_agent_key == (message.team_name, message.agent_name):
            sv = self.query_one("#session-view", SessionView)
            if message.is_idle:
                sv._set_idle()
            else:
                tool = message.tool_name
                if tool:
                    try:
                        status = sv.query_one(".session-status", Static)
                        status.update(f"\\[{tool}]")
                        status.display = True
                        sv.query_one(LoadingIndicator).display = True
                    except Exception:
                        sv._set_active()
                else:
                    sv._set_active()

    async def on_unmount(self) -> None:
        """Stop the filesystem watcher on screen teardown."""
        if hasattr(self, "_state_manager"):
            await self._state_manager.stop()
