"""StatusBar widget — single-line status display at the bottom of the screen."""

from __future__ import annotations

from textual.app import ComposeResult
from textual.widget import Widget
from textual.widgets import Static


class StatusBar(Widget):
    """Single-line status bar showing team/agent/task info and current mode."""

    DEFAULT_CSS = """
    StatusBar {
        height: 1;
        dock: bottom;
        background: $panel;
        color: $text-muted;
    }
    StatusBar Static {
        width: 100%;
        height: 1;
    }
    """

    # ------------------------------------------------------------------ #
    # Composition
    # ------------------------------------------------------------------ #

    def compose(self) -> ComposeResult:
        yield Static("", id="status-text")

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #

    def update_status(
        self,
        team_name: str,
        agent_count: int,
        active_count: int,
        task_total: int,
        task_done: int,
        vim_mode: bool = False,
    ) -> None:
        """Refresh the status bar text.

        Args:
            team_name:    Current team name (empty string = no team).
            agent_count:  Total number of agents in the team.
            active_count: Number of currently active agents.
            task_total:   Total tasks (all statuses).
            task_done:    Completed tasks.
            vim_mode:     True -> shows "VIM", False -> shows "STD".
        """
        mode = "VIM" if vim_mode else "STD"

        team_part = team_name if team_name else "\u2014"
        agents_part = f"{active_count}/{agent_count}"
        tasks_part = f"{task_done}/{task_total}"

        text = (
            f" Team: {team_part}"
            f"  Agents: {agents_part}"
            f"  Tasks: {tasks_part}"
            f"  [{mode}]"
        )
        self.query_one("#status-text", Static).update(text)
