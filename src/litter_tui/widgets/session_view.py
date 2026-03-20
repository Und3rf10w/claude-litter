"""SessionView widget — scrollable output display for an agent session."""

from __future__ import annotations

import logging

from textual.app import ComposeResult
from textual.message import Message
from textual.widget import Widget
from textual.widgets import RichLog, LoadingIndicator, Static
from textual import work

_log = logging.getLogger("litter_tui.session_view")


class TodoWriteDetected(Message):
    """Fired when a TodoWrite tool_use block is detected in the stream."""

    def __init__(self, todos: list[dict]) -> None:
        super().__init__()
        self.todos = todos


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

    # How often (seconds) to flush buffered text to the RichLog during streaming.
    _FLUSH_INTERVAL = 0.1

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
        self._stream_buffer: list[str] = []

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
        """Start streaming output from an AgentSession.

        The session object is expected to have a ``stream_response()``
        async iterator method.
        """
        _log.info("connect_session called, session=%r", session)
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
        """Add *text* to the display as a complete block (one RichLog.write call)."""
        try:
            log = self.query_one(RichLog)
            log.write(text)
            if not self._user_scrolled_up:
                log.scroll_end(animate=False)
        except Exception:
            pass

    def _flush_stream_buffer(self) -> None:
        """Flush accumulated streaming text to the RichLog as a single block."""
        if not self._stream_buffer:
            return
        text = "".join(self._stream_buffer)
        self._stream_buffer.clear()
        if text:
            self.append_output(text)

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
        """Background worker that reads from the session and appends output.

        Buffers text chunks and flushes them periodically so the RichLog
        gets complete paragraphs instead of one-word-per-line entries.
        """
        session = self._session
        if session is None:
            _log.warning("_stream_session: session is None, returning")
            return

        _log.info(
            "_stream_session: starting to stream, session.status=%s, "
            "session._connected=%s, session._client=%r",
            session.status, session._connected, session._client,
        )
        try:
            chunk_count = 0
            async for chunk in session.stream_response():
                if not self._streaming:
                    _log.info("_stream_session: streaming stopped by flag")
                    break
                chunk_count += 1
                if chunk_count <= 3:
                    _log.info("_stream_session: chunk #%d type=%s", chunk_count, type(chunk).__name__)
                if isinstance(chunk, str) and chunk:
                    self._stream_buffer.append(chunk)
                    # Flush on newlines or when buffer gets large
                    if "\n" in chunk or len(self._stream_buffer) > 50:
                        self._flush_stream_buffer()
                elif isinstance(chunk, dict):
                    # Flush any pending text before tool output
                    self._flush_stream_buffer()
                    chunk_type = chunk.get("type")
                    if chunk_type == "tool_start":
                        self.append_output(f"\n[dim][Using {chunk['name']}...][/dim]")
                    elif chunk_type == "tool_done":
                        self.append_output(" [dim]done[/dim]\n")
                        # Detect TodoWrite tool calls
                        if chunk.get("name") == "TodoWrite":
                            todos = chunk.get("input", {}).get("todos", [])
                            if todos:
                                self.post_message(TodoWriteDetected(todos))
            _log.info("_stream_session: stream ended, total chunks=%d", chunk_count)
        except Exception as exc:
            _log.exception("_stream_session: exception: %s", exc)
            self._flush_stream_buffer()
            self.append_output(f"\n[red]Stream error: {exc}[/red]\n")
        finally:
            # Flush any remaining buffered text
            self._flush_stream_buffer()
            self._set_idle()
            self._streaming = False

    # ------------------------------------------------------------------
    # Scroll tracking
    # ------------------------------------------------------------------

    def on_rich_log_scroll(self) -> None:
        """Track whether the user has scrolled up."""
        try:
            log = self.query_one(RichLog)
            self._user_scrolled_up = not log.is_vertical_scroll_end
        except Exception:
            pass
