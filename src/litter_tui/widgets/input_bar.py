"""InputBar widget — prompt/command input with history and mode indicator."""

from __future__ import annotations

from collections import deque

from textual.app import ComposeResult
from textual.widget import Widget
from textual.widgets import Input, Button, Label
from textual.containers import Horizontal
from textual.message import Message
from textual import on


# ---------------------------------------------------------------------------
# Custom messages
# ---------------------------------------------------------------------------

class PromptSubmitted(Message):
    """Fired when the user submits a plain (non-command) prompt."""

    def __init__(self, text: str) -> None:
        super().__init__()
        self.text = text


class CommandSubmitted(Message):
    """Fired when the user submits a :-prefixed command."""

    def __init__(self, command: str, args: str) -> None:
        super().__init__()
        self.command = command
        self.args = args


class InterruptRequested(Message):
    """Fired when the user presses Ctrl+C."""


# ---------------------------------------------------------------------------
# InputBar widget
# ---------------------------------------------------------------------------

_KNOWN_COMMANDS = {
    "spawn", "kill", "msg", "broadcast", "task", "team",
    "kitty", "detach", "vim",
}

_MAX_HISTORY = 50


class InputBar(Widget):
    """Horizontal prompt/command input bar with history and mode indicator.

    Emits:
        PromptSubmitted  — plain text submitted
        CommandSubmitted — :command [args] submitted
        InterruptRequested — Ctrl+C pressed
    """

    DEFAULT_CSS = """
    InputBar {
        height: 3;
        layout: horizontal;
        background: $surface;
        border-top: solid $primary-darken-2;
    }

    InputBar .mode-indicator {
        width: 3;
        height: 3;
        content-align: center middle;
        color: $text-muted;
        background: $surface-darken-1;
    }

    InputBar .mode-indicator.command-mode {
        color: $warning;
        background: $warning-darken-3;
        text-style: bold;
    }

    InputBar Input {
        height: 3;
        width: 1fr;
        border: none;
    }

    InputBar Button {
        height: 3;
        min-width: 8;
    }
    """

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._history: deque[str] = deque(maxlen=_MAX_HISTORY)
        self._history_index: int = -1  # -1 means not navigating history
        self._pending_input: str = ""  # saved draft while navigating history
        self._command_mode: bool = False

    # ------------------------------------------------------------------
    # Composition
    # ------------------------------------------------------------------

    def compose(self) -> ComposeResult:
        yield Label(">", classes="mode-indicator")
        yield Input(placeholder="Enter prompt or :command …", id="prompt-input")
        yield Button("Send", id="send-btn", variant="primary")

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @property
    def _input(self) -> Input:
        return self.query_one("#prompt-input", Input)

    @property
    def _indicator(self) -> Label:
        return self.query_one(".mode-indicator", Label)

    def _set_command_mode(self, active: bool) -> None:
        if active == self._command_mode:
            return
        self._command_mode = active
        indicator = self._indicator
        if active:
            indicator.update(":")
            indicator.add_class("command-mode")
        else:
            indicator.update(">")
            indicator.remove_class("command-mode")

    def _submit(self, value: str) -> None:
        """Parse and post the appropriate message for *value*."""
        text = value.strip()
        if not text:
            return

        # Save to history
        if not self._history or self._history[-1] != text:
            self._history.append(text)
        self._history_index = -1
        self._pending_input = ""

        # Clear input
        self._input.value = ""
        self._set_command_mode(False)

        if text.startswith(":"):
            parts = text[1:].split(None, 1)
            command = parts[0] if parts else ""
            args = parts[1] if len(parts) > 1 else ""
            self.post_message(CommandSubmitted(command=command, args=args))
        else:
            self.post_message(PromptSubmitted(text=text))

    # ------------------------------------------------------------------
    # Event handlers
    # ------------------------------------------------------------------

    @on(Input.Changed, "#prompt-input")
    def _on_input_changed(self, event: Input.Changed) -> None:
        """Update command-mode indicator as user types."""
        self._set_command_mode(event.value.startswith(":"))
        # Reset history navigation when user types manually
        self._history_index = -1

    @on(Input.Submitted, "#prompt-input")
    def _on_input_submitted(self, event: Input.Submitted) -> None:
        self._submit(event.value)

    @on(Button.Pressed, "#send-btn")
    def _on_send_pressed(self, event: Button.Pressed) -> None:
        self._submit(self._input.value)

    def on_key(self, event) -> None:
        """Handle Up/Down history navigation and Ctrl+C interrupt."""
        key = event.key

        if key == "ctrl+c":
            event.prevent_default()
            event.stop()
            self.post_message(InterruptRequested())
            return

        if key == "up":
            event.prevent_default()
            event.stop()
            self._navigate_history(-1)
            return

        if key == "down":
            event.prevent_default()
            event.stop()
            self._navigate_history(1)
            return

    def _navigate_history(self, direction: int) -> None:
        """Move through history.  direction=-1 → older, +1 → newer."""
        if not self._history:
            return

        if self._history_index == -1:
            # Starting navigation — save current draft
            self._pending_input = self._input.value
            if direction == -1:
                self._history_index = len(self._history) - 1
            else:
                return  # Can't go "newer" from the live prompt
        else:
            new_index = self._history_index + direction
            if new_index < 0:
                return  # Already at oldest
            if new_index >= len(self._history):
                # Past newest — restore the draft
                self._history_index = -1
                self._input.value = self._pending_input
                self._set_command_mode(self._pending_input.startswith(":"))
                return
            self._history_index = new_index

        entry = self._history[self._history_index]
        self._input.value = entry
        self._set_command_mode(entry.startswith(":"))
        # Move cursor to end
        self._input.cursor_position = len(entry)
