"""Tests for SwarmPanel widget."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from textual.app import App, ComposeResult
from textual.widgets import Static

from claude_litter.models.swarm import SwarmState
from claude_litter.widgets.swarm_panel import SwarmPanel


def _make_state(tmp_path: Path, instance_id: str = "abcd1234", **overrides) -> SwarmState:
    """Create a SwarmState from a temporary directory."""
    d = tmp_path / instance_id
    d.mkdir(parents=True, exist_ok=True)
    data = {
        "version": 2, "mode": "default", "goal": "test goal",
        "completion_promise": "done", "soft_budget": 10,
        "session_id": "test", "instance_id": instance_id,
        "iteration": 2, "phase": "execute",
        "started_at": "2026-01-01T00:00:00Z",
        "last_updated": "2026-01-01T00:01:00Z",
        "team_name": "test-team", "safe_mode": True,
        "sentinel_timeout": 600, "teammates_isolation": "shared",
        "teammates_max_count": 8, "permission_failures": [],
        "autonomy_health": "healthy", "progress_history": [],
    }
    data.update(overrides)
    (d / "state.json").write_text(json.dumps(data))
    return SwarmState.from_files(d)


class SwarmPanelApp(App):
    def compose(self) -> ComposeResult:
        yield SwarmPanel(id="swarm-panel")


class TestSwarmPanel:
    @pytest.mark.anyio
    async def test_swarm_panel_toggle(self):
        """Panel mounts, toggle changes _visible, has_class('-visible')."""
        app = SwarmPanelApp()
        async with app.run_test() as pilot:
            panel = app.query_one(SwarmPanel)
            assert not panel._visible
            panel.toggle()
            assert panel._visible
            assert panel.has_class("-visible")

    @pytest.mark.anyio
    async def test_swarm_panel_toggle_twice(self):
        """Toggling twice returns to hidden state."""
        app = SwarmPanelApp()
        async with app.run_test() as pilot:
            panel = app.query_one(SwarmPanel)
            panel.toggle()
            panel.toggle()
            assert not panel._visible
            assert not panel.has_class("-visible")

    @pytest.mark.anyio
    async def test_swarm_panel_empty_state(self, tmp_path):
        """update_instances([]) keeps empty message visible."""
        app = SwarmPanelApp()
        async with app.run_test() as pilot:
            panel = app.query_one(SwarmPanel)
            panel.update_instances([])
            await pilot.pause()
            empty = panel.query_one("#swarm-empty", Static)
            assert empty.display

    @pytest.mark.anyio
    async def test_swarm_panel_with_instance(self, tmp_path):
        """update_instances with real SwarmState shows status overview with 'Iter' text."""
        state = _make_state(tmp_path)
        assert state is not None

        app = SwarmPanelApp()
        async with app.run_test() as pilot:
            panel = app.query_one(SwarmPanel)
            panel.update_instances([state])
            await pilot.pause()
            overview = panel.query_one("#swarm-status-overview", Static)
            assert "Iter" in str(overview.content)

    @pytest.mark.anyio
    async def test_swarm_panel_hides_empty_with_instance(self, tmp_path):
        """update_instances with SwarmState hides the empty message."""
        state = _make_state(tmp_path)
        assert state is not None

        app = SwarmPanelApp()
        async with app.run_test() as pilot:
            panel = app.query_one(SwarmPanel)
            panel.update_instances([state])
            await pilot.pause()
            empty = panel.query_one("#swarm-empty", Static)
            assert not empty.display

    @pytest.mark.anyio
    async def test_instance_switcher_hidden_single(self, tmp_path):
        """Single instance should not show the multi-instance bar."""
        from textual.containers import Horizontal

        state = _make_state(tmp_path)
        app = SwarmPanelApp()
        async with app.run_test() as pilot:
            panel = app.query_one(SwarmPanel)
            panel.update_instances([state])
            await pilot.pause()
            bar = panel.query_one("#swarm-instance-bar", Horizontal)
            assert not bar.has_class("-multi")

    @pytest.mark.anyio
    async def test_instance_switcher_visible_multi(self, tmp_path):
        """Multiple instances should show the multi-instance bar."""
        from textual.containers import Horizontal

        state1 = _make_state(tmp_path, instance_id="aaaa0001")
        state2 = _make_state(tmp_path, instance_id="bbbb0002")
        app = SwarmPanelApp()
        async with app.run_test() as pilot:
            panel = app.query_one(SwarmPanel)
            panel.update_instances([state1, state2])
            await pilot.pause()
            bar = panel.query_one("#swarm-instance-bar", Horizontal)
            assert bar.has_class("-multi")
