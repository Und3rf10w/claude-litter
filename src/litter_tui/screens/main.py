"""MainScreen — primary application screen."""
from __future__ import annotations

import logging

from textual import work
from textual.app import ComposeResult
from textual.screen import Screen
from textual.widgets import Footer, Header, Static
from textual.containers import Horizontal, Vertical

from litter_tui.models.task import TodoItem
from litter_tui.services.agent_manager import AgentManager, AgentSession
from litter_tui.widgets.sidebar import TeamSidebar
from litter_tui.widgets.tab_bar import SessionTabBar
from litter_tui.widgets.session_view import SessionView, TodoWriteDetected
from litter_tui.widgets.input_bar import InputBar, PromptSubmitted
from litter_tui.widgets.task_panel import TaskPanel
from litter_tui.widgets.message_panel import MessagePanel

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
        self._current_session: AgentSession | None = None

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
        yield Footer()

    def on_mount(self) -> None:
        # Skip the welcome screen — go straight to a live session
        self.show_session()
        sv = self.query_one("#session-view", SessionView)
        sv.append_output("[dim]Connecting to agent...[/dim]\n")
        self._connect_default_agent()
        # Focus the input bar so the user can start typing immediately
        self.query_one("#prompt-input").focus()

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

    @work(exclusive=True, group="prompt")
    async def _run_prompt(self, text: str, images: list[tuple[str, bytes]] | None) -> None:
        """Background worker: send prompt to session, then stream response inline.

        Streaming is done directly here (not delegated to SessionView._stream_session)
        to avoid cross-widget worker coordination issues that can cause the stream
        to return 0 chunks in real terminals.
        """
        _log.info("_run_prompt worker started, text=%r", text)
        sv = self.query_one("#session-view", SessionView)
        try:
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
                        chunk_type = chunk.get("type")
                        if chunk_type == "tool_start":
                            sv.append_output(f"\n[dim][Using {chunk['name']}...][/dim]")
                        elif chunk_type == "tool_done":
                            sv.append_output(" [dim]done[/dim]\n")
                            if chunk.get("name") == "TodoWrite":
                                todos = chunk.get("input", {}).get("todos", [])
                                if todos:
                                    sv.post_message(TodoWriteDetected(todos))
                        elif chunk_type == "api_retry":
                            attempt = chunk.get("attempt", "?")
                            error = chunk.get("error", "unknown")
                            status = chunk.get("status", "?")
                            sv.append_output(
                                f"\n[yellow]API retry #{attempt} (HTTP {status}: {error})[/yellow]"
                            )
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
