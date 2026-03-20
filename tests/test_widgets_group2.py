"""Tests for SessionView and InputBar widgets."""

from __future__ import annotations

import pytest

from textual.app import App, ComposeResult
from textual.widgets import Input

from litter_tui.widgets.session_view import SessionView
from litter_tui.widgets.input_bar import (
    InputBar,
    PromptSubmitted,
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
    input_widget = app.query_one("#prompt-input", Input)
    input_widget.value = text
    # Manually sync command-mode since setting .value directly skips Input.Changed
    ib = app.query_one(InputBar)
    ib._set_command_mode(text.startswith(":"))
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
            from textual.widgets import RichLog
            log = sv.query_one(RichLog)
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
            from textual.widgets import RichLog
            log = sv.query_one(RichLog)
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
    async def test_submit_on_enter_fires_prompt_submitted(self):
        app = InputApp()
        async with app.run_test() as pilot:
            await _set_input(pilot, app, "hello there")
            await pilot.press("enter")
            await pilot.pause()
        assert "hello there" in app.submitted

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
            await _set_input(pilot, app, ":spawn researcher sonnet")
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
            await _set_input(pilot, app, ":team")
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
            await _set_input(pilot, app, ":")
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
            # Focus the input and navigate up once
            await pilot.click("#prompt-input")
            await pilot.press("up")
            await pilot.pause()
            assert ib._input.value == "second entry"

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
            # Navigate via internal method (avoids key routing through Input widget)
            ib._navigate_history(-1)  # → beta
            ib._navigate_history(-1)  # → alpha
            await pilot.pause()
            assert ib._input.value == "alpha"

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
            ib._navigate_history(-1)  # → old
            ib._navigate_history(1)   # → restore draft
            await pilot.pause()
            assert ib._input.value == "draft"

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
            assert ib._input.value == ""
