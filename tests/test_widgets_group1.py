"""Tests for Unit 6: TeamSidebar, SessionTabBar, StatusBar widgets."""

from __future__ import annotations

import pytest
from textual.app import App, ComposeResult
from textual.widgets import Tree, Static, TabbedContent

from litter_tui.widgets.sidebar import TeamSidebar
from litter_tui.widgets.tab_bar import SessionTabBar
from litter_tui.widgets.status_bar import StatusBar


# ------------------------------------------------------------------ #
# TeamSidebar tests
# ------------------------------------------------------------------ #


class SidebarApp(App):
    def compose(self) -> ComposeResult:
        yield TeamSidebar(id="sidebar")


SAMPLE_TEAMS = [
    {
        "name": "alpha",
        "status": "active",
        "agents": [
            {"name": "backend", "model": "sonnet", "unread": 2, "task_id": "42"},
            {"name": "frontend", "model": "haiku", "unread": 0, "task_id": None},
        ],
    },
    {
        "name": "beta",
        "status": "inactive",
        "agents": [
            {"name": "tester", "model": "opus", "unread": 1, "task_id": "7"},
        ],
    },
]


@pytest.mark.anyio
async def test_sidebar_composes_with_tree():
    """TeamSidebar should contain a Tree widget after composition."""
    async with SidebarApp().run_test() as pilot:
        sidebar = pilot.app.query_one(TeamSidebar)
        tree = sidebar.query_one(Tree)
        assert tree is not None


@pytest.mark.anyio
async def test_sidebar_update_teams_populates_tree():
    """update_teams should add team and agent nodes to the tree."""
    async with SidebarApp().run_test() as pilot:
        sidebar = pilot.app.query_one(TeamSidebar)
        sidebar.update_teams(SAMPLE_TEAMS)
        await pilot.pause()

        assert "alpha" in sidebar._team_nodes
        assert "beta" in sidebar._team_nodes
        assert ("alpha", "backend") in sidebar._agent_nodes
        assert ("alpha", "frontend") in sidebar._agent_nodes
        assert ("beta", "tester") in sidebar._agent_nodes


@pytest.mark.anyio
async def test_sidebar_refresh_agent_updates_data():
    """refresh_agent should update stored data for an existing agent."""
    async with SidebarApp().run_test() as pilot:
        sidebar = pilot.app.query_one(TeamSidebar)
        sidebar.update_teams(SAMPLE_TEAMS)
        await pilot.pause()

        sidebar.refresh_agent("alpha", "backend", unread=5, task_id="99")
        assert sidebar._agent_data[("alpha", "backend")]["unread"] == 5
        assert sidebar._agent_data[("alpha", "backend")]["task_id"] == "99"


@pytest.mark.anyio
async def test_sidebar_refresh_agent_new_entry():
    """refresh_agent should create an entry for unknown agents."""
    async with SidebarApp().run_test() as pilot:
        sidebar = pilot.app.query_one(TeamSidebar)
        sidebar.update_teams([])
        await pilot.pause()

        sidebar.refresh_agent("gamma", "new-agent", unread=0)
        assert ("gamma", "new-agent") in sidebar._agent_data


@pytest.mark.anyio
async def test_sidebar_team_selected_message():
    """Posting TeamSelected message should be received by app handler."""
    received: list[TeamSidebar.TeamSelected] = []

    class WatchApp(App):
        def compose(self) -> ComposeResult:
            yield TeamSidebar(id="sidebar")

        def on_team_sidebar_team_selected(self, msg: TeamSidebar.TeamSelected):
            received.append(msg)

    async with WatchApp().run_test() as pilot:
        sidebar = pilot.app.query_one(TeamSidebar)
        sidebar.update_teams(SAMPLE_TEAMS)
        await pilot.pause()

        sidebar.post_message(TeamSidebar.TeamSelected(team="alpha"))
        await pilot.pause()

    assert len(received) == 1
    assert received[0].team == "alpha"


@pytest.mark.anyio
async def test_sidebar_agent_selected_message():
    """Posting AgentSelected message should be received by app handler."""
    received: list[TeamSidebar.AgentSelected] = []

    class WatchApp(App):
        def compose(self) -> ComposeResult:
            yield TeamSidebar(id="sidebar")

        def on_team_sidebar_agent_selected(self, msg: TeamSidebar.AgentSelected):
            received.append(msg)

    async with WatchApp().run_test() as pilot:
        sidebar = pilot.app.query_one(TeamSidebar)
        sidebar.update_teams(SAMPLE_TEAMS)
        await pilot.pause()

        sidebar.post_message(TeamSidebar.AgentSelected(team="alpha", agent="backend"))
        await pilot.pause()

    assert len(received) == 1
    assert received[0].team == "alpha"
    assert received[0].agent == "backend"


# ------------------------------------------------------------------ #
# SessionTabBar tests
# ------------------------------------------------------------------ #


class TabBarApp(App):
    def compose(self) -> ComposeResult:
        yield SessionTabBar(id="tabbar")


@pytest.mark.anyio
async def test_tabbar_composes_with_tabbedcontent():
    """SessionTabBar should contain a TabbedContent widget."""
    async with TabBarApp().run_test() as pilot:
        tabbar = pilot.app.query_one(SessionTabBar)
        tc = tabbar.query_one(TabbedContent)
        assert tc is not None


@pytest.mark.anyio
async def test_tabbar_add_tab():
    """add_tab should record the tab and add a pane."""
    async with TabBarApp().run_test() as pilot:
        tabbar = pilot.app.query_one(SessionTabBar)
        tabbar.add_tab("alpha", "backend")
        await pilot.pause()

        assert ("alpha", "backend") in tabbar._tabs


@pytest.mark.anyio
async def test_tabbar_add_tab_idempotent():
    """add_tab with same team/agent should not duplicate."""
    async with TabBarApp().run_test() as pilot:
        tabbar = pilot.app.query_one(SessionTabBar)
        tabbar.add_tab("alpha", "backend")
        tabbar.add_tab("alpha", "backend")
        await pilot.pause()

        assert tabbar._tabs.count(("alpha", "backend")) == 1


@pytest.mark.anyio
async def test_tabbar_remove_tab():
    """remove_tab should remove the entry from _tabs."""
    async with TabBarApp().run_test() as pilot:
        tabbar = pilot.app.query_one(SessionTabBar)
        tabbar.add_tab("alpha", "backend")
        await pilot.pause()

        tabbar.remove_tab("alpha", "backend")
        await pilot.pause()

        assert ("alpha", "backend") not in tabbar._tabs


@pytest.mark.anyio
async def test_tabbar_remove_nonexistent_is_noop():
    """remove_tab on a tab that doesn't exist should not raise."""
    async with TabBarApp().run_test() as pilot:
        tabbar = pilot.app.query_one(SessionTabBar)
        tabbar.remove_tab("ghost", "agent")
        await pilot.pause()

        assert tabbar._tabs == []


@pytest.mark.anyio
async def test_tabbar_tab_activated_message():
    """TabActivated message should be received by app handler."""
    received: list[SessionTabBar.TabActivated] = []

    class WatchApp(App):
        def compose(self) -> ComposeResult:
            yield SessionTabBar(id="tabbar")

        def on_session_tab_bar_tab_activated(self, msg: SessionTabBar.TabActivated):
            received.append(msg)

    async with WatchApp().run_test() as pilot:
        tabbar = pilot.app.query_one(SessionTabBar)
        tabbar.add_tab("alpha", "backend")
        await pilot.pause()

        tabbar.post_message(SessionTabBar.TabActivated(team="alpha", agent="backend"))
        await pilot.pause()

    assert len(received) == 1
    assert received[0].team == "alpha"
    assert received[0].agent == "backend"


# ------------------------------------------------------------------ #
# StatusBar tests
# ------------------------------------------------------------------ #


class StatusBarApp(App):
    def compose(self) -> ComposeResult:
        yield StatusBar(id="statusbar")


@pytest.mark.anyio
async def test_statusbar_composes():
    """StatusBar should contain a Static widget."""
    async with StatusBarApp().run_test() as pilot:
        sb = pilot.app.query_one(StatusBar)
        static = sb.query_one("#status-text", Static)
        assert static is not None


@pytest.mark.anyio
async def test_statusbar_update_status_std_mode():
    """update_status should render team, agents, tasks, and STD mode."""
    async with StatusBarApp().run_test() as pilot:
        sb = pilot.app.query_one(StatusBar)
        sb.update_status(
            team_name="alpha",
            agent_count=4,
            active_count=3,
            task_total=10,
            task_done=7,
            vim_mode=False,
        )
        await pilot.pause()

        text_str = str(sb.query_one("#status-text", Static).content)
        assert "alpha" in text_str
        assert "3/4" in text_str
        assert "7/10" in text_str
        assert "STD" in text_str


@pytest.mark.anyio
async def test_statusbar_update_status_vim_mode():
    """update_status with vim_mode=True should show VIM."""
    async with StatusBarApp().run_test() as pilot:
        sb = pilot.app.query_one(StatusBar)
        sb.update_status(
            team_name="beta",
            agent_count=2,
            active_count=1,
            task_total=5,
            task_done=2,
            vim_mode=True,
        )
        await pilot.pause()

        text_str = str(sb.query_one("#status-text", Static).content)
        assert "VIM" in text_str


@pytest.mark.anyio
async def test_statusbar_no_team():
    """update_status with empty team_name should show em-dash placeholder."""
    async with StatusBarApp().run_test() as pilot:
        sb = pilot.app.query_one(StatusBar)
        sb.update_status(
            team_name="",
            agent_count=0,
            active_count=0,
            task_total=0,
            task_done=0,
        )
        await pilot.pause()

        text_str = str(sb.query_one("#status-text", Static).content)
        assert "\u2014" in text_str


# ------------------------------------------------------------------ #
# Import smoke test
# ------------------------------------------------------------------ #


def test_widget_imports():
    """All three widget classes should be importable from the package."""
    from litter_tui.widgets import TeamSidebar, SessionTabBar, StatusBar

    assert TeamSidebar is not None
    assert SessionTabBar is not None
    assert StatusBar is not None
