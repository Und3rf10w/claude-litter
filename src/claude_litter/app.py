"""Main application class for claude-litter."""

from __future__ import annotations

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Center, Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Label, Static

from claude_litter.config import Config
from claude_litter.services.agent_manager import AgentManager
from claude_litter.widgets.session_view import _copy_to_system_clipboard


class QuitScreen(ModalScreen[bool]):
    """Centered quit confirmation dialog."""

    DEFAULT_CSS = """
    QuitScreen {
        align: center middle;
    }
    QuitScreen > Vertical {
        width: 40;
        height: auto;
        padding: 1 2;
        background: $surface;
        border: thick $primary;
    }
    QuitScreen Label {
        width: 100%;
        text-align: center;
        margin-bottom: 1;
    }
    QuitScreen .buttons {
        width: 100%;
        height: auto;
        align-horizontal: center;
    }
    QuitScreen Button {
        margin: 0 1;
    }
    """

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Label("Do you want to quit?")
            with Center(classes="buttons"):
                yield Button("Quit", variant="error", id="quit-yes")
                yield Button("Cancel", variant="default", id="quit-no")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "quit-yes":
            self.dismiss(True)
        else:
            self.dismiss(False)


class ClaudeLitterApp(App):
    """A Textual TUI for managing Claude swarm teams."""

    CSS_PATH = "styles/app.tcss"
    TITLE = "claude-litter"

    BINDINGS = [
        Binding("ctrl+q", "request_quit", "Quit"),
        Binding("ctrl+t", "toggle_tasks", "Tasks"),
        Binding("ctrl+n", "new_team", "New Team"),
        Binding("ctrl+s", "spawn_agent", "Spawn Agent"),
        Binding("ctrl+d", "detach", "Detach"),
        Binding("super+c", "copy_selection", "Copy", show=False),
        Binding("escape", "maybe_quit", "Back/Quit"),
        Binding("f1", "about", "About"),
        Binding("f2", "toggle_messages", "Messages"),
        Binding("f3", "settings", "Settings"),
        Binding("ctrl+l", "toggle_swarm", "Swarm"),
    ]

    def __init__(self, config: Config | None = None, **kwargs: object) -> None:
        """Initialize the app with optional config."""
        super().__init__(**kwargs)
        self.config = config or Config()
        self.agent_manager = AgentManager()

    def on_mount(self) -> None:
        """Push the main screen on startup."""
        from claude_litter.screens.main import MainScreen

        self.push_screen(MainScreen(agent_manager=self.agent_manager))

    def compose(self) -> ComposeResult:
        """Compose the initial UI (placeholder; MainScreen replaces this)."""
        yield Static("claude-litter loading...")

    def action_toggle_tasks(self) -> None:
        """Toggle the task panel."""
        from claude_litter.screens.main import MainScreen

        if isinstance(self.screen, MainScreen):
            self.screen.toggle_tasks()

    def action_toggle_messages(self) -> None:
        """Toggle the message panel."""
        from claude_litter.screens.main import MainScreen

        if isinstance(self.screen, MainScreen):
            self.screen.toggle_messages()

    def action_toggle_swarm(self) -> None:
        """Toggle the swarm panel."""
        from claude_litter.screens.main import MainScreen

        if isinstance(self.screen, MainScreen):
            self.screen.toggle_swarm()

    def action_new_team(self) -> None:
        """Open the create-team dialog."""
        from claude_litter.screens.create_team import CreateTeamScreen

        def _on_result(result: dict | None) -> None:
            if result is None:
                return
            from claude_litter.screens.main import MainScreen

            if isinstance(self.screen, MainScreen):
                self.screen.create_team(result)

        self.push_screen(CreateTeamScreen(), callback=_on_result)

    def action_spawn_agent(self) -> None:
        """Open the spawn-agent dialog."""
        from claude_litter.screens.spawn_agent import SpawnAgentScreen

        self.push_screen(SpawnAgentScreen())

    def action_request_quit(self) -> None:
        """Show centered quit confirmation dialog."""

        def _on_quit(confirmed: bool | None) -> None:
            if confirmed:
                self.exit()

        self.push_screen(QuitScreen(), callback=_on_quit)

    def action_maybe_quit(self) -> None:
        """Escape: pop screen if in a dialog, otherwise show quit confirmation."""
        if len(self.screen_stack) > 2:
            self.pop_screen()
        else:
            self.action_request_quit()

    def action_detach(self) -> None:
        """Detach the active agent session."""
        from claude_litter.screens.main import _MAIN_CHAT_KEY, MainScreen

        screen = self.screen
        if not isinstance(screen, MainScreen):
            return
        key = screen._active_agent_key
        if key and key != _MAIN_CHAT_KEY:
            screen._detach_agent(*key)

    def action_about(self) -> None:
        """Show about dialog."""
        from claude_litter.screens.about import AboutScreen

        self.push_screen(AboutScreen())

    def action_settings(self) -> None:
        """Open the settings screen."""
        from claude_litter.screens.settings import SettingsScreen

        self.push_screen(SettingsScreen())

    def copy_to_clipboard(self, text: str) -> None:
        """Copy text to clipboard via OSC 52 and system clipboard."""
        super().copy_to_clipboard(text)
        _copy_to_system_clipboard(text)

    def action_copy_selection(self) -> None:
        """Copy selected text to clipboard (Cmd+C handler)."""
        selected = self.screen.get_selected_text()
        if selected:
            self.copy_to_clipboard(selected)
