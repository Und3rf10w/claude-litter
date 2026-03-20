"""Read and expose Claude Code settings from ~/.claude/settings.json."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path


_SETTINGS_PATH = Path.home() / ".claude" / "settings.json"


@dataclass(frozen=True)
class ClaudeSettings:
    """Resolved Claude Code settings (read-only snapshot)."""

    model: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    raw: dict = field(default_factory=dict)

    # Convenience accessors for commonly checked env vars
    @property
    def base_url(self) -> str | None:
        return self.env.get("ANTHROPIC_BASE_URL")

    @property
    def auth_token(self) -> str | None:
        return self.env.get("ANTHROPIC_AUTH_TOKEN")

    @property
    def opus_model(self) -> str | None:
        return self.env.get("ANTHROPIC_DEFAULT_OPUS_MODEL")

    @property
    def sonnet_model(self) -> str | None:
        return self.env.get("ANTHROPIC_DEFAULT_SONNET_MODEL")

    @property
    def haiku_model(self) -> str | None:
        return self.env.get("ANTHROPIC_DEFAULT_HAIKU_MODEL")

    @property
    def subagent_model(self) -> str | None:
        return self.env.get("CLAUDE_CODE_SUBAGENT_MODEL")

    @classmethod
    def load(cls, path: Path | None = None) -> "ClaudeSettings":
        """Load settings from disk.  Returns empty defaults on failure."""
        settings_path = path or _SETTINGS_PATH
        try:
            data = json.loads(settings_path.read_text())
        except (OSError, json.JSONDecodeError, TypeError):
            return cls()

        return cls(
            model=data.get("model") or None,
            env=data.get("env") or {},
            raw=data,
        )
