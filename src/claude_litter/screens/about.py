"""AboutScreen — modal 'About' dialog."""

from __future__ import annotations

import webbrowser

from textual.app import ComposeResult
from textual.screen import ModalScreen
from textual.widgets import Static
from textual.containers import Vertical

_REPO_URL = "https://github.com/Und3rf10w/claude-litter"

_TITLE_ART = r"""
 ▄████▄   ██▓    ▄▄▄       █    ██ ▓█████▄ ▓█████  ██▓     ██▓▄▄▄█████▓▄▄▄█████▓▓█████  ██▀███  
▒██▀ ▀█  ▓██▒   ▒████▄     ██  ▓██▒▒██▀ ██▌▓█   ▀ ▓██▒    ▓██▒▓  ██▒ ▓▒▓  ██▒ ▓▒▓█   ▀ ▓██ ▒ ██▒
▒▓█    ▄ ▒██░   ▒██  ▀█▄  ▓██  ▒██░░██   █▌▒███   ▒██░    ▒██▒▒ ▓██░ ▒░▒ ▓██░ ▒░▒███   ▓██ ░▄█ ▒
▒▓▓▄ ▄██▒▒██░   ░██▄▄▄▄██ ▓▓█  ░██░░▓█▄   ▌▒▓█  ▄ ▒██░    ░██░░ ▓██▓ ░ ░ ▓██▓ ░ ▒▓█  ▄ ▒██▀▀█▄  
▒ ▓███▀ ░░██████▒▓█   ▓██▒▒▒█████▓ ░▒████▓ ░▒████▒░██████▒░██░  ▒██▒ ░   ▒██▒ ░ ░▒████▒░██▓ ▒██▒
░ ░▒ ▒  ░░ ▒░▓  ░▒▒   ▓▒█░░▒▓▒ ▒ ▒  ▒▒▓  ▒ ░░ ▒░ ░░ ▒░▓  ░░▓    ▒ ░░     ▒ ░░   ░░ ▒░ ░░ ▒▓ ░▒▓░
  ░  ▒   ░ ░ ▒  ░ ▒   ▒▒ ░░░▒░ ░ ░  ░ ▒  ▒  ░ ░  ░░ ░ ▒  ░ ▒ ░    ░        ░     ░ ░  ░  ░▒ ░ ▒░
░          ░ ░    ░   ▒    ░░░ ░ ░  ░ ░  ░    ░     ░ ░    ▒ ░  ░        ░         ░     ░░   ░ 
░ ░          ░  ░     ░  ░   ░        ░       ░  ░    ░  ░ ░                       ░  ░   ░     
░                                   ░
"""


class _RepoLink(Static):
    """Clickable repo link that opens in the browser."""

    DEFAULT_CSS = """
    _RepoLink {
        text-align: center;
        width: 100%;
        margin-bottom: 1;
    }
    _RepoLink:hover { text-style: bold; }
    """

    def __init__(self) -> None:
        super().__init__(
            f"Repo: [underline]{_REPO_URL}[/underline]",
        )

    def on_click(self, event) -> None:
        event.stop()
        webbrowser.open(_REPO_URL)


class AboutScreen(ModalScreen[None]):
    """Modal about dialog that dismisses on any key or click outside."""

    DEFAULT_CSS = """
    AboutScreen { align: center middle; }
    #about-box {
        width: 120;
        height: auto;
        padding: 1 2;
        border: thick $primary;
        background: $surface;
    }
    #about-title {
        text-align: center;
        text-style: bold;
        color: $accent;
        width: 100%;
        margin-bottom: 1;
    }
    #about-tagline {
        text-align: center;
        color: $text-muted;
        width: 100%;
    }
    #about-credit {
        text-align: center;
        color: $text-muted;
        width: 100%;
    }
    #about-dismiss {
        text-align: center;
        color: $text-disabled;
        width: 100%;
        margin-top: 1;
    }
    """

    def compose(self) -> ComposeResult:
        with Vertical(id="about-box"):
            yield Static(_TITLE_ART, id="about-title", markup=False)
            yield Static("Helping you manage your litter box", id="about-tagline")
            yield _RepoLink()
            yield Static("From Und3rf10w, with <3", id="about-credit")
            yield Static("Press any key to dismiss", id="about-dismiss")

    def on_key(self, event) -> None:
        self.dismiss(None)
