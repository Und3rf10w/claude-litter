"""SessionTabBar widget — tabbed navigation over team/agent sessions."""

from __future__ import annotations

from textual import events
from textual.app import ComposeResult
from textual.css.query import NoMatches
from textual.message import Message
from textual.widget import Widget
from textual.widgets import Tab, TabbedContent, TabPane, Tabs


def _tab_id(team: str, agent: str) -> str:
    """Stable DOM id for a team/agent tab pane.

    Uses a length-prefix encoding to prevent collisions between team/agent
    names that contain hyphens: ``tab-{len(team):04d}-{team}-{agent}``.
    """
    safe_team = team.replace("/", "-").replace(" ", "_")
    safe_agent = agent.replace("/", "-").replace(" ", "_")
    return f"tab-{len(safe_team):04d}-{safe_team}-{safe_agent}"


def _tab_label(team: str, agent: str, *, active: bool = False) -> str:
    """Build a tab label with a colored ✕ close button."""
    name = f"{team}/{agent}" if team else agent
    close_color = "red" if active else "dim"
    return f"{name} [{close_color}]✕[/{close_color}]"


def _pane_id_from_tab_id(tab_dom_id: str) -> str:
    """Extract the pane id from a Tab widget's DOM id."""
    return tab_dom_id.removeprefix("--content-tab-")


class SessionTabBar(Widget):
    """Tab bar for switching between active team/agent sessions."""

    DEFAULT_CSS = """
    SessionTabBar {
        height: auto;
        dock: top;
    }
    SessionTabBar ContentSwitcher {
        height: 0;
    }
    """

    class TabActivated(Message):
        """Emitted when the active tab changes."""

        def __init__(self, team: str, agent: str) -> None:
            super().__init__()
            self.team = team
            self.agent = agent

    class TabClosed(Message):
        """Emitted when a tab is closed."""

        def __init__(self, team: str, agent: str) -> None:
            super().__init__()
            self.team = team
            self.agent = agent

    class TabContextMenuRequested(Message):
        """Emitted when a tab is right-clicked."""

        def __init__(self, team: str, agent: str, screen_x: int, screen_y: int) -> None:
            super().__init__()
            self.team = team
            self.agent = agent
            self.screen_x = screen_x
            self.screen_y = screen_y

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._tabs: list[tuple[str, str]] = []

    def compose(self) -> ComposeResult:
        yield TabbedContent(id="session-tabs")

    def add_tab(self, team: str, agent: str) -> None:
        """Add a new tab for team/agent. No-op if already present."""
        key = (team, agent)
        if key in self._tabs:
            # Activate the existing tab
            tabbed = self.query_one(TabbedContent)
            pane_id = _tab_id(team, agent)
            tabbed.active = pane_id
            return

        self._tabs.append(key)
        tab_id = _tab_id(team, agent)
        # Use the agent name as the plain pane title; the styled label
        # with the ✕ button is set on the Tab widget via _update_close_colors.
        title = agent if not team else f"{agent}"
        tabbed = self.query_one(TabbedContent)
        tabbed.add_pane(TabPane(title, id=tab_id))
        tabbed.active = tab_id

    def remove_tab(self, team: str, agent: str) -> None:
        """Remove the tab for team/agent. No-op if not present."""
        key = (team, agent)
        if key not in self._tabs:
            return

        self._tabs.remove(key)
        tab_id = _tab_id(team, agent)
        tabbed = self.query_one(TabbedContent)
        tabbed.remove_pane(tab_id)
        self.post_message(self.TabClosed(team=team, agent=agent))

    def close_active_tab(self) -> None:
        """Close the currently active tab."""
        tabbed = self.query_one(TabbedContent)
        active_pane_id = tabbed.active
        if not active_pane_id:
            return
        for team, agent in self._tabs:
            if _tab_id(team, agent) == active_pane_id:
                self.remove_tab(team, agent)
                return

    def close_others(self, team: str, agent: str) -> None:
        """Close all tabs except the specified one."""
        to_close = [(t, a) for t, a in self._tabs if (t, a) != (team, agent)]
        for t, a in to_close:
            self.remove_tab(t, a)

    def close_to_right(self, team: str, agent: str) -> None:
        """Close all tabs to the right of the specified one."""
        key = (team, agent)
        try:
            idx = self._tabs.index(key)
        except ValueError:
            return
        to_close = list(self._tabs[idx + 1:])
        for t, a in to_close:
            self.remove_tab(t, a)

    def close_all(self) -> None:
        """Close all tabs."""
        to_close = list(self._tabs)
        for t, a in to_close:
            self.remove_tab(t, a)

    def on_tabbed_content_tab_activated(
        self, event: TabbedContent.TabActivated
    ) -> None:
        event.stop()
        if event.tab is None:
            return
        pane_id = event.pane.id if event.pane else ""
        # Update ✕ colors: red on active, dim on others
        self._update_close_colors(pane_id or "")
        for team, agent in self._tabs:
            if _tab_id(team, agent) == pane_id:
                self.post_message(self.TabActivated(team=team, agent=agent))
                return

    def _update_close_colors(self, active_pane_id: str) -> None:
        """Re-render tab labels so the active tab's ✕ is red and others are dim."""
        try:
            tabs_widget = self.query_one(Tabs)
        except NoMatches:
            return
        for team, agent in self._tabs:
            pane_id = _tab_id(team, agent)
            is_active = pane_id == active_pane_id
            # Tab DOM id is "--content-tab-" + pane_id
            try:
                tab = tabs_widget.query_one(f"#--content-tab-{pane_id}", Tab)
                tab.label = _tab_label(team, agent, active=is_active)
            except NoMatches:
                pass

    def on_tabbed_content_cleared(self, event: TabbedContent.Cleared) -> None:
        """Handle all tabs being closed."""
        event.stop()

    def _find_tab_key_at(self, screen_x: int, screen_y: int) -> tuple[str, str] | None:
        """Find which (team, agent) tab is at the given screen coordinates."""
        try:
            widget, _ = self.screen.get_widget_at(screen_x, screen_y)
        except Exception:
            return None

        # Walk up from the hit widget to find a Tab
        node = widget
        from textual.widgets._tabs import Tab
        while node is not None:
            if isinstance(node, Tab):
                pane_id = _pane_id_from_tab_id(node.id or "")
                for team, agent in self._tabs:
                    if _tab_id(team, agent) == pane_id:
                        return (team, agent)
                return None
            node = node.parent
        return None

    def _is_close_button_hit(self, screen_x: int, screen_y: int) -> bool:
        """Check if the click is on the ✕ portion of a tab."""
        try:
            widget, _ = self.screen.get_widget_at(screen_x, screen_y)
        except Exception:
            return False

        from textual.widgets._tabs import Tab
        tab = widget
        while tab is not None:
            if isinstance(tab, Tab):
                break
            tab = tab.parent
        else:
            return False

        # tab.region is relative to the screen, so we can directly compare
        local_x = screen_x - tab.region.x
        # ✕ is the last visible character — check the last 3 columns of the tab
        if local_x >= tab.region.width - 3:
            return True
        return False

    async def on_click(self, event: events.Click) -> None:
        """Handle right-clicks (context menu) and ✕ clicks (close) on tabs."""
        if event.button == 3:
            key = self._find_tab_key_at(event.screen_x, event.screen_y)
            if key is not None:
                event.stop()
                event.prevent_default()
                self.post_message(
                    self.TabContextMenuRequested(
                        team=key[0],
                        agent=key[1],
                        screen_x=event.screen_x,
                        screen_y=event.screen_y,
                    )
                )
            return

        if event.button == 1:
            key = self._find_tab_key_at(event.screen_x, event.screen_y)
            if key is not None and self._is_close_button_hit(event.screen_x, event.screen_y):
                event.stop()
                event.prevent_default()
                self.remove_tab(key[0], key[1])
