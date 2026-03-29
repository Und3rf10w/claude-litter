"""InputBar widget — prompt/command input with history, autocomplete, and mode indicator."""

from __future__ import annotations

import json
import logging
import mimetypes
from collections import deque
from pathlib import Path

from textual import events, on, work
from textual.app import ComposeResult
from textual.containers import Horizontal
from textual.message import Message
from textual.widget import Widget
from textual.widgets import Button, Label, OptionList, TextArea
from textual.widgets.option_list import Option

_log = logging.getLogger("claude_litter.input_bar")

_HISTORY_PATH = Path("~/.claude/claude-litter/input_history.json").expanduser()
_MAX_HISTORY = 500


# ---------------------------------------------------------------------------
# Custom messages
# ---------------------------------------------------------------------------


class PromptSubmitted(Message):
    """Fired when the user submits a plain (non-command) prompt."""

    def __init__(self, text: str, images: list[tuple[str, bytes]] | None = None) -> None:
        super().__init__()
        self.text = text
        self.images = images


class CommandSubmitted(Message):
    """Fired when the user submits a /-prefixed command."""

    def __init__(self, command: str, args: str) -> None:
        super().__init__()
        self.command = command
        self.args = args


class InterruptRequested(Message):
    """Fired when the user presses Ctrl+C."""


class PermissionResponse(Message):
    """Fired when the user responds to a permission prompt."""

    def __init__(self, allow: bool, always: bool = False) -> None:
        super().__init__()
        self.allow = allow
        self.always = always


# ---------------------------------------------------------------------------
# PromptTextArea — TextArea subclass with submit + conditional Up/Down
# ---------------------------------------------------------------------------


class PromptTextArea(TextArea):
    """TextArea subclass that delegates Up/Down to parent when appropriate."""

    class SubmitRequested(Message):
        """Fired on Ctrl+Enter or Enter (when single-line)."""

    async def _on_key(self, event: events.Key) -> None:
        key = event.key

        # Ctrl+Enter → always submit
        if key in ("ctrl+enter", "ctrl+j"):
            event.prevent_default()
            event.stop()
            self.post_message(self.SubmitRequested())
            return

        # Shift+Enter or Alt+Enter → always insert newline.
        # Note: Most terminals don't distinguish Shift+Enter from Enter
        # (same escape sequence), so Alt+Enter is the reliable alternative.
        if key in ("shift+enter", "alt+enter"):
            event.prevent_default()
            event.stop()
            self.insert("\n")
            return

        # Enter on single-line content → submit
        if key == "enter" and "\n" not in self.text:
            event.prevent_default()
            event.stop()
            self.post_message(self.SubmitRequested())
            return

        # Up/Down: if single-line content, let parent handle (history / autocomplete)
        if key in ("up", "down") and "\n" not in self.text:
            return  # don't consume — bubbles to InputBar.on_key()

        await super()._on_key(event)


# ---------------------------------------------------------------------------
# Non-focusable completion list
# ---------------------------------------------------------------------------


class _CompletionList(OptionList, can_focus=False):
    """Non-focusable completion list — focus stays in PromptTextArea."""


# ---------------------------------------------------------------------------
# TUI commands (always available)
# ---------------------------------------------------------------------------

_TUI_COMMANDS: dict[str, str] = {
    "spawn": "Spawn a new agent",
    "kill": "Kill an agent session",
    "msg": "Send a message to an agent",
    "broadcast": "Broadcast to all agents",
    "task": "Create or manage tasks",
    "team": "Team management commands",
    "kitty": "Kitty terminal integration",
    "detach": "Detach current session",
    "attach": "Attach image file to next prompt",
}


# ---------------------------------------------------------------------------
# InputBar widget
# ---------------------------------------------------------------------------


class InputBar(Widget):
    """Horizontal prompt/command input bar with history, autocomplete, and mode indicator.

    Emits:
        PromptSubmitted  — plain text submitted
        CommandSubmitted — /command [args] submitted
        InterruptRequested — Ctrl+C pressed
        PermissionResponse — user responded to a permission prompt
    """

    DEFAULT_CSS = """
    InputBar {
        height: auto;
        max-height: 8;
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

    InputBar .mode-indicator.permission-mode {
        color: $warning;
        background: $warning-darken-3;
        text-style: bold;
    }

    InputBar PromptTextArea {
        width: 1fr;
        height: auto;
        max-height: 6;
    }

    InputBar Button {
        min-width: 8;
    }

    InputBar #permission-bar {
        display: none;
        width: 1fr;
        height: 3;
        layout: horizontal;
        align: center middle;
    }

    InputBar #permission-bar.-visible {
        display: block;
    }

    InputBar #permission-label {
        width: 1fr;
        height: 1;
        content-align: left middle;
        padding: 0 1;
        color: $warning;
    }

    InputBar .permission-btn {
        min-width: 10;
        margin: 0 1;
    }

    InputBar #cmd-completions {
        display: none;
        overlay: screen;
        constrain: none inflect;
        width: 1fr;
        height: auto;
        max-height: 10;
        background: $surface;
        border: tall $border;
    }

    InputBar #cmd-completions.-visible {
        display: block;
    }
    """

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._history: deque[str] = deque(maxlen=_MAX_HISTORY)
        self._history_index: int = -1  # -1 means not navigating history
        self._pending_input: str = ""  # saved draft while navigating history
        self._command_mode: bool = False
        self._permission_mode: bool = False
        self._all_commands: dict[str, str] = dict(_TUI_COMMANDS)
        self._pending_images: list[tuple[str, bytes]] = []

    # ------------------------------------------------------------------
    # Composition
    # ------------------------------------------------------------------

    def compose(self) -> ComposeResult:
        yield _CompletionList(id="cmd-completions")
        yield Label(">", classes="mode-indicator")
        yield PromptTextArea("", id="prompt-input")
        with Horizontal(id="permission-bar"):
            yield Label("", id="permission-label")
            yield Button("Allow (y)", id="perm-allow", variant="success", classes="permission-btn")
            yield Button("Deny (n)", id="perm-deny", variant="error", classes="permission-btn")
            yield Button("Always (a)", id="perm-always", variant="warning", classes="permission-btn")
        yield Button("Send", id="send-btn", variant="primary")

    def on_mount(self) -> None:
        """Load input history from disk on startup."""
        try:
            items = json.loads(_HISTORY_PATH.read_text())
            self._history = deque(items, maxlen=_MAX_HISTORY)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _save_history(self) -> None:
        """Persist input history to disk."""
        try:
            _HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
            _HISTORY_PATH.write_text(json.dumps(list(self._history)))
        except Exception:
            pass

    @property
    def _input(self) -> PromptTextArea:
        return self.query_one("#prompt-input", PromptTextArea)

    @property
    def _indicator(self) -> Label:
        return self.query_one(".mode-indicator", Label)

    def _set_command_mode(self, active: bool) -> None:
        if active == self._command_mode:
            return
        self._command_mode = active
        indicator = self._indicator
        if active:
            indicator.update("/")
            indicator.add_class("command-mode")
        else:
            indicator.update(">")
            indicator.remove_class("command-mode")

    # ------------------------------------------------------------------
    # Permission mode
    # ------------------------------------------------------------------

    def enter_permission_mode(self, tool_name: str, tool_summary: str) -> None:
        """Switch to permission approval mode — hide text input, show Allow/Deny buttons."""
        self._permission_mode = True
        indicator = self._indicator
        indicator.update("?")
        indicator.add_class("permission-mode")
        # Hide normal input, show permission bar
        self.query_one("#prompt-input", PromptTextArea).display = False
        self.query_one("#send-btn", Button).display = False
        perm_bar = self.query_one("#permission-bar")
        perm_bar.add_class("-visible")
        safe_name = tool_name.replace("[", "\\[")
        safe_summary = tool_summary.replace("[", "\\[") if tool_summary else ""
        label_text = f"{safe_name}: {safe_summary}" if safe_summary else safe_name
        self.query_one("#permission-label", Label).update(label_text)
        # Focus the Allow button
        self.query_one("#perm-allow", Button).focus()

    def exit_permission_mode(self) -> None:
        """Restore normal input mode."""
        self._permission_mode = False
        indicator = self._indicator
        indicator.remove_class("permission-mode")
        indicator.update(">")
        # Show normal input, hide permission bar
        self.query_one("#prompt-input", PromptTextArea).display = True
        self.query_one("#send-btn", Button).display = True
        perm_bar = self.query_one("#permission-bar")
        perm_bar.remove_class("-visible")
        # Restore focus to text input
        self.query_one("#prompt-input", PromptTextArea).focus()

    def _submit(self, value: str) -> None:
        """Parse and post the appropriate message for *value*."""
        text = value.strip()
        _log.info("_submit called, text=%r", text)
        if not text:
            _log.info("_submit: empty text, returning")
            return

        # Save to history
        if not self._history or self._history[-1] != text:
            self._history.append(text)
            self.call_later(self._save_history)
        self._history_index = -1
        self._pending_input = ""

        # Clear input
        self._input.load_text("")
        self._set_command_mode(False)
        self._hide_completions()

        if text.startswith("/"):
            parts = text[1:].split(None, 1)
            command = parts[0] if parts else ""
            args = parts[1] if len(parts) > 1 else ""

            # Handle /attach locally
            if command == "attach":
                self._handle_attach(args)
                return

            self.post_message(CommandSubmitted(command=command, args=args))
        else:
            images = self._pending_images if self._pending_images else None
            _log.info("Posting PromptSubmitted(text=%r, images=%s)", text, images is not None)
            self.post_message(PromptSubmitted(text=text, images=images))
            self._pending_images = []

    def _handle_attach(self, path_str: str) -> None:
        """Attach an image file for the next prompt."""
        path_str = path_str.strip()
        if not path_str:
            self.notify("Usage: /attach <file-path>", severity="warning")
            return
        p = Path(path_str).expanduser()
        if not p.is_file():
            self.notify(f"File not found: {p}", severity="error")
            return
        media_type, _ = mimetypes.guess_type(str(p))
        if not media_type or not media_type.startswith("image/"):
            self.notify(f"Not an image file: {p}", severity="error")
            return
        self._read_and_attach(p, media_type)

    @work(exclusive=True, group="attach")
    async def _read_and_attach(self, path: Path, media_type: str) -> None:
        """Read image bytes in a background worker to avoid blocking the event loop."""
        import anyio

        try:
            data = await anyio.Path(path).read_bytes()
            self._pending_images.append((media_type, data))
            self.notify(f"Attached: {path.name} ({len(self._pending_images)} image(s) pending)")
        except Exception as exc:
            self.notify(f"Failed to read {path.name}: {exc}", severity="error")

    # ------------------------------------------------------------------
    # Autocomplete
    # ------------------------------------------------------------------

    def update_commands(self, commands: dict[str, str]) -> None:
        """Merge in additional commands (e.g., from Claude Code server_info)."""
        self._all_commands.update(commands)

    def _update_completions(self, text: str) -> None:
        """Show/hide autocomplete based on current first-line text."""
        completions = self.query_one("#cmd-completions", _CompletionList)
        if text.startswith("/") and " " not in text and "\n" not in text and len(text) > 0:
            partial = text[1:].lower()
            matches = [(n, d) for n, d in self._all_commands.items() if not partial or n.lower().startswith(partial)]
            if matches:
                completions.clear_options()
                for name, desc in sorted(matches):
                    completions.add_option(Option(f"/{name}  {desc}", id=name))
                completions.add_class("-visible")
                completions.highlighted = 0
                return
        completions.remove_class("-visible")

    def _hide_completions(self) -> None:
        try:
            self.query_one("#cmd-completions", _CompletionList).remove_class("-visible")
        except Exception:
            pass

    def _accept_completion(self, completions: _CompletionList) -> None:
        """Accept the highlighted completion."""
        idx = completions.highlighted
        if idx is not None and idx >= 0:
            option = completions.get_option_at_index(idx)
            if option and option.id:
                self._input.load_text(f"/{option.id} ")
                self._input.move_cursor(self._input.document.end)
        completions.remove_class("-visible")

    # ------------------------------------------------------------------
    # Event handlers
    # ------------------------------------------------------------------

    @on(TextArea.Changed, "#prompt-input")
    def _on_input_changed(self, event: TextArea.Changed) -> None:
        """Update command-mode indicator and autocomplete as user types."""
        text = event.text_area.text
        first_line = text.split("\n", 1)[0]
        self._set_command_mode(first_line.startswith("/"))
        # Reset history navigation when user types manually
        self._history_index = -1
        self._update_completions(first_line)

    @on(PromptTextArea.SubmitRequested)
    def _on_submit_requested(self) -> None:
        _log.info("SubmitRequested received, text=%r", self._input.text)
        self._submit(self._input.text)

    @on(Button.Pressed, "#send-btn")
    def _on_send_pressed(self, event: Button.Pressed) -> None:
        self._submit(self._input.text)

    @on(Button.Pressed, "#perm-allow")
    def _on_perm_allow(self) -> None:
        self.post_message(PermissionResponse(allow=True, always=False))

    @on(Button.Pressed, "#perm-deny")
    def _on_perm_deny(self) -> None:
        self.post_message(PermissionResponse(allow=False))

    @on(Button.Pressed, "#perm-always")
    def _on_perm_always(self) -> None:
        self.post_message(PermissionResponse(allow=True, always=True))

    def on_key(self, event: events.Key) -> None:
        """Handle autocomplete navigation, history, permission shortcuts, and Ctrl+C interrupt."""
        key = event.key

        # Permission mode shortcuts
        if self._permission_mode:
            if key in ("y", "enter"):
                event.prevent_default()
                event.stop()
                self.post_message(PermissionResponse(allow=True, always=False))
                return
            if key == "n":
                event.prevent_default()
                event.stop()
                self.post_message(PermissionResponse(allow=False))
                return
            if key == "a":
                event.prevent_default()
                event.stop()
                self.post_message(PermissionResponse(allow=True, always=True))
                return
            if key == "escape":
                event.prevent_default()
                event.stop()
                self.post_message(PermissionResponse(allow=False))
                return
            # Block all other keys in permission mode
            return

        if key == "ctrl+c":
            # If there's selected text on screen, let the Screen's copy binding handle it
            try:
                selected = self.screen.get_selected_text()
                if selected:
                    return  # don't consume — Screen will copy to clipboard
            except Exception:
                pass
            event.prevent_default()
            event.stop()
            self.post_message(InterruptRequested())
            return

        # Autocomplete takes priority
        try:
            completions = self.query_one("#cmd-completions", _CompletionList)
            is_completing = completions.has_class("-visible")
        except Exception:
            is_completing = False

        if is_completing:
            if key == "up":
                event.prevent_default()
                event.stop()
                completions.action_cursor_up()
                return
            if key == "down":
                event.prevent_default()
                event.stop()
                completions.action_cursor_down()
                return
            if key in ("tab",):
                event.prevent_default()
                event.stop()
                self._accept_completion(completions)
                return
            if key == "escape":
                event.prevent_default()
                event.stop()
                completions.remove_class("-visible")
                return

        # History navigation (only when not completing)
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
        """Move through history.  direction=-1 -> older, +1 -> newer."""
        if not self._history:
            return

        if self._history_index == -1:
            # Starting navigation — save current draft
            self._pending_input = self._input.text
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
                self._input.load_text(self._pending_input)
                self._set_command_mode(self._pending_input.startswith("/"))
                self._input.move_cursor(self._input.document.end)
                return
            self._history_index = new_index

        entry = self._history[self._history_index]
        self._input.load_text(entry)
        self._set_command_mode(entry.startswith("/"))
        # Move cursor to end
        self._input.move_cursor(self._input.document.end)
