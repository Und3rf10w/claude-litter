"""TeamSidebar widget — displays teams and agents in a collapsible tree."""

from __future__ import annotations

from textual import events
from textual.app import ComposeResult
from textual.message import Message
from textual.widget import Widget
from textual.widgets import Tree
from textual.widgets.tree import TreeNode


_STATUS_COLOR = {
    "active": "green",
    "partial": "yellow",
    "inactive": "gray",
}

# Map agent color names to Rich/Textual color names
_AGENT_COLORS = {
    "blue": "dodger_blue1",
    "green": "green3",
    "yellow": "yellow3",
    "purple": "medium_purple",
    "orange": "dark_orange",
    "pink": "hot_pink",
    "red": "red1",
    "cyan": "cyan",
}


def _short_model(model: str) -> str:
    """Extract a short model badge from a full model string."""
    low = model.lower()
    if "opus" in low:
        return "O"
    if "haiku" in low:
        return "H"
    # Default to sonnet
    return "S"


class _SidebarTree(Tree):
    """Tree subclass that intercepts right-clicks before default handling."""

    async def _on_click(self, event: events.Click) -> None:
        if event.button == 3:
            meta = event.style.meta
            if "line" in meta:
                node = self.get_node_at_line(meta["line"])
                if node and node.data and node.data.get("type") == "agent":
                    self.post_message(
                        TeamSidebar.AgentContextMenuRequested(
                            team=node.data["team"],
                            agent=node.data["agent"],
                            screen_x=event.screen_x,
                            screen_y=event.screen_y,
                        )
                    )
                elif node and node.data and node.data.get("type") == "team":
                    self.post_message(
                        TeamSidebar.TeamContextMenuRequested(
                            team=node.data["team"],
                            screen_x=event.screen_x,
                            screen_y=event.screen_y,
                        )
                    )
            event.stop()
            event.prevent_default()
            return
        await super()._on_click(event)


class TeamSidebar(Widget):
    """Sidebar showing teams and their agents as a collapsible tree."""

    DEFAULT_CSS = """
    TeamSidebar {
        width: 28;
        height: 100%;
        border-right: solid $panel-lighten-1;
    }
    """

    class AgentSelected(Message):
        """Emitted when an agent node is clicked."""

        def __init__(self, team: str, agent: str) -> None:
            super().__init__()
            self.team = team
            self.agent = agent

    class MainChatSelected(Message):
        """Emitted when the Main Chat node is clicked."""

    class TeamSelected(Message):
        """Emitted when a team root node is clicked."""

        def __init__(self, team: str) -> None:
            super().__init__()
            self.team = team

    class AgentContextMenuRequested(Message):
        """Emitted when an agent node is right-clicked."""

        def __init__(self, team: str, agent: str, screen_x: int, screen_y: int) -> None:
            super().__init__()
            self.team = team
            self.agent = agent
            self.screen_x = screen_x
            self.screen_y = screen_y

    class TeamContextMenuRequested(Message):
        """Emitted when a team node is right-clicked."""

        def __init__(self, team: str, screen_x: int, screen_y: int) -> None:
            super().__init__()
            self.team = team
            self.screen_x = screen_x
            self.screen_y = screen_y

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._team_nodes: dict[str, TreeNode] = {}
        self._agent_nodes: dict[tuple[str, str], TreeNode] = {}
        self._agent_data: dict[tuple[str, str], dict] = {}

    def compose(self) -> ComposeResult:
        tree: _SidebarTree = _SidebarTree("Teams", id="sidebar-tree")
        tree.root.expand()
        yield tree

    def update_teams(self, teams: list[dict]) -> None:
        """Rebuild the tree from a list of team dicts."""
        tree = self.query_one(Tree)
        tree.clear()
        tree.root.expand()
        self._team_nodes.clear()
        self._agent_nodes.clear()
        self._agent_data.clear()

        # Add "Main Chat" entry at the top
        tree.root.add_leaf(
            "[bold]> Litter Overlord[/bold]",
            data={"type": "main_chat"},
        )

        for team in teams:
            team_name = team["name"]
            dir_name = team.get("dir_name", team_name)
            status = team.get("status", "inactive")
            color = _STATUS_COLOR.get(status, "gray")
            label = f"[@{color}]\u25cf[/@{color}] {team_name.replace('[', '\\[')}"
            team_node: TreeNode[dict] = tree.root.add(
                label, data={"type": "team", "team": dir_name}, expand=True
            )
            self._team_nodes[dir_name] = team_node

            for agent in team.get("agents", []):
                agent_name = agent["name"]
                self._agent_data[(dir_name, agent_name)] = agent
                agent_node = team_node.add_leaf(
                    self._agent_label(agent),
                    data={"type": "agent", "team": dir_name, "agent": agent_name},
                )
                self._agent_nodes[(dir_name, agent_name)] = agent_node

    def refresh_agent(self, team: str, agent: str, **data) -> None:
        """Update a single agent node in the tree without full rebuild."""
        key = (team, agent)
        if key in self._agent_data:
            self._agent_data[key].update(data)
        else:
            self._agent_data[key] = {"name": agent, **data}

        node = self._agent_nodes.get(key)
        if node is not None:
            node.set_label(self._agent_label(self._agent_data[key]))

    def on_tree_node_selected(self, event: Tree.NodeSelected) -> None:
        event.stop()
        node_data = event.node.data
        if node_data is None:
            return
        if node_data.get("type") == "main_chat":
            self.post_message(self.MainChatSelected())
        elif node_data.get("type") == "team":
            # Toggle collapse/expand on team nodes
            event.node.toggle()
            self.post_message(self.TeamSelected(team=node_data["team"]))
        elif node_data.get("type") == "agent":
            self.post_message(
                self.AgentSelected(team=node_data["team"], agent=node_data["agent"])
            )

    @staticmethod
    def _agent_label(agent: dict) -> str:
        model_raw = agent.get("model", "sonnet")
        badge = _short_model(model_raw)
        unread = agent.get("unread", 0)
        task_id = agent.get("task_id")
        agent_type = agent.get("agentType", "")
        color = agent.get("color", "")
        working = agent.get("working")
        tool = agent.get("tool", "")

        # Color the badge using the agent's assigned color
        color_name = _AGENT_COLORS.get(color, "dim")
        safe_name = agent.get("name", "?").replace("[", "\\[")

        # Activity indicator
        if working is True:
            indicator = "[green]\u25cf[/green]"
        elif working is False:
            indicator = "[dim]\u25cb[/dim]"
        else:
            indicator = ""

        parts = [f"[{color_name}]{badge}[/{color_name}]"]
        if indicator:
            parts.append(indicator)
        parts.append(safe_name)

        if agent_type and agent_type not in ("general-purpose", "teammate"):
            parts.append(f"[dim]({agent_type})[/dim]")
        if unread:
            parts.append(f"[bold yellow]({unread})[/bold yellow]")
        if task_id:
            parts.append(f"[dim]#{task_id}[/dim]")
        if tool:
            safe_tool = tool.replace("[", "\\[")
            parts.append(f"[dim]\\[{safe_tool}][/dim]")
        return " ".join(parts)
