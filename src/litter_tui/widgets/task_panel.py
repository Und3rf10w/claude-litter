"""TaskPanel widget — slide-out task list with filtering and sorting."""

from __future__ import annotations

from textual.app import ComposeResult
from textual.message import Message
from textual.widget import Widget
from textual.widgets import Button, Label, ListItem, ListView, Static
from textual.containers import Horizontal, Vertical


# Status icons
_ICONS = {
    "pending": "○",
    "in_progress": "●",
    "blocked": "🔒",
    "completed": "✓",
}

# Status colors (CSS class names)
_STATUS_CLASSES = {
    "pending": "task-pending",
    "in_progress": "task-in-progress",
    "blocked": "task-blocked",
    "completed": "task-completed",
}

DEFAULT_CSS = """
TaskPanel {
    width: 35%;
    height: 100%;
    offset-x: 100%;
    transition: offset 300ms;
    background: $surface;
    border-left: solid $primary;
    layer: overlay;
    dock: right;
}

TaskPanel.-visible {
    offset-x: 0;
}

TaskPanel .task-filter-bar {
    height: 3;
    background: $panel;
    padding: 0 1;
}

TaskPanel .task-sort-bar {
    height: 3;
    background: $panel;
    padding: 0 1;
}

TaskPanel .task-list-container {
    height: 1fr;
}

TaskPanel .task-item {
    padding: 0 1;
    height: 3;
}

TaskPanel .task-item:hover {
    background: $boost;
}

TaskPanel .task-pending {
    color: yellow;
}

TaskPanel .task-in-progress {
    color: blue;
}

TaskPanel .task-blocked {
    color: gray;
}

TaskPanel .task-completed {
    color: green;
}

TaskPanel .task-panel-title {
    background: $primary;
    color: $text;
    text-align: center;
    height: 2;
    padding: 0 1;
}
"""


class TaskSelected(Message):
    """Fired when a task is clicked."""

    def __init__(self, task_id: str) -> None:
        super().__init__()
        self.task_id = task_id


class _TaskItem(ListItem):
    """A single task row."""

    def __init__(self, task: dict) -> None:
        super().__init__()
        self._task_data = task

    def compose(self) -> ComposeResult:
        task = self._task_data
        status = task.get("status", "pending")
        blocked_by = task.get("blockedBy", [])

        # Determine effective status for display
        if blocked_by and status != "completed":
            display_status = "blocked"
        else:
            display_status = status

        icon = _ICONS.get(display_status, "?")
        css_class = _STATUS_CLASSES.get(display_status, "")
        subject = task.get("subject", task.get("id", "Unknown"))
        owner = task.get("owner", "")
        task_id = task.get("id", "")

        label_text = f"{icon} [{task_id}] {subject}"
        if owner:
            label_text += f" ({owner})"

        label = Label(label_text, classes=f"task-item {css_class}", markup=False)
        yield label

    def on_click(self) -> None:
        task_id = self._task_data.get("id", "")
        self.post_message(TaskSelected(task_id))


_PRIORITY_ICONS = {
    "high": "\u2191",     # ↑
    "medium": "\u2192",   # →
    "low": "\u2193",      # ↓
}


class _TodoItem(ListItem):
    """A single todo item row."""

    def __init__(self, todo: object) -> None:
        super().__init__()
        self._todo = todo

    def compose(self) -> ComposeResult:
        todo = self._todo
        status = getattr(todo, "status", None)
        status_val = status.value if status else "pending"
        priority = getattr(todo, "priority", "medium")
        content = getattr(todo, "content", "")
        todo_id = getattr(todo, "id", "")

        icon = _ICONS.get(status_val, "○")
        priority_icon = _PRIORITY_ICONS.get(priority, "→")
        css_class = _STATUS_CLASSES.get(status_val, "")

        label_text = f"{icon} {priority_icon} [{todo_id}] {content}"
        yield Label(label_text, classes=f"task-item {css_class}", markup=False)


class TaskPanel(Widget):
    """Slide-out task panel from the right side of the screen.

    Shows tasks with status icons, supports filtering and sorting.
    Posts TaskSelected messages on task click.
    Also displays agent todo items captured from TodoWrite tool calls.
    """

    DEFAULT_CSS = DEFAULT_CSS

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._all_tasks: list[dict] = []
        self._all_todos: list = []
        self._filter: str | None = None
        self._sort_by: str = "id"
        self._visible: bool = False

    def compose(self) -> ComposeResult:
        yield Static("Tasks", classes="task-panel-title")
        with Horizontal(classes="task-filter-bar"):
            yield Button("All", id="filter-all", variant="primary")
            yield Button("Pending", id="filter-pending")
            yield Button("In Progress", id="filter-in-progress")
            yield Button("Completed", id="filter-completed")
        with Horizontal(classes="task-sort-bar"):
            yield Label("Sort: ")
            yield Button("ID", id="sort-id", variant="primary")
            yield Button("Status", id="sort-status")
            yield Button("Owner", id="sort-owner")
        with Vertical(classes="task-list-container"):
            yield ListView(id="task-list")

    def _get_filtered_sorted_tasks(self) -> list[dict]:
        tasks = list(self._all_tasks)

        # Apply filter
        if self._filter is not None:
            if self._filter == "blocked":
                tasks = [
                    t for t in tasks
                    if t.get("blockedBy") and t.get("status") != "completed"
                ]
            else:
                tasks = [
                    t for t in tasks
                    if t.get("status") == self._filter
                    and not (t.get("blockedBy") and self._filter == "pending")
                ]

        # Apply sort
        def sort_key(t: dict):
            if self._sort_by == "id":
                return str(t.get("id", ""))
            elif self._sort_by == "status":
                return t.get("status", "")
            elif self._sort_by == "owner":
                return t.get("owner", "")
            return str(t.get("id", ""))

        tasks.sort(key=sort_key)
        return tasks

    def _refresh_list(self) -> None:
        task_list = self.query_one("#task-list", ListView)
        task_list.clear()
        for task in self._get_filtered_sorted_tasks():
            task_list.append(_TaskItem(task))
        # Append agent todos if present
        if self._all_todos:
            task_list.append(ListItem(Label("── Agent Todos ──", classes="task-panel-title")))
            for todo in self._all_todos:
                task_list.append(_TodoItem(todo))

    def update_tasks(self, tasks: list) -> None:
        """Refresh the task list with new data."""
        self._all_tasks = tasks
        self._refresh_list()

    def update_todos(self, todos: list) -> None:
        """Update the agent todo items (from TodoWrite tool calls)."""
        self._all_todos = todos
        self._refresh_list()

    def toggle(self) -> None:
        """Show or hide the panel."""
        self._visible = not self._visible
        self.toggle_class("-visible")

    def set_filter(self, status: str | None) -> None:
        """Filter tasks by status. Pass None to show all."""
        self._filter = status
        self._refresh_list()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        button_id = event.button.id

        # Filter buttons
        filter_map = {
            "filter-all": None,
            "filter-pending": "pending",
            "filter-in-progress": "in_progress",
            "filter-completed": "completed",
        }
        if button_id in filter_map:
            self.set_filter(filter_map[button_id])
            # Update button variants
            for btn_id in filter_map:
                btn = self.query_one(f"#{btn_id}", Button)
                btn.variant = "primary" if btn_id == button_id else "default"
            return

        # Sort buttons
        sort_map = {
            "sort-id": "id",
            "sort-status": "status",
            "sort-owner": "owner",
        }
        if button_id in sort_map:
            self._sort_by = sort_map[button_id]
            self._refresh_list()
            for btn_id in sort_map:
                btn = self.query_one(f"#{btn_id}", Button)
                btn.variant = "primary" if btn_id == button_id else "default"
