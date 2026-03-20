"""ConfigureAgentScreen — modal dialog for editing an existing agent's metadata."""

from __future__ import annotations

from rich.text import Text

from textual.app import ComposeResult
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Label, Select, Static
from textual.containers import Horizontal, Vertical

from .create_team import validate_team_name


_VALID_COLORS = {"blue", "green", "yellow", "purple", "orange", "pink", "red", "cyan", ""}
_VALID_TYPES = {"worker", "backend-dev", "frontend-dev", "tester", "researcher"}

# Map color values to Rich style names for the swatch block
_COLOR_RICH_STYLES: dict[str, str] = {
    "blue": "dodger_blue1",
    "green": "green3",
    "yellow": "yellow3",
    "purple": "medium_purple",
    "orange": "dark_orange",
    "pink": "hot_pink",
    "red": "red1",
    "cyan": "cyan",
}


def _color_options() -> list[tuple[Text | str, str]]:
    """Build color Select options with colored swatch blocks."""
    options: list[tuple[Text | str, str]] = []
    for name, value in [
        ("Blue", "blue"),
        ("Green", "green"),
        ("Yellow", "yellow"),
        ("Purple", "purple"),
        ("Orange", "orange"),
        ("Pink", "pink"),
        ("Red", "red"),
        ("Cyan", "cyan"),
    ]:
        rich_color = _COLOR_RICH_STYLES[value]
        label = Text("██ ")
        label.stylize(f"{rich_color}", 0, 2)
        label.append(name)
        options.append((label, value))
    options.append(("None", ""))
    return options


def _normalize_model(raw: str) -> str:
    """Map a full model string (e.g. 'bedrock:...claude-sonnet-4-5...') to a short name."""
    low = raw.lower()
    if "opus" in low:
        return "opus"
    if "haiku" in low:
        return "haiku"
    # Default to sonnet for any sonnet variant or unknown
    return "sonnet"


class ConfigureAgentScreen(ModalScreen[dict | None]):
    """Modal dialog for reconfiguring an agent's name, model, color, or type."""

    DEFAULT_CSS = """
    ConfigureAgentScreen { align: center middle; }
    #dialog { padding: 1 2; width: 60; height: auto; border: thick $primary; background: $surface; }
    #title { text-align: center; text-style: bold; margin-bottom: 1; }
    .field-label { margin-top: 1; }
    #name-error { color: $error; height: auto; }
    #buttons { margin-top: 1; height: auto; }
    Button { margin-right: 1; }
    """

    def __init__(
        self,
        team: str,
        agent_name: str,
        current: dict,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self._team = team
        self._agent_name = agent_name
        self._current = current

    def compose(self) -> ComposeResult:
        cur = self._current
        model_value = _normalize_model(cur.get("model", "sonnet"))
        color_value = cur.get("color", "")
        if color_value not in _VALID_COLORS:
            color_value = ""
        type_value = cur.get("agentType", "worker")
        if type_value not in _VALID_TYPES:
            type_value = "worker"
        with Vertical(id="dialog"):
            yield Static("Configure Agent", id="title")

            yield Label("Agent Name", classes="field-label")
            yield Input(value=cur.get("name", self._agent_name), id="agent-name")
            yield Static("", id="name-error")

            yield Label("Model", classes="field-label")
            yield Select(
                [("Haiku", "haiku"), ("Sonnet", "sonnet"), ("Opus", "opus")],
                value=model_value,
                id="model",
            )

            yield Label("Color", classes="field-label")
            yield Select(
                _color_options(),
                value=color_value,
                id="color",
            )

            yield Label("Agent Type", classes="field-label")
            yield Select(
                [
                    ("Worker", "worker"),
                    ("Backend Dev", "backend-dev"),
                    ("Frontend Dev", "frontend-dev"),
                    ("Tester", "tester"),
                    ("Researcher", "researcher"),
                ],
                value=type_value,
                id="agent-type",
            )

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
            "model": self.query_one("#model", Select).value,
            "color": self.query_one("#color", Select).value,
            "agentType": self.query_one("#agent-type", Select).value,
        })
