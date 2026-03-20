"""SettingsScreen — full-page settings screen (not a modal)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from textual.app import ComposeResult
from textual.screen import Screen
from textual.widgets import Button, Footer, Header, Label, Select, Static, Switch
from textual.containers import Horizontal, Vertical


_CONFIG_PATH = Path.home() / ".claude" / "litter-tui" / "config.json"


def _load_config() -> dict[str, Any]:
    if _CONFIG_PATH.exists():
        try:
            return json.loads(_CONFIG_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {"vim_mode": False, "theme": "dark"}


def _save_config(config: dict[str, Any]) -> None:
    _CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    _CONFIG_PATH.write_text(json.dumps(config, indent=2))


class SettingsScreen(Screen):
    """Full-page settings screen. Not a modal."""

    DEFAULT_CSS = """
    SettingsScreen { padding: 1 2; }
    #page-title { text-style: bold; text-align: center; margin-bottom: 1; }
    .section-title { text-style: bold underline; margin-top: 1; }
    .setting-row { height: auto; margin-top: 1; }
    .setting-label { width: 1fr; }
    .setting-control { width: auto; }
    #claude-home-value { color: $text-muted; margin-left: 2; }
    #kitty-note { color: $text-muted; margin-left: 2; margin-top: 1; }
    #buttons { margin-top: 2; height: auto; }
    Button { margin-right: 1; }
    """

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._config = _load_config()

    def compose(self) -> ComposeResult:
        yield Header()
        with Vertical():
            yield Static("Settings", id="page-title")
            yield Static("General", classes="section-title")
            with Horizontal(classes="setting-row"):
                yield Label("Vim Mode", classes="setting-label")
                yield Switch(value=self._config.get("vim_mode", False), id="vim-mode", classes="setting-control")
            with Horizontal(classes="setting-row"):
                yield Label("Theme", classes="setting-label")
                yield Select(
                    [("Dark", "dark"), ("Light", "light")],
                    value=self._config.get("theme", "dark"),
                    id="theme",
                    classes="setting-control",
                )
            yield Static("Claude", classes="section-title")
            yield Label("Claude Home Path")
            yield Static(str(Path.home() / ".claude"), id="claude-home-value")
            yield Static("Kitty", classes="section-title")
            yield Static(
                "Kitty configuration is managed via ~/.config/kitty/kitty.conf.",
                id="kitty-note",
            )
            with Horizontal(id="buttons"):
                yield Button("Save", variant="primary", id="save")
                yield Button("Back", id="back")
        yield Footer()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "back":
            self.app.pop_screen()
        elif event.button.id == "save":
            config = dict(self._config)
            config["vim_mode"] = self.query_one("#vim-mode", Switch).value
            config["theme"] = self.query_one("#theme", Select).value
            _save_config(config)
            self._config = config
            self.app.theme = config["theme"]
            self.notify("Settings saved.")
