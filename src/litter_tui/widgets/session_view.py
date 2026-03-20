"""SessionView widget — scrollable output display for an agent session."""

from __future__ import annotations

import logging
import re

from textual.app import ComposeResult
from textual.message import Message
from textual.selection import Selection
from textual.widget import Widget
from textual.widgets import RichLog, LoadingIndicator, Static
from textual import work

_log = logging.getLogger("litter_tui.session_view")

# Regex to strip Rich markup tags like [bold], [/bold], [dim], [red], etc.
_MARKUP_RE = re.compile(r"\[/?[a-zA-Z0-9_ #=,.\-]+\]")


class SelectableLog(RichLog):
    """RichLog subclass that supports text selection and copying.

    The stock RichLog's ``get_selection`` returns ``None`` because
    ``_render()`` yields a ``RichVisual`` (not ``Text``/``Content``).

    This subclass maintains a parallel plain-text buffer and overrides
    ``get_selection`` to extract from it, enabling ``Ctrl+C`` / ``Cmd+C``
    copy via the Screen's ``action_copy_text`` binding.
    """

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._plain_lines: list[str] = []

    def write_with_text(self, markup_text: str) -> None:
        """Write *markup_text* to the log and store its plain-text form."""
        plain = _MARKUP_RE.sub("", markup_text).replace("\\[", "[")
        self._plain_lines.extend(plain.splitlines() or [""])
        self.write(markup_text)

    def get_selection(self, selection: Selection) -> tuple[str, str] | None:
        """Extract selected text from the plain-text buffer."""
        if not self._plain_lines:
            return None
        text = "\n".join(self._plain_lines)
        return selection.extract(text), "\n"

    def clear(self) -> None:  # type: ignore[override]
        self._plain_lines.clear()
        return super().clear()


# ------------------------------------------------------------------
# Module-level helpers for tool rendering
# ------------------------------------------------------------------


def _format_tool_input(tool_name: str, input_dict: dict) -> str:
    """Return a one-line summary of the tool's input arguments."""
    if not input_dict:
        return ""
    name = tool_name.lower()
    if name == "bash":
        cmd = input_dict.get("command", "")
        return cmd[:80] + ("..." if len(cmd) > 80 else "")
    if name == "read":
        return input_dict.get("file_path", "")
    if name in ("write", "edit"):
        return input_dict.get("file_path", "")
    if name == "grep":
        pattern = input_dict.get("pattern", "")
        path = input_dict.get("path", "")
        return f"{pattern} {path}".strip()
    if name == "glob":
        return input_dict.get("pattern", "")
    if name == "agent":
        return input_dict.get("description", "")
    return ""


def _truncate_tool_output(content: str, max_lines: int = 4) -> str:
    """Truncate long tool output, showing first 2 + last 1 lines with a collapse indicator."""
    if not content:
        return ""
    lines = content.splitlines()
    if len(lines) <= max_lines:
        return content
    # Show first 2 lines and last 1 line
    head = lines[:2]
    tail = lines[-1:]
    hidden = len(lines) - 3
    return "\n".join(head + [f"  ... +{hidden} lines ..."] + tail)


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
        self._output_history: list[str] = []
        self._last_tool_name: str = ""
        self._last_tool_input: dict = {}

    def compose(self) -> ComposeResult:
        header_text = self._make_header_text()
        yield Static(header_text, classes="session-header")
        yield SelectableLog(highlight=True, markup=True, classes="session-output")
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

    def update_header(
        self,
        agent_name: str = "",
        team: str = "",
        model: str = "",
        cwd: str = "",
        agent_type: str = "",
        color: str = "",
    ) -> None:
        """Update the header bar with agent metadata."""
        # Map color names to Rich color names
        _color_map = {
            "blue": "dodger_blue1",
            "green": "green3",
            "yellow": "yellow3",
            "purple": "medium_purple",
            "orange": "dark_orange",
            "pink": "hot_pink",
            "red": "red1",
            "cyan": "cyan",
        }
        rich_color = _color_map.get(color, "")

        parts: list[str] = []
        if agent_name:
            if rich_color:
                parts.append(f"[bold {rich_color}]{agent_name}[/bold {rich_color}]")
            else:
                parts.append(f"[bold]{agent_name}[/bold]")
        if team:
            parts.append(f"[dim]team:[/dim] {team}")

        # Model badge
        if model:
            low = model.lower()
            if "opus" in low:
                badge = "O"
            elif "haiku" in low:
                badge = "H"
            else:
                badge = "S"
            parts.append(f"[dim]model:[/dim] {badge}")

        # Agent type badge
        if agent_type and agent_type not in ("general-purpose",):
            if rich_color:
                parts.append(f"[{rich_color}]{agent_type}[/{rich_color}]")
            else:
                parts.append(f"[dim]{agent_type}[/dim]")

        # CWD / project path (shortened)
        if cwd:
            home = str(__import__("pathlib").Path.home())
            display_cwd = cwd.replace(home, "~") if cwd.startswith(home) else cwd
            parts.append(f"[dim]{display_cwd}[/dim]")

        header = "  |  ".join(parts) if parts else "Session"
        try:
            self.query_one(".session-header", Static).update(header)
        except Exception:
            pass

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
            self._output_history.append(text)
            log = self.query_one(SelectableLog)
            log.write_with_text(text)
            if not self._user_scrolled_up:
                log.scroll_end(animate=False)
        except Exception:
            pass

    def get_output_history(self) -> list[str]:
        """Return a copy of all output written to this view."""
        return list(self._output_history)

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
        self._output_history.clear()
        try:
            self.query_one(SelectableLog).clear()
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Tool rendering
    # ------------------------------------------------------------------

    def render_tool_chunk(self, chunk: dict) -> None:
        """Centralized rendering for tool_start, tool_done, tool_result, and api_retry chunks."""
        chunk_type = chunk.get("type")

        if chunk_type == "tool_start":
            name = chunk.get("name", "?")
            self._last_tool_name = name
            self._last_tool_input = {}
            self.append_output(f"\n[bold dim]{name}[/bold dim]")

        elif chunk_type == "tool_done":
            name = chunk.get("name", self._last_tool_name)
            input_dict = chunk.get("input", {})
            self._last_tool_input = input_dict
            summary = _format_tool_input(name, input_dict)
            if summary:
                # Escape Rich markup in user content
                safe = summary.replace("[", "\\[")
                self.append_output(f"[dim]({safe})[/dim]")
            # Detect TodoWrite tool calls
            if name == "TodoWrite":
                todos = input_dict.get("todos", [])
                if todos:
                    self.post_message(TodoWriteDetected(todos))

        elif chunk_type == "tool_result":
            content = chunk.get("content", "")
            is_error = chunk.get("is_error", False)
            if content:
                truncated = _truncate_tool_output(str(content))
                if is_error:
                    self.append_output(f"\n[red]{truncated}[/red]")
                else:
                    # Indent and dim the output snippet
                    indented = "\n".join(f"  {line}" for line in truncated.splitlines())
                    self.append_output(f"\n[dim]{indented}[/dim]")
            self.append_output("")  # blank line after tool output

        elif chunk_type == "api_retry":
            attempt = chunk.get("attempt", "?")
            error = chunk.get("error", "unknown")
            status = chunk.get("status", "?")
            self.append_output(
                f"\n[yellow]API retry #{attempt} (HTTP {status}: {error})[/yellow]"
            )

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
                    self.render_tool_chunk(chunk)
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
            log = self.query_one(SelectableLog)
            self._user_scrolled_up = not log.is_vertical_scroll_end
        except Exception:
            pass
