from __future__ import annotations

import json
from pathlib import Path

from claude_litter.models.swarm import SwarmHeartbeat, SwarmProgressEntry, SwarmState
from claude_litter.services.state import SwarmUpdated, _parse_swarm_change_path


class TestSwarmProgressEntry:
    def test_from_dict(self):
        data = {
            "task_id": "1",
            "task": "Fix bug",
            "teammate": "alice",
            "tasks_completed": 3,
            "tasks_total": 5,
            "ts": "2026-01-01T00:00:00Z",
        }
        entry = SwarmProgressEntry.from_dict(data)
        assert entry.task_id == "1"
        assert entry.tasks_completed == 3
        assert entry.ts == "2026-01-01T00:00:00Z"

    def test_from_dict_missing_fields(self):
        entry = SwarmProgressEntry.from_dict({})
        assert entry.task_id == ""
        assert entry.tasks_completed == 0


class TestSwarmHeartbeat:
    def test_from_dict(self):
        data = {
            "iteration": 2,
            "phase": "execute",
            "tasks_completed": 3,
            "tasks_total": 5,
            "last_tool": "Write",
            "team_active": True,
            "autonomy_health": "healthy",
            "timestamp": "2026-01-01T00:00:00Z",
        }
        hb = SwarmHeartbeat.from_dict(data)
        assert hb.iteration == 2
        assert hb.phase == "execute"
        assert hb.team_active is True

    def test_from_dict_defaults(self):
        hb = SwarmHeartbeat.from_dict({})
        assert hb.iteration == 0
        assert hb.team_active is True
        assert hb.autonomy_health == "healthy"


class TestSwarmState:
    def _write_state(self, instance_dir: Path, data: dict) -> None:
        instance_dir.mkdir(parents=True, exist_ok=True)
        (instance_dir / "state.json").write_text(json.dumps(data))

    def _minimal_state(self) -> dict:
        return {
            "version": 2,
            "mode": "default",
            "goal": "test",
            "completion_promise": "done",
            "soft_budget": 10,
            "session_id": "test",
            "instance_id": "abcd1234",
            "iteration": 1,
            "phase": "initial",
            "started_at": "2026-01-01T00:00:00Z",
            "last_updated": "2026-01-01T00:00:00Z",
            "team_name": "test-team",
            "safe_mode": True,
            "sentinel_timeout": 600,
            "teammates_isolation": "shared",
            "teammates_max_count": 8,
            "permission_failures": [],
            "autonomy_health": "healthy",
            "progress_history": [],
        }

    def test_from_files_missing_dir(self, tmp_path):
        result = SwarmState.from_files(tmp_path / "nonexistent")
        assert result is None

    def test_from_files_corrupt_json(self, tmp_path):
        d = tmp_path / "abcd1234"
        d.mkdir()
        (d / "state.json").write_text("not json{{{")
        assert SwarmState.from_files(d) is None

    def test_from_files_minimal(self, tmp_path):
        d = tmp_path / "abcd1234"
        self._write_state(d, self._minimal_state())
        state = SwarmState.from_files(d)
        assert state is not None
        assert state.instance_id == "abcd1234"
        assert state.iteration == 1
        assert state.phase == "initial"
        assert state.mode == "default"
        assert state.heartbeat is None

    def test_from_files_with_heartbeat(self, tmp_path):
        d = tmp_path / "abcd1234"
        self._write_state(d, self._minimal_state())
        hb = {
            "iteration": 2,
            "phase": "execute",
            "tasks_completed": 3,
            "tasks_total": 5,
            "last_tool": "Write",
            "team_active": True,
            "autonomy_health": "healthy",
            "timestamp": "2026-01-01T00:00:00Z",
        }
        (d / "heartbeat.json").write_text(json.dumps(hb))
        state = SwarmState.from_files(d)
        assert state is not None
        assert state.heartbeat is not None
        assert state.heartbeat.tasks_completed == 3

    def test_from_files_sentinel(self, tmp_path):
        d = tmp_path / "abcd1234"
        self._write_state(d, self._minimal_state())
        (d / "next-iteration").write_text("")
        state = SwarmState.from_files(d)
        assert state is not None
        assert state.has_sentinel is True

    def test_from_files_no_sentinel(self, tmp_path):
        d = tmp_path / "abcd1234"
        self._write_state(d, self._minimal_state())
        state = SwarmState.from_files(d)
        assert state is not None
        assert state.has_sentinel is False

    def test_from_files_deepplan(self, tmp_path):
        d = tmp_path / "abcd1234"
        data = self._minimal_state()
        data["mode"] = "deepplan"
        data["findings_complete"] = {"architecture": True, "file_discovery": False}
        data["has_draft"] = True
        self._write_state(d, data)
        state = SwarmState.from_files(d)
        assert state is not None
        assert state.deepplan_findings_complete == {"architecture": True, "file_discovery": False}
        assert state.deepplan_has_draft is True

    def test_from_files_async(self, tmp_path):
        d = tmp_path / "abcd1234"
        data = self._minimal_state()
        data["mode"] = "async"
        data["background_agents"] = [{"id": "agent-1"}, {"id": "agent-2"}]
        data["agents_completed"] = 1
        self._write_state(d, data)
        state = SwarmState.from_files(d)
        assert state is not None
        assert state.async_agents == ("agent-1", "agent-2")
        assert state.async_agents_completed == 1

    def test_progress_pct_no_heartbeat(self, tmp_path):
        d = tmp_path / "abcd1234"
        self._write_state(d, self._minimal_state())
        state = SwarmState.from_files(d)
        assert state.progress_pct == 0.0

    def test_progress_pct_with_heartbeat(self, tmp_path):
        d = tmp_path / "abcd1234"
        self._write_state(d, self._minimal_state())
        hb = {
            "iteration": 1,
            "phase": "execute",
            "tasks_completed": 3,
            "tasks_total": 6,
            "last_tool": "Write",
            "team_active": True,
            "autonomy_health": "healthy",
            "timestamp": "2026-01-01T00:00:00Z",
        }
        (d / "heartbeat.json").write_text(json.dumps(hb))
        state = SwarmState.from_files(d)
        assert state.progress_pct == 0.5


class TestParseSwarmChangePath:
    def test_matching_path(self, tmp_path):
        idir = tmp_path / "abcd1234"
        idir.mkdir()
        dirs = {"abcd1234": (idir, str(tmp_path))}
        changed = idir / "state.json"
        result = _parse_swarm_change_path(changed, dirs)
        assert result is not None
        assert isinstance(result, SwarmUpdated)
        assert result.instance_id == "abcd1234"

    def test_non_matching_path(self, tmp_path):
        idir = tmp_path / "abcd1234"
        idir.mkdir()
        dirs = {"abcd1234": (idir, str(tmp_path))}
        changed = tmp_path / "other" / "file.txt"
        result = _parse_swarm_change_path(changed, dirs)
        assert result is None

    def test_multiple_instances(self, tmp_path):
        idir_a = tmp_path / "instance-aaa"
        idir_b = tmp_path / "instance-bbb"
        idir_a.mkdir()
        idir_b.mkdir()
        dirs = {
            "instance-aaa": (idir_a, str(tmp_path)),
            "instance-bbb": (idir_b, str(tmp_path)),
        }
        changed = idir_b / "heartbeat.json"
        result = _parse_swarm_change_path(changed, dirs)
        assert result is not None
        assert result.instance_id == "instance-bbb"

    def test_empty_dirs(self, tmp_path):
        changed = tmp_path / "anything"
        result = _parse_swarm_change_path(changed, {})
        assert result is None
