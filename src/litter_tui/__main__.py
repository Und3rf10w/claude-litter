"""Command-line entry point for litter-tui."""
from __future__ import annotations

import argparse
import logging
from pathlib import Path


def _setup_logging(debug: bool = False) -> None:
    """Configure logging. Only writes to file when *debug* is True."""
    if debug:
        log_path = Path.home() / ".claude" / "litter-tui" / "debug.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        logging.basicConfig(
            filename=str(log_path),
            level=logging.DEBUG,
            format="%(asctime)s %(name)s %(levelname)s %(message)s",
            force=True,
        )
        logging.getLogger("litter_tui").setLevel(logging.DEBUG)
    else:
        logging.basicConfig(level=logging.WARNING, force=True)
        logging.getLogger("litter_tui").setLevel(logging.WARNING)


def main() -> None:
    """Parse arguments and launch the litter-tui app."""
    parser = argparse.ArgumentParser(
        prog="litter-tui",
        description="A Textual TUI for managing Claude swarm teams",
    )
    parser.add_argument(
        "--version",
        action="version",
        version="%(prog)s 0.1.0",
    )
    parser.add_argument(
        "--vim",
        action="store_true",
        default=False,
        help="Enable vim keybindings",
    )
    parser.add_argument(
        "--theme",
        default="dark",
        choices=["dark", "light"],
        help="Color theme (default: dark)",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        default=False,
        help="Enable debug logging to ~/.claude/litter-tui/debug.log",
    )
    args = parser.parse_args()

    _setup_logging(debug=args.debug)

    from litter_tui.app import LitterTuiApp
    from litter_tui.config import Config

    config = Config(vim_mode=args.vim, theme=args.theme)
    app = LitterTuiApp(config=config)
    app.run()


if __name__ == "__main__":
    main()
