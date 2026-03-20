"""SessionTabBar widget — tabbed navigation over team/agent sessions."""

from __future__ import annotations

from textual.app import ComposeResult
from textual.message import Message
from textual.widget import Widget
from textual.widgets import TabbedContent, TabPane


def _tab_id(team: str, agent: str) -> str:
    """Stable DOM id for a team/agent tab."""
    return f"tab-{team}-{agent}".replace("/", "-").replace(" ", "_")


class SessionTabBar(Widget):
    """Tab bar for switching between active team/agent sessions."""

    DEFAULT_CSS = """
    SessionTabBar {
        height: auto;
        dock: top;
    }
    """

    # ------------------------------------------------------------------ #
    # Custom messages
    # ------------------------------------------------------------------ #

    class TabActivated(Message):
        """Emitted when the active tab changes."""

        def __init__(self, team: str, agent: str) -> None:
            super().__init__()
            self.team = team
            self.agent = agent

    # ------------------------------------------------------------------ #
    # Internal state
    # ------------------------------------------------------------------ #

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        # ordered list of (team, agent) for tracking
        self._tabs: list[tuple[str, str]] = []

    # ------------------------------------------------------------------ #
    # Composition
    # ------------------------------------------------------------------ #

    def compose(self) -> ComposeResult:
        yield TabbedContent(id="session-tabs")

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #

    def add_tab(self, team: str, agent: str) -> None:
        """Add a new tab for team/agent. No-op if already present."""
        key = (team, agent)
        if key in self._tabs:
            return

        self._tabs.append(key)
        tab_id = _tab_id(team, agent)
        label = f"{team}/{agent}"
        tabbed = self.query_one(TabbedContent)
        tabbed.add_pane(TabPane(label, id=tab_id))

    def remove_tab(self, team: str, agent: str) -> None:
        """Remove the tab for team/agent. No-op if not present."""
        key = (team, agent)
        if key not in self._tabs:
            return

        self._tabs.remove(key)
        tab_id = _tab_id(team, agent)
        tabbed = self.query_one(TabbedContent)
        tabbed.remove_pane(tab_id)

    # ------------------------------------------------------------------ #
    # Event handling
    # ------------------------------------------------------------------ #

    def on_tabbed_content_tab_activated(
        self, event: TabbedContent.TabActivated
    ) -> None:
        event.stop()
        if event.tab is None:
            return
        pane_id = event.tab.id  # e.g. "tab-myteam-myagent"
        # reverse-lookup from pane id
        for team, agent in self._tabs:
            if _tab_id(team, agent) == pane_id:
                self.post_message(self.TabActivated(team=team, agent=agent))
                return
