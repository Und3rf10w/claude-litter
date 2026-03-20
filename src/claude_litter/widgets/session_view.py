"""SessionView widget — scrollable output display for an agent session."""

from __future__ import annotations

import logging
import subprocess
import sys

from rich.segment import Segment
from rich.style import Style as RichStyle

from textual.app import ComposeResult
from textual.events import MouseDown
from textual.message import Message
from textual.selection import Selection
from textual.strip import Strip
from textual.widget import Widget
from textual.widgets import RichLog, LoadingIndicator, Static
from textual import work

_log = logging.getLogger("claude_litter.session_view")


class SelectableLog(RichLog):
    """RichLog subclass with full mouse-drag text selection and copy support.

    Stock RichLog cannot:
    - visually highlight selected text (render_line skips selection styling)
    - map mouse coordinates to text positions (missing apply_offsets)
    - extract selected text for clipboard (get_selection returns None)

    This subclass fixes all three by maintaining a parallel plain-text buffer
    and overriding the render pipeline to apply selection highlights and offsets.
    """

    ALLOW_SELECT = True

    @property
    def allow_select(self) -> bool:
        return True

    def write_with_text(self, markup_text: str) -> None:
        """Write *markup_text* to the log (kept for API compat)."""
        self.write(markup_text)

    def get_selection(self, selection: Selection) -> tuple[str, str] | None:
        """Extract selected plain text from the rendered strips."""
        if not self.lines:
            return None
        text = "\n".join(strip.text for strip in self.lines)
        return selection.extract(text), "\n"

    def selection_updated(self, selection: Selection | None) -> None:
        """Clear render cache and repaint when selection changes."""
        self._line_cache.clear()
        self.refresh()

    def render_line(self, y: int) -> Strip:
        """Render a line with selection highlighting and coordinate offsets."""
        scroll_x, scroll_y = self.scroll_offset
        abs_y = scroll_y + y
        width = self.scrollable_content_region.width

        if abs_y >= len(self.lines):
            return Strip.blank(width, self.rich_style)

        selection = self.text_selection

        # Check cache only when no active selection
        cache_key = (abs_y + self._start_line, scroll_x, width, self._widest_line_width)
        if selection is None and cache_key in self._line_cache:
            strip = self._line_cache[cache_key]
            strip = strip.apply_style(self.rich_style)
            strip = strip.apply_offsets(scroll_x, abs_y)
            return strip

        strip = self.lines[abs_y]
        strip = strip.crop_extend(scroll_x, scroll_x + width, self.rich_style)

        # Apply selection highlight over the cropped strip
        if selection is not None:
            span = selection.get_span(abs_y)
            if span is not None:
                sel_start, sel_end = span
                # Adjust for horizontal scroll
                sel_start = max(0, sel_start - scroll_x)
                if sel_end == -1:
                    sel_end = width
                else:
                    sel_end = max(0, sel_end - scroll_x)
                if sel_start < sel_end:
                    sel_style = self.screen.get_component_rich_style(
                        "screen--selection"
                    )
                    strip = _apply_selection_to_strip(strip, sel_start, sel_end, sel_style)

        if selection is None:
            self._line_cache[cache_key] = strip

        strip = strip.apply_style(self.rich_style)
        strip = strip.apply_offsets(scroll_x, abs_y)
        return strip

    def clear(self) -> None:  # type: ignore[override]
        return super().clear()

    def on_mouse_down(self, event: MouseDown) -> None:
        """Right-click copies selected text to clipboard."""
        if event.button == 3:
            event.stop()
            event.prevent_default()
            selected = self.screen.get_selected_text()
            if selected:
                self.app.copy_to_clipboard(selected)
                _copy_to_system_clipboard(selected)
                self.app.notify("Copied to clipboard", timeout=2)
            else:
                # Copy all visible text as fallback
                all_text = "\n".join(strip.text for strip in self.lines)
                if all_text.strip():
                    self.app.copy_to_clipboard(all_text)
                    _copy_to_system_clipboard(all_text)
                    self.app.notify("Copied all text to clipboard", timeout=2)


def _copy_to_system_clipboard(text: str) -> None:
    """Copy text to the system clipboard using platform-native tools."""
    try:
        if sys.platform == "darwin":
            subprocess.run(
                ["pbcopy"], input=text.encode("utf-8"), check=True, timeout=2
            )
        elif sys.platform == "linux":
            # Try xclip first, then xsel
            try:
                subprocess.run(
                    ["xclip", "-selection", "clipboard"],
                    input=text.encode("utf-8"),
                    check=True,
                    timeout=2,
                )
            except FileNotFoundError:
                subprocess.run(
                    ["xsel", "--clipboard", "--input"],
                    input=text.encode("utf-8"),
                    check=True,
                    timeout=2,
                )
    except Exception:
        pass  # Silently fail — OSC 52 is the primary mechanism


def _apply_selection_to_strip(
    strip: Strip, start: int, end: int, style: RichStyle
) -> Strip:
    """Apply a highlight style to a character range within a Strip."""
    new_segments: list[Segment] = []
    col = 0
    for segment in strip._segments:
        text = segment.text
        seg_len = segment.cell_length
        seg_end = col + seg_len

        if seg_end <= start or col >= end:
            # Entirely outside selection
            new_segments.append(segment)
        elif col >= start and seg_end <= end:
            # Entirely inside selection
            new_segments.append(
                Segment(text, (segment.style or RichStyle()) + style, segment.control)
            )
        else:
            # Partial overlap — split character by character
            for i, ch in enumerate(text):
                ch_col = col + i
                if start <= ch_col < end:
                    new_segments.append(
                        Segment(ch, (segment.style or RichStyle()) + style, segment.control)
                    )
                else:
                    new_segments.append(Segment(ch, segment.style, segment.control))
        col = seg_end

    return Strip(new_segments, strip.cell_length)


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
