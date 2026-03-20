"""MainScreen — primary application screen."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.screen import Screen
from textual.widgets import Footer, Header, Static
from textual.containers import Horizontal, Vertical

from litter_tui.widgets.sidebar import TeamSidebar
from litter_tui.widgets.tab_bar import SessionTabBar
from litter_tui.widgets.session_view import SessionView
from litter_tui.widgets.input_bar import InputBar
from litter_tui.widgets.status_bar import StatusBar
from litter_tui.widgets.task_panel import TaskPanel
from litter_tui.widgets.message_panel import MessagePanel


_WELCOME_TEXT = """\
[bold]Welcome to litter-tui[/bold]

No teams found. Get started:

  [bold cyan]Ctrl+N[/bold cyan]  Create a new team
  [bold cyan]Ctrl+S[/bold cyan]  Spawn an agent
  [bold cyan]Ctrl+T[/bold cyan]  Toggle task panel
  [bold cyan]Ctrl+M[/bold cyan]  Toggle message panel
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
    """

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal():
            yield TeamSidebar(id="sidebar")
            with Vertical(id="main-content"):
                yield SessionTabBar(id="tab-bar")
                yield Static(_WELCOME_TEXT, id="welcome-message", markup=True)
                yield SessionView(id="session-view")
                yield InputBar(id="input-bar")
        yield TaskPanel(id="task-panel", classes="slide-panel")
        yield MessagePanel(id="message-panel", classes="slide-panel")
        yield StatusBar()
        yield Footer()

    def on_mount(self) -> None:
        # Start with the welcome message visible and session view hidden
        self.query_one("#session-view", SessionView).display = False
        self._update_status_bar()

    def _update_status_bar(self) -> None:
        """Refresh the status bar with current counts."""
        self.query_one(StatusBar).update_status(
            team_name="",
            agent_count=0,
            active_count=0,
            task_total=0,
            task_done=0,
        )

    def show_session(self, agent_name: str = "", team: str = "", model: str = "") -> None:
        """Switch from welcome message to a session view."""
        welcome = self.query_one("#welcome-message", Static)
        session = self.query_one("#session-view", SessionView)
        welcome.display = False
        session.display = True

    def show_welcome(self) -> None:
        """Switch back to the welcome message."""
        welcome = self.query_one("#welcome-message", Static)
        session = self.query_one("#session-view", SessionView)
        welcome.display = True
        session.display = False

    def toggle_tasks(self) -> None:
        """Show/hide the task panel."""
        self.query_one("#task-panel", TaskPanel).toggle()

    def toggle_messages(self) -> None:
        """Show/hide the message panel."""
        self.query_one("#message-panel", MessagePanel).toggle()
