"""Tests for task graph pure functions: _resolve_blocks, _topo_sort, _compute_depths."""

from __future__ import annotations

import pytest

from claude_litter.widgets.task_panel import _resolve_blocks, _topo_sort, _compute_depths


def make_task(id: str, status: str = "pending", blocked_by: list[str] | None = None) -> dict:
    return {"id": id, "status": status, "blockedBy": blocked_by or []}


# ---------------------------------------------------------------------------
# TestResolveBlocks
# ---------------------------------------------------------------------------

class TestResolveBlocks:
    def test_empty_list(self):
        assert _resolve_blocks([]) == []

    def test_single_task_no_deps(self):
        task = make_task("1")
        result = _resolve_blocks([task])
        assert len(result) == 1
        assert result[0]["blockedBy"] == []

    def test_blocked_by_pending_task_stays_blocked(self):
        tasks = [
            make_task("1", status="pending"),
            make_task("2", status="pending", blocked_by=["1"]),
        ]
        result = _resolve_blocks(tasks)
        task2 = next(t for t in result if t["id"] == "2")
        assert task2["blockedBy"] == ["1"]

    def test_blocked_by_completed_task_is_unblocked(self):
        tasks = [
            make_task("1", status="completed"),
            make_task("2", status="pending", blocked_by=["1"]),
        ]
        result = _resolve_blocks(tasks)
        task2 = next(t for t in result if t["id"] == "2")
        assert task2["blockedBy"] == []

    def test_nonexistent_blocker_keeps_reference(self):
        # blockedBy references a task not in the list → kept (may exist outside filter)
        task = make_task("1", blocked_by=["999"])
        result = _resolve_blocks([task])
        assert result[0]["blockedBy"] == ["999"]

    def test_circular_blocking_does_not_crash(self):
        # A blocked by B, B blocked by A — should not raise
        tasks = [
            make_task("1", blocked_by=["2"]),
            make_task("2", blocked_by=["1"]),
        ]
        result = _resolve_blocks(tasks)
        assert len(result) == 2

    def test_partial_completion_removes_only_completed_deps(self):
        tasks = [
            make_task("1", status="completed"),
            make_task("2", status="pending"),
            make_task("3", status="pending", blocked_by=["1", "2"]),
        ]
        result = _resolve_blocks(tasks)
        task3 = next(t for t in result if t["id"] == "3")
        # "1" is completed, "2" is pending → only "2" should remain
        assert task3["blockedBy"] == ["2"]


# ---------------------------------------------------------------------------
# TestTopoSort
# ---------------------------------------------------------------------------

class TestTopoSort:
    def test_empty_list(self):
        assert _topo_sort([]) == []

    def test_single_task(self):
        task = make_task("1")
        result = _topo_sort([task])
        assert result == [task]

    def test_linear_chain(self):
        # A → B → C (C is blocked by B, B is blocked by A)
        a = make_task("1")
        b = make_task("2", blocked_by=["1"])
        c = make_task("3", blocked_by=["2"])
        result = _topo_sort([a, b, c])
        ids = [t["id"] for t in result]
        assert ids.index("1") < ids.index("2") < ids.index("3")

    def test_diamond_dependency(self):
        # A → B, A → C, B → D, C → D
        a = make_task("1")
        b = make_task("2", blocked_by=["1"])
        c = make_task("3", blocked_by=["1"])
        d = make_task("4", blocked_by=["2", "3"])
        result = _topo_sort([a, b, c, d])
        ids = [t["id"] for t in result]
        # A must come before B, C, D; B and C before D
        assert ids.index("1") < ids.index("2")
        assert ids.index("1") < ids.index("3")
        assert ids.index("2") < ids.index("4")
        assert ids.index("3") < ids.index("4")

    def test_cycle_does_not_infinite_loop(self):
        # Cyclic dep should return some result without hanging
        tasks = [
            make_task("1", blocked_by=["2"]),
            make_task("2", blocked_by=["1"]),
        ]
        result = _topo_sort(tasks)
        # All tasks should appear in result
        assert len(result) == 2

    def test_independent_tasks_come_first(self):
        # Tasks with no blockedBy should appear before those that do
        root = make_task("1")
        dependent = make_task("2", blocked_by=["1"])
        result = _topo_sort([dependent, root])
        ids = [t["id"] for t in result]
        assert ids.index("1") < ids.index("2")

    def test_all_tasks_present_in_result(self):
        tasks = [make_task(str(i)) for i in range(1, 6)]
        result = _topo_sort(tasks)
        assert {t["id"] for t in result} == {t["id"] for t in tasks}


# ---------------------------------------------------------------------------
# TestComputeDepths
# ---------------------------------------------------------------------------

class TestComputeDepths:
    def test_no_dependencies_all_depth_zero(self):
        tasks = [make_task("1"), make_task("2"), make_task("3")]
        depths = _compute_depths(tasks)
        assert all(depths[t["id"]] == 0 for t in tasks)

    def test_linear_chain_incrementing_depths(self):
        # 1 → 2 → 3
        tasks = [
            make_task("1"),
            make_task("2", blocked_by=["1"]),
            make_task("3", blocked_by=["2"]),
        ]
        depths = _compute_depths(tasks)
        assert depths["1"] == 0
        assert depths["2"] == 1
        assert depths["3"] == 2

    def test_diamond_correct_max_depth(self):
        # 1 → 2, 1 → 3, 2 → 4, 3 → 4
        tasks = [
            make_task("1"),
            make_task("2", blocked_by=["1"]),
            make_task("3", blocked_by=["1"]),
            make_task("4", blocked_by=["2", "3"]),
        ]
        depths = _compute_depths(tasks)
        assert depths["1"] == 0
        assert depths["2"] == 1
        assert depths["3"] == 1
        assert depths["4"] == 2

    def test_isolated_tasks_depth_zero(self):
        tasks = [make_task("10"), make_task("20")]
        depths = _compute_depths(tasks)
        assert depths["10"] == 0
        assert depths["20"] == 0

    def test_returns_dict_keyed_by_id(self):
        tasks = [make_task("1"), make_task("2", blocked_by=["1"])]
        depths = _compute_depths(tasks)
        assert isinstance(depths, dict)
        assert set(depths.keys()) == {"1", "2"}

    def test_cycle_does_not_crash(self):
        # Circular dep: cycle guard should prevent infinite recursion
        tasks = [
            make_task("1", blocked_by=["2"]),
            make_task("2", blocked_by=["1"]),
        ]
        result = _compute_depths(tasks)
        assert isinstance(result, dict)
        assert "1" in result and "2" in result
