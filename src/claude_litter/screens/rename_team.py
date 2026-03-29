"""RenameTeamScreen — modal dialog for renaming a team."""

from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Label, Static

from .create_team import validate_team_name


class RenameTeamScreen(ModalScreen[str | None]):
    """Modal dialog that collects a new team name."""

    DEFAULT_CSS = """
    RenameTeamScreen { align: center middle; }
    #dialog { padding: 1 2; width: 50; height: auto; border: thick $primary; background: $surface; }
    #title { text-align: center; text-style: bold; margin-bottom: 1; }
    .field-label { margin-top: 1; }
    #name-error { color: $error; height: auto; }
    #buttons { margin-top: 1; height: auto; }
    Button { margin-right: 1; }
    """

    def __init__(self, current_name: str, **kwargs) -> None:
        super().__init__(**kwargs)
        self._current_name = current_name

    def compose(self) -> ComposeResult:
        with Vertical(id="dialog"):
            yield Static("Rename Team", id="title")
            yield Label("New Name", classes="field-label")
            yield Input(value=self._current_name, id="team-name")
            yield Static("", id="name-error")
            with Horizontal(id="buttons"):
                yield Button("Rename", variant="primary", id="ok")
                yield Button("Cancel", id="cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "cancel":
            self.dismiss(None)
            return
        name = self.query_one("#team-name", Input).value.strip()
        if name == self._current_name:
            self.notify("Name unchanged", severity="information")
            self.dismiss(None)
            return
        error = validate_team_name(name)
        if error:
            self.query_one("#name-error", Static).update(error)
            return
        self.query_one("#name-error", Static).update("")
        self.dismiss(name)
