"""CreateTeamScreen — modal dialog for creating a new swarm team."""

from __future__ import annotations

import re
from textual.app import ComposeResult
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Label, Select, Static, Switch, TextArea
from textual.containers import Horizontal, Vertical


_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{1,100}$")


def validate_team_name(name: str) -> str | None:
    """Return an error message or None if valid."""
    if not name:
        return "Name is required."
    if ".." in name:
        return "Name must not contain '..'."
    if "/" in name:
        return "Name must not contain '/'."
    if name.startswith("-"):
        return "Name must not start with '-'."
    if len(name) > 100:
        return "Name must be 100 characters or fewer."
    if not _NAME_RE.match(name):
        return "Name must contain only letters, digits, hyphens, and underscores."
    return None


class CreateTeamScreen(ModalScreen[dict | None]):
    """Modal dialog that collects info for creating a new team."""

    DEFAULT_CSS = """
    CreateTeamScreen { align: center middle; }
    #dialog { padding: 1 2; width: 60; height: auto; border: thick $primary; background: $surface; }
    #title { text-align: center; text-style: bold; margin-bottom: 1; }
    .field-label { margin-top: 1; }
    #name-error { color: $error; height: auto; }
    #buttons { margin-top: 1; height: auto; }
    Button { margin-right: 1; }
    """

    def compose(self) -> ComposeResult:
        with Vertical(id="dialog"):
            yield Static("Create New Team", id="title")
            yield Label("Team Name", classes="field-label")
            yield Input(placeholder="my-team", id="team-name")
            yield Static("", id="name-error")
            yield Label("Description", classes="field-label")
            yield TextArea(id="description")
            yield Label("Auto-spawn Team Lead", classes="field-label")
            yield Switch(value=True, id="auto-lead")
            yield Label("Model", classes="field-label")
            yield Select(
                [("Haiku", "haiku"), ("Sonnet", "sonnet"), ("Opus", "opus")],
                value="sonnet",
                id="model",
            )
            with Horizontal(id="buttons"):
                yield Button("OK", variant="primary", id="ok")
                yield Button("Cancel", id="cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "cancel":
            self.dismiss(None)
            return
        name = self.query_one("#team-name", Input).value.strip()
        error = validate_team_name(name)
        if error:
            self.query_one("#name-error", Static).update(error)
            return
        self.query_one("#name-error", Static).update("")
        self.dismiss({
            "name": name,
            "description": self.query_one("#description", TextArea).text,
            "auto_lead": self.query_one("#auto-lead", Switch).value,
            "model": self.query_one("#model", Select).value,
        })
