from __future__ import annotations

from pathlib import Path

# Color name -> Rich color name mapping (used for inbox sender badges and session headers)
COLOR_MAP = {
    "blue": "dodger_blue1",
    "green": "green3",
    "yellow": "yellow3",
    "purple": "medium_purple",
    "orange": "dark_orange",
    "pink": "hot_pink",
    "red": "red1",
    "cyan": "cyan",
}


def safe_path(root: Path, *parts: str) -> Path:
    """Resolve a path under *root*, raising ValueError on traversal attempts."""
    result = root.joinpath(*parts).resolve()
    if not result.is_relative_to(root.resolve()):
        raise ValueError(f"Path traversal attempt: {parts!r}")
    return result
