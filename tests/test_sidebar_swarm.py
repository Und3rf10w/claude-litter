"""Tests for TeamSidebar swarm instance integration."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from textual.app import App, ComposeResult

from claude_litter.models.swarm import SwarmState
from claude_litter.widgets.sidebar import TeamSidebar


def _make_state(tmp_path: Path, instance_id: str = "abcd1234", **overrides) -> SwarmState:
    """Create a SwarmState from a temporary directory."""
    d = tmp_path / instance_id
    d.mkdir(parents=True, exist_ok=True)
    data = {
        "version": 2,
        "mode": "default",
        "goal": "test goal",
        "completion_promise": "done",
        "soft_budget": 10,
        "session_id": "test",
        "instance_id": instance_id,
        "iteration": 3,
        "phase": "review",
        "started_at": "2026-01-01T00:00:00Z",
        "last_updated": "2026-01-01T00:02:00Z",
        "team_name": "test-team",
        "safe_mode": True,
        "sentinel_timeout": 600,
        "teammates_isolation": "shared",
        "teammates_max_count": 8,
        "permission_failures": [],
        "autonomy_health": "healthy",
        "progress_history": [],
    }
    data.update(overrides)
    (d / "state.json").write_text(json.dumps(data))
    return SwarmState.from_files(d)


class SidebarApp(App):
    def compose(self) -> ComposeResult:
        yield TeamSidebar(id="sidebar")


class TestSidebarSwarm:
    @pytest.mark.anyio
    async def test_sidebar_no_swarm(self):
        """update_swarm_instances([]) has no swarm nodes."""
        app = SidebarApp()
        async with app.run_test() as pilot:
            sidebar = app.query_one(TeamSidebar)
            sidebar.update_swarm_instances([])
            await pilot.pause()
            assert sidebar._swarm_nodes == {}
            assert sidebar._swarm_fallback_node is None

    @pytest.mark.anyio
    async def test_sidebar_with_swarm_fallback(self, tmp_path):
        """Swarm instances with no matching team go to fallback root node."""
        state = _make_state(tmp_path)
        assert state is not None

        app = SidebarApp()
        async with app.run_test() as pilot:
            sidebar = app.query_one(TeamSidebar)
            sidebar.update_swarm_instances([state])
            await pilot.pause()
            assert sidebar._swarm_fallback_node is not None
            assert len(sidebar._swarm_fallback_node.children) == 1

    @pytest.mark.anyio
    async def test_sidebar_swarm_nested_under_team(self, tmp_path):
        """Swarm instances nest under their matching team node."""
        state = _make_state(tmp_path)
        assert state is not None

        app = SidebarApp()
        async with app.run_test() as pilot:
            sidebar = app.query_one(TeamSidebar)
            sidebar.update_teams([{"name": "test-team", "dir_name": "test-team", "status": "active", "agents": []}])
            sidebar.update_swarm_instances([state])
            await pilot.pause()
            assert sidebar._swarm_fallback_node is None
            assert "test-team" in sidebar._swarm_nodes
            assert len(sidebar._swarm_nodes["test-team"].children) == 1

    @pytest.mark.anyio
    async def test_sidebar_swarm_cleared_on_empty(self, tmp_path):
        """Calling update_swarm_instances([]) after adding instances clears swarm nodes."""
        state = _make_state(tmp_path)
        assert state is not None

        app = SidebarApp()
        async with app.run_test() as pilot:
            sidebar = app.query_one(TeamSidebar)
            sidebar.update_swarm_instances([state])
            await pilot.pause()
            assert sidebar._swarm_fallback_node is not None

            sidebar.update_swarm_instances([])
            await pilot.pause()
            assert sidebar._swarm_fallback_node is None
            assert sidebar._swarm_nodes == {}

    @pytest.mark.anyio
    async def test_sidebar_swarm_multiple_instances(self, tmp_path):
        """Multiple swarm instances for the same team nest under one branch."""
        state1 = _make_state(tmp_path, instance_id="aaa11111")
        state2 = _make_state(tmp_path, instance_id="bbb22222")
        assert state1 is not None
        assert state2 is not None

        app = SidebarApp()
        async with app.run_test() as pilot:
            sidebar = app.query_one(TeamSidebar)
            sidebar.update_teams([{"name": "test-team", "dir_name": "test-team", "status": "active", "agents": []}])
            sidebar.update_swarm_instances([state1, state2])
            await pilot.pause()
            assert "test-team" in sidebar._swarm_nodes
            assert len(sidebar._swarm_nodes["test-team"].children) == 2
