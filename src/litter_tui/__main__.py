"""Command-line entry point for litter-tui."""
from __future__ import annotations

import argparse


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
    args = parser.parse_args()

    from litter_tui.app import LitterTuiApp
    from litter_tui.config import Config

    config = Config(vim_mode=args.vim, theme=args.theme)
    app = LitterTuiApp(config=config)
    app.run()


if __name__ == "__main__":
    main()
