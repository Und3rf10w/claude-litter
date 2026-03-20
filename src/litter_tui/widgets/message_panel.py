"""MessagePanel widget — slide-out inbox/broadcast viewer with compose form."""

from __future__ import annotations

from textual.app import ComposeResult
from textual.message import Message
from textual.widget import Widget
from textual.widgets import Button, Input, Label, ListItem, ListView, Select, Static
from textual.containers import Horizontal, Vertical


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

MessagePanel .msg-view-toggle {
    height: 3;
    background: $panel;
    padding: 0 1;
}

MessagePanel .msg-list-container {
    height: 1fr;
}

MessagePanel .msg-item {
    padding: 0 1;
    border-bottom: solid $panel;
    min-height: 4;
}

MessagePanel .msg-item-unread {
    background: $boost;
    text-style: bold;
}

MessagePanel .msg-sender {
    text-style: bold;
}

MessagePanel .msg-timestamp {
    color: $text-muted;
}

MessagePanel .msg-compose {
    height: auto;
    max-height: 8;
    background: $panel;
    padding: 1;
    border-top: solid $primary;
}

MessagePanel .compose-row {
    height: 3;
    margin-bottom: 1;
}
"""


class MessageComposed(Message):
    """Fired when user sends a message."""

    def __init__(self, to: str, text: str) -> None:
        super().__init__()
        self.to = to
        self.text = text


class _MessageItem(ListItem):
    """A single message row."""

    def __init__(self, msg: dict) -> None:
        super().__init__()
        self._msg_data = msg

    def compose(self) -> ComposeResult:
        sender = self._msg_data.get("from", self._msg_data.get("sender", "unknown"))
        text = self._msg_data.get("text", self._msg_data.get("message", ""))
        timestamp = self._msg_data.get("timestamp", self._msg_data.get("time", ""))
        read = self._msg_data.get("read", True)

        item_class = "msg-item"
        if not read:
            item_class += " msg-item-unread"

        with Vertical(classes=item_class):
            with Horizontal():
                yield Label(sender, classes="msg-sender", markup=False)
                if timestamp:
                    yield Label(f"  {timestamp}", classes="msg-timestamp", markup=False)
            yield Label(text, markup=False)


class MessagePanel(Widget):
    """Slide-out message panel from the right side of the screen.

    Shows inbox or broadcast feed, with a compose form at the bottom.
    Posts MessageComposed messages when user sends.
    """

    DEFAULT_CSS = DEFAULT_CSS

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._all_messages: list[dict] = []
        self._broadcast_messages: list[dict] = []
        self._show_broadcasts: bool = False
        self._visible: bool = False
        self._team: str = ""
        self._agent: str = ""
        self._known_agents: list[str] = []

    def compose(self) -> ComposeResult:
        yield Static("Messages", classes="msg-panel-title")
        with Horizontal(classes="msg-view-toggle"):
            yield Button("Inbox", id="view-inbox", variant="primary")
            yield Button("Broadcast", id="view-broadcast")
        with Vertical(classes="msg-list-container"):
            yield ListView(id="msg-list")
        with Vertical(classes="msg-compose"):
            yield Label("Compose")
            with Horizontal(classes="compose-row"):
                yield Select(
                    options=[],
                    prompt="To...",
                    id="compose-to",
                    allow_blank=True,
                )
            with Horizontal(classes="compose-row"):
                yield Input(placeholder="Message...", id="compose-text")
                yield Button("Send", id="send-btn", variant="primary")

    def _refresh_list(self) -> None:
        msg_list = self.query_one("#msg-list", ListView)
        msg_list.clear()
        messages = (
            self._broadcast_messages if self._show_broadcasts else self._all_messages
        )
        for msg in messages:
            msg_list.append(_MessageItem(msg))

    def update_messages(self, messages: list) -> None:
        """Refresh the inbox with new messages."""
        if self._show_broadcasts:
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
        self.query_one(".msg-panel-title", Static).update(
            f"Messages — {agent}"
        )

    def _update_to_dropdown(self) -> None:
        """Refresh the To dropdown with known agents."""
        select = self.query_one("#compose-to", Select)
        options = [(name, name) for name in self._known_agents if name != self._agent]
        select.set_options(options)

    def set_known_agents(self, agents: list[str]) -> None:
        """Populate the To dropdown with agent names."""
        self._known_agents = agents
        self._update_to_dropdown()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        button_id = event.button.id

        if button_id == "view-inbox":
            self._show_broadcasts = False
            self.query_one("#view-inbox", Button).variant = "primary"
            self.query_one("#view-broadcast", Button).variant = "default"
            self._refresh_list()

        elif button_id == "view-broadcast":
            self._show_broadcasts = True
            self.query_one("#view-inbox", Button).variant = "default"
            self.query_one("#view-broadcast", Button).variant = "primary"
            self._refresh_list()

        elif button_id == "send-btn":
            to_select = self.query_one("#compose-to", Select)
            text_input = self.query_one("#compose-text", Input)
            to_value = str(to_select.value) if to_select.value is not None and to_select.value != Select.BLANK else ""
            text_value = text_input.value.strip()
            if to_value and text_value:
                self.post_message(MessageComposed(to=to_value, text=text_value))
                text_input.value = ""
