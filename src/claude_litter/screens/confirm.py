"""ConfirmScreen — reusable yes/no confirmation dialog."""

from __future__ import annotations

from textual.app import ComposeResult
from textual.screen import ModalScreen
from textual.widgets import Button, Static
from textual.containers import Horizontal, Vertical


class ConfirmScreen(ModalScreen[bool]):
    """A modal dialog with a message and Yes/No buttons."""

    DEFAULT_CSS = """
    ConfirmScreen { align: center middle; }
    #dialog { padding: 1 2; width: 50; height: auto; border: thick $primary; background: $surface; }
    #message { text-align: center; margin-bottom: 1; }
    #buttons { margin-top: 1; height: auto; align: center middle; }
    Button { margin-right: 1; }
    """

    def __init__(
        self,
        message: str,
        *,
        yes_label: str = "Yes",
        no_label: str = "No",
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self._message = message
        self._yes_label = yes_label
        self._no_label = no_label

    def compose(self) -> ComposeResult:
        with Vertical(id="dialog"):
            yield Static(self._message, id="message")
            with Horizontal(id="buttons"):
                yield Button(self._yes_label, variant="error", id="yes")
                yield Button(self._no_label, id="no")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        self.dismiss(event.button.id == "yes")
