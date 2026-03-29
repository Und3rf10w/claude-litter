"""StateManager: watches ~/.claude/ for changes and reads teams/tasks/messages."""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import TYPE_CHECKING

import anyio
import anyio.abc

from claude_litter.models.message import Message
from claude_litter.models.task import Task
from claude_litter.models.team import Team
from claude_litter.utils import safe_path

try:
    from textual.message import Message as TextualMessage
except ImportError:  # allow use without textual installed in tests
    class TextualMessage:  # type: ignore[no-redef]
        pass

logger = logging.getLogger(__name__)

_DEFAULT_BASE = Path.home() / ".claude"
_DEBOUNCE_SECONDS = 0.1


# ---------------------------------------------------------------------------
# Textual messages
# ---------------------------------------------------------------------------

class TeamUpdated(TextualMessage):
    """Posted when a team config changes."""

    def __init__(self, team_name: str) -> None:
        super().__init__()
        self.team_name = team_name


class TaskUpdated(TextualMessage):
    """Posted when a task file changes."""

    def __init__(self, team_name: str, task_id: str) -> None:
        super().__init__()
        self.team_name = team_name
        self.task_id = task_id


class InboxUpdated(TextualMessage):
    """Posted when an agent inbox changes."""

    def __init__(self, team_name: str, agent_name: str) -> None:
        super().__init__()
        self.team_name = team_name
        self.agent_name = agent_name


class TranscriptActivity(TextualMessage):
    """Posted when a JSONL transcript changes, indicating agent activity."""

    def __init__(self, team_name: str, agent_name: str, tool_name: str, is_idle: bool) -> None:
        super().__init__()
        self.team_name = team_name
        self.agent_name = agent_name
        self.tool_name = tool_name
        self.is_idle = is_idle


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read_json(path: Path) -> dict | list | None:
    """Read JSON file, returning None on any error."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _read_last_entry(path: Path) -> tuple[str, bool]:
    """Read the last JSONL line to extract current tool and idle state.

    Returns ``(tool_name, is_idle)``.  *tool_name* is ``""`` when the agent
    is idle or thinking (no specific tool in progress).
    """
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            if size == 0:
                return "", True
            chunk = min(8192, size)
            f.seek(-chunk, 2)
            data = f.read().decode("utf-8", errors="ignore")
        lines = [ln for ln in data.splitlines() if ln.strip()]
        if not lines:
            return "", True
        entry = json.loads(lines[-1])
    except Exception:
        return "", False  # can't read → assume working (conservative)

    entry_type = entry.get("type")
    msg = entry.get("message", {})

    if entry_type == "system":
        if entry.get("subtype") == "turn_duration":
            return "", True

    if entry_type == "assistant":
        stop = msg.get("stop_reason")
        if stop == "end_turn":
            return "", True
        content = msg.get("content", [])
        if isinstance(content, list):
            for blk in reversed(content):
                if isinstance(blk, dict) and blk.get("type") == "tool_use":
                    return blk.get("name", ""), False
        return "", False  # thinking/streaming

    if entry_type == "user":
        content = msg.get("content")
        if isinstance(content, list):
            for blk in content:
                if isinstance(blk, dict) and blk.get("type") == "tool_result":
                    return "", False
        return "", False

    return "", False


def _parse_change_path(
    changed: Path, teams_dir: Path, tasks_dir: Path
) -> TeamUpdated | TaskUpdated | InboxUpdated | None:
    """Map a filesystem path to the appropriate Textual message, or None."""
    try:
        rel_teams = changed.relative_to(teams_dir)
    except ValueError:
        rel_teams = None

    try:
        rel_tasks = changed.relative_to(tasks_dir)
    except ValueError:
        rel_tasks = None

    if rel_teams is not None:
        parts = rel_teams.parts
        if len(parts) >= 1:
            team_name = parts[0]
            if len(parts) == 1:
                return TeamUpdated(team_name)
            if len(parts) == 2 and parts[1] == "config.json":
                return TeamUpdated(team_name)
            if len(parts) == 3 and parts[1] == "inboxes":
                agent_name = Path(parts[2]).stem
                return InboxUpdated(team_name, agent_name)
        return None

    if rel_tasks is not None:
        parts = rel_tasks.parts
        if len(parts) == 2:
            team_name = parts[0]
            filename = parts[1]
            if filename.startswith("."):
                return None
            task_id = Path(filename).stem
            return TaskUpdated(team_name, task_id)
        return None

    return None


# ---------------------------------------------------------------------------
# StateManager
# ---------------------------------------------------------------------------

class StateManager:
    """Reads swarm state from ~/.claude/ and posts Textual messages on changes."""

    def __init__(self, base_path: Path | None = None) -> None:
        self._base = base_path or _DEFAULT_BASE
        self._teams_dir = self._base / "teams"
        self._tasks_dir = self._base / "tasks"
        self._projects_dir = self._base / "projects"
        self._task_group: anyio.abc.TaskGroup | None = None
        self._cancel_scope: anyio.CancelScope | None = None
        self._app: object | None = None  # Textual App reference for posting
        self._transcript_index: dict[str, tuple[str, str]] = {}

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def set_app(self, app: object) -> None:
        """Provide a Textual App so messages can be posted."""
        self._app = app

    async def start(self) -> None:
        """Start the background file-watcher task."""
        if self._cancel_scope is not None:
            return  # already running

        # Use a cancel scope we own so stop() can kill the watcher.
        cancel_scope = anyio.CancelScope()
        self._cancel_scope = cancel_scope

        async def _runner() -> None:
            with cancel_scope:
                async with anyio.create_task_group() as tg:
                    self._task_group = tg
                    tg.start_soon(self._watch_loop)

        # Fire and forget — run in background
        asyncio.get_running_loop().create_task(_runner())

    async def stop(self) -> None:
        """Cancel the background watcher."""
        if self._cancel_scope is not None:
            self._cancel_scope.cancel()
            self._cancel_scope = None
            self._task_group = None

    async def restart(self) -> None:
        """Stop and re-start the watcher (picks up new transcript paths)."""
        await self.stop()
        # Brief yield so the cancelled task can clean up
        await anyio.sleep(0)
        await self.start()

    # ------------------------------------------------------------------
    # Getters
    # ------------------------------------------------------------------

    def get_teams(self) -> list[Team]:
        if not self._teams_dir.is_dir():
            return []
        teams: list[Team] = []
        for team_dir in sorted(self._teams_dir.iterdir()):
            if not team_dir.is_dir():
                continue
            config = _read_json(team_dir / "config.json")
            if isinstance(config, dict):
                try:
                    teams.append(Team.from_dict(config))
                except Exception:
                    logger.debug("Corrupt team config: %s", team_dir)
        return teams

    def get_team(self, name: str) -> Team | None:
        try:
            config_path = safe_path(self._teams_dir, name, "config.json")
        except ValueError:
            return None
        data = _read_json(config_path)
        if isinstance(data, dict):
            try:
                return Team.from_dict(data)
            except Exception:
                return None
        return None

    def get_tasks(self, team_name: str) -> list[Task]:
        try:
            task_dir = safe_path(self._tasks_dir, team_name)
        except ValueError:
            return []
        if not task_dir.is_dir():
            return []
        tasks: list[Task] = []
        for task_file in sorted(task_dir.iterdir()):
            if task_file.suffix != ".json":
                continue
            data = _read_json(task_file)
            if isinstance(data, dict):
                try:
                    tasks.append(Task.from_dict(data))
                except Exception:
                    logger.debug("Corrupt task file: %s", task_file)
        return tasks

    def get_task(self, team_name: str, task_id: str) -> Task | None:
        try:
            task_path = safe_path(self._tasks_dir, team_name, f"{task_id}.json")
        except ValueError:
            return None
        data = _read_json(task_path)
        if isinstance(data, dict):
            try:
                return Task.from_dict(data)
            except Exception:
                return None
        return None

    def get_inbox(self, team_name: str, agent_name: str) -> list[Message]:
        try:
            inbox_path = safe_path(self._teams_dir, team_name, "inboxes", f"{agent_name}.json")
        except ValueError:
            return []
        data = _read_json(inbox_path)
        if not isinstance(data, list):
            return []
        messages: list[Message] = []
        for item in data:
            if isinstance(item, dict):
                try:
                    messages.append(Message.from_dict(item))
                except Exception:
                    pass
        return messages

    def get_unread_count(self, team_name: str, agent_name: str) -> int:
        return sum(1 for m in self.get_inbox(team_name, agent_name) if not m.read)

    # ------------------------------------------------------------------
    # Transcript index
    # ------------------------------------------------------------------

    def build_transcript_index(self) -> None:
        """Scan all teams to map JSONL transcript files to (team_dir, agent) pairs."""
        index: dict[str, tuple[str, str]] = {}
        if not self._teams_dir.is_dir():
            self._transcript_index = index
            return
        for team_dir in self._teams_dir.iterdir():
            if not team_dir.is_dir():
                continue
            config_path = team_dir / "config.json"
            if not config_path.exists():
                continue
            config = _read_json(config_path)
            if not isinstance(config, dict):
                continue
            lead_session = config.get("leadSessionId", "")
            members = config.get("members", [])
            if not lead_session or not members:
                continue
            cwd = members[0].get("cwd", "")
            if not cwd:
                continue
            sanitized = "".join(c if c.isalnum() else "-" for c in cwd)[:200]
            subagents_dir = self._projects_dir / sanitized / lead_session / "subagents"
            if not subagents_dir.is_dir():
                continue
            member_names = {m.get("name") for m in members if m.get("name")}
            # Track best mtime per (team, agent) to keep only the most recent JSONL
            best: dict[tuple[str, str], tuple[str, float]] = {}
            for meta_path in subagents_dir.glob("agent-*.meta.json"):
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                    agent_type = meta.get("agentType", "")
                    if agent_type not in member_names:
                        continue
                    jsonl_path = Path(str(meta_path).replace(".meta.json", ".jsonl"))
                    if not jsonl_path.exists():
                        continue
                    mtime = jsonl_path.stat().st_mtime
                    key = (team_dir.name, agent_type)
                    prev = best.get(key)
                    if prev is None or mtime > prev[1]:
                        best[key] = (str(jsonl_path), mtime)
                except Exception:
                    continue
            for (team_name, agent_name), (jsonl_str, _) in best.items():
                index[jsonl_str] = (team_name, agent_name)

            # Also index the team lead's main session JSONL
            lead_name = ""
            lead_agent_id = config.get("leadAgentId", "")
            if "@" in lead_agent_id:
                lead_name = lead_agent_id.rsplit("@", 1)[0]
            if not lead_name and members:
                lead_name = members[0].get("name", "")
            if lead_name:
                lead_jsonl = self._projects_dir / sanitized / lead_session / f"{lead_session}.jsonl"
                if lead_jsonl.exists():
                    index[str(lead_jsonl)] = (team_dir.name, lead_name)

        self._transcript_index = index

    # ------------------------------------------------------------------
    # Internal watcher
    # ------------------------------------------------------------------

    async def _watch_loop(self) -> None:
        watch_paths: list[str] = []
        for path in (self._teams_dir, self._tasks_dir):
            path.mkdir(parents=True, exist_ok=True)
            watch_paths.append(str(path))

        # Build transcript index and add subagent dirs to watch
        self.build_transcript_index()
        watched_dirs: set[str] = set()
        for jsonl_path in self._transcript_index:
            parent = str(Path(jsonl_path).parent)
            if parent not in watched_dirs:
                watched_dirs.add(parent)
                watch_paths.append(parent)
        # Also watch the lead session dirs (parent of subagents/)
        for jsonl_path in self._transcript_index:
            p = Path(jsonl_path)
            if p.parent.name != "subagents":
                parent = str(p.parent)
                if parent not in watched_dirs:
                    watched_dirs.add(parent)
                    watch_paths.append(parent)

        try:
            from watchfiles import awatch, Change

            async for changes in awatch(*watch_paths, debounce=int(_DEBOUNCE_SECONDS * 1000)):
                for change_type, path_str in changes:
                    # Check transcript index first
                    transcript_key = self._transcript_index.get(path_str)
                    if transcript_key is not None:
                        team, agent = transcript_key
                        tool_name, is_idle = _read_last_entry(Path(path_str))
                        if self._app is not None:
                            try:
                                self._app.post_message(  # type: ignore[attr-defined]
                                    TranscriptActivity(team, agent, tool_name, is_idle)
                                )
                            except Exception:
                                pass
                        continue

                    changed = Path(path_str)
                    msg = _parse_change_path(changed, self._teams_dir, self._tasks_dir)
                    if msg is not None and self._app is not None:
                        try:
                            self._app.post_message(msg)  # type: ignore[attr-defined]
                        except Exception:
                            pass
        except Exception as exc:
            logger.debug("File watcher stopped: %s", exc)
