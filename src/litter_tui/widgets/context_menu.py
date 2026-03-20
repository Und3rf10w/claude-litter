"""ContextMenu widget — floating right-click menu for agent/tab actions."""

from __future__ import annotations

from textual.geometry import Offset
from textual.message import Message
from textual.widgets import OptionList
from textual.widgets.option_list import Option


class ContextMenu(OptionList):
    """A floating context menu that appears on right-click.

    Uses ``overlay: screen`` + ``absolute_offset`` for cursor-relative
    positioning (the same mechanism Textual's Tooltip uses).
    """

    DEFAULT_CSS = """
    ContextMenu {
        layer: _default;
        overlay: screen;
        constrain: inside inflect;
        width: auto;
        max-width: 40;
        height: auto;
        max-height: 12;
        display: none;
        background: $surface;
        border: tall $border;
    }
    ContextMenu.-visible { display: block; }
    """

    class ActionSelected(Message):
        """Emitted when the user picks a menu item."""

        def __init__(self, action: str, team: str, agent: str) -> None:
            super().__init__()
            self.action = action
            self.team = team
            self.agent = agent

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._team = ""
        self._agent = ""

    def show_at(self, team: str, agent: str, x: int, y: int) -> None:
        """Populate and display agent context menu near *x*, *y*."""
        self._team = team
        self._agent = agent
        self.clear_options()
        self.add_option(Option("View Chat Log", id="view"))
        self.add_option(Option("Send Message", id="message"))
        self.add_option(Option("Configure", id="configure"))
        self.add_option(Option("Kill Agent", id="kill"))
        self.add_option(Option("Detach Session", id="detach"))
        self.add_option(Option("Duplicate Agent", id="duplicate"))
        self.absolute_offset = Offset(x, y)
        self.add_class("-visible")
        self.focus()

    def show_tab_menu_at(self, team: str, agent: str, x: int, y: int) -> None:
        """Populate and display tab context menu near *x*, *y*."""
        self._team = team
        self._agent = agent
        self.clear_options()
        self.add_option(Option("Close", id="tab_close"))
        self.add_option(Option("Close Others", id="tab_close_others"))
        self.add_option(Option("Close to the Right", id="tab_close_right"))
        self.add_option(Option("Close All", id="tab_close_all"))
        self.absolute_offset = Offset(x, y)
        self.add_class("-visible")
        self.focus()

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        event.stop()
        self.remove_class("-visible")
        option = event.option
        self.post_message(
            self.ActionSelected(option.id or "", self._team, self._agent)
        )

    def on_blur(self) -> None:
        self.remove_class("-visible")

    def on_key(self, event) -> None:
        if event.key == "escape":
            self.remove_class("-visible")
            event.stop()
