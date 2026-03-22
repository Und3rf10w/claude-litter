"""Read and expose Claude Code settings from ~/.claude/settings.json."""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path


_SETTINGS_PATH = Path.home() / ".claude" / "settings.json"
_CACHE_TTL = 30.0

_settings_cache: tuple[float, "ClaudeSettings"] | None = None


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
        """Load settings from disk, with a 30s module-level cache.

        The cache is bypassed when a custom *path* is provided (e.g. in tests).
        Returns empty defaults on read/parse failure.
        """
        global _settings_cache

        if path is None:
            if _settings_cache is not None and time.monotonic() - _settings_cache[0] < _CACHE_TTL:
                return _settings_cache[1]

        settings_path = path or _SETTINGS_PATH
        try:
            data = json.loads(settings_path.read_text())
        except (OSError, json.JSONDecodeError, TypeError):
            result = cls()
        else:
            result = cls(
                model=data.get("model") or None,
                env=data.get("env") or {},
                raw=data,
            )

        if path is None:
            _settings_cache = (time.monotonic(), result)

        return result

    @classmethod
    def clear_cache(cls) -> None:
        """Invalidate the module-level settings cache (useful in tests)."""
        global _settings_cache
        _settings_cache = None
