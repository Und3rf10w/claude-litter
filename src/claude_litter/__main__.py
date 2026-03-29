"""Command-line entry point for claude-litter."""

from __future__ import annotations

import argparse
import logging
from pathlib import Path

from claude_litter import __version__


def _setup_logging(debug: bool = False) -> None:
    """Configure logging. Only writes to file when *debug* is True."""
    if debug:
        log_path = Path.home() / ".claude" / "claude-litter" / "debug.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        logging.basicConfig(
            filename=str(log_path),
            level=logging.DEBUG,
            format="%(asctime)s %(name)s %(levelname)s %(message)s",
            force=True,
        )
        logging.getLogger("claude_litter").setLevel(logging.DEBUG)
    else:
        logging.basicConfig(level=logging.WARNING, force=True)
        logging.getLogger("claude_litter").setLevel(logging.WARNING)


def main() -> None:
    """Parse arguments and launch the claude-litter app."""
    parser = argparse.ArgumentParser(
        prog="claude-litter",
        description="A Textual TUI for managing Claude swarm teams",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__}",
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
        help="Enable debug logging to ~/.claude/claude-litter/debug.log",
    )
    args = parser.parse_args()

    _setup_logging(debug=args.debug)

    from claude_litter.app import ClaudeLitterApp
    from claude_litter.config import Config

    config = Config.load()
    # Override with explicitly-provided CLI flags only
    if args.vim:
        config.vim_mode = True
    if args.theme != "dark":  # "dark" is the argparse default, not an explicit override
        config.theme = args.theme
    app = ClaudeLitterApp(config=config)
    app.run()


if __name__ == "__main__":
    main()
