from __future__ import annotations

import datetime
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class SwarmProgressEntry:
    task_id: str
    task: str
    teammate: str
    tasks_completed: int
    tasks_total: int
    ts: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SwarmProgressEntry:
        return cls(
            task_id=str(data.get("task_id", "")),
            task=str(data.get("task", "")),
            teammate=str(data.get("teammate", "")),
            tasks_completed=int(data.get("tasks_completed", 0)),
            tasks_total=int(data.get("tasks_total", 0)),
            ts=str(data.get("ts", "")),
        )


@dataclass(frozen=True)
class SwarmHeartbeat:
    iteration: int
    phase: str
    tasks_completed: int
    tasks_total: int
    last_tool: str
    team_active: bool
    autonomy_health: str
    timestamp: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SwarmHeartbeat:
        return cls(
            iteration=int(data.get("iteration", 0)),
            phase=str(data.get("phase", "")),
            tasks_completed=int(data.get("tasks_completed", 0)),
            tasks_total=int(data.get("tasks_total", 0)),
            last_tool=str(data.get("last_tool", "")),
            team_active=bool(data.get("team_active", True)),
            autonomy_health=str(data.get("autonomy_health", "healthy")),
            timestamp=str(data.get("timestamp", "")),
        )


@dataclass(frozen=True)
class SwarmState:
    instance_id: str
    instance_dir: Path = field(hash=False, compare=False)
    iteration: int
    phase: str
    goal: str
    mode: str
    autonomy_health: str
    completion_promise: str
    team_name: str
    safe_mode: bool
    started_at: str
    last_updated: str
    permission_failures: tuple[str, ...]
    hook_warnings: tuple[str, ...]
    sentinel_timeout: int
    teammates_isolation: str
    teammates_max_count: int
    has_sentinel: bool
    # deepplan extras
    deepplan_findings_complete: dict[str, bool] | None = field(default=None, hash=False, compare=False)
    deepplan_has_draft: bool = False
    # async extras
    async_agents: tuple[str, ...] = ()
    async_agents_completed: int = 0
    # live data
    heartbeat: SwarmHeartbeat | None = None

    @classmethod
    def from_files(cls, instance_dir: Path) -> SwarmState | None:
        """Read all files for an instance. Returns None if state.json is absent/corrupt."""
        state_path = instance_dir / "state.json"
        try:
            raw = json.loads(state_path.read_text(encoding="utf-8"))
        except Exception:
            return None

        if not isinstance(raw, dict):
            return None

        # Read heartbeat
        heartbeat = None
        hb_path = instance_dir / "heartbeat.json"
        try:
            hb_raw = json.loads(hb_path.read_text(encoding="utf-8"))
            if isinstance(hb_raw, dict):
                heartbeat = SwarmHeartbeat.from_dict(hb_raw)
        except Exception:
            pass

        # Check sentinel
        has_sentinel = (instance_dir / "next-iteration").exists()

        # deepplan extras
        findings = raw.get("findings_complete")
        has_draft = bool(raw.get("has_draft", False))

        # async extras
        bg_agents = raw.get("background_agents", [])
        async_agent_names = tuple(str(a.get("id", "")) for a in bg_agents if isinstance(a, dict))
        async_completed = int(raw.get("agents_completed", 0))

        # permission failures as strings
        pf = raw.get("permission_failures", [])
        pf_strs = tuple(str(p) if isinstance(p, str) else json.dumps(p) for p in pf)

        # hook warnings
        hw = raw.get("hook_warnings", [])
        hw_strs = tuple(str(w) if isinstance(w, str) else json.dumps(w) for w in hw)

        return cls(
            instance_id=str(raw.get("instance_id", instance_dir.name)),
            instance_dir=instance_dir,
            iteration=int(raw.get("iteration", 0)),
            phase=str(raw.get("phase", "")),
            goal=str(raw.get("goal", "")),
            mode=str(raw.get("mode", "")),
            autonomy_health=str(raw.get("autonomy_health", "healthy")),
            completion_promise=str(raw.get("completion_promise", "")),
            team_name=str(raw.get("team_name", "")),
            safe_mode=bool(raw.get("safe_mode", True)),
            started_at=str(raw.get("started_at", "")),
            last_updated=str(raw.get("last_updated", "")),
            permission_failures=pf_strs,
            hook_warnings=hw_strs,
            sentinel_timeout=int(raw.get("sentinel_timeout", 600)),
            teammates_isolation=str(raw.get("teammates_isolation", "shared")),
            teammates_max_count=int(raw.get("teammates_max_count", 8)),
            has_sentinel=has_sentinel,
            deepplan_findings_complete=findings if isinstance(findings, dict) else None,
            deepplan_has_draft=has_draft,
            async_agents=async_agent_names,
            async_agents_completed=async_completed,
            heartbeat=heartbeat,
        )

    @property
    def progress_pct(self) -> float:
        if self.heartbeat and self.heartbeat.tasks_total > 0:
            return self.heartbeat.tasks_completed / self.heartbeat.tasks_total
        return 0.0


@dataclass(frozen=True)
class DefunctSwarmInstance:
    """A swarm run whose state.json was deleted but artefacts (log.md) remain."""

    instance_id: str
    instance_dir: Path = field(hash=False, compare=False)
    last_updated: str
    goal: str = ""
    # Defaults matching SwarmState fields accessed by the panel via getattr
    phase: str = "completed"
    iteration: int = 0
    mode: str = ""
    autonomy_health: str = "defunct"
    completion_promise: str = ""
    team_name: str = ""
    safe_mode: bool = False
    started_at: str = ""
    sentinel_timeout: int = 600
    teammates_isolation: str = "shared"
    teammates_max_count: int = 8
    has_sentinel: bool = False
    permission_failures: tuple[str, ...] = ()
    hook_warnings: tuple[str, ...] = ()
    heartbeat: SwarmHeartbeat | None = None
    # deepplan / async
    deepplan_findings_complete: dict[str, bool] | None = field(default=None, hash=False, compare=False)
    deepplan_has_draft: bool = False
    async_agents: tuple[str, ...] = ()
    async_agents_completed: int = 0

    @classmethod
    def from_dir(cls, instance_dir: Path) -> DefunctSwarmInstance | None:
        """Build from a directory that has no state.json but has log.md."""
        log_path = instance_dir / "log.md"
        if not log_path.exists():
            return None
        goal = ""
        prompt_path = instance_dir / "prompt.md"
        try:
            goal = prompt_path.read_text(encoding="utf-8").strip()[:200]
        except Exception:
            pass
        try:
            mtime = log_path.stat().st_mtime
            last_updated = datetime.datetime.fromtimestamp(mtime, tz=datetime.UTC).isoformat(timespec="seconds")
        except Exception:
            last_updated = ""
        return cls(
            instance_id=instance_dir.name,
            instance_dir=instance_dir,
            last_updated=last_updated,
            goal=goal,
        )

    @property
    def progress_pct(self) -> float:
        return 0.0
