"""DuplicateAgentScreen — modal dialog for duplicating an agent to another team."""

from __future__ import annotations

from textual.app import ComposeResult
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Label, Select, Static, Switch
from textual.containers import Horizontal, Vertical

from .create_team import validate_team_name
from .configure_agent import _normalize_model


class DuplicateAgentScreen(ModalScreen[dict | None]):
    """Modal dialog for duplicating an agent into a different team."""

    DEFAULT_CSS = """
    DuplicateAgentScreen { align: center middle; }
    #dialog { padding: 1 2; width: 60; height: auto; border: thick $primary; background: $surface; }
    #title { text-align: center; text-style: bold; margin-bottom: 1; }
    .field-label { margin-top: 1; }
    #source-info { color: $text-muted; }
    #name-error { color: $error; height: auto; }
    #no-teams-warning { color: $warning; height: auto; }
    #buttons { margin-top: 1; height: auto; }
    Button { margin-right: 1; }
    """

    def __init__(
        self,
        source_team: str,
        source_agent: str,
        all_teams: list[str],
        source_model: str = "sonnet",
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self._source_team = source_team
        self._source_agent = source_agent
        self._source_model = source_model
        self._other_teams = [t for t in all_teams if t != source_team]

    def compose(self) -> ComposeResult:
        with Vertical(id="dialog"):
            yield Static("Duplicate Agent", id="title")
            yield Label("Source", classes="field-label")
            yield Static(
                f"{self._source_agent} @ {self._source_team}",
                id="source-info",
            )

            if not self._other_teams:
                yield Static(
                    "No other teams available. Create another team first.",
                    id="no-teams-warning",
                )
            else:
                yield Label("Target Team", classes="field-label")
                yield Select(
                    [(t, t) for t in self._other_teams],
                    value=self._other_teams[0],
                    id="target-team",
                )

            yield Label("New Agent Name", classes="field-label")
            yield Input(
                value=f"{self._source_agent}-copy",
                id="agent-name",
            )
            yield Static("", id="name-error")

            yield Label("Model", classes="field-label")
            yield Select(
                [("Haiku", "haiku"), ("Sonnet", "sonnet"), ("Opus", "opus")],
                value=_normalize_model(self._source_model),
                id="model",
            )

            yield Label("Copy inbox messages", classes="field-label")
            yield Switch(value=False, id="copy-inbox")

            yield Label("Include context summary", classes="field-label")
            yield Switch(value=False, id="copy-context")

            with Horizontal(id="buttons"):
                ok_btn = Button("OK", variant="primary", id="ok")
                if not self._other_teams:
                    ok_btn.disabled = True
                yield ok_btn
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

        target_team = self.query_one("#target-team", Select).value
        self.dismiss({
            "target_team": target_team,
            "new_name": name,
            "model": self.query_one("#model", Select).value,
            "copy_inbox": self.query_one("#copy-inbox", Switch).value,
            "copy_context": self.query_one("#copy-context", Switch).value,
        })
