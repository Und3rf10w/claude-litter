import pytest
from pathlib import Path


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def tmp_claude_home(tmp_path):
    """Create a temporary ~/.claude/ directory structure."""
    claude_home = tmp_path / ".claude"
    (claude_home / "teams").mkdir(parents=True)
    (claude_home / "tasks").mkdir(parents=True)
    (claude_home / "claude-litter").mkdir(parents=True)
    return claude_home
