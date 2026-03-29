"""TaskDetailScreen — modal for viewing and editing a task."""

from __future__ import annotations

from typing import Any

from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.reactive import reactive
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Label, Select, Static, TextArea

_STATUS_OPTIONS = [
    ("Pending", "pending"),
    ("In Progress", "in_progress"),
    ("Completed", "completed"),
]


class TaskDetailScreen(ModalScreen[dict | None]):
    """Modal for viewing and optionally editing a task."""

    DEFAULT_CSS = """
    TaskDetailScreen { align: center middle; }
    #dialog { padding: 1 2; width: 70; height: auto; max-height: 90vh; border: thick $primary; background: $surface; }
    #title { text-align: center; text-style: bold; margin-bottom: 1; }
    .field-label { margin-top: 1; text-style: bold; }
    .field-value { margin-left: 2; color: $text-muted; }
    #buttons { margin-top: 1; height: auto; }
    Button { margin-right: 1; }
    .hidden { display: none; }
    """

    editing: reactive[bool] = reactive(False)

    def __init__(self, task_data: dict[str, Any], **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._task_data = task_data

    def compose(self) -> ComposeResult:
        td = self._task_data
        with Vertical(id="dialog"):
            yield Static("Task Detail", id="title")
            yield Label("ID", classes="field-label")
            yield Static(str(td.get("id", "")), classes="field-value", id="id-value")
            yield Label("Blocks", classes="field-label")
            blocks = ", ".join(str(b) for b in td.get("blocks", []))
            yield Static(blocks or "\u2014", classes="field-value", id="blocks-value")
            yield Label("Blocked By", classes="field-label")
            blocked_by = ", ".join(str(b) for b in td.get("blockedBy", []))
            yield Static(blocked_by or "\u2014", classes="field-value", id="blocked-by-value")
            yield Label("Subject", classes="field-label")
            yield Static(td.get("subject", ""), classes="field-value", id="subject-display")
            yield Input(value=td.get("subject", ""), id="subject-input", classes="hidden")
            yield Label("Description", classes="field-label")
            yield Static(td.get("description", ""), classes="field-value", id="description-display")
            yield TextArea(td.get("description", ""), id="description-input", classes="hidden")
            yield Label("Status", classes="field-label")
            current_status = td.get("status", "pending")
            yield Static(current_status, classes="field-value", id="status-display")
            yield Select(_STATUS_OPTIONS, value=current_status, id="status-input", classes="hidden")
            yield Label("Owner", classes="field-label")
            yield Static(td.get("owner", "\u2014"), classes="field-value", id="owner-display")
            yield Input(value=td.get("owner", ""), id="owner-input", classes="hidden")
            with Horizontal(id="buttons"):
                yield Button("Edit", id="edit")
                yield Button("Save", variant="primary", id="save", classes="hidden")
                yield Button("Cancel", id="cancel")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        btn = event.button.id
        if btn == "cancel":
            self.dismiss(None)
        elif btn == "edit":
            for w in ("subject", "description", "status", "owner"):
                self.query_one(f"#{w}-display").add_class("hidden")
                self.query_one(f"#{w}-input").remove_class("hidden")
            self.query_one("#edit").add_class("hidden")
            self.query_one("#save").remove_class("hidden")
        elif btn == "save":
            updated = dict(self._task_data)
            updated["subject"] = self.query_one("#subject-input", Input).value
            updated["description"] = self.query_one("#description-input", TextArea).text
            updated["status"] = self.query_one("#status-input", Select).value
            updated["owner"] = self.query_one("#owner-input", Input).value
            self.dismiss(updated)
