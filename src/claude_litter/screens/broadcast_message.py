"""BroadcastMessageScreen — modal dialog for sending a broadcast to a team."""

from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Label, Static, TextArea


class BroadcastMessageScreen(ModalScreen[str | None]):
    """Modal dialog for composing a broadcast message to all team members."""

    DEFAULT_CSS = """
    BroadcastMessageScreen { align: center middle; }
    #dialog { padding: 1 2; width: 60; height: auto; border: thick $primary; background: $surface; }
    #title { text-align: center; text-style: bold; margin-bottom: 1; }
    .field-label { margin-top: 1; }
    #msg-error { color: $error; height: auto; }
    #buttons { margin-top: 1; height: auto; }
    Button { margin-right: 1; }
    """

    def __init__(self, team_name: str, **kwargs) -> None:
        super().__init__(**kwargs)
        self._team_name = team_name

    def compose(self) -> ComposeResult:
        with Vertical(id="dialog"):
            yield Static(f"Broadcast to [bold]{self._team_name}[/bold]", id="title")
            yield Label("Message", classes="field-label")
            yield TextArea(id="broadcast-text")
            yield Static("", id="msg-error")
            with Horizontal(id="buttons"):
                yield Button("Send", variant="primary", id="ok")
                yield Button("Cancel", id="cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "cancel":
            self.dismiss(None)
            return
        text = self.query_one("#broadcast-text", TextArea).text.strip()
        if not text:
            self.query_one("#msg-error", Static).update("Message cannot be empty.")
            return
        self.query_one("#msg-error", Static).update("")
        self.dismiss(text)
