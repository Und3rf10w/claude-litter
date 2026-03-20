"""SpawnAgentScreen — modal dialog for spawning a new agent into a team."""

from __future__ import annotations

from textual.app import ComposeResult
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Label, Select, Static, TextArea
from textual.containers import Horizontal, Vertical

from .create_team import validate_team_name


class SpawnAgentScreen(ModalScreen[dict | None]):
    """Modal dialog for spawning a new agent."""

    DEFAULT_CSS = """
    SpawnAgentScreen { align: center middle; }
    #dialog { padding: 1 2; width: 60; height: auto; border: thick $primary; background: $surface; }
    #title { text-align: center; text-style: bold; margin-bottom: 1; }
    .field-label { margin-top: 1; }
    #name-error { color: $error; height: auto; }
    #buttons { margin-top: 1; height: auto; }
    Button { margin-right: 1; }
    """

    def __init__(self, *, team_name: str = "", **kwargs) -> None:
        super().__init__(**kwargs)
        self._team_name = team_name

    def compose(self) -> ComposeResult:
        title = f"Spawn Agent in [bold]{self._team_name}[/bold]" if self._team_name else "Spawn Agent"
        with Vertical(id="dialog"):
            yield Static(title, id="title")
            yield Label("Agent Name", classes="field-label")
            yield Input(placeholder="backend-dev-1", id="agent-name")
            yield Static("", id="name-error")
            yield Label("Type", classes="field-label")
            yield Select(
                [("Worker", "worker"), ("Backend Dev", "backend-dev"),
                 ("Frontend Dev", "frontend-dev"), ("Tester", "tester"),
                 ("Researcher", "researcher")],
                value="worker",
                id="agent-type",
            )
            yield Label("Model", classes="field-label")
            yield Select(
                [("Haiku", "haiku"), ("Sonnet", "sonnet"), ("Opus", "opus")],
                value="sonnet",
                id="model",
            )
            yield Label("Initial Prompt", classes="field-label")
            yield TextArea(id="initial-prompt")
            with Horizontal(id="buttons"):
                yield Button("OK", variant="primary", id="ok")
                yield Button("Cancel", id="cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "cancel":
            self.dismiss(None)
            return
        name = self.query_one("#agent-name", Input).value.strip()
        error = validate_team_name(name)
        if error:
            self.query_one("#name-error", Static).update(error)
            return
        self.query_one("#name-error", Static).update("")
        self.dismiss({
            "name": name,
            "type": self.query_one("#agent-type", Select).value,
            "model": self.query_one("#model", Select).value,
            "initial_prompt": self.query_one("#initial-prompt", TextArea).text,
        })
