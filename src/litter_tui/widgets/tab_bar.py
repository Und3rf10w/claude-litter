"""SessionTabBar widget — tabbed navigation over team/agent sessions."""

from __future__ import annotations

from textual import events
from textual.app import ComposeResult
from textual.css.query import NoMatches
from textual.message import Message
from textual.widget import Widget
from textual.widgets import TabbedContent, TabPane, Tabs


def _tab_id(team: str, agent: str) -> str:
    """Stable DOM id for a team/agent tab pane."""
    return f"tab-{team}-{agent}".replace("/", "-").replace(" ", "_")


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
        label = _tab_label(team, agent, active=True)
        tabbed = self.query_one(TabbedContent)
        tabbed.add_pane(TabPane(label, id=tab_id))
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
        self._update_close_colors(pane_id)
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
                tab = tabs_widget.query_one(f"#--content-tab-{pane_id}")
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
        node = widget
        while node is not None:
            if isinstance(node, Tab):
                # ✕ is in the last 2 columns of the tab (space + ✕)
                # region.x is parent-relative; we need to compute how far
                # screen_x is from the right edge of the tab.
                # Use the widget's own coordinate system.
                # node.region gives position within parent.
                # We can compute offset from right edge using
                # the fact that get_widget_at found this tab at screen_x.
                # The local x within the tab = screen_x mapped to tab-local coords.
                # Textual resolves this via the compositor, but we can approximate:
                # The tab's content width matches region.width, and the ✕ is at the end.
                # We just need: is screen_x in the last 2 cols of the tab?
                # Use get_widget_at's _meta or just offset math:
                # Simpler: walk to screen and compute tab screen bounds.
                tab_screen_x = node.region.x
                p = node.parent
                while p is not None and p is not self.screen:
                    tab_screen_x += p.region.x
                    if hasattr(p, 'scroll_offset'):
                        tab_screen_x -= p.scroll_offset.x
                    p = p.parent
                local_x = screen_x - tab_screen_x
                if local_x >= node.region.width - 2:
                    return True
                return False
            node = node.parent
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
