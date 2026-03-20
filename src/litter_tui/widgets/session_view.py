"""SessionView widget — scrollable output display for an agent session."""

from __future__ import annotations

from typing import TYPE_CHECKING

from textual.app import ComposeResult
from textual.widget import Widget
from textual.widgets import RichLog, LoadingIndicator, Label, Static
from textual.containers import Vertical
from textual import work

if TYPE_CHECKING:
    pass


class SessionView(Widget):
    """Scrollable output display for an agent session.

    Streams output from an agent session, shows a loading spinner while the
    agent is active, and displays session metadata in a header.
    """

    DEFAULT_CSS = """
    SessionView {
        layout: vertical;
        height: 1fr;
        border: solid $primary-darken-2;
    }

    SessionView .session-header {
        height: 1;
        background: $primary-darken-2;
        color: $text;
        padding: 0 1;
        text-style: bold;
    }

    SessionView .session-output {
        height: 1fr;
    }

    SessionView .session-status {
        height: 1;
        background: $surface;
        color: $text-muted;
        padding: 0 1;
    }

    SessionView LoadingIndicator {
        height: 1;
    }
    """

    def __init__(
        self,
        agent_name: str = "",
        team: str = "",
        model: str = "",
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self._agent_name = agent_name
        self._team = team
        self._model = model
        self._session = None
        self._streaming = False
        self._user_scrolled_up = False

    def compose(self) -> ComposeResult:
        header_text = self._make_header_text()
        yield Static(header_text, classes="session-header")
        yield RichLog(highlight=True, markup=True, classes="session-output")
        yield LoadingIndicator()
        yield Static("Agent idle", classes="session-status")

    def on_mount(self) -> None:
        # Start in idle state
        self._set_idle()

    def _make_header_text(self) -> str:
        parts = []
        if self._agent_name:
            parts.append(self._agent_name)
        if self._team:
            parts.append(f"team: {self._team}")
        if self._model:
            parts.append(f"model: {self._model}")
        return "  |  ".join(parts) if parts else "Session"

    def _set_idle(self) -> None:
        """Switch UI to idle state."""
        try:
            self.query_one(LoadingIndicator).display = False
            self.query_one(".session-status", Static).update("Agent idle")
            self.query_one(".session-status", Static).display = True
        except Exception:
            pass

    def _set_active(self) -> None:
        """Switch UI to active/streaming state."""
        try:
            self.query_one(".session-status", Static).display = False
            self.query_one(LoadingIndicator).display = True
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def connect_session(self, session) -> None:
        """Start streaming output from *session*.

        The session object is expected to be an async iterable that yields
        str chunks, or to have an ``aiter_text()`` method.
        """
        self._session = session
        self._streaming = True
        self._set_active()
        self._stream_session()

    def disconnect_session(self) -> None:
        """Stop streaming from the current session."""
        self._streaming = False
        self._session = None
        self._set_idle()

    def append_output(self, text: str) -> None:
        """Add *text* to the display."""
        try:
            log = self.query_one(RichLog)
            log.write(text)
            if not self._user_scrolled_up:
                log.scroll_end(animate=False)
        except Exception:
            pass

    def clear_output(self) -> None:
        """Clear all displayed text."""
        try:
            self.query_one(RichLog).clear()
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Internal streaming worker
    # ------------------------------------------------------------------

    @work(exclusive=True)
    async def _stream_session(self) -> None:
        """Background worker that reads from the session and appends output."""
        session = self._session
        if session is None:
            return

        try:
            # Support both async-iterable sessions and those with aiter_text()
            if hasattr(session, "aiter_text"):
                aiter = session.aiter_text()
            else:
                aiter = session.__aiter__()

            async for chunk in aiter:
                if not self._streaming:
                    break
                if chunk:
                    self.app.call_from_thread(self.append_output, chunk)
        except Exception as exc:
            self.app.call_from_thread(
                self.append_output, f"\n[red]Stream error: {exc}[/red]\n"
            )
        finally:
            self.app.call_from_thread(self._set_idle)
            self._streaming = False

    # ------------------------------------------------------------------
    # Scroll tracking
    # ------------------------------------------------------------------

    def on_rich_log_scroll(self) -> None:
        """Track whether the user has scrolled up."""
        try:
            log = self.query_one(RichLog)
            # If the scroll position is not at the bottom, user has scrolled up
            self._user_scrolled_up = not log.is_vertical_scroll_end
        except Exception:
            pass
