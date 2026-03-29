"""Tests for MainScreen._format_inbox_text static method."""

from __future__ import annotations

import json

import pytest

from claude_litter.screens.main import MainScreen

fmt = MainScreen._format_inbox_text


class TestFormatInboxText:
    # ------------------------------------------------------------------
    # Plain text (non-JSON) pass-through
    # ------------------------------------------------------------------

    def test_plain_text_returned_as_is(self):
        assert fmt("hello world") == "hello world"

    def test_plain_text_long_not_truncated_by_default(self):
        long_text = "x" * 500
        assert fmt(long_text) == long_text

    def test_empty_string_returned_as_is(self):
        assert fmt("") == ""

    def test_plain_text_not_starting_with_brace(self):
        assert fmt("not json at all") == "not json at all"

    # ------------------------------------------------------------------
    # Invalid / malformed JSON treated as plain text
    # ------------------------------------------------------------------

    def test_malformed_json_returned_as_is(self):
        bad = "{not valid json"
        assert fmt(bad) == bad

    def test_almost_json_but_invalid_returned_as_is(self):
        bad = '{"key": }'
        assert fmt(bad) == bad

    # ------------------------------------------------------------------
    # idle_notification → empty string (skip sentinel)
    # ------------------------------------------------------------------

    def test_idle_notification_returns_empty(self):
        msg = json.dumps({"type": "idle_notification"})
        assert fmt(msg) == ""

    def test_idle_notification_with_extra_fields_still_empty(self):
        msg = json.dumps({"type": "idle_notification", "agent": "bob", "ts": 123})
        assert fmt(msg) == ""

    # ------------------------------------------------------------------
    # task_assignment
    # ------------------------------------------------------------------

    def test_task_assignment_short_description(self):
        msg = json.dumps({
            "type": "task_assignment",
            "taskId": "42",
            "subject": "Fix bug",
            "description": "Short desc",
        })
        result = fmt(msg)
        assert result == "[Task #42] Fix bug\n  Short desc"

    def test_task_assignment_long_description_truncated_by_default(self):
        long_desc = "A" * 300
        msg = json.dumps({
            "type": "task_assignment",
            "taskId": "7",
            "subject": "Do work",
            "description": long_desc,
        })
        result = fmt(msg)
        assert result.startswith("[Task #7] Do work\n  ")
        preview = result.split("\n  ", 1)[1]
        assert preview == long_desc[:200] + "..."

    def test_task_assignment_long_description_not_truncated_when_false(self):
        long_desc = "B" * 300
        msg = json.dumps({
            "type": "task_assignment",
            "taskId": "8",
            "subject": "Big task",
            "description": long_desc,
        })
        result = fmt(msg, truncate=False)
        assert result == f"[Task #8] Big task\n  {long_desc}"

    def test_task_assignment_description_exactly_200_chars_not_truncated(self):
        desc = "C" * 200
        msg = json.dumps({
            "type": "task_assignment",
            "taskId": "9",
            "subject": "Edge",
            "description": desc,
        })
        result = fmt(msg)
        assert result == f"[Task #9] Edge\n  {desc}"

    def test_task_assignment_missing_fields_use_defaults(self):
        msg = json.dumps({"type": "task_assignment"})
        result = fmt(msg)
        assert result == "[Task #] \n  "

    # ------------------------------------------------------------------
    # task_completed
    # ------------------------------------------------------------------

    def test_task_completed(self):
        msg = json.dumps({"type": "task_completed", "taskId": "3", "subject": "Done"})
        result = fmt(msg)
        assert result == "Task #3 completed: Done"

    def test_task_completed_missing_fields(self):
        msg = json.dumps({"type": "task_completed"})
        result = fmt(msg)
        assert result == "Task #? completed: "

    # ------------------------------------------------------------------
    # shutdown_request
    # ------------------------------------------------------------------

    def test_shutdown_request_with_reason(self):
        msg = json.dumps({"type": "shutdown_request", "reason": "Maintenance"})
        result = fmt(msg)
        assert result == "Shutdown requested: Maintenance"

    def test_shutdown_request_no_reason(self):
        msg = json.dumps({"type": "shutdown_request"})
        result = fmt(msg)
        assert result == "Shutdown requested: "

    # ------------------------------------------------------------------
    # shutdown_response
    # ------------------------------------------------------------------

    def test_shutdown_response_approved(self):
        msg = json.dumps({
            "type": "shutdown_response",
            "approve": True,
            "reason": "OK",
        })
        result = fmt(msg)
        assert result == "Shutdown approved: OK"

    def test_shutdown_response_rejected(self):
        msg = json.dumps({
            "type": "shutdown_response",
            "approve": False,
            "reason": "Not now",
        })
        result = fmt(msg)
        assert result == "Shutdown rejected: Not now"

    def test_shutdown_response_missing_approve_defaults_false(self):
        msg = json.dumps({"type": "shutdown_response", "reason": "?"})
        result = fmt(msg)
        assert result == "Shutdown rejected: ?"

    # ------------------------------------------------------------------
    # Fallback: unknown type → show [type] content
    # ------------------------------------------------------------------

    def test_unknown_type_shows_type_and_content(self):
        msg = json.dumps({"type": "custom_event", "data": "hello"})
        result = fmt(msg)
        assert result.startswith("[custom_event]")

    def test_unknown_type_content_truncated_at_300_by_default(self):
        big_data = "x" * 400
        msg = json.dumps({"type": "big_msg", "data": big_data})
        result = fmt(msg)
        # The content portion (after "[big_msg] ") should be truncated
        content_part = result[len("[big_msg] "):]
        assert content_part.endswith("...")
        assert len(content_part) == 303  # 300 chars + "..."

    def test_unknown_type_no_truncation_when_false(self):
        big_data = "y" * 400
        msg = json.dumps({"type": "big_msg2", "data": big_data})
        result = fmt(msg, truncate=False)
        # Full JSON must appear
        full_json = json.dumps({"type": "big_msg2", "data": big_data}, indent=2)
        assert full_json.replace("[", "\\[") in result

    def test_unknown_type_square_brackets_escaped(self):
        # Only "[" is escaped by the method (not "]"), verify the prefix is correct
        msg = json.dumps({"type": "foo[bar]", "x": 1})
        result = fmt(msg)
        # safe_type = "foo[bar]".replace("[", "\\[") → "foo\\[bar]"
        assert result.startswith("[foo\\[bar]]")

    def test_no_type_field_falls_back_to_json_label(self):
        msg = json.dumps({"key": "value"})
        result = fmt(msg)
        assert result.startswith("[json]")

    def test_json_content_square_brackets_escaped(self):
        # Ensure "[" in JSON content are escaped for Rich markup safety
        msg = json.dumps({"type": "note", "data": "[important]"})
        result = fmt(msg)
        assert "\\[" in result

    # ------------------------------------------------------------------
    # truncate=True vs truncate=False — explicit checks
    # ------------------------------------------------------------------

    def test_truncate_true_is_default(self):
        long_desc = "Z" * 300
        msg = json.dumps({
            "type": "task_assignment",
            "taskId": "1",
            "subject": "S",
            "description": long_desc,
        })
        assert fmt(msg, truncate=True) == fmt(msg)

    def test_truncate_false_preserves_full_content_for_fallback(self):
        small_msg = json.dumps({"type": "ping"})
        # Small content — both truncate settings should give the same result
        assert fmt(small_msg, truncate=True) == fmt(small_msg, truncate=False)
