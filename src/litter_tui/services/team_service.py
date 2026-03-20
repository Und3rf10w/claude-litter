"""TeamService — direct JSON file operations for swarm team/task data."""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import anyio


class TeamService:
    def __init__(self, base_path: Path | None = None) -> None:
        self.base_path = base_path or Path.home() / ".claude"
        self.teams_path = self.base_path / "teams"
        self.tasks_path = self.base_path / "tasks"

    # ------------------------------------------------------------------ #
    #  File locking (mkdir-based atomic lock)
    # ------------------------------------------------------------------ #

    def _acquire_lock(self, path: Path, timeout: float = 5.0) -> Path:
        lock_dir = path.with_suffix(".lock")
        deadline = time.monotonic() + timeout
        while True:
            try:
                os.mkdir(lock_dir)
                return lock_dir
            except FileExistsError:
                if time.monotonic() > deadline:
                    raise TimeoutError(f"Could not acquire lock: {lock_dir}")
                time.sleep(0.05)

    async def _acquire_lock_async(self, path: Path, timeout: float = 5.0) -> Path:
        """Async version of _acquire_lock that yields to the event loop while waiting."""
        lock_dir = path.with_suffix(".lock")
        deadline = time.monotonic() + timeout
        while True:
            try:
                os.mkdir(lock_dir)
                return lock_dir
            except FileExistsError:
                if time.monotonic() > deadline:
                    raise TimeoutError(f"Could not acquire lock: {lock_dir}")
                await anyio.sleep(0.05)

    def _release_lock(self, lock_dir: Path) -> None:
        try:
            os.rmdir(lock_dir)
        except OSError:
            pass

    def _read_json(self, path: Path) -> dict | list:
        with open(path) as f:
            return json.load(f)

    def _write_json(self, path: Path, data: dict | list) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2)
        tmp.replace(path)

    def _locked_update(self, path: Path, update_fn) -> dict | list:
        """Read → transform → write under a lock."""
        lock = self._acquire_lock(path)
        try:
            data = self._read_json(path) if path.exists() else {}
            result = update_fn(data)
            self._write_json(path, result if result is not None else data)
            return result if result is not None else data
        finally:
            self._release_lock(lock)

    async def _locked_update_async(self, path: Path, update_fn) -> dict | list:
        """Async version: read → transform → write under a lock without blocking the event loop."""
        lock = await self._acquire_lock_async(path)
        try:
            data = self._read_json(path) if path.exists() else {}
            result = update_fn(data)
            self._write_json(path, result if result is not None else data)
            return result if result is not None else data
        finally:
            self._release_lock(lock)

    # ------------------------------------------------------------------ #
    #  Teams
    # ------------------------------------------------------------------ #

    def create_team(self, name: str, description: str = "") -> dict:
        team_dir = self.teams_path / name
        team_dir.mkdir(parents=True, exist_ok=True)
        (team_dir / "inboxes").mkdir(exist_ok=True)

        config_path = team_dir / "config.json"
        if config_path.exists():
            return self._read_json(config_path)  # type: ignore[return-value]

        config: dict = {
            "name": name,
            "description": description,
            "createdAt": int(time.time() * 1000),
            "leadAgentId": "",
            "leadSessionId": "",
            "members": [],
        }
        self._write_json(config_path, config)
        return config

    def delete_team(self, name: str) -> None:
        import shutil
        team_dir = self.teams_path / name
        if team_dir.exists():
            shutil.rmtree(team_dir)
        tasks_dir = self.tasks_path / name
        if tasks_dir.exists():
            shutil.rmtree(tasks_dir)

    def get_team(self, name: str) -> dict | None:
        config_path = self.teams_path / name / "config.json"
        if not config_path.exists():
            return None
        return self._read_json(config_path)  # type: ignore[return-value]

    def list_teams(self) -> list[str]:
        if not self.teams_path.exists():
            return []
        return [
            d.name
            for d in self.teams_path.iterdir()
            if d.is_dir() and (d / "config.json").exists()
        ]

    # ------------------------------------------------------------------ #
    #  Members
    # ------------------------------------------------------------------ #

    def add_member(self, team_name: str, member: dict) -> None:
        config_path = self.teams_path / team_name / "config.json"

        def _add(data: dict) -> dict:
            members = data.get("members", [])
            # Avoid duplicates by agentId
            agent_id = member.get("agentId", member.get("agent_id", ""))
            if not any(m.get("agentId") == agent_id for m in members):
                members.append(member)
            data["members"] = members
            return data

        self._locked_update(config_path, _add)

    def remove_member(self, team_name: str, agent_id: str) -> None:
        config_path = self.teams_path / team_name / "config.json"

        def _remove(data: dict) -> dict:
            data["members"] = [
                m for m in data.get("members", [])
                if m.get("agentId") != agent_id
            ]
            return data

        self._locked_update(config_path, _remove)

    def update_member(self, team_name: str, agent_id: str, **fields) -> None:
        """Update fields on an existing member identified by *agent_id*.

        If *name* is changed, the ``agentId`` is updated to
        ``"{new_name}@{team_name}"`` and the inbox file is renamed.
        """
        config_path = self.teams_path / team_name / "config.json"
        old_name: str | None = None
        new_name: str | None = fields.get("name")

        def _update(data: dict) -> dict:
            nonlocal old_name
            for member in data.get("members", []):
                if member.get("agentId") == agent_id:
                    old_name = member.get("name")
                    member.update(fields)
                    if new_name and new_name != old_name:
                        member["agentId"] = f"{new_name}@{team_name}"
                    break
            return data

        self._locked_update(config_path, _update)

        # Rename inbox file when the agent name changes
        if new_name and old_name and new_name != old_name:
            inboxes_dir = self.teams_path / team_name / "inboxes"
            old_inbox = inboxes_dir / f"{old_name}.json"
            new_inbox = inboxes_dir / f"{new_name}.json"
            if old_inbox.exists():
                old_inbox.rename(new_inbox)

    def copy_inbox(
        self,
        src_team: str,
        src_agent: str,
        dst_team: str,
        dst_agent: str,
    ) -> int:
        """Copy all inbox messages from one agent to another.

        Returns the number of messages copied.
        """
        src_path = self.teams_path / src_team / "inboxes" / f"{src_agent}.json"
        if not src_path.exists():
            return 0

        messages = self._read_json(src_path)
        if not isinstance(messages, list) or not messages:
            return 0

        dst_path = self.teams_path / dst_team / "inboxes" / f"{dst_agent}.json"
        dst_path.parent.mkdir(parents=True, exist_ok=True)

        if not dst_path.exists():
            self._write_json(dst_path, [])

        def _append(data) -> list:
            if not isinstance(data, list):
                data = []
            data.extend(messages)
            return data

        self._locked_update(dst_path, _append)
        return len(messages)

    # ------------------------------------------------------------------ #
    #  Tasks
    # ------------------------------------------------------------------ #

    def _next_task_id(self, team_name: str) -> str:
        tasks_dir = self.tasks_path / team_name
        tasks_dir.mkdir(parents=True, exist_ok=True)
        existing = [
            int(f.stem) for f in tasks_dir.glob("*.json")
            if f.stem.isdigit()
        ]
        return str(max(existing, default=0) + 1)

    def create_task(self, team_name: str, subject: str, description: str = "") -> dict:
        tasks_dir = self.tasks_path / team_name
        tasks_dir.mkdir(parents=True, exist_ok=True)

        task_id = self._next_task_id(team_name)
        task: dict = {
            "id": task_id,
            "subject": subject,
            "description": description,
            "status": "pending",
            "blocks": [],
            "blockedBy": [],
        }
        self._write_json(tasks_dir / f"{task_id}.json", task)
        return task

    def get_task(self, team_name: str, task_id: str) -> dict | None:
        task_path = self.tasks_path / team_name / f"{task_id}.json"
        if not task_path.exists():
            return None
        return self._read_json(task_path)  # type: ignore[return-value]

    def update_task(self, team_name: str, task_id: str, **fields) -> dict:
        task_path = self.tasks_path / team_name / f"{task_id}.json"

        def _update(data: dict) -> dict:
            data.update(fields)
            return data

        return self._locked_update(task_path, _update)  # type: ignore[return-value]

    def list_tasks(self, team_name: str) -> list[dict]:
        tasks_dir = self.tasks_path / team_name
        if not tasks_dir.exists():
            return []
        tasks = []
        for f in sorted(tasks_dir.glob("*.json"), key=lambda p: int(p.stem) if p.stem.isdigit() else 0):
            try:
                tasks.append(self._read_json(f))
            except (json.JSONDecodeError, OSError):
                continue
        return tasks

    # ------------------------------------------------------------------ #
    #  Messaging
    # ------------------------------------------------------------------ #

    def send_message(
        self,
        team_name: str,
        to_agent: str,
        from_agent: str,
        text: str,
    ) -> None:
        inbox_path = self.teams_path / team_name / "inboxes" / f"{to_agent}.json"
        inbox_path.parent.mkdir(parents=True, exist_ok=True)

        message = {
            "from": from_agent,
            "text": text,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "read": False,
        }

        def _append(data) -> list:
            if not isinstance(data, list):
                data = []
            data.append(message)
            return data

        if not inbox_path.exists():
            self._write_json(inbox_path, [])

        self._locked_update(inbox_path, _append)

    def read_inbox(self, team_name: str, agent_name: str) -> list[dict]:
        inbox_path = self.teams_path / team_name / "inboxes" / f"{agent_name}.json"
        if not inbox_path.exists():
            return []
        data = self._read_json(inbox_path)
        return data if isinstance(data, list) else []
