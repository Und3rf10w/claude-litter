"""Tests for ClaudeSettings service."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from claude_litter.services.claude_settings import ClaudeSettings


@pytest.fixture(autouse=True)
def _clear_cache():
    """Clear the module-level settings cache before and after each test."""
    ClaudeSettings.clear_cache()
    yield
    ClaudeSettings.clear_cache()


def test_load_valid_settings(tmp_path: Path) -> None:
    """Load a valid settings.json and verify fields are populated."""
    settings_file = tmp_path / "settings.json"
    settings_file.write_text(json.dumps({
        "model": "claude-opus-4-6",
        "env": {
            "ANTHROPIC_BASE_URL": "https://api.example.com",
            "ANTHROPIC_AUTH_TOKEN": "sk-test-token",
        },
    }))

    result = ClaudeSettings.load(path=settings_file)

    assert result.model == "claude-opus-4-6"
    assert result.base_url == "https://api.example.com"
    assert result.auth_token == "sk-test-token"
    assert result.raw["model"] == "claude-opus-4-6"


def test_load_missing_file(tmp_path: Path) -> None:
    """Returns empty defaults when the settings file does not exist."""
    missing = tmp_path / "nonexistent.json"

    result = ClaudeSettings.load(path=missing)

    assert result.model is None
    assert result.env == {}
    assert result.raw == {}


def test_load_corrupt_json(tmp_path: Path) -> None:
    """Handles invalid JSON gracefully, returning empty defaults."""
    settings_file = tmp_path / "settings.json"
    settings_file.write_text("{this is not valid json")

    result = ClaudeSettings.load(path=settings_file)

    assert result.model is None
    assert result.env == {}


def test_env_vars_extraction(tmp_path: Path) -> None:
    """Verify env vars are exposed via ClaudeSettings convenience properties."""
    settings_file = tmp_path / "settings.json"
    settings_file.write_text(json.dumps({
        "env": {
            "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-6",
            "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-5",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5",
            "CLAUDE_CODE_SUBAGENT_MODEL": "claude-haiku-4-5",
        },
    }))

    result = ClaudeSettings.load(path=settings_file)

    assert result.opus_model == "claude-opus-4-6"
    assert result.sonnet_model == "claude-sonnet-4-5"
    assert result.haiku_model == "claude-haiku-4-5"
    assert result.subagent_model == "claude-haiku-4-5"
    # model field is absent
    assert result.model is None


def test_custom_path_bypasses_cache(tmp_path: Path) -> None:
    """A custom path argument always re-reads from disk (no caching)."""
    settings_file = tmp_path / "settings.json"
    settings_file.write_text(json.dumps({"model": "claude-sonnet-4-6"}))

    first = ClaudeSettings.load(path=settings_file)
    settings_file.write_text(json.dumps({"model": "claude-haiku-4-5"}))
    second = ClaudeSettings.load(path=settings_file)

    assert first.model == "claude-sonnet-4-6"
    assert second.model == "claude-haiku-4-5"


def test_load_empty_model_field_returns_none(tmp_path: Path) -> None:
    """An empty string model field is normalised to None."""
    settings_file = tmp_path / "settings.json"
    settings_file.write_text(json.dumps({"model": ""}))

    result = ClaudeSettings.load(path=settings_file)

    assert result.model is None


def test_convenience_properties_missing_env(tmp_path: Path) -> None:
    """Convenience properties return None when the env vars are absent."""
    settings_file = tmp_path / "settings.json"
    settings_file.write_text(json.dumps({"model": "sonnet"}))

    result = ClaudeSettings.load(path=settings_file)

    assert result.base_url is None
    assert result.auth_token is None
    assert result.opus_model is None
    assert result.sonnet_model is None
    assert result.haiku_model is None
    assert result.subagent_model is None
