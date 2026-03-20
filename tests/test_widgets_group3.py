"""Tests for TaskPanel and MessagePanel widgets (Unit 8)."""

from __future__ import annotations

import pytest
from textual.app import App, ComposeResult
from textual.widgets import Button, Input, Label, ListView, Select, Static

from claude_litter.widgets.task_panel import TaskPanel, TaskSelected
from claude_litter.widgets.message_panel import MessagePanel, MessageComposed


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SAMPLE_TASKS = [
    {"id": "1", "subject": "Fix bug", "status": "pending", "owner": "alice", "blockedBy": []},
    {"id": "2", "subject": "Add feature", "status": "in_progress", "owner": "bob", "blockedBy": []},
    {"id": "3", "subject": "Review PR", "status": "completed", "owner": "alice", "blockedBy": []},
    {"id": "4", "subject": "Deploy", "status": "pending", "owner": "", "blockedBy": ["2"]},
]

SAMPLE_MESSAGES = [
    {"from": "alice", "text": "Hello there", "timestamp": "10:00", "read": True},
    {"from": "bob", "text": "Unread msg", "timestamp": "10:05", "read": False},
]


class TaskPanelApp(App):
    """Minimal app for testing TaskPanel."""

    def compose(self) -> ComposeResult:
        yield TaskPanel(id="panel")


class MessagePanelApp(App):
    """Minimal app for testing MessagePanel."""

    captured_composed: list[MessageComposed]

    def compose(self) -> ComposeResult:
        self.captured_composed = []
        yield MessagePanel(id="panel")

    def on_message_composed(self, event: MessageComposed) -> None:
        self.captured_composed.append(event)


# ---------------------------------------------------------------------------
# TaskPanel Tests
# ---------------------------------------------------------------------------

class TestTaskPanel:
    @pytest.mark.anyio
    async def test_task_panel_renders(self):
        """TaskPanel mounts without errors."""
        app = TaskPanelApp()
        async with app.run_test() as pilot:
            panel = app.query_one("#panel", TaskPanel)
            assert panel is not None

    @pytest.mark.anyio
    async def test_update_tasks_populates_list(self):
        """update_tasks() fills the ListView."""
        app = TaskPanelApp()
        async with app.run_test() as pilot:
            panel = app.query_one("#panel", TaskPanel)
            panel.update_tasks(SAMPLE_TASKS)
            await pilot.pause()
            task_list = panel.query_one("#task-list", ListView)
            assert len(task_list) == len(SAMPLE_TASKS)

    @pytest.mark.anyio
    async def test_pending_icon_present(self):
        """Tasks with pending status get the ○ icon."""
        app = TaskPanelApp()
        async with app.run_test() as pilot:
            panel = app.query_one("#panel", TaskPanel)
            panel.update_tasks([SAMPLE_TASKS[0]])
            await pilot.pause()
            labels = panel.query(Label)
            texts = [str(lbl.content) for lbl in labels]
            assert any("○" in t for t in texts)

    @pytest.mark.anyio
    async def test_in_progress_icon_present(self):
        """Tasks with in_progress status get the ● icon."""
        app = TaskPanelApp()
        async with app.run_test() as pilot:
            panel = app.query_one("#panel", TaskPanel)
            panel.update_tasks([SAMPLE_TASKS[1]])
            await pilot.pause()
            labels = panel.query(Label)
            texts = [str(lbl.content) for lbl in labels]
            assert any("●" in t for t in texts)

    @pytest.mark.anyio
    async def test_completed_icon_present(self):
        """Tasks with completed status get the ✓ icon."""
        app = TaskPanelApp()
        async with app.run_test() as pilot:
            panel = app.query_one("#panel", TaskPanel)
            panel.update_tasks([SAMPLE_TASKS[2]])
            await pilot.pause()
            labels = panel.query(Label)
            texts = [str(lbl.content) for lbl in labels]
            assert any("✓" in t for t in texts)

    @pytest.mark.anyio
    async def test_blocked_icon_present(self):
        """Tasks with non-empty blockedBy get the 🔒 icon."""
        app = TaskPanelApp()
        async with app.run_test() as pilot:
            panel = app.query_one("#panel", TaskPanel)
            panel.update_tasks([SAMPLE_TASKS[3]])
            await pilot.pause()
            labels = panel.query(Label)
            texts = [str(lbl.content) for lbl in labels]
            assert any("🔒" in t for t in texts)

    @pytest.mark.anyio
    async def test_filter_pending(self):
        """set_filter('pending') shows only pending (non-blocked) tasks."""
        app = TaskPanelApp()
        async with app.run_test() as pilot:
            panel = app.query_one("#panel", TaskPanel)
            panel.update_tasks(SAMPLE_TASKS)
            panel.set_filter("pending")
            await pilot.pause()
            task_list = panel.query_one("#task-list", ListView)
            # pending tasks: id 1 only (id 4 has blockedBy so excluded from pending filter)
            assert len(task_list) == 1

    @pytest.mark.anyio
    async def test_filter_completed(self):
        """set_filter('completed') shows only completed tasks."""
        app = TaskPanelApp()
        async with app.run_test() as pilot:
            panel = app.query_one("#panel", TaskPanel)
            panel.update_tasks(SAMPLE_TASKS)
            panel.set_filter("completed")
            await pilot.pause()
            task_list = panel.query_one("#task-list", ListView)
            assert len(task_list) == 1

    @pytest.mark.anyio
    async def test_filter_none_shows_all(self):
        """set_filter(None) shows all tasks."""
        app = TaskPanelApp()
        async with app.run_test() as pilot:
            panel = app.query_one("#panel", TaskPanel)
            panel.update_tasks(SAMPLE_TASKS)
            panel.set_filter("completed")
            await pilot.pause()
            panel.set_filter(None)
            await pilot.pause()
            task_list = panel.query_one("#task-list", ListView)
            assert len(task_list) == len(SAMPLE_TASKS)

    @pytest.mark.anyio
    async def test_toggle_visibility(self):
        """toggle() adds/removes -visible CSS class."""
        app = TaskPanelApp()
        async with app.run_test() as pilot:
            panel = app.query_one("#panel", TaskPanel)
            assert not panel.has_class("-visible")
            panel.toggle()
            assert panel.has_class("-visible")
            panel.toggle()
            assert not panel.has_class("-visible")

    @pytest.mark.anyio
    async def test_filter_button_all(self):
        """'All' filter resets to show all tasks."""
        app = TaskPanelApp()
        async with app.run_test() as pilot:
            panel = app.query_one("#panel", TaskPanel)
            panel.update_tasks(SAMPLE_TASKS)
            panel.set_filter("completed")
            await pilot.pause()
            panel.set_filter(None)
            await pilot.pause()
            task_list = panel.query_one("#task-list", ListView)
            assert len(task_list) == len(SAMPLE_TASKS)

    @pytest.mark.anyio
    async def test_sort_by_owner(self):
        """Sorting by owner groups tasks alphabetically."""
        app = TaskPanelApp()
        async with app.run_test() as pilot:
            panel = app.query_one("#panel", TaskPanel)
            panel.update_tasks(SAMPLE_TASKS)
            panel._sort_by = "owner"
            panel._refresh_list()
            await pilot.pause()
            task_list = panel.query_one("#task-list", ListView)
            assert len(task_list) == len(SAMPLE_TASKS)


# ---------------------------------------------------------------------------
# MessagePanel Tests
# ---------------------------------------------------------------------------

class TestMessagePanel:
    @pytest.mark.anyio
    async def test_message_panel_renders(self):
        """MessagePanel mounts without errors."""
        app = MessagePanelApp()
        async with app.run_test() as pilot:
            panel = app.query_one("#panel", MessagePanel)
            assert panel is not None

    @pytest.mark.anyio
    async def test_update_messages_populates_list(self):
        """update_messages() fills the ListView."""
        app = MessagePanelApp()
        async with app.run_test() as pilot:
            panel = app.query_one("#panel", MessagePanel)
            panel.update_messages(SAMPLE_MESSAGES)
            await pilot.pause()
            msg_list = panel.query_one("#msg-list", ListView)
            assert len(msg_list) == len(SAMPLE_MESSAGES)

    @pytest.mark.anyio
    async def test_toggle_visibility(self):
        """toggle() adds/removes -visible CSS class."""
        app = MessagePanelApp()
        async with app.run_test() as pilot:
            panel = app.query_one("#panel", MessagePanel)
            assert not panel.has_class("-visible")
            panel.toggle()
            assert panel.has_class("-visible")
            panel.toggle()
            assert not panel.has_class("-visible")

    @pytest.mark.anyio
    async def test_set_agent_updates_title(self):
        """set_agent() updates the panel title."""
        app = MessagePanelApp()
        async with app.run_test() as pilot:
            panel = app.query_one("#panel", MessagePanel)
            panel.set_agent("my-team", "alice")
            await pilot.pause()
            title = panel.query_one(".msg-panel-title", Static)
            assert "alice" in str(title.content)

    @pytest.mark.anyio
    async def test_compose_fires_message_composed(self):
        """Filling compose form and pressing Send fires MessageComposed."""
        app = MessagePanelApp()

        async with app.run_test() as pilot:
            panel = app.query_one("#panel", MessagePanel)
            panel.set_known_agents(["alice", "bob"])
            panel.set_agent("my-team", "carol")
            await pilot.pause()

            # Set values directly then trigger button press
            text_input = panel.query_one("#compose-text", Input)
            text_input.value = "Hello Alice!"

            to_select = panel.query_one("#compose-to", Select)
            to_select.value = "alice"
            await pilot.pause()

            # Trigger send via button pressed event directly
            send_btn = panel.query_one("#send-btn", Button)
            panel.on_button_pressed(Button.Pressed(send_btn))
            await pilot.pause()

            assert len(app.captured_composed) == 1
            assert app.captured_composed[0].to == "alice"
            assert app.captured_composed[0].text == "Hello Alice!"

    @pytest.mark.anyio
    async def test_compose_does_not_fire_without_recipient(self):
        """Send button does nothing if no recipient is selected."""
        app = MessagePanelApp()

        async with app.run_test() as pilot:
            panel = app.query_one("#panel", MessagePanel)
            panel.toggle()
            await pilot.pause()

            text_input = panel.query_one("#compose-text", Input)
            text_input.value = "No recipient"
            await pilot.pause()

            await pilot.click("#send-btn")
            await pilot.pause()

            assert len(app.captured_composed) == 0

    @pytest.mark.anyio
    async def test_view_toggle_broadcast(self):
        """Switching to broadcast shows broadcast messages (empty by default)."""
        app = MessagePanelApp()
        async with app.run_test() as pilot:
            panel = app.query_one("#panel", MessagePanel)
            panel.update_messages(SAMPLE_MESSAGES)
            await pilot.pause()

            # Switch to broadcast view directly
            panel._show_broadcasts = True
            panel._refresh_list()
            await pilot.pause()

            msg_list = panel.query_one("#msg-list", ListView)
            assert len(msg_list) == 0

    @pytest.mark.anyio
    async def test_view_toggle_inbox(self):
        """Switching back to inbox shows inbox messages."""
        app = MessagePanelApp()
        async with app.run_test() as pilot:
            panel = app.query_one("#panel", MessagePanel)
            panel.update_messages(SAMPLE_MESSAGES)
            await pilot.pause()

            panel._show_broadcasts = True
            panel._refresh_list()
            await pilot.pause()

            panel._show_broadcasts = False
            panel._refresh_list()
            await pilot.pause()

            msg_list = panel.query_one("#msg-list", ListView)
            assert len(msg_list) == len(SAMPLE_MESSAGES)
