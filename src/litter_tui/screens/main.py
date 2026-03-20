"""MainScreen — primary application screen."""
from __future__ import annotations

import json
import logging
from pathlib import Path

from textual import work
from textual.app import ComposeResult
from textual.screen import Screen
from textual.widgets import Footer, Header, Static
from textual.containers import Horizontal, Vertical

from litter_tui.models.task import TodoItem
from litter_tui.services.agent_manager import AgentManager, AgentSession
from litter_tui.services.team_service import TeamService
from litter_tui.widgets.sidebar import TeamSidebar
from litter_tui.widgets.tab_bar import SessionTabBar
from litter_tui.widgets.session_view import SessionView, TodoWriteDetected
from litter_tui.widgets.input_bar import InputBar, PromptSubmitted
from litter_tui.widgets.task_panel import TaskPanel
from litter_tui.widgets.message_panel import MessagePanel
from litter_tui.widgets.context_menu import ContextMenu

_log = logging.getLogger("litter_tui.main_screen")


_WELCOME_TEXT = """\
[bold]Welcome to litter-tui[/bold]

No teams found. Get started:

  [bold cyan]Ctrl+N[/bold cyan]  Create a new team
  [bold cyan]Ctrl+S[/bold cyan]  Spawn an agent
  [bold cyan]Ctrl+T[/bold cyan]  Toggle task panel
  [bold cyan]F2[/bold cyan]      Toggle message panel
  [bold cyan]F1[/bold cyan]      Help

Teams are read from [dim]~/.claude/teams/[/dim]
"""

# Key used for the main (default) chat session
_MAIN_CHAT_KEY = ("", "Main Chat")


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
        self._current_session: AgentSession | None = None
        self._agent_outputs: dict[tuple[str, str], list[str]] = {}
        self._active_agent_key: tuple[str, str] | None = _MAIN_CHAT_KEY
        # Cache of full member dicts from config.json, keyed by (team, agent)
        self._member_info: dict[tuple[str, str], dict] = {}

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal(id="layout"):
            yield TeamSidebar(id="sidebar")
            with Vertical(id="main-content"):
                yield SessionTabBar(id="tab-bar")
                yield Static(_WELCOME_TEXT, id="welcome-message", markup=True)
                yield SessionView(id="session-view")
                yield InputBar(id="input-bar")
        yield TaskPanel(id="task-panel", classes="slide-panel")
        yield MessagePanel(id="message-panel", classes="slide-panel")
        yield ContextMenu(id="context-menu")
        yield Footer()

    def on_mount(self) -> None:
        # Skip the welcome screen — go straight to a live session
        self.show_session()
        sv = self.query_one("#session-view", SessionView)
        sv.append_output("[dim]Connecting to agent...[/dim]\n")
        self._connect_default_agent()
        # Add the permanent "Main Chat" tab
        tab_bar = self.query_one("#tab-bar", SessionTabBar)
        tab_bar.add_tab("", "Main Chat")
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
            session = await self._agent_manager.spawn_agent("", "default")
            self._current_session = session
            # Populate autocomplete with CC commands from server_info
            if session.server_info:
                cc_commands = {
                    c["name"]: c.get("description", "")
                    for c in session.server_info.get("commands", [])
                }
                self.query_one("#input-bar", InputBar).update_commands(cc_commands)
            sv.append_output("[green]Agent ready.[/green]\n")
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
        sv.append_output(f"\n[bold cyan]> {event.text}[/bold cyan]\n")
        self._run_prompt(event.text, event.images)

    def _build_team_context(self) -> str:
        """Build a context block describing active teams and agents for Main Chat."""
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

    @work(exclusive=True, group="prompt")
    async def _run_prompt(self, text: str, images: list[tuple[str, bytes]] | None) -> None:
        """Background worker: send prompt to session, then stream response inline."""
        _log.info("_run_prompt worker started, text=%r", text)
        sv = self.query_one("#session-view", SessionView)
        try:
            # Inject team context for Main Chat prompts
            if self._active_agent_key == _MAIN_CHAT_KEY:
                context = self._build_team_context()
                if context:
                    text = f"{context}\n\n{text}"

            session = self._current_session
            _log.info("_run_prompt: current_session=%r", session)
            if session is None:
                # Agent not connected yet — connect now
                sv.append_output("[dim]Connecting to agent...[/dim]\n")
                session = self._agent_manager.get_session("", "default")
                if session is None:
                    session = await self._agent_manager.spawn_agent("", "default")
                    if session.server_info:
                        cc_commands = {
                            c["name"]: c.get("description", "")
                            for c in session.server_info.get("commands", [])
                        }
                        self.query_one("#input-bar", InputBar).update_commands(cc_commands)
                self._current_session = session

            _log.info("_run_prompt: calling send_prompt")
            await session.send_prompt(text, images=images)
            _log.info("_run_prompt: send_prompt done, starting inline stream")

            # Stream the response directly in this worker
            sv._set_active()
            sv._streaming = True
            sv._session = session
            chunk_count = 0
            try:
                async for chunk in session.stream_response():
                    if not sv._streaming:
                        _log.info("_run_prompt: streaming stopped by flag")
                        break
                    chunk_count += 1
                    if chunk_count <= 3:
                        _log.info("_run_prompt: chunk #%d type=%s", chunk_count, type(chunk).__name__)
                    if isinstance(chunk, str) and chunk:
                        sv._stream_buffer.append(chunk)
                        if "\n" in chunk or len(sv._stream_buffer) > 50:
                            sv._flush_stream_buffer()
                    elif isinstance(chunk, dict):
                        sv._flush_stream_buffer()
                        sv.render_tool_chunk(chunk)
                _log.info("_run_prompt: stream ended, total chunks=%d", chunk_count)
            finally:
                sv._flush_stream_buffer()
                sv._set_idle()
                sv._streaming = False
        except Exception as exc:
            _log.exception("_run_prompt: exception: %s", exc)
            sv.append_output(
                f"\n[red]Failed to connect to agent: {exc}[/red]\n"
                "[dim]Make sure Claude Code is available and claude-agent-sdk is installed.[/dim]\n"
            )

    # ------------------------------------------------------------------
    # Todo handling
    # ------------------------------------------------------------------

    def on_todo_write_detected(self, event: TodoWriteDetected) -> None:
        """Handle TodoWrite tool calls by updating the task panel."""
        todos = [TodoItem.from_dict(t) for t in event.todos]
        self.query_one("#task-panel", TaskPanel).update_todos(todos)

    # ------------------------------------------------------------------
    # View switching
    # ------------------------------------------------------------------

    def show_session(self, agent_name: str = "", team: str = "", model: str = "") -> None:
        """Switch from welcome message to a session view."""
        self.query_one("#welcome-message", Static).display = False
        self.query_one("#session-view", SessionView).display = True

    def show_welcome(self) -> None:
        """Switch back to the welcome message."""
        self.query_one("#welcome-message", Static).display = True
        self.query_one("#session-view", SessionView).display = False

    def toggle_tasks(self) -> None:
        """Show/hide the task panel."""
        self.query_one("#task-panel", TaskPanel).toggle()

    def toggle_messages(self) -> None:
        """Show/hide the message panel."""
        self.query_one("#message-panel", MessagePanel).toggle()

    # ------------------------------------------------------------------
    # Team management
    # ------------------------------------------------------------------

    def create_team(self, result: dict) -> None:
        """Create a team from the dialog result and refresh the sidebar."""
        name = result["name"]
        description = result.get("description", "")
        self._team_service.create_team(name, description)
        _log.info("create_team: created team %r", name)
        self._refresh_sidebar()

    def _refresh_sidebar(self) -> None:
        """Reload all teams from disk and update the sidebar widget."""
        team_names = self._team_service.list_teams()
        teams: list[dict] = []
        self._member_info.clear()
        for name in team_names:
            config = self._team_service.get_team(name)
            if config is not None:
                agents = []
                for m in config.get("members", []):
                    agent_dict = {
                        "name": m.get("name", "?"),
                        "model": m.get("model", "sonnet"),
                        "agentType": m.get("agentType", ""),
                        "color": m.get("color", ""),
                        "cwd": m.get("cwd", ""),
                    }
                    agents.append(agent_dict)
                    # Cache full member info for header display
                    self._member_info[(name, m.get("name", "?"))] = m
                has_active = any(m.get("status") == "active" for m in config.get("members", []))
                teams.append({
                    "name": config["name"],
                    "status": "active" if has_active else "inactive",
                    "agents": agents,
                })
        self.query_one("#sidebar", TeamSidebar).update_teams(teams)

    # ------------------------------------------------------------------
    # Main Chat navigation
    # ------------------------------------------------------------------

    def on_team_sidebar_main_chat_selected(self, event: TeamSidebar.MainChatSelected) -> None:
        """Switch back to the main default chat."""
        self._switch_to_main_chat()

    def _switch_to_main_chat(self) -> None:
        """Restore the main chat session view."""
        sv = self.query_one("#session-view", SessionView)
        tab_bar = self.query_one("#tab-bar", SessionTabBar)
        key = _MAIN_CHAT_KEY

        if self._active_agent_key == key:
            return

        # Save current output
        if self._active_agent_key:
            self._agent_outputs[self._active_agent_key] = sv.get_output_history()

        # Activate the Main Chat tab
        tab_bar.add_tab("", "Main Chat")
        self._current_session = self._agent_manager.get_session("", "default")
        self._active_agent_key = key

        # Restore main chat output
        sv.clear_output()
        sv.update_header()  # Reset to default "Session" header
        if key in self._agent_outputs:
            for line in self._agent_outputs[key]:
                sv.append_output(line)

        self.show_session()

    # ------------------------------------------------------------------
    # Agent click-to-view + tab switching
    # ------------------------------------------------------------------

    def on_team_sidebar_agent_selected(self, event: TeamSidebar.AgentSelected) -> None:
        """Left-click on an agent node -> switch view to that agent."""
        self._switch_to_agent(event.team, event.agent)

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
        """Save current output, swap to *agent*'s view, restore/load history."""
        sv = self.query_one("#session-view", SessionView)
        tab_bar = self.query_one("#tab-bar", SessionTabBar)
        key = (team, agent)

        # No-op if already viewing this agent
        if self._active_agent_key == key:
            return

        # Save current output before switching
        if self._active_agent_key:
            self._agent_outputs[self._active_agent_key] = sv.get_output_history()

        # Add tab (no-op if already exists), switch session reference
        tab_bar.add_tab(team, agent)
        self._current_session = self._agent_manager.get_session(team, agent)
        self._active_agent_key = key

        # Update session header with agent metadata
        member = self._member_info.get(key, {})
        sv.update_header(
            agent_name=agent,
            team=team,
            model=member.get("model", ""),
            cwd=member.get("cwd", ""),
            agent_type=member.get("agentType", ""),
            color=member.get("color", ""),
        )

        # Restore saved output or load history
        sv.clear_output()
        if key in self._agent_outputs:
            for line in self._agent_outputs[key]:
                sv.append_output(line)
        else:
            self._load_agent_history(team, agent)

        self.show_session()

    @work(exclusive=True, group="history")
    async def _load_agent_history(self, team: str, agent: str) -> None:
        """Load chat history from inbox messages and JSONL transcripts."""
        sv = self.query_one("#session-view", SessionView)

        # 1. Try loading from inbox (messages sent TO this agent)
        inbox_loaded = self._load_inbox_history(sv, team, agent)

        # 2. Try loading from JSONL transcript
        transcript_loaded = self._load_transcript_history(sv, team, agent)

        if not inbox_loaded and not transcript_loaded:
            sv.append_output(f"[dim]No history found for {agent}[/dim]\n")

    def _load_inbox_history(self, sv: SessionView, team: str, agent: str) -> bool:
        """Load inbox messages for the agent. Returns True if any were loaded."""
        try:
            messages = self._team_service.read_inbox(team, agent)
            if not messages:
                return False

            # Color map for sender badges
            _color_map = {
                "blue": "dodger_blue1",
                "green": "green3",
                "yellow": "yellow3",
                "purple": "medium_purple",
                "orange": "dark_orange",
                "pink": "hot_pink",
                "red": "red1",
            }

            sv.append_output(f"[bold]Inbox ({len(messages)} messages)[/bold]\n")
            for msg in messages:
                sender = msg.get("from", "?")
                text = msg.get("text", "")
                color = msg.get("color", "")
                summary = msg.get("summary", "")
                read = msg.get("read", False)

                # Skip idle notifications
                if text.startswith("{"):
                    try:
                        parsed = json.loads(text)
                        if parsed.get("type") == "idle_notification":
                            continue
                    except (json.JSONDecodeError, TypeError):
                        pass

                rich_color = _color_map.get(color, "dim")
                read_marker = "" if read else " [bold yellow]*[/bold yellow]"

                # Show sender with color badge
                sv.append_output(
                    f"[{rich_color}]{sender}[/{rich_color}]{read_marker}\n"
                )

                # Show summary if available, else truncated text
                display = summary or (text[:200] + "..." if len(text) > 200 else text)
                sv.append_output(f"  {display}\n\n")

            return True
        except Exception as exc:
            _log.debug("Failed to load inbox for %s/%s: %s", team, agent, exc)
            return False

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
        if not subagents_dir.exists():
            return False

        # Scan subagent JSONLs to find the one matching this agent
        # Match by teammate_id in the first user message
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
            return False

        # Parse the JSONL transcript
        try:
            msg_count = 0
            sv.append_output(f"[bold]Transcript[/bold]\n")
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
                        # Show user prompts (skip very long system prompts)
                        if len(content) > 500:
                            content = content[:200] + "..."
                        sv.append_output(f"[bold cyan]> {content}[/bold cyan]\n")
                        msg_count += 1
                    elif role == "assistant":
                        blocks = content if isinstance(content, list) else []
                        for block in blocks:
                            if not isinstance(block, dict):
                                continue
                            if block.get("type") == "text":
                                text = block["text"]
                                if len(text) > 1000:
                                    text = text[:500] + "\n[dim]... (truncated)[/dim]"
                                sv.append_output(text + "\n")
                                msg_count += 1
                            elif block.get("type") == "tool_use":
                                sv.append_output(
                                    f"[dim][Used {block.get('name', '?')}][/dim]\n"
                                )

                    # Limit to avoid flooding
                    if msg_count > 100:
                        sv.append_output("[dim]... (showing last 100 messages)[/dim]\n")
                        break

            return msg_count > 0
        except Exception as exc:
            _log.debug("Failed to load transcript for %s/%s: %s", team, agent, exc)
            return False

    # ------------------------------------------------------------------
    # Right-click context menu
    # ------------------------------------------------------------------

    def on_team_sidebar_agent_context_menu_requested(
        self, event: TeamSidebar.AgentContextMenuRequested
    ) -> None:
        menu = self.query_one("#context-menu", ContextMenu)
        menu.show_at(event.team, event.agent, event.screen_x, event.screen_y)

    def on_session_tab_bar_tab_context_menu_requested(
        self, event: SessionTabBar.TabContextMenuRequested
    ) -> None:
        menu = self.query_one("#context-menu", ContextMenu)
        menu.show_tab_menu_at(event.team, event.agent, event.screen_x, event.screen_y)

    def on_context_menu_action_selected(
        self, event: ContextMenu.ActionSelected
    ) -> None:
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
        from litter_tui.screens.duplicate_agent import DuplicateAgentScreen

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
        self, source_team: str, source_agent: str, opts: dict,
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
                source_team, source_agent, target_team, new_name,
            )

        # Spawn the agent session
        await self._agent_manager.duplicate_agent(
            source_team, source_agent, target_team, new_name,
            model=model, initial_prompt=initial_prompt,
        )

        self._refresh_sidebar()
        self.notify(f"Duplicated {source_agent} -> {new_name} in {target_team}")

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
        return (
            "Context from the source agent's recent work:\n\n"
            + "\n---\n".join(recent)
        )

    def _configure_agent(self, team: str, agent: str) -> None:
        """Open the ConfigureAgentScreen dialog."""
        from litter_tui.screens.configure_agent import ConfigureAgentScreen

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
        self, team: str, agent_id: str, old_name: str, opts: dict,
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
                team=team,
                model=opts.get("model", ""),
                agent_type=opts.get("agentType", ""),
                color=opts.get("color", ""),
            )

        self.notify(f"Updated configuration for {new_name}")
