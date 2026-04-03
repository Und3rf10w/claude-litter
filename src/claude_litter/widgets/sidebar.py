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

    class SwarmSelected(Message):
        """Emitted when a swarm instance node is clicked."""

        def __init__(self, instance_id: str) -> None:
            super().__init__()
            self.instance_id = instance_id

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._team_nodes: dict[str, TreeNode] = {}
        self._agent_nodes: dict[tuple[str, str], TreeNode] = {}
        self._agent_data: dict[tuple[str, str], dict] = {}
        self._swarm_nodes: dict[str, TreeNode] = {}
        self._swarm_fallback_node: TreeNode | None = None

    def compose(self) -> ComposeResult:
        tree: _SidebarTree = _SidebarTree("Teams", id="sidebar-tree")
        tree.root.expand()
        yield tree

    def update_teams(self, teams: list[dict]) -> None:
        """Update the tree from a list of team dicts, diffing to avoid flicker."""
        tree = self.query_one(Tree)

        # Build the incoming structure for comparison
        incoming_teams: list[str] = []
        incoming_agents: dict[str, list[str]] = {}
        incoming_data: dict[str, dict] = {}
        incoming_agent_data: dict[tuple[str, str], dict] = {}
        for team in teams:
            dir_name = team.get("dir_name", team["name"])
            incoming_teams.append(dir_name)
            incoming_data[dir_name] = team
            incoming_agents[dir_name] = [a["name"] for a in team.get("agents", [])]
            for agent in team.get("agents", []):
                incoming_agent_data[(dir_name, agent["name"])] = agent

        existing_teams = list(self._team_nodes.keys())

        # Check if the structural set of teams/agents changed
        structure_changed = existing_teams != incoming_teams
        if not structure_changed:
            for dir_name in incoming_teams:
                existing = [name for (t, name) in self._agent_nodes if t == dir_name]
                if existing != incoming_agents.get(dir_name, []):
                    structure_changed = True
                    break

        if structure_changed or not self._team_nodes:
            # Full rebuild needed — structure differs
            tree.clear()
            tree.root.expand()
            self._team_nodes.clear()
            self._agent_nodes.clear()
            self._agent_data.clear()
            self._swarm_nodes.clear()
            self._swarm_fallback_node = None

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
                team_node: TreeNode[dict] = tree.root.add(label, data={"type": "team", "team": dir_name}, expand=True)
                self._team_nodes[dir_name] = team_node

                for agent in team.get("agents", []):
                    agent_name = agent["name"]
                    self._agent_data[(dir_name, agent_name)] = agent
                    agent_node = team_node.add_leaf(
                        self._agent_label(agent),
                        data={"type": "agent", "team": dir_name, "agent": agent_name},
                    )
                    self._agent_nodes[(dir_name, agent_name)] = agent_node
        else:
            # Structure is the same — update labels in place
            for dir_name, team in incoming_data.items():
                team_name = team["name"]
                status = team.get("status", "inactive")
                color = _STATUS_COLOR.get(status, "gray")
                new_label = f"[@{color}]\u25cf[/@{color}] {team_name.replace('[', '\\[')}"
                team_node = self._team_nodes.get(dir_name)
                if team_node is not None:
                    team_node.set_label(new_label)

                for agent in team.get("agents", []):
                    agent_name = agent["name"]
                    key = (dir_name, agent_name)
                    old = self._agent_data.get(key)
                    self._agent_data[key] = agent
                    new_label = self._agent_label(agent)
                    node = self._agent_nodes.get(key)
                    if node is not None and (old is None or self._agent_label(old) != new_label):
                        node.set_label(new_label)

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

    def update_unread(self, team: str, agent: str, unread: int) -> None:
        """Update just the unread badge for a single agent without rebuilding."""
        key = (team, agent)
        if key in self._agent_data:
            old_unread = self._agent_data[key].get("unread", 0)
            if old_unread == unread:
                return
            self._agent_data[key]["unread"] = unread
            node = self._agent_nodes.get(key)
            if node is not None:
                node.set_label(self._agent_label(self._agent_data[key]))

    def update_swarm_instances(self, instances: list) -> None:
        """Update the swarm instances section, nesting under parent teams."""
        try:
            tree = self.query_one(Tree)
        except Exception:
            return
        # Remove old swarm sections
        for node in self._swarm_nodes.values():
            try:
                node.remove()
            except Exception:
                pass
        self._swarm_nodes.clear()
        if self._swarm_fallback_node is not None:
            try:
                self._swarm_fallback_node.remove()
            except Exception:
                pass
            self._swarm_fallback_node = None
        if not instances:
            return
        # Group instances by team_name
        from collections import defaultdict

        by_team: dict[str, list] = defaultdict(list)
        orphans: list = []
        for state in instances:
            team_name = getattr(state, "team_name", "") or ""
            if team_name and team_name in self._team_nodes:
                by_team[team_name].append(state)
            else:
                orphans.append(state)
        # Add swarm section under each team
        for team_name, team_instances in by_team.items():
            team_node = self._team_nodes[team_name]
            swarm_branch = team_node.add(
                "[bold magenta]\u25c6 Swarm[/bold magenta]",
                data={"type": "swarm_root"},
                expand=True,
            )
            self._swarm_nodes[team_name] = swarm_branch
            for state in team_instances:
                swarm_branch.add_leaf(
                    self._swarm_instance_label(state),
                    data={"type": "swarm_instance", "instance_id": getattr(state, "instance_id", "????")},
                )
        # Fallback for orphans (no matching team)
        if orphans:
            self._swarm_fallback_node = tree.root.add(
                "[bold magenta]\u25c6 Swarm Loop[/bold magenta]",
                data={"type": "swarm_root"},
                expand=True,
            )
            for state in orphans:
                self._swarm_fallback_node.add_leaf(
                    self._swarm_instance_label(state),
                    data={"type": "swarm_instance", "instance_id": getattr(state, "instance_id", "????")},
                )

    @staticmethod
    def _swarm_instance_label(state) -> str:
        """Build a Rich label for a swarm instance leaf node."""
        health = getattr(state, "autonomy_health", "unknown")
        health_color = {"healthy": "green", "degraded": "yellow", "critical": "red"}.get(health, "dim")
        hb = getattr(state, "heartbeat", None)
        pct = ""
        if hb and getattr(hb, "tasks_total", 0):
            pct = f" \\[{hb.tasks_completed}/{hb.tasks_total}]"
        iid = getattr(state, "instance_id", "????")
        phase = getattr(state, "phase", "?")
        iteration = getattr(state, "iteration", 0)
        return f"[{health_color}]\u25cf[/{health_color}] [dim]{iid}[/dim] iter {iteration} {phase}{pct}"

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
            self.post_message(self.AgentSelected(team=node_data["team"], agent=node_data["agent"]))
        elif node_data.get("type") == "swarm_instance":
            self.post_message(self.SwarmSelected(instance_id=node_data["instance_id"]))

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
