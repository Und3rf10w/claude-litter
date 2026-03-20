"""MainScreen — primary application screen."""
from __future__ import annotations

from textual.app import ComposeResult
from textual.screen import Screen
from textual.widgets import Footer, Header, Static
from textual.containers import Horizontal, Vertical

from litter_tui.widgets.task_panel import TaskPanel
from litter_tui.widgets.message_panel import MessagePanel


class MainScreen(Screen):
    """The main application screen with sidebar, session view, and panels."""

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal():
            # Sidebar (left column)
            yield Static("Teams", id="sidebar")
            # Main content area
            with Vertical(id="main-content"):
                # Tab bar at top
                yield Static("Tabs", id="tab-bar")
                # Session view (scrollable agent output)
                yield Static("Session", id="session-view")
                # Input bar at bottom
                yield Static("> ", id="input-bar")
        # Slide-out panels (overlay on right)
        yield TaskPanel(id="task-panel", classes="slide-panel")
        yield MessagePanel(id="message-panel", classes="slide-panel")
        yield Footer()

    def toggle_tasks(self) -> None:
        """Show/hide the task panel."""
        self.query_one("#task-panel", TaskPanel).toggle()

    def toggle_messages(self) -> None:
        """Show/hide the message panel."""
        self.query_one("#message-panel", MessagePanel).toggle()
