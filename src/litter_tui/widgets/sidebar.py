"""TeamSidebar widget — displays teams and agents in a collapsible tree."""

from __future__ import annotations

from textual.app import ComposeResult
from textual.message import Message
from textual.widget import Widget
from textual.widgets import Tree
from textual.widgets.tree import TreeNode


_MODEL_BADGE = {
    "haiku": "H",
    "sonnet": "S",
    "opus": "O",
}

_STATUS_COLOR = {
    "active": "green",
    "partial": "yellow",
    "inactive": "gray",
}


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

    class TeamSelected(Message):
        """Emitted when a team root node is clicked."""

        def __init__(self, team: str) -> None:
            super().__init__()
            self.team = team

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._team_nodes: dict[str, TreeNode] = {}
        self._agent_nodes: dict[tuple[str, str], TreeNode] = {}
        self._agent_data: dict[tuple[str, str], dict] = {}

    def compose(self) -> ComposeResult:
        tree: Tree[dict] = Tree("Teams", id="sidebar-tree")
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

        for team in teams:
            team_name = team["name"]
            status = team.get("status", "inactive")
            color = _STATUS_COLOR.get(status, "gray")
            label = f"[@{color}]\u25cf[/@{color}] {team_name}"
            team_node: TreeNode[dict] = tree.root.add(
                label, data={"type": "team", "team": team_name}, expand=True
            )
            self._team_nodes[team_name] = team_node

            for agent in team.get("agents", []):
                agent_name = agent["name"]
                self._agent_data[(team_name, agent_name)] = agent
                agent_node = team_node.add_leaf(
                    self._agent_label(agent),
                    data={"type": "agent", "team": team_name, "agent": agent_name},
                )
                self._agent_nodes[(team_name, agent_name)] = agent_node

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
        if node_data.get("type") == "team":
            self.post_message(self.TeamSelected(team=node_data["team"]))
        elif node_data.get("type") == "agent":
            self.post_message(
                self.AgentSelected(team=node_data["team"], agent=node_data["agent"])
            )

    @staticmethod
    def _agent_label(agent: dict) -> str:
        model_key = agent.get("model", "sonnet").lower()
        badge = _MODEL_BADGE.get(model_key, "?")
        unread = agent.get("unread", 0)
        task_id = agent.get("task_id")

        parts = [f"[dim]{badge}[/dim]", agent.get("name", "?")]
        if unread:
            parts.append(f"[bold yellow]({unread})[/bold yellow]")
        if task_id:
            parts.append(f"[dim]#{task_id}[/dim]")
        return " ".join(parts)
