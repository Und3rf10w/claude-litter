"""Tests for SessionView and InputBar widgets."""

from __future__ import annotations

import pytest

from textual.app import App, ComposeResult

from claude_litter.widgets.session_view import SessionView
from claude_litter.widgets.session_view import _format_tool_input, _truncate_tool_output
from claude_litter.widgets.input_bar import (
    InputBar,
    PromptSubmitted,
    PromptTextArea,
    CommandSubmitted,
    InterruptRequested,
)


# ---------------------------------------------------------------------------
# Minimal test apps
# ---------------------------------------------------------------------------


class SessionApp(App):
    def compose(self) -> ComposeResult:
        yield SessionView(agent_name="test-agent", team="test-team", model="sonnet")


class InputApp(App):
    """App that captures submitted messages."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.submitted: list[str] = []
        self.commands: list[tuple[str, str]] = []
        self.interrupts: list[bool] = []

    def compose(self) -> ComposeResult:
        yield InputBar()

    def on_prompt_submitted(self, event: PromptSubmitted) -> None:
        self.submitted.append(event.text)

    def on_command_submitted(self, event: CommandSubmitted) -> None:
        self.commands.append((event.command, event.args))

    def on_interrupt_requested(self, event: InterruptRequested) -> None:
        self.interrupts.append(True)


async def _set_input(pilot, app: InputApp, text: str) -> None:
    """Set the input value directly and sync the InputBar state."""
    input_widget = app.query_one("#prompt-input", PromptTextArea)
    input_widget.load_text(text)
    input_widget.move_cursor(input_widget.document.end)
    # Manually sync command-mode since setting text directly skips TextArea.Changed
    ib = app.query_one(InputBar)
    ib._set_command_mode(text.startswith("/"))
    await pilot.pause()


# ---------------------------------------------------------------------------
# SessionView tests
# ---------------------------------------------------------------------------


class TestSessionView:
    @pytest.mark.anyio
    async def test_session_view_mounts(self):
        app = SessionApp()
        async with app.run_test() as pilot:
            sv = app.query_one(SessionView)
            assert sv is not None

    @pytest.mark.anyio
    async def test_append_output_writes_text(self):
        app = SessionApp()
        async with app.run_test() as pilot:
            sv = app.query_one(SessionView)
            sv.append_output("Hello world")
            await pilot.pause()
            from claude_litter.widgets.session_view import SelectableLog
            log = sv.query_one(SelectableLog)
            assert log is not None

    @pytest.mark.anyio
    async def test_clear_output(self):
        app = SessionApp()
        async with app.run_test() as pilot:
            sv = app.query_one(SessionView)
            sv.append_output("Some text")
            await pilot.pause()
            sv.clear_output()
            await pilot.pause()
            from claude_litter.widgets.session_view import SelectableLog
            log = sv.query_one(SelectableLog)
            assert log is not None  # log still exists after clear

    @pytest.mark.anyio
    async def test_disconnect_session_sets_idle(self):
        app = SessionApp()
        async with app.run_test() as pilot:
            sv = app.query_one(SessionView)
            # connect then disconnect
            sv._set_active()
            await pilot.pause()
            sv.disconnect_session()
            await pilot.pause()
            from textual.widgets import LoadingIndicator
            spinner = sv.query_one(LoadingIndicator)
            assert spinner.display is False


# ---------------------------------------------------------------------------
# InputBar tests
# ---------------------------------------------------------------------------


class TestInputBar:
    @pytest.mark.anyio
    async def test_input_bar_mounts(self):
        app = InputApp()
        async with app.run_test() as pilot:
            ib = app.query_one(InputBar)
            assert ib is not None

    @pytest.mark.anyio
    async def test_submit_fires_prompt_submitted(self):
        app = InputApp()
        async with app.run_test() as pilot:
            await _set_input(pilot, app, "hello there")
            # Single-line enter triggers submit via PromptTextArea
            await pilot.press("enter")
            await pilot.pause()
        assert "hello there" in app.submitted

    @pytest.mark.anyio
    async def test_submit_via_ctrl_enter(self):
        app = InputApp()
        async with app.run_test() as pilot:
            await _set_input(pilot, app, "ctrl enter test")
            await pilot.press("ctrl+j")
            await pilot.pause()
        assert "ctrl enter test" in app.submitted

    @pytest.mark.anyio
    async def test_submit_via_send_button(self):
        app = InputApp()
        async with app.run_test() as pilot:
            await _set_input(pilot, app, "button test")
            await pilot.click("#send-btn")
            await pilot.pause()
        assert "button test" in app.submitted

    @pytest.mark.anyio
    async def test_command_mode_detection(self):
        app = InputApp()
        async with app.run_test() as pilot:
            await _set_input(pilot, app, "/spawn researcher sonnet")
            await pilot.press("enter")
            await pilot.pause()
        assert len(app.commands) == 1
        cmd, args = app.commands[0]
        assert cmd == "spawn"
        assert args == "researcher sonnet"

    @pytest.mark.anyio
    async def test_command_no_args(self):
        app = InputApp()
        async with app.run_test() as pilot:
            await _set_input(pilot, app, "/team")
            await pilot.press("enter")
            await pilot.pause()
        assert len(app.commands) == 1
        cmd, args = app.commands[0]
        assert cmd == "team"
        assert args == ""

    @pytest.mark.anyio
    async def test_command_mode_indicator_updates(self):
        app = InputApp()
        async with app.run_test() as pilot:
            ib = app.query_one(InputBar)
            await _set_input(pilot, app, "/")
            assert ib._command_mode is True

    @pytest.mark.anyio
    async def test_prompt_mode_indicator(self):
        app = InputApp()
        async with app.run_test() as pilot:
            ib = app.query_one(InputBar)
            await _set_input(pilot, app, "hello")
            assert ib._command_mode is False

    @pytest.mark.anyio
    async def test_history_navigation_up(self):
        app = InputApp()
        async with app.run_test() as pilot:
            # Submit two entries to build history
            ib = app.query_one(InputBar)
            await _set_input(pilot, app, "first entry")
            await pilot.press("enter")
            await pilot.pause()
            await _set_input(pilot, app, "second entry")
            await pilot.press("enter")
            await pilot.pause()
            # Navigate up once via internal method
            ib._navigate_history(-1)
            await pilot.pause()
            assert ib._input.text == "second entry"

    @pytest.mark.anyio
    async def test_history_navigation_up_twice(self):
        app = InputApp()
        async with app.run_test() as pilot:
            ib = app.query_one(InputBar)
            await _set_input(pilot, app, "alpha")
            await pilot.press("enter")
            await pilot.pause()
            await _set_input(pilot, app, "beta")
            await pilot.press("enter")
            await pilot.pause()
            # Navigate via internal method
            ib._navigate_history(-1)  # -> beta
            ib._navigate_history(-1)  # -> alpha
            await pilot.pause()
            assert ib._input.text == "alpha"

    @pytest.mark.anyio
    async def test_history_down_restores_draft(self):
        app = InputApp()
        async with app.run_test() as pilot:
            ib = app.query_one(InputBar)
            await _set_input(pilot, app, "old")
            await pilot.press("enter")
            await pilot.pause()
            await _set_input(pilot, app, "draft")
            # Navigate up then back down via internal method
            ib._navigate_history(-1)  # -> old
            ib._navigate_history(1)   # -> restore draft
            await pilot.pause()
            assert ib._input.text == "draft"

    @pytest.mark.anyio
    async def test_empty_input_does_not_fire(self):
        app = InputApp()
        async with app.run_test() as pilot:
            await pilot.click("#prompt-input")
            await pilot.press("enter")
            await pilot.pause()
        assert app.submitted == []

    @pytest.mark.anyio
    async def test_input_cleared_after_submit(self):
        app = InputApp()
        async with app.run_test() as pilot:
            await _set_input(pilot, app, "clear me")
            await pilot.press("enter")
            await pilot.pause()
            ib = app.query_one(InputBar)
            assert ib._input.text == ""


# ---------------------------------------------------------------------------
# Tool rendering helper tests
# ---------------------------------------------------------------------------


class TestFormatToolInput:
    def test_bash_command(self):
        assert _format_tool_input("Bash", {"command": "ls -la"}) == "ls -la"

    def test_bash_truncates_long_command(self):
        long_cmd = "x" * 100
        result = _format_tool_input("Bash", {"command": long_cmd})
        assert len(result) == 83  # 80 + "..."
        assert result.endswith("...")

    def test_read_file_path(self):
        assert _format_tool_input("Read", {"file_path": "/src/app.py"}) == "/src/app.py"

    def test_write_file_path(self):
        assert _format_tool_input("Write", {"file_path": "/out.txt"}) == "/out.txt"

    def test_edit_file_path(self):
        assert _format_tool_input("Edit", {"file_path": "/foo.py"}) == "/foo.py"

    def test_grep_pattern_and_path(self):
        result = _format_tool_input("Grep", {"pattern": "TODO", "path": "src/"})
        assert result == "TODO src/"

    def test_grep_pattern_only(self):
        assert _format_tool_input("Grep", {"pattern": "TODO"}) == "TODO"

    def test_glob_pattern(self):
        assert _format_tool_input("Glob", {"pattern": "**/*.py"}) == "**/*.py"

    def test_agent_description(self):
        assert _format_tool_input("Agent", {"description": "find tests"}) == "find tests"

    def test_unknown_tool(self):
        assert _format_tool_input("SomethingElse", {"foo": "bar"}) == ""

    def test_empty_input(self):
        assert _format_tool_input("Bash", {}) == ""

    def test_case_insensitive(self):
        assert _format_tool_input("bash", {"command": "echo hi"}) == "echo hi"
        assert _format_tool_input("READ", {"file_path": "/a.py"}) == "/a.py"


class TestTruncateToolOutput:
    def test_short_output_unchanged(self):
        text = "line1\nline2\nline3"
        assert _truncate_tool_output(text) == text

    def test_four_lines_unchanged(self):
        text = "a\nb\nc\nd"
        assert _truncate_tool_output(text) == text

    def test_long_output_collapsed(self):
        lines = [f"line{i}" for i in range(10)]
        result = _truncate_tool_output("\n".join(lines))
        result_lines = result.splitlines()
        assert result_lines[0] == "line0"
        assert result_lines[1] == "line1"
        assert "+7 lines" in result_lines[2]
        assert result_lines[3] == "line9"
        assert len(result_lines) == 4

    def test_empty_content(self):
        assert _truncate_tool_output("") == ""

    def test_single_line(self):
        assert _truncate_tool_output("hello") == "hello"

    def test_custom_max_lines(self):
        text = "a\nb\nc\nd\ne"
        result = _truncate_tool_output(text, max_lines=5)
        assert result == text  # 5 lines, max_lines=5, no truncation


class TestRenderToolChunk:
    @pytest.mark.anyio
    async def test_tool_start(self):
        app = SessionApp()
        async with app.run_test() as pilot:
            sv = app.query_one(SessionView)
            sv.render_tool_chunk({"type": "tool_start", "name": "Bash"})
            await pilot.pause()
            history = sv.get_output_history()
            assert any("Bash" in h for h in history)

    @pytest.mark.anyio
    async def test_tool_done_with_summary(self):
        app = SessionApp()
        async with app.run_test() as pilot:
            sv = app.query_one(SessionView)
            sv.render_tool_chunk({"type": "tool_start", "name": "Read"})
            sv.render_tool_chunk({
                "type": "tool_done",
                "name": "Read",
                "input": {"file_path": "/src/app.py"},
            })
            await pilot.pause()
            history = sv.get_output_history()
            assert any("/src/app.py" in h for h in history)

    @pytest.mark.anyio
    async def test_tool_result_shows_output(self):
        app = SessionApp()
        async with app.run_test() as pilot:
            sv = app.query_one(SessionView)
            sv.render_tool_chunk({
                "type": "tool_result",
                "tool_use_id": "abc",
                "content": "test output line",
                "is_error": False,
            })
            await pilot.pause()
            history = sv.get_output_history()
            assert any("test output line" in h for h in history)

    @pytest.mark.anyio
    async def test_tool_result_error_in_red(self):
        app = SessionApp()
        async with app.run_test() as pilot:
            sv = app.query_one(SessionView)
            sv.render_tool_chunk({
                "type": "tool_result",
                "tool_use_id": "abc",
                "content": "something failed",
                "is_error": True,
            })
            await pilot.pause()
            history = sv.get_output_history()
            assert any("red" in h and "something failed" in h for h in history)

    @pytest.mark.anyio
    async def test_tool_result_truncated(self):
        app = SessionApp()
        async with app.run_test() as pilot:
            sv = app.query_one(SessionView)
            long_output = "\n".join(f"line{i}" for i in range(20))
            sv.render_tool_chunk({
                "type": "tool_result",
                "tool_use_id": "abc",
                "content": long_output,
                "is_error": False,
            })
            await pilot.pause()
            history = sv.get_output_history()
            assert any("+17 lines" in h for h in history)

    @pytest.mark.anyio
    async def test_api_retry(self):
        app = SessionApp()
        async with app.run_test() as pilot:
            sv = app.query_one(SessionView)
            sv.render_tool_chunk({
                "type": "api_retry",
                "attempt": 2,
                "error": "rate limited",
                "status": 429,
            })
            await pilot.pause()
            history = sv.get_output_history()
            assert any("retry" in h and "429" in str(h) for h in history)
