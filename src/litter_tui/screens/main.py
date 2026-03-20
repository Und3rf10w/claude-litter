"""MainScreen."""
from __future__ import annotations
from textual.app import ComposeResult
from textual.screen import Screen
from textual.widgets import Static


class MainScreen(Screen):
    """The main application screen."""
    def compose(self) -> ComposeResult:
        yield Static("litter-tui")
