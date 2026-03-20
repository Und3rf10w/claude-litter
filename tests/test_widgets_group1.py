"""Tests for Unit 6: TeamSidebar, SessionTabBar, StatusBar widgets."""

from __future__ import annotations

import pytest
from textual.app import App, ComposeResult
from textual.widgets import Tree, Static, TabbedContent, Tabs

from litter_tui.widgets.sidebar import TeamSidebar
from litter_tui.widgets.tab_bar import SessionTabBar, _tab_label, _tab_id
from litter_tui.widgets.status_bar import StatusBar
from litter_tui.widgets.context_menu import ContextMenu


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

    # add_tab activates the tab (firing an event) + we manually post one
    assert len(received) >= 1
    matching = [e for e in received if e.team == "alpha" and e.agent == "backend"]
    assert len(matching) >= 1


@pytest.mark.anyio
async def test_tabbar_close_active_tab():
    """close_active_tab should remove the currently active tab."""
    async with TabBarApp().run_test() as pilot:
        tabbar = pilot.app.query_one(SessionTabBar)
        tabbar.add_tab("alpha", "a1")
        tabbar.add_tab("alpha", "a2")
        await pilot.pause()

        tabbar.close_active_tab()
        await pilot.pause()

        # One tab should remain
        assert len(tabbar._tabs) == 1


@pytest.mark.anyio
async def test_tabbar_close_others():
    """close_others should remove all tabs except the specified one."""
    async with TabBarApp().run_test() as pilot:
        tabbar = pilot.app.query_one(SessionTabBar)
        tabbar.add_tab("t", "a1")
        tabbar.add_tab("t", "a2")
        tabbar.add_tab("t", "a3")
        await pilot.pause()

        tabbar.close_others("t", "a2")
        await pilot.pause()

        assert tabbar._tabs == [("t", "a2")]


@pytest.mark.anyio
async def test_tabbar_close_to_right():
    """close_to_right should remove tabs after the specified one."""
    async with TabBarApp().run_test() as pilot:
        tabbar = pilot.app.query_one(SessionTabBar)
        tabbar.add_tab("t", "a1")
        tabbar.add_tab("t", "a2")
        tabbar.add_tab("t", "a3")
        await pilot.pause()

        tabbar.close_to_right("t", "a1")
        await pilot.pause()

        assert tabbar._tabs == [("t", "a1")]


@pytest.mark.anyio
async def test_tabbar_close_all():
    """close_all should remove every tab."""
    async with TabBarApp().run_test() as pilot:
        tabbar = pilot.app.query_one(SessionTabBar)
        tabbar.add_tab("t", "a1")
        tabbar.add_tab("t", "a2")
        await pilot.pause()

        tabbar.close_all()
        await pilot.pause()

        assert tabbar._tabs == []


@pytest.mark.anyio
async def test_tabbar_close_label_has_x():
    """Tab labels should include ✕ close button."""
    async with TabBarApp().run_test() as pilot:
        tabbar = pilot.app.query_one(SessionTabBar)
        tabbar.add_tab("team", "agent")
        await pilot.pause()

        tabs = tabbar.query_one(Tabs)
        tab_widgets = list(tabs.query("Tab"))
        assert len(tab_widgets) == 1
        label_text = str(tab_widgets[0].label)
        assert "✕" in label_text


def test_tab_label_active_has_red():
    """_tab_label with active=True should produce red markup for ✕."""
    label = _tab_label("team", "agent", active=True)
    assert "[red]✕[/red]" in label


def test_tab_label_inactive_has_dim():
    """_tab_label with active=False should produce dim markup for ✕."""
    label = _tab_label("team", "agent", active=False)
    assert "[dim]✕[/dim]" in label


@pytest.mark.anyio
async def test_tabbar_close_colors_update_on_switch():
    """Active tab ✕ should be red; inactive should be dim after switching."""
    async with TabBarApp().run_test() as pilot:
        tabbar = pilot.app.query_one(SessionTabBar)
        tabbar.add_tab("t", "a1")
        tabbar.add_tab("t", "a2")
        await pilot.pause()

        # Manually trigger color update for a1
        tabbar._update_close_colors(_tab_id("t", "a1"))
        await pilot.pause()

        tabs = tabbar.query_one(Tabs)
        tab1 = tabs.query_one(f"#--content-tab-{_tab_id('t', 'a1')}")
        tab2 = tabs.query_one(f"#--content-tab-{_tab_id('t', 'a2')}")
        # Content stores style info in spans; check that styles differ
        tab1_spans = tab1.label.spans
        tab2_spans = tab2.label.spans
        # Active tab (a1) should have 'red' style on ✕
        assert any("red" in str(s.style) for s in tab1_spans)
        # Inactive tab (a2) should have 'dim' style on ✕
        assert any("dim" in str(s.style) for s in tab2_spans)


@pytest.mark.anyio
async def test_tabbar_right_click_emits_context_menu():
    """Right-clicking on a tab should emit TabContextMenuRequested."""
    received: list[SessionTabBar.TabContextMenuRequested] = []

    class WatchApp(App):
        def compose(self) -> ComposeResult:
            yield SessionTabBar(id="tabbar")

        def on_session_tab_bar_tab_context_menu_requested(
            self, msg: SessionTabBar.TabContextMenuRequested
        ):
            received.append(msg)

    async with WatchApp().run_test(size=(80, 24)) as pilot:
        tabbar = pilot.app.query_one(SessionTabBar)
        tabbar.add_tab("team", "agent")
        await pilot.pause()

        # Right-click on the tab area (x=5, y=0)
        await pilot.click(offset=(5, 0), button=3)
        await pilot.pause()

    assert len(received) == 1
    assert received[0].team == "team"
    assert received[0].agent == "agent"


@pytest.mark.anyio
async def test_tabbar_tab_closed_message():
    """TabClosed message should fire when a tab is removed."""
    received: list[SessionTabBar.TabClosed] = []

    class WatchApp(App):
        def compose(self) -> ComposeResult:
            yield SessionTabBar(id="tabbar")

        def on_session_tab_bar_tab_closed(self, msg: SessionTabBar.TabClosed):
            received.append(msg)

    async with WatchApp().run_test() as pilot:
        tabbar = pilot.app.query_one(SessionTabBar)
        tabbar.add_tab("t", "a1")
        await pilot.pause()

        tabbar.remove_tab("t", "a1")
        await pilot.pause()

    assert len(received) == 1
    assert received[0].team == "t"
    assert received[0].agent == "a1"


# ------------------------------------------------------------------ #
# Sidebar tree collapse tests
# ------------------------------------------------------------------ #


@pytest.mark.anyio
async def test_sidebar_team_node_toggles():
    """Clicking a team node should toggle its expanded state."""
    async with SidebarApp().run_test() as pilot:
        sidebar = pilot.app.query_one(TeamSidebar)
        sidebar.update_teams(SAMPLE_TEAMS)
        await pilot.pause()

        # Team nodes start expanded
        team_node = sidebar._team_nodes["alpha"]
        assert team_node.is_expanded

        # Directly call toggle to verify the mechanism works
        team_node.toggle()
        await pilot.pause()
        assert not team_node.is_expanded

        team_node.toggle()
        await pilot.pause()
        assert team_node.is_expanded


# ------------------------------------------------------------------ #
# ContextMenu tests
# ------------------------------------------------------------------ #


class ContextMenuApp(App):
    def compose(self) -> ComposeResult:
        yield ContextMenu(id="ctx")


@pytest.mark.anyio
async def test_context_menu_show_at_becomes_visible():
    """show_at should add the -visible class."""
    async with ContextMenuApp().run_test() as pilot:
        menu = pilot.app.query_one(ContextMenu)
        assert not menu.has_class("-visible")

        menu.show_at("team", "agent", 10, 5)
        await pilot.pause()

        assert menu.has_class("-visible")


@pytest.mark.anyio
async def test_context_menu_show_at_populates_options():
    """show_at should populate agent action options."""
    async with ContextMenuApp().run_test() as pilot:
        menu = pilot.app.query_one(ContextMenu)
        menu.show_at("team", "agent", 10, 5)
        await pilot.pause()

        assert menu.option_count == 5  # view, message, kill, detach, duplicate


@pytest.mark.anyio
async def test_context_menu_tab_menu_options():
    """show_tab_menu_at should populate tab-specific options."""
    async with ContextMenuApp().run_test() as pilot:
        menu = pilot.app.query_one(ContextMenu)
        menu.show_tab_menu_at("team", "agent", 10, 5)
        await pilot.pause()

        assert menu.option_count == 4  # close, close others, close right, close all


@pytest.mark.anyio
async def test_context_menu_dismiss_on_escape():
    """Pressing Escape should hide the context menu."""
    async with ContextMenuApp().run_test() as pilot:
        menu = pilot.app.query_one(ContextMenu)
        menu.show_at("team", "agent", 10, 5)
        await pilot.pause()

        assert menu.has_class("-visible")
        await pilot.press("escape")
        await pilot.pause()

        assert not menu.has_class("-visible")


@pytest.mark.anyio
async def test_context_menu_action_selected_message():
    """Selecting an option should emit ActionSelected."""
    received: list[ContextMenu.ActionSelected] = []

    class WatchApp(App):
        def compose(self) -> ComposeResult:
            yield ContextMenu(id="ctx")

        def on_context_menu_action_selected(self, msg: ContextMenu.ActionSelected):
            received.append(msg)

    async with WatchApp().run_test() as pilot:
        menu = pilot.app.query_one(ContextMenu)
        menu.show_at("team", "agent", 10, 5)
        await pilot.pause()

        menu.post_message(ContextMenu.ActionSelected("kill", "team", "agent"))
        await pilot.pause()

    assert len(received) == 1
    assert received[0].action == "kill"
    assert received[0].team == "team"
    assert received[0].agent == "agent"


@pytest.mark.anyio
async def test_context_menu_positions_with_absolute_offset():
    """show_at should set absolute_offset for cursor-relative positioning."""
    async with ContextMenuApp().run_test() as pilot:
        menu = pilot.app.query_one(ContextMenu)
        menu.show_at("team", "agent", 15, 8)
        await pilot.pause()

        assert menu.absolute_offset is not None
        assert menu.absolute_offset.x == 15
        assert menu.absolute_offset.y == 8


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
