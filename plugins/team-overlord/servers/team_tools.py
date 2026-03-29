#!/usr/bin/env python3
"""Team Overlord MCP Server — team/task/message management tools."""

from __future__ import annotations

import json
import os
import re
import time
from datetime import UTC, datetime
from pathlib import Path

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

mcp = FastMCP("team-overlord")

CLAUDE_HOME = Path(os.environ.get("CLAUDE_HOME", str(Path.home() / ".claude")))
TEAMS = CLAUDE_HOME / "teams"
TASKS = CLAUDE_HOME / "tasks"

_VALID_STATUSES = {"pending", "in_progress", "completed"}


def _sanitize_team_name(name: str) -> str:
    """Sanitize a team name for use as a directory name.

    Matches Claude Code's ``pA6()`` — lowercase, replace non-alphanumeric with ``-``.
    """
    return re.sub(r"[^a-zA-Z0-9]", "-", name).lower()


def _sanitize_name(name: str) -> str:
    """Sanitize a name for filesystem paths (task dirs, inbox filenames).

    Matches Claude Code's ``ZN6()`` — replace chars outside ``[a-zA-Z0-9_-]`` with ``-``.
    """
    return re.sub(r"[^a-zA-Z0-9_-]", "-", name)


# ---------------------------------------------------------------------------
# Helpers — mirror TeamService patterns (mkdir-based atomic file locking)
# ---------------------------------------------------------------------------


def _safe_path(root: Path, *parts: str) -> Path:
    """Resolve a path under *root*, raising ValueError on traversal attempts."""
    result = root.joinpath(*parts).resolve()
    if not result.is_relative_to(root.resolve()):
        raise ValueError(f"Path traversal attempt: {parts!r}")
    return result


def _acquire_lock(path: Path, timeout: float = 5.0) -> Path:
    lock_dir = path.with_suffix(".lock")
    pid_file = lock_dir / "pid"
    deadline = time.monotonic() + timeout
    while True:
        try:
            os.mkdir(lock_dir)
            # Write our PID so stale locks can be detected
            pid_file.write_text(str(os.getpid()))
            return lock_dir
        except FileExistsError:
            # Check if the owning process is still alive
            try:
                owner_pid = int(pid_file.read_text())
                try:
                    os.kill(owner_pid, 0)  # signal 0 = existence check
                except ProcessLookupError:
                    # Owning process is dead — steal the lock
                    try:
                        pid_file.write_text(str(os.getpid()))
                    except OSError:
                        pass
                    return lock_dir
            except OSError, ValueError:
                pass
            if time.monotonic() > deadline:
                raise TimeoutError(f"Could not acquire lock: {lock_dir}")
            time.sleep(0.05)


def _release_lock(lock_dir: Path) -> None:
    try:
        # Remove PID file first, then the directory
        pid_file = lock_dir / "pid"
        try:
            pid_file.unlink(missing_ok=True)
        except OSError:
            pass
        os.rmdir(lock_dir)
    except OSError:
        pass


def _read_json(path: Path) -> dict | list:  # type: ignore[type-arg]
    with open(path) as f:
        return json.load(f)


def _write_json(path: Path, data: dict | list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".tmp.{os.getpid()}.{int(time.monotonic() * 1e6)}")
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    tmp.replace(path)


def _locked_update(path: Path, update_fn, default_data=None) -> dict | list:
    """Read -> transform -> write under a lock."""
    lock = _acquire_lock(path)
    try:
        if default_data is None:
            default_data = {}
        data = _read_json(path) if path.exists() else default_data
        result = update_fn(data)
        _write_json(path, result if result is not None else data)
        return result if result is not None else data
    finally:
        _release_lock(lock)


def _next_task_id(tasks_dir: Path) -> str:
    """Generate next task ID. Must be called while holding a directory-level lock."""
    existing = [int(f.stem) for f in tasks_dir.glob("*.json") if f.stem.isdigit()]
    return str(max(existing, default=0) + 1)


# ---------------------------------------------------------------------------
# Read-only tools
# ---------------------------------------------------------------------------


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
def list_teams() -> str:
    """List all teams with their members and status.

    Returns a JSON array of team summaries.
    """
    if not TEAMS.exists():
        return "[]"
    results = []
    for d in sorted(TEAMS.iterdir()):
        config_path = d / "config.json"
        if d.is_dir() and config_path.exists():
            try:
                config: dict = _read_json(config_path)
                members: list[dict] = config.get("members", [])
                results.append(
                    {
                        "name": config.get("name", d.name),
                        "description": config.get("description", ""),
                        "status": config.get("status", "active"),
                        "members": [
                            {
                                "name": m.get("name", "?"),
                                "model": m.get("model", ""),
                                "agentType": m.get("agentType", ""),
                            }
                            for m in members
                        ],
                    }
                )
            except json.JSONDecodeError, OSError:
                continue
    return json.dumps(results, indent=2)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
def get_team(team: str) -> str:
    """Get full configuration for a specific team.

    Args:
        team: Team name
    """
    try:
        config_path = _safe_path(TEAMS, team, "config.json")
    except ValueError as e:
        return json.dumps({"error": str(e)})
    if not config_path.exists():
        return json.dumps({"error": f"Team '{team}' not found"})
    return json.dumps(_read_json(config_path), indent=2)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
def list_tasks(team: str, status: str = "") -> str:
    """List tasks for a team, optionally filtered by status.

    Args:
        team: Team name
        status: Filter by status (pending, in_progress, completed). Empty string means all.
    """
    try:
        tasks_dir = _safe_path(TASKS, team)
    except ValueError as e:
        return json.dumps({"error": str(e)})
    if not tasks_dir.exists():
        return "[]"
    results = []
    for f in sorted(tasks_dir.glob("*.json"), key=lambda p: int(p.stem) if p.stem.isdigit() else 0):
        if f.name.startswith("."):
            continue
        try:
            task: dict = _read_json(f)
            if status and task.get("status") != status:
                continue
            results.append(task)
        except json.JSONDecodeError, OSError:
            continue
    return json.dumps(results, indent=2)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
def get_task(team: str, task_id: str) -> str:
    """Get a specific task by ID.

    Args:
        team: Team name
        task_id: Task ID
    """
    try:
        task_path = _safe_path(TASKS, team, f"{task_id}.json")
    except ValueError as e:
        return json.dumps({"error": str(e)})
    if not task_path.exists():
        return json.dumps({"error": f"Task '{task_id}' not found in team '{team}'"})
    return json.dumps(_read_json(task_path), indent=2)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
def read_inbox(team: str, agent: str) -> str:
    """Read an agent's message inbox.

    Args:
        team: Team name
        agent: Agent name
    """
    try:
        inbox_path = _safe_path(TEAMS, team, "inboxes", f"{agent}.json")
    except ValueError as e:
        return json.dumps({"error": str(e)})
    if not inbox_path.exists():
        return "[]"
    data = _read_json(inbox_path)
    return json.dumps(data if isinstance(data, list) else [], indent=2)


# ---------------------------------------------------------------------------
# Write tools
# ---------------------------------------------------------------------------


@mcp.tool()
def create_team(name: str, description: str = "") -> str:
    """Create a new team.

    Args:
        name: Team name
        description: Optional team description
    """
    dir_name = _sanitize_team_name(name)
    if not dir_name:
        return json.dumps({"error": f"Invalid team name '{name}': sanitizes to empty string"})
    try:
        team_dir = _safe_path(TEAMS, dir_name)
    except ValueError as e:
        return json.dumps({"error": str(e)})
    team_dir.mkdir(parents=True, exist_ok=True)

    config_path = team_dir / "config.json"
    if config_path.exists():
        return json.dumps(_read_json(config_path), indent=2)

    config = {
        "name": name,
        "description": description,
        "createdAt": int(time.time() * 1000),
        "leadAgentId": "",
        "leadSessionId": "",
        "members": [],
    }
    _write_json(config_path, config)
    return json.dumps(config, indent=2)


@mcp.tool()
def create_task(team: str, subject: str, description: str = "") -> str:
    """Create a new task for a team.

    Args:
        team: Team name
        subject: Brief task title
        description: Detailed description of what needs to be done
    """
    try:
        tasks_dir = _safe_path(TASKS, team)
    except ValueError as e:
        return json.dumps({"error": str(e)})
    tasks_dir.mkdir(parents=True, exist_ok=True)

    # Acquire a lock on the tasks directory to prevent ID race conditions
    lock_sentinel = tasks_dir / ".lock"
    lock = _acquire_lock(lock_sentinel)
    try:
        task_id = _next_task_id(tasks_dir)
        task = {
            "id": task_id,
            "subject": subject,
            "description": description,
            "status": "pending",
            "blocks": [],
            "blockedBy": [],
        }
        _write_json(tasks_dir / f"{task_id}.json", task)
    finally:
        _release_lock(lock)
    return json.dumps(task, indent=2)


@mcp.tool()
def update_task(
    team: str,
    task_id: str,
    status: str = "",
    owner: str = "",
    subject: str = "",
    description: str = "",
) -> str:
    """Update a task's fields. Only non-empty values are changed.

    Args:
        team: Team name
        task_id: Task ID to update
        status: New status (pending, in_progress, completed). Empty = no change.
        owner: Assign to agent name. Empty = no change.
        subject: New subject. Empty = no change.
        description: New description. Empty = no change.
    """
    try:
        task_path = _safe_path(TASKS, team, f"{task_id}.json")
    except ValueError as e:
        return json.dumps({"error": str(e)})
    if not task_path.exists():
        return json.dumps({"error": f"Task '{task_id}' not found in team '{team}'"})

    if status and status not in _VALID_STATUSES:
        return json.dumps({"error": f"Invalid status '{status}': must be one of {sorted(_VALID_STATUSES)}"})

    fields = {}
    if status:
        fields["status"] = status
    if owner:
        fields["owner"] = owner
    if subject:
        fields["subject"] = subject
    if description:
        fields["description"] = description

    if not fields:
        return json.dumps(_read_json(task_path), indent=2)

    def _update(data: dict) -> dict:
        data.update(fields)
        return data

    result = _locked_update(task_path, _update)
    return json.dumps(result, indent=2)


@mcp.tool()
def send_message(team: str, to: str, text: str, from_agent: str = "tui") -> str:
    """Send a message to a specific agent in a team.

    Args:
        team: Team name
        to: Agent name to send the message to
        text: Message text
        from_agent: Sender name (default "tui")
    """
    try:
        inbox_path = _safe_path(TEAMS, team, "inboxes", f"{to}.json")
    except ValueError as e:
        return json.dumps({"error": str(e)})
    inbox_path.parent.mkdir(parents=True, exist_ok=True)

    message = {
        "from": from_agent,
        "text": text,
        "timestamp": datetime.now(UTC).isoformat(),
        "read": False,
    }

    if not inbox_path.exists():
        _write_json(inbox_path, [])

    def _append(data) -> list:
        if not isinstance(data, list):
            data = []
        data.append(message)
        return data

    _locked_update(inbox_path, _append, default_data=[])
    return f"Message sent to {to} in team {team}"


@mcp.tool()
def broadcast_message(team: str, text: str, from_agent: str = "tui") -> str:
    """Broadcast a message to all agents in a team.

    Args:
        team: Team name
        text: Message text to broadcast
        from_agent: Sender name (default "tui")
    """
    try:
        config_path = _safe_path(TEAMS, team, "config.json")
    except ValueError as e:
        return json.dumps({"error": str(e)})
    if not config_path.exists():
        return json.dumps({"error": f"Team '{team}' not found"})

    config: dict = _read_json(config_path)
    members: list[dict] = config.get("members", [])
    count = 0
    summary = text[:100] + ("..." if len(text) > 100 else "")

    for member in members:
        name = member.get("name", "")
        if name and name != from_agent:
            try:
                inbox_path = _safe_path(TEAMS, team, "inboxes", f"{name}.json")
            except ValueError:
                continue
            inbox_path.parent.mkdir(parents=True, exist_ok=True)

            message = {
                "from": from_agent,
                "text": text,
                "timestamp": datetime.now(UTC).isoformat(),
                "read": False,
                "summary": f"[broadcast] {summary}",
            }

            if not inbox_path.exists():
                _write_json(inbox_path, [])

            def _append(data, msg=message) -> list:
                if not isinstance(data, list):
                    data = []
                data.append(msg)
                return data

            _locked_update(inbox_path, _append, default_data=[])
            count += 1

    return f"Broadcast sent to {count} agent(s) in team {team}"


if __name__ == "__main__":
    mcp.run(transport="stdio")
