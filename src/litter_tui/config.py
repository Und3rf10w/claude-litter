"""Configuration dataclass for litter-tui."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path


_DEFAULT_CONFIG_PATH = Path.home() / ".claude" / "litter-tui" / "config.json"


@dataclass
class Config:
    """Application configuration."""

    claude_home: Path = field(default_factory=lambda: Path.home() / ".claude")
    vim_mode: bool = False
    theme: str = "dark"

    @classmethod
    def load(cls, path: Path | None = None) -> "Config":
        """Load config from disk; return defaults on missing or corrupt file."""
        config_path = path or _DEFAULT_CONFIG_PATH
        if not config_path.exists():
            return cls()
        try:
            data = json.loads(config_path.read_text())
            if "claude_home" in data:
                data["claude_home"] = Path(data["claude_home"])
            known = {k: v for k, v in data.items() if k in cls.__dataclass_fields__}
            return cls(**known)
        except Exception:
            return cls()

    def save(self, path: Path | None = None) -> None:
        """Persist config to disk."""
        config_path = path or _DEFAULT_CONFIG_PATH
        config_path.parent.mkdir(parents=True, exist_ok=True)
        data = asdict(self)
        data["claude_home"] = str(data["claude_home"])
        config_path.write_text(json.dumps(data, indent=2))
