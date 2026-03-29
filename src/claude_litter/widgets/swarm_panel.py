"""SwarmPanel widget — slide-out swarm-loop status panel."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any

from rich.markup import escape as rich_escape
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, VerticalScroll
from textual.message import Message
from textual.widget import Widget
from textual.widgets import Button, Markdown, Static, TabbedContent, TabPane

if TYPE_CHECKING:
    from claude_litter.models.swarm import SwarmState

_LOG_LINE_CAP = 500


class SwarmPanel(Widget):
    """Slide-out swarm-loop status panel."""

    BINDINGS = [
        Binding("left", "prev_instance", "Prev", show=False),
        Binding("right", "next_instance", "Next", show=False),
        Binding("r", "refresh_swarm", "Refresh", show=False),
    ]

    DEFAULT_CSS = """
    SwarmPanel {
        width: 40%;
        height: 100%;
        offset-x: 100%;
        transition: offset 300ms;
        background: $surface;
        border-left: solid $primary;
        layer: overlay;
        dock: right;
    }
    SwarmPanel.-visible {
        offset-x: 0;
    }
    SwarmPanel .swarm-panel-title {
        background: $primary;
        color: $text;
        text-align: center;
        height: 2;
        padding: 0 1;
    }
    SwarmPanel .swarm-row {
        height: auto;
        padding: 0 1;
        margin: 0;
    }
    SwarmPanel .swarm-empty {
        height: auto;
        padding: 1 2;
        color: $text-muted;
        text-align: center;
    }
    SwarmPanel #swarm-tabs {
        height: 1fr;
    }
    SwarmPanel .swarm-scroll {
        height: 1fr;
    }
    SwarmPanel .swarm-log-line {
        height: auto;
        padding: 0 1;
    }
    SwarmPanel #log-markdown {
        padding: 0 1;
        height: auto;
    }
    SwarmPanel .swarm-progress-line {
        height: auto;
        padding: 0 1;
    }
    SwarmPanel #swarm-instance-bar {
        height: auto;
        display: none;
        padding: 0 1;
    }
    SwarmPanel #swarm-instance-bar.-multi {
        display: block;
    }
    SwarmPanel #swarm-instance-bar Button {
        min-width: 12;
        margin: 0 1 0 0;
    }
    """

    # ------------------------------------------------------------------
    # Messages
    # ------------------------------------------------------------------

    class RefreshRequested(Message):
        """Fired when user presses 'r' inside the swarm panel."""

    class DataLoadRequested(Message):
        """Request the parent screen to load log/progress data off-thread."""

        def __init__(self, instance_id: str, instance_dir: Path) -> None:
            super().__init__()
            self.instance_id = instance_id
            self.instance_dir = instance_dir

    class LogDataReady(Message):
        """Carries pre-read log and progress data back from the worker."""

        def __init__(
            self,
            instance_id: str,
            log_lines: list[str],
            progress_entries: list[dict[str, Any]],
            log_truncated: bool,
        ) -> None:
            super().__init__()
            self.instance_id = instance_id
            self.log_lines = log_lines
            self.progress_entries = progress_entries
            self.log_truncated = log_truncated

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._instances: list = []
        self._selected_idx: int = 0
        self._visible: bool = False
        # Incremental log tracking
        self._last_log_instance_id: str = ""
        self._last_log_line_count: int = 0

    def compose(self) -> ComposeResult:
        yield Static("Swarm Loop", classes="swarm-panel-title", id="swarm-title")
        yield Horizontal(id="swarm-instance-bar")
        yield Static("No swarm loop active", id="swarm-empty", classes="swarm-empty")
        with TabbedContent(id="swarm-tabs"):
            with TabPane("Status", id="tab-status"):
                with VerticalScroll(classes="swarm-scroll", id="status-scroll"):
                    yield Static("", id="swarm-status-overview", classes="swarm-row")
                    yield Static("", id="swarm-progress", classes="swarm-row")
                    yield Static("", id="swarm-goal", classes="swarm-row")
                    yield Static("", id="swarm-meta", classes="swarm-row")
                    yield Static("", id="swarm-heartbeat", classes="swarm-row")
                    yield Static("", id="swarm-warnings", classes="swarm-row")
                    yield Static("", id="swarm-profile-extras", classes="swarm-row")
            with TabPane("Log", id="tab-log"):
                with VerticalScroll(classes="swarm-scroll", id="log-scroll"):
                    yield Markdown("", id="log-markdown")
            with TabPane("Progress", id="tab-progress"):
                yield VerticalScroll(classes="swarm-scroll", id="progress-scroll")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def toggle(self) -> None:
        """Show or hide the panel."""
        self._visible = not self._visible
        self.toggle_class("-visible")

    def update_instances(self, instances: list) -> None:
        """Refresh the panel with new swarm instance data."""
        self._instances = instances
        self._refresh_display()

    # ------------------------------------------------------------------
    # Display refresh
    # ------------------------------------------------------------------

    def _refresh_display(self) -> None:
        if not self._instances:
            self._show_empty()
            return
        self._hide_empty()
        self._selected_idx = min(self._selected_idx, len(self._instances) - 1)
        state = self._instances[self._selected_idx]
        self._update_instance_bar()
        self._render_state(state)

    def _show_empty(self) -> None:
        try:
            self.query_one("#swarm-empty", Static).display = True
            self.query_one("#swarm-tabs").display = False
            for wid in (
                "swarm-status-overview",
                "swarm-progress",
                "swarm-goal",
                "swarm-meta",
                "swarm-heartbeat",
                "swarm-warnings",
                "swarm-profile-extras",
            ):
                self.query_one(f"#{wid}", Static).update("")
            self.query_one("#log-markdown", Markdown).update("")
            self.query_one("#progress-scroll", VerticalScroll).remove_children()
            self._last_log_instance_id = ""
            self._last_log_line_count = 0
        except Exception:
            pass

    def _hide_empty(self) -> None:
        try:
            self.query_one("#swarm-empty", Static).display = False
            self.query_one("#swarm-tabs").display = True
        except Exception:
            pass

    # ------------------------------------------------------------------
    # State rendering
    # ------------------------------------------------------------------

    def _render_state(self, state: SwarmState) -> None:
        from claude_litter.models.swarm import DefunctSwarmInstance

        is_defunct = isinstance(state, DefunctSwarmInstance)

        if is_defunct:
            self._render_defunct_state(state)
        else:
            self._render_active_state(state)

        # Request async file data load for log/progress tabs
        instance_dir = getattr(state, "instance_dir", None)
        instance_id = getattr(state, "instance_id", "")
        if instance_dir is not None:
            self.post_message(self.DataLoadRequested(instance_id, instance_dir))

    def _render_defunct_state(self, state: SwarmState) -> None:
        overview = "[dim]Run completed / no active state[/dim]  [italic]Read-only[/italic]"
        self._safe_update("#swarm-status-overview", overview)
        self._safe_update("#swarm-progress", "")

        goal = getattr(state, "goal", "") or ""
        goal_display = rich_escape(goal)
        self._safe_update("#swarm-goal", f"[bold]Goal:[/bold] {goal_display}" if goal else "")

        iid = getattr(state, "instance_id", "")
        self._safe_update("#swarm-meta", f"[dim]Instance: {iid}[/dim]")
        self._safe_update("#swarm-heartbeat", "")
        self._safe_update("#swarm-warnings", "")
        self._safe_update("#swarm-profile-extras", "")

    def _render_active_state(self, state: SwarmState) -> None:
        health = getattr(state, "autonomy_health", "unknown")
        health_color = {"healthy": "green", "degraded": "yellow", "critical": "red"}.get(health, "dim")

        has_sentinel = getattr(state, "has_sentinel", False)
        sentinel_ind = " [cyan]\\[→next][/cyan]" if has_sentinel else ""

        overview = (
            f"Iter [bold]{state.iteration}[/bold]"
            f"  Phase: [cyan]{state.phase}[/cyan]"
            f"  Health: [{health_color}]{health}[/{health_color}]"
            f"{sentinel_ind}"
        )
        self._safe_update("#swarm-status-overview", overview)

        # Progress bar
        hb = getattr(state, "heartbeat", None)
        if hb and hb.tasks_total > 0:
            total = hb.tasks_total
            done = hb.tasks_completed
            bar_width = 30
            filled = int(bar_width * done / total)
            bar = "\u2588" * filled + "\u2591" * (bar_width - filled)
            progress_text = f"Tasks \\[{bar}] {done}/{total}"
        elif hb:
            progress_text = f"Tasks: {hb.tasks_completed}/{hb.tasks_total}"
        else:
            progress_text = "Tasks: [dim]no heartbeat[/dim]"
        self._safe_update("#swarm-progress", progress_text)

        # Goal
        goal = getattr(state, "goal", "") or ""
        goal_display = rich_escape(goal)
        self._safe_update("#swarm-goal", f"[bold]Goal:[/bold] {goal_display}")

        # Meta
        mode = getattr(state, "mode", "")
        team = getattr(state, "team_name", "")
        safe = getattr(state, "safe_mode", True)
        started = getattr(state, "started_at", "")
        meta = f"Mode: {mode}  Team: {team}  Safe: {safe}"
        if started:
            meta += f"  Started: {started[:19]}"
        self._safe_update("#swarm-meta", meta)

        # Heartbeat
        if hb:
            hb_text = f"Last tool: {hb.last_tool or '\u2014'}  Active: {hb.team_active}"
        else:
            hb_text = "[dim]No heartbeat data[/dim]"
        self._safe_update("#swarm-heartbeat", hb_text)

        # Warnings
        pf = getattr(state, "permission_failures", ())
        hw = getattr(state, "hook_warnings", ())
        warnings = []
        if pf:
            warnings.append(f"[red]{len(pf)} perm failure{'s' if len(pf) != 1 else ''}[/red]")
        if hw:
            warnings.append(f"[yellow]{len(hw)} hook warning{'s' if len(hw) != 1 else ''}[/yellow]")
        self._safe_update("#swarm-warnings", "  ".join(warnings) if warnings else "")

        # Profile-specific extras
        extras = []
        if state.mode == "deepplan":
            findings = getattr(state, "deepplan_findings_complete", None)
            if findings:
                extras.append("[bold]Findings:[/bold]")
                for k, v in findings.items():
                    icon = "[green]\u2713[/green]" if v else "[yellow]\u25cb[/yellow]"
                    extras.append(f"  {icon} {k}")
            if getattr(state, "deepplan_has_draft", False):
                extras.append("[green]Draft ready[/green]")
        elif state.mode == "async":
            agents = getattr(state, "async_agents", ())
            completed = getattr(state, "async_agents_completed", 0)
            if agents:
                extras.append(f"[bold]Background agents:[/bold] {', '.join(agents)}")
                extras.append(f"[bold]Agents:[/bold] {completed}/{len(agents)} completed")
        self._safe_update("#swarm-profile-extras", "\n".join(extras))

    # ------------------------------------------------------------------
    # Async log/progress data handler
    # ------------------------------------------------------------------

    def on_swarm_panel_log_data_ready(self, event: LogDataReady) -> None:
        """Apply pre-read log/progress data from the worker."""
        # Guard: only apply if this is still the selected instance
        current_id = ""
        if self._instances and self._selected_idx < len(self._instances):
            current_id = getattr(self._instances[self._selected_idx], "instance_id", "")
        if current_id != event.instance_id:
            return
        self._apply_log_lines(event.instance_id, event.log_lines, event.log_truncated)
        self._apply_progress_entries(event.progress_entries)

    def _apply_log_lines(self, instance_id: str, lines: list[str], truncated: bool) -> None:
        try:
            scroll = self.query_one("#log-scroll", VerticalScroll)
            md_widget = self.query_one("#log-markdown", Markdown)
        except Exception:
            return

        instance_changed = instance_id != self._last_log_instance_id
        if instance_changed:
            self._last_log_line_count = 0
            self._last_log_instance_id = instance_id

        if not lines:
            if instance_changed:
                md_widget.update("*Log is empty*")
            return

        # Skip update if no new lines
        if len(lines) == self._last_log_line_count:
            return

        content = "\n".join(lines)
        if truncated:
            content = f"*(showing last {_LOG_LINE_CAP} lines)*\n\n{content}"

        md_widget.update(content)
        self._last_log_line_count = len(lines)
        scroll.scroll_end(animate=False)

    def _apply_progress_entries(self, entries: list[dict[str, Any]]) -> None:
        try:
            scroll = self.query_one("#progress-scroll", VerticalScroll)
        except Exception:
            return
        # Progress entries are small; full remount is fine
        scroll.remove_children()
        if not entries:
            scroll.mount(Static("[dim]No progress entries[/dim]", classes="swarm-progress-line"))
            return
        widgets = []
        for entry in entries:
            ts = str(entry.get("ts", ""))
            if "T" in ts:
                ts_display = ts.split("T", 1)[1][:8]
            else:
                ts_display = ts[:8]
            teammate = rich_escape(str(entry.get("teammate", "")))
            task = rich_escape(str(entry.get("task", "")))
            done = int(entry.get("tasks_completed", 0))
            total = int(entry.get("tasks_total", 0))
            if total > 0:
                bar_width = 8
                filled = int(bar_width * done / total)
                bar = "\u2588" * filled + "\u2591" * (bar_width - filled)
                count = f" {done}/{total}"
            else:
                bar = "\u2591" * 8
                count = ""
            line = f"[dim]{ts_display}[/dim] [cyan]{teammate}[/cyan]: {task} [{bar}]{count}"
            widgets.append(Static(line, classes="swarm-progress-line"))
        scroll.mount(*widgets)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _safe_update(self, selector: str, text: str) -> None:
        try:
            self.query_one(selector, Static).update(text)
        except Exception:
            pass

    def _update_instance_bar(self) -> None:
        try:
            bar = self.query_one("#swarm-instance-bar", Horizontal)
            bar.remove_children()
            if len(self._instances) <= 1:
                bar.remove_class("-multi")
                return
            bar.add_class("-multi")
            for i, inst in enumerate(self._instances):
                iid = getattr(inst, "instance_id", "????")
                variant = "primary" if i == self._selected_idx else "default"
                bar.mount(Button(iid[:8], id=f"swarm-inst-{iid}", variant=variant))
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Button / key handlers
    # ------------------------------------------------------------------

    def on_button_pressed(self, event: Button.Pressed) -> None:
        bid = event.button.id or ""
        if bid.startswith("swarm-inst-"):
            iid = bid[len("swarm-inst-") :]
            for i, inst in enumerate(self._instances):
                if inst.instance_id == iid:
                    self._selected_idx = i
                    break
            self._refresh_display()

    def action_prev_instance(self) -> None:
        if self._instances:
            self._selected_idx = (self._selected_idx - 1) % len(self._instances)
            self._refresh_display()

    def action_next_instance(self) -> None:
        if self._instances:
            self._selected_idx = (self._selected_idx + 1) % len(self._instances)
            self._refresh_display()

    def action_refresh_swarm(self) -> None:
        self.post_message(self.RefreshRequested())
