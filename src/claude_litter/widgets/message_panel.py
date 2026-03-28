"""MessagePanel widget — slide-out inbox/broadcast viewer with compose form."""

from __future__ import annotations

from rich.markdown import Markdown
from rich.markup import escape as rich_escape

from textual.app import ComposeResult
from textual.containers import Vertical, VerticalScroll
from textual.message import Message
from textual.widget import Widget
from textual.widgets import (
    Button,
    Checkbox,
    Collapsible,
    Label,
    Select,
    Static,
    TabbedContent,
    TabPane,
    TextArea,
)


DEFAULT_CSS = """
MessagePanel {
    width: 35%;
    height: 100%;
    offset-x: 100%;
    transition: offset 300ms;
    background: $surface;
    border-left: solid $primary;
    layer: overlay;
    dock: right;
}

MessagePanel.-visible {
    offset-x: 0;
}

MessagePanel .msg-panel-title {
    background: $primary;
    color: $text;
    text-align: center;
    height: 2;
    padding: 0 1;
}

MessagePanel #msg-tabs {
    height: 1fr;
}

MessagePanel .msg-list-container {
    height: 1fr;
}

MessagePanel CollapsibleTitle {
    width: 1fr;
}

MessagePanel Collapsible {
    border-bottom: solid $panel;
    padding: 0;
    background: $surface;
}

MessagePanel .msg-unread > CollapsibleTitle {
    text-style: bold;
    background: $boost;
}

MessagePanel .msg-detail-header {
    color: $text-muted;
    padding: 0 1;
    height: auto;
    width: 1fr;
}

MessagePanel .msg-text {
    width: 1fr;
    padding: 0 1;
}

MessagePanel .msg-compose {
    height: 1fr;
    padding: 1;
}

MessagePanel .compose-from {
    color: $text-muted;
    height: 1;
}

MessagePanel #compose-to {
    height: 3;
}

MessagePanel #compose-text {
    height: 1fr;
    min-height: 3;
}

MessagePanel #send-btn {
    width: 100%;
    margin-top: 1;
}
"""


class MessageComposed(Message):
    """Fired when user sends a message."""

    def __init__(self, to: str, text: str, *, broadcast: bool = False) -> None:
        super().__init__()
        self.to = to
        self.text = text
        self.broadcast = broadcast


def _make_message_collapsible(msg: dict) -> Collapsible:
    """Build a Collapsible widget for a single inbox/broadcast message."""
    sender = msg.get("from", msg.get("sender", "unknown"))
    text = msg.get("text", msg.get("message", ""))
    timestamp = msg.get("timestamp", msg.get("time", ""))
    read = msg.get("read", False)
    summary = msg.get("summary", "")

    # Build collapsed title: unread dot + sender + summary/preview
    unread_dot = "\u25cf " if not read else ""
    safe_sender = rich_escape(sender)
    preview = summary or (text[:80] + "\u2026" if len(text) > 80 else text)
    # Replace newlines in preview for a single-line title
    preview = preview.replace("\n", " ").strip()
    safe_preview = rich_escape(preview)
    title = f"{unread_dot}[bold]{safe_sender}[/bold]: {safe_preview}"

    # Build expanded content
    meta_parts = [f"From: {sender}"]
    if timestamp:
        meta_parts.append(timestamp)
    meta_parts.append("read" if read else "unread")
    meta_label = Label("  |  ".join(meta_parts), classes="msg-detail-header", markup=False)

    children: list[Widget] = [meta_label]
    if text.strip():
        try:
            renderable: str | Markdown = Markdown(text)
        except Exception:
            renderable = text
        children.append(Static(renderable, classes="msg-text", markup=False))

    classes = "msg-unread" if not read else ""
    return Collapsible(
        *children,
        title=title,
        collapsed=True,
        classes=classes,
    )


class MessagePanel(Widget):
    """Slide-out message panel with tabbed Inbox/Send views.

    Shows collapsible message items for reading, and a compose form for sending.
    Posts MessageComposed messages when user sends.
    """

    DEFAULT_CSS = DEFAULT_CSS

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._all_messages: list[dict] = []
        self._broadcast_messages: list[dict] = []
        self._visible: bool = False
        self._team: str = ""
        self._agent: str = ""
        self._known_agents: list[str] = []

    def compose(self) -> ComposeResult:
        yield Static("Messages", classes="msg-panel-title")
        with TabbedContent(id="msg-tabs"):
            with TabPane("Inbox", id="tab-inbox"):
                yield VerticalScroll(id="inbox-list", classes="msg-list-container")
            with TabPane("Send", id="tab-send"):
                with Vertical(classes="msg-compose"):
                    yield Label("From:", id="compose-from-label", classes="compose-from")
                    yield Checkbox("Broadcast to all", id="compose-broadcast")
                    yield Select(
                        options=[],
                        prompt="To...",
                        id="compose-to",
                        allow_blank=True,
                    )
                    yield TextArea("", id="compose-text")
                    yield Button("Send", id="send-btn", variant="primary")

    def _refresh_list(self) -> None:
        try:
            inbox = self.query_one("#inbox-list", VerticalScroll)
        except Exception:
            return  # not mounted yet

        inbox.remove_children()
        # Show broadcast messages first (if any), then regular inbox
        for msg in self._broadcast_messages:
            inbox.mount(_make_message_collapsible(msg))
        for msg in self._all_messages:
            inbox.mount(_make_message_collapsible(msg))

    def update_messages(self, messages: list, *, broadcast: bool = False) -> None:
        """Refresh the inbox or broadcast list with new messages.

        Args:
            messages: The list of message dicts to store.
            broadcast: When True, update the broadcast feed; otherwise update inbox.
        """
        if broadcast:
            self._broadcast_messages = messages
        else:
            self._all_messages = messages
        self._refresh_list()

    def toggle(self) -> None:
        """Show or hide the panel."""
        self._visible = not self._visible
        self.toggle_class("-visible")

    def set_agent(self, team: str, agent: str) -> None:
        """Switch whose inbox to display."""
        self._team = team
        self._agent = agent
        try:
            self.query_one(".msg-panel-title", Static).update(
                f"Messages \u2014 {agent}"
            )
            self.query_one("#compose-from-label", Label).update(f"From: {agent}")
        except Exception:
            pass  # not yet mounted

    def _update_to_dropdown(self) -> None:
        """Refresh the To dropdown with known agents."""
        select = self.query_one("#compose-to", Select)
        options = [(name, name) for name in self._known_agents if name != self._agent]
        select.set_options(options)

    def set_known_agents(self, agents: list[str]) -> None:
        """Populate the To dropdown with agent names."""
        self._known_agents = agents
        self._update_to_dropdown()

    def on_checkbox_changed(self, event: Checkbox.Changed) -> None:
        if event.checkbox.id == "compose-broadcast":
            select = self.query_one("#compose-to", Select)
            select.disabled = event.value

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "send-btn":
            broadcast_cb = self.query_one("#compose-broadcast", Checkbox)
            to_select = self.query_one("#compose-to", Select)
            text_area = self.query_one("#compose-text", TextArea)
            text_value = text_area.text.strip()
            if not text_value:
                return

            if broadcast_cb.value:
                self.post_message(
                    MessageComposed(to="", text=text_value, broadcast=True)
                )
                text_area.clear()
            else:
                raw = to_select.value
                to_value = str(raw) if isinstance(raw, str) else ""
                if to_value:
                    self.post_message(MessageComposed(to=to_value, text=text_value))
                    text_area.clear()
