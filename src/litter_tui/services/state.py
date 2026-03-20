"""StateManager: watches ~/.claude/ for changes and reads teams/tasks/messages."""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import TYPE_CHECKING

import anyio
import anyio.abc

from litter_tui.models.message import Message
from litter_tui.models.task import Task
from litter_tui.models.team import Team

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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read_json(path: Path) -> dict | list | None:
    """Read JSON file, returning None on any error."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


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
            task_id = Path(parts[1]).stem
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
        self._task_group: anyio.abc.TaskGroup | None = None
        self._cancel_scope: anyio.CancelScope | None = None
        self._app: object | None = None  # Textual App reference for posting

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
        asyncio.get_event_loop().create_task(_runner())

    async def stop(self) -> None:
        """Cancel the background watcher."""
        if self._cancel_scope is not None:
            self._cancel_scope.cancel()
            self._cancel_scope = None
            self._task_group = None

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
        config_path = self._teams_dir / name / "config.json"
        data = _read_json(config_path)
        if isinstance(data, dict):
            try:
                return Team.from_dict(data)
            except Exception:
                return None
        return None

    def get_tasks(self, team_name: str) -> list[Task]:
        task_dir = self._tasks_dir / team_name
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
        task_path = self._tasks_dir / team_name / f"{task_id}.json"
        data = _read_json(task_path)
        if isinstance(data, dict):
            try:
                return Task.from_dict(data)
            except Exception:
                return None
        return None

    def get_inbox(self, team_name: str, agent_name: str) -> list[Message]:
        inbox_path = self._teams_dir / team_name / "inboxes" / f"{agent_name}.json"
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
    # Internal watcher
    # ------------------------------------------------------------------

    async def _watch_loop(self) -> None:
        watch_paths: list[str] = []
        for path in (self._teams_dir, self._tasks_dir):
            path.mkdir(parents=True, exist_ok=True)
            watch_paths.append(str(path))

        try:
            from watchfiles import awatch, Change

            async for changes in awatch(*watch_paths, debounce=int(_DEBOUNCE_SECONDS * 1000)):
                for change_type, path_str in changes:
                    changed = Path(path_str)
                    msg = _parse_change_path(changed, self._teams_dir, self._tasks_dir)
                    if msg is not None and self._app is not None:
                        try:
                            self._app.post_message(msg)  # type: ignore[attr-defined]
                        except Exception:
                            pass
        except Exception as exc:
            logger.debug("File watcher stopped: %s", exc)
