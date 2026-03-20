"""Main application class for litter-tui."""
from __future__ import annotations

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.widgets import Static

from litter_tui.config import Config


class LitterTuiApp(App):
    """A Textual TUI for managing Claude swarm teams."""

    CSS_PATH = "styles/app.tcss"
    TITLE = "litter-tui"

    BINDINGS = [
        Binding("ctrl+q", "quit", "Quit"),
        Binding("q", "quit", "Quit", show=False, priority=False),
        Binding("ctrl+t", "toggle_tasks", "Tasks"),
        Binding("ctrl+m", "toggle_messages", "Messages"),
        Binding("ctrl+n", "new_team", "New Team"),
        Binding("ctrl+s", "spawn_agent", "Spawn Agent"),
        Binding("ctrl+d", "detach", "Detach"),
        Binding("escape", "maybe_quit", "Back/Quit"),
        Binding("f1", "help", "Help"),
        Binding("tab", "focus_next", "Focus Next"),
    ]

    def __init__(self, config: Config | None = None, **kwargs: object) -> None:
        """Initialize the app with optional config."""
        super().__init__(**kwargs)
        self.config = config or Config()

    def on_mount(self) -> None:
        """Push the main screen on startup."""
        from litter_tui.screens.main import MainScreen
        self.push_screen(MainScreen())

    def compose(self) -> ComposeResult:
        """Compose the initial UI (placeholder; MainScreen replaces this)."""
        yield Static("litter-tui loading...")

    def action_toggle_tasks(self) -> None:
        """Toggle the task panel."""
        from litter_tui.screens.main import MainScreen
        if isinstance(self.screen, MainScreen):
            self.screen.toggle_tasks()

    def action_toggle_messages(self) -> None:
        """Toggle the message panel."""
        from litter_tui.screens.main import MainScreen
        if isinstance(self.screen, MainScreen):
            self.screen.toggle_messages()

    def action_new_team(self) -> None:
        """Open the create-team dialog."""
        from litter_tui.screens.create_team import CreateTeamScreen
        self.push_screen(CreateTeamScreen())

    def action_spawn_agent(self) -> None:
        """Open the spawn-agent dialog."""
        from litter_tui.screens.spawn_agent import SpawnAgentScreen
        self.push_screen(SpawnAgentScreen())

    def action_maybe_quit(self) -> None:
        """Escape: pop screen if in a dialog, otherwise quit."""
        if len(self.screen_stack) > 2:
            self.pop_screen()
        else:
            self.exit()

    def action_detach(self) -> None:
        """Detach current session."""

    def action_help(self) -> None:
        """Show help."""
