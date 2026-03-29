"""Tests for StatusBar swarm-related fields."""

from __future__ import annotations

import pytest
from textual.app import App, ComposeResult
from textual.widgets import Static

from claude_litter.widgets.status_bar import StatusBar


class StatusBarApp(App):
    def compose(self) -> ComposeResult:
        yield StatusBar(id="status-bar")


@pytest.mark.anyio
async def test_status_bar_no_swarm():
    """Without swarm params, 'Swarm' should not appear in the status text."""
    app = StatusBarApp()
    async with app.run_test() as pilot:
        sb = app.query_one(StatusBar)
        sb.update_status("test-team", 2, 1, 5, 3)
        await pilot.pause()
        text_str = str(sb.query_one("#status-text", Static).content)
        assert "Swarm" not in text_str


@pytest.mark.anyio
async def test_status_bar_with_swarm():
    """With swarm_active=True, status text should include 'Swarm' and iteration."""
    app = StatusBarApp()
    async with app.run_test() as pilot:
        sb = app.query_one(StatusBar)
        sb.update_status(
            "test-team", 2, 1, 5, 3,
            swarm_active=True,
            swarm_phase="execute",
            swarm_iteration=2,
        )
        await pilot.pause()
        text_str = str(sb.query_one("#status-text", Static).content)
        assert "Swarm" in text_str
        assert "iter 2" in text_str


@pytest.mark.anyio
async def test_status_bar_swarm_phase_shown():
    """Swarm phase should appear in the status text."""
    app = StatusBarApp()
    async with app.run_test() as pilot:
        sb = app.query_one(StatusBar)
        sb.update_status(
            "test-team", 1, 1, 3, 1,
            swarm_active=True,
            swarm_phase="plan",
            swarm_iteration=1,
        )
        await pilot.pause()
        text_str = str(sb.query_one("#status-text", Static).content)
        assert "plan" in text_str
