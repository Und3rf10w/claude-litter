# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Run

```bash
uv sync
uv run claude-litter
```

Python 3.14+ is required — `uv` manages this automatically via `.python-version`.

## Testing

```bash
uv run pytest tests/ -v
uv run pytest tests/ -v -k 'test_name'  # single test
```

Tests use the `tmp_claude_home` fixture (from `conftest.py`) to create an isolated `~/.claude/` structure — never touch the real `~/.claude/` in tests.

## Conventions

- **Commits**: conventional commits — `type(scope): description` (e.g., `feat(tui): add sidebar`)
- **Branches**: feature branches off `main`, merged via merge commits
- **Imports**: every file starts with `from __future__ import annotations`
- **Models**: frozen dataclasses (`@dataclass(frozen=True)`)
- **Filesystem**: use `pathlib.Path` for all path operations
- **Textual markup**: escape `[` as `\[` in Rich markup when rendering external text
- **Textual version**: >= 3.0 (API differs from 2.x — verify against installed version if you hit import errors)

## Architecture Notes

- All runtime state (teams, tasks, agent inboxes, TUI config, debug log) lives under `~/.claude/`. The `CLAUDE_HOME` env var overrides this path.
- `src/claude_litter/screens/main.py` (~75 KB) is the primary file for UI work.
- Plugins live in `plugins/`:
  - `swarm-loop` — multi-agent orchestration loop (bash). Requires `jq` and `perl` at runtime.
  - `team-overlord` — team/task MCP server (Python/fastmcp).
- Subdirectory CLAUDE.md files can be added under `plugins/` for plugin-specific instructions.
