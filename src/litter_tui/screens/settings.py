"""SettingsScreen — full-page settings screen (not a modal)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from textual import work
from textual.app import ComposeResult
from textual.screen import Screen
from textual.widgets import Button, Footer, Header, Label, Select, Static, Switch
from textual.containers import Horizontal, Vertical, VerticalScroll

import anyio

from litter_tui.services.claude_settings import ClaudeSettings

_CONFIG_PATH = Path.home() / ".claude" / "litter-tui" / "config.json"


def _load_config() -> dict[str, Any]:
    if _CONFIG_PATH.exists():
        try:
            return json.loads(_CONFIG_PATH.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {"vim_mode": False, "theme": "dark"}


async def _save_config_async(config: dict[str, Any]) -> None:
    p = anyio.Path(_CONFIG_PATH)
    await anyio.Path(p).parent.mkdir(parents=True, exist_ok=True)
    await p.write_text(json.dumps(config, indent=2))


def _mask_token(token: str | None) -> str:
    """Show first 8 and last 4 chars of a token, mask the rest."""
    if not token:
        return "(not set)"
    if len(token) <= 16:
        return token[:4] + "..." + token[-4:]
    return token[:8] + "..." + token[-4:]


class SettingsScreen(Screen):
    """Full-page settings screen. Not a modal."""

    DEFAULT_CSS = """
    SettingsScreen { padding: 1 2; }
    #page-title { text-style: bold; text-align: center; margin-bottom: 1; }
    .section-title { text-style: bold underline; margin-top: 1; color: $accent; }
    .setting-row { height: auto; margin-top: 1; }
    .setting-label { width: 1fr; }
    .setting-control { width: auto; }
    .config-key { color: $accent; min-width: 32; padding: 0 1; }
    .config-value { color: $text; padding: 0 1; }
    .config-value-muted { color: $text-muted; padding: 0 1; }
    #buttons { margin-top: 2; height: auto; }
    Button { margin-right: 1; }
    """

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._config: dict[str, Any] = {"vim_mode": False, "theme": "dark"}
        self._claude_settings: ClaudeSettings | None = None

    def on_mount(self) -> None:
        self._config = _load_config()
        self._claude_settings = ClaudeSettings.load()
        try:
            self.query_one("#vim-mode", Switch).value = self._config.get("vim_mode", False)
            self.query_one("#theme", Select).value = self._config.get("theme", "dark")
        except Exception:
            pass
        self._populate_claude_settings()

    def compose(self) -> ComposeResult:
        yield Header()
        with VerticalScroll():
            yield Static("Settings", id="page-title")

            # --- TUI Settings ---
            yield Static("TUI Settings", classes="section-title")
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

            # --- Claude Code Settings (read-only) ---
            yield Static("Claude Code Settings", classes="section-title")
            yield Static(
                "[dim]Read from ~/.claude/settings.json (read-only)[/dim]",
                markup=True,
            )
            yield Vertical(id="claude-settings-grid")

            # --- Resolved Environment ---
            yield Static("Resolved Environment", classes="section-title")
            yield Static(
                "[dim]Env vars from settings.json env block[/dim]",
                markup=True,
            )
            yield Vertical(id="env-settings-grid")

            # --- Paths ---
            yield Static("Paths", classes="section-title")
            with Horizontal(classes="setting-row"):
                yield Label("Claude Home", classes="config-key")
                yield Label(str(Path.home() / ".claude"), classes="config-value")
            with Horizontal(classes="setting-row"):
                yield Label("Settings File", classes="config-key")
                yield Label(str(Path.home() / ".claude" / "settings.json"), classes="config-value")
            with Horizontal(classes="setting-row"):
                yield Label("TUI Config", classes="config-key")
                yield Label(str(_CONFIG_PATH), classes="config-value")

            with Horizontal(id="buttons"):
                yield Button("Save", variant="primary", id="save")
                yield Button("Reload", id="reload")
                yield Button("Back", id="back")
        yield Footer()

    def _populate_claude_settings(self) -> None:
        """Fill the Claude settings grids with current values."""
        cs = self._claude_settings or ClaudeSettings()
        self._refresh_claude_grid(cs)
        self._refresh_env_grid(cs)

    @work(exclusive=True, group="settings-populate")
    async def _refresh_claude_grid(self, cs: ClaudeSettings) -> None:
        grid = self.query_one("#claude-settings-grid", Vertical)
        await grid.remove_children()
        settings_rows: list[tuple[str, str]] = [
            ("Model", cs.model or "(not set)"),
            ("Base URL", cs.base_url or "(default)"),
            ("Auth Token", _mask_token(cs.auth_token)),
            ("Opus Model ID", cs.opus_model or "(default)"),
            ("Sonnet Model ID", cs.sonnet_model or "(default)"),
            ("Haiku Model ID", cs.haiku_model or "(default)"),
            ("Subagent Model", cs.subagent_model or "(default)"),
        ]
        for key, value in settings_rows:
            muted = value.startswith("(")
            val_cls = "config-value-muted" if muted else "config-value"
            row = Horizontal(classes="setting-row")
            await grid.mount(row)
            await row.mount(Label(key, classes="config-key"))
            await row.mount(Label(value, classes=val_cls))

    @work(exclusive=True, group="settings-populate-env")
    async def _refresh_env_grid(self, cs: ClaudeSettings) -> None:
        env_grid = self.query_one("#env-settings-grid", Vertical)
        await env_grid.remove_children()
        env = cs.env
        if not env:
            row = Horizontal(classes="setting-row")
            await env_grid.mount(row)
            await row.mount(Label("(no env vars configured)", classes="config-value-muted"))
        else:
            for k, v in sorted(env.items()):
                display_val = _mask_token(v) if "TOKEN" in k or "SECRET" in k or "KEY" in k else v
                row = Horizontal(classes="setting-row")
                await env_grid.mount(row)
                await row.mount(Label(k, classes="config-key"))
                await row.mount(Label(display_val, classes="config-value"))

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "back":
            self.app.pop_screen()
        elif event.button.id == "reload":
            self._claude_settings = ClaudeSettings.load()
            self._populate_claude_settings()
            self.notify("Settings reloaded.")
        elif event.button.id == "save":
            config = dict(self._config)
            config["vim_mode"] = self.query_one("#vim-mode", Switch).value
            config["theme"] = self.query_one("#theme", Select).value
            self._config = config
            self.app.theme = config["theme"]
            self._do_save(config)

    @work(exclusive=True, group="settings-save")
    async def _do_save(self, config: dict[str, Any]) -> None:
        try:
            await _save_config_async(config)
            self.notify("Settings saved.")
        except Exception as exc:
            self.notify(f"Failed to save: {exc}", severity="error")
