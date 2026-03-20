# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Litter is a standalone Textual TUI (`claude-litter`) for managing Claude Code agent teams visually. It reads/writes the native Claude Code team/task JSON files under `~/.claude/` and provides a dashboard with sidebar navigation, tabbed sessions with transcript history, task management, and messaging.

## Repository Structure

```
claude-litter/
├── src/claude_litter/       # Textual TUI application (Python 3.14+)
├── tests/                # 310 pytest tests
├── dev/                  # Ad-hoc developer scripts (live SDK testing)
├── pyproject.toml        # Project config (hatchling, textual>=3.0, claude-agent-sdk, anyio, watchfiles)
├── uv.lock               # Dependency lockfile
├── README.md             # User-facing documentation
└── CLAUDE.md             # This file (guidance for Claude Code)
```

## Dependencies

- `textual>=3.0` — TUI framework (App > Screen > Widget hierarchy)
- `claude-agent-sdk` — Claude Code agent session management (ClaudeSDKClient)
- `anyio` — async primitives
- `watchfiles` — filesystem watching for live JSON change detection
- Dev: `pytest`, `pytest-anyio`

## Data Storage

All state stored as JSON under `~/.claude/`:

```
~/.claude/
├── teams/<team-name>/
│   ├── config.json              # Team config: name, description, createdAt, leadAgentId, leadSessionId, members[]
│   └── inboxes/
│       └── <agent-name>.json    # Message inbox per agent (array of {from, text, timestamp, read, color?, summary?})
├── tasks/<team-name>/
│   └── <id>.json                # Task: id, subject, description, status, owner?, blocks[], blockedBy[], activeForm?, metadata?
├── settings.json                # Claude Code settings (model, env vars — read by ClaudeSettings service)
└── claude-litter/
    ├── config.json              # TUI config: claude_home, vim_mode, theme
    ├── debug.log                # Debug log (when --debug is used)
    └── detached-sessions.json   # Detached agent sessions (session_id + model, for reattach)
```

### Team config.json schema

```json
{
  "name": "team-name",
  "description": "",
  "createdAt": 1710000000000,
  "leadAgentId": "name@team",
  "leadSessionId": "uuid",
  "members": [
    {
      "agentId": "name@team",
      "name": "agent-name",
      "agentType": "worker",
      "model": "sonnet",
      "joinedAt": 1710000000000,
      "color": "blue",
      "cwd": "/path/to/project"
    }
  ]
}
```

### Task JSON schema

```json
{
  "id": "1",
  "subject": "Task title",
  "description": "Detailed description",
  "status": "pending|in_progress|completed",
  "owner": "agent-name",
  "blocks": ["2"],
  "blockedBy": [],
  "activeForm": "Working on task",
  "metadata": {}
}
```

## Transcript Loading

The TUI loads conversation history from Claude Code's JSONL transcript files:

```
~/.claude/projects/<sanitized-cwd>/<leadSessionId>/
├── <leadSessionId>.jsonl          # Team lead's transcript
└── subagents/
    ├── agent-<uuid>.jsonl         # Subagent transcript
    └── agent-<uuid>.meta.json     # Sidecar with agentType field (agent name)
```

Agent matching strategies (in priority order):
1. `.meta.json` sidecar — `agentType` field matches agent name (newer teams)
2. First-line content heuristic — looks for `You are "<agent>"` or `teammate_id="<agent>"` patterns
3. Team lead fallback — `<leadSessionId>.jsonl` for the team-lead agent

## Package Structure

```
src/claude_litter/
├── app.py                  # ClaudeLitterApp — main App, keybindings, QuitScreen
├── config.py               # Config dataclass (persisted to ~/.claude/claude-litter/config.json)
├── __main__.py             # CLI entry point (argparse: --vim, --theme, --debug, --version)
├── models/
│   ├── team.py             # Team, TeamMember frozen dataclasses
│   ├── task.py             # Task, TaskStatus enum, TodoItem
│   └── message.py          # Message dataclass (from_agent ↔ "from" key aliasing)
├── services/
│   ├── state.py            # StateManager — watchfiles.awatch on ~/.claude/ for live updates
│   ├── team_service.py     # TeamService — JSON CRUD with mkdir-based atomic file locking
│   ├── agent_manager.py    # AgentManager — claude-agent-sdk session management, detach/reattach
│   ├── kitty.py            # KittyService — kitty terminal pop-out/import
│   └── claude_settings.py  # ClaudeSettings — reads ~/.claude/settings.json (model, env vars)
├── screens/
│   ├── main.py             # MainScreen — primary layout (sidebar + tabs + session + input + panels)
│   ├── create_team.py      # CreateTeamScreen (modal)
│   ├── spawn_agent.py      # SpawnAgentScreen (modal)
│   ├── task_detail.py      # TaskDetailScreen (modal, view/edit toggle)
│   ├── settings.py         # SettingsScreen (full-page, theme picker, Claude Code settings display)
│   ├── about.py            # AboutScreen (modal, ASCII art)
│   ├── confirm.py          # ConfirmScreen (reusable yes/no modal)
│   ├── rename_team.py      # RenameTeamScreen (modal)
│   ├── broadcast_message.py# BroadcastMessageScreen (modal)
│   ├── configure_agent.py  # ConfigureAgentScreen (modal, model/color/type)
│   └── duplicate_agent.py  # DuplicateAgentScreen (modal, cross-team with inbox/context copy)
├── widgets/
│   ├── sidebar.py          # TeamSidebar — Tree widget with colored agent badges and status dots
│   ├── tab_bar.py          # SessionTabBar — TabbedContent with close buttons, right-click menus
│   ├── session_view.py     # SessionView — RichLog with text selection, streaming, tool rendering
│   ├── input_bar.py        # InputBar — multi-line input with history, autocomplete, /command mode
│   ├── task_panel.py       # TaskPanel — slide-out panel with filter/sort, task + todo items
│   ├── message_panel.py    # MessagePanel — slide-out panel with inbox/broadcast/compose
│   ├── context_menu.py     # ContextMenu — floating right-click menus for agents/tabs/teams
│   └── status_bar.py       # StatusBar — team/agent/task summary line
└── styles/
    └── app.tcss            # Textual CSS — dark theme, slide-panel transitions, widget styling
```

## Key Patterns

- **Textual CSS** in `.tcss` files, not inline — slide panels use `offset-x: 100%` + `transition: offset 300ms` + `toggle_class("-visible")`
- **Textual markup** (not Rich markup) in widget content — escape `[` brackets with `\[` when rendering external text
- Use `self.screen.query()` not `self.app.query()` for active screen queries
- `ModalScreen[T]` for typed dismiss dialogs — constructor params, `.dismiss(value)` returns T
- `@work(exclusive=True)` for async streaming, `post_message()` for thread-safe messaging
- State reads from `~/.claude/teams/` and `~/.claude/tasks/` JSON via `StateManager` (watchfiles)
- State writes via `TeamService` — direct JSON file operations with mkdir-based atomic file locking
- Agent sessions via `AgentManager` → `AgentSession` → `ClaudeSDKClient` from claude-agent-sdk
- Structured inbox messages: parse JSON `type` field (`task_assignment`, `task_completed`, `idle_notification`, `shutdown_request`, `shutdown_response`) in `MainScreen._format_inbox_text()`
- Strip `<teammate-message>` XML wrappers from transcript user prompts
- Context menus: `ContextMenu` widget with `show_at()` / `show_tab_menu_at()` / `show_team_menu_at()`, action routing in `MainScreen.on_context_menu_action_selected()`

## Screens Reference

| Screen | Type | Purpose |
|--------|------|---------|
| `MainScreen` | Screen | Primary layout: sidebar + tabs + session view + input bar + slide panels |
| `CreateTeamScreen` | ModalScreen[dict\|None] | Create team: name, description, auto-lead toggle, model |
| `SpawnAgentScreen` | ModalScreen[dict\|None] | Spawn agent: name, type, model, initial prompt |
| `TaskDetailScreen` | ModalScreen[dict\|None] | View/edit task: subject, description, status, owner |
| `SettingsScreen` | Screen | Full-page settings: vim mode, theme, Claude Code settings display |
| `AboutScreen` | ModalScreen[None] | About dialog with ASCII art, repo link |
| `ConfirmScreen` | ModalScreen[bool] | Reusable yes/no confirmation |
| `RenameTeamScreen` | ModalScreen[str\|None] | Rename team with validation |
| `BroadcastMessageScreen` | ModalScreen[str\|None] | Compose broadcast message |
| `ConfigureAgentScreen` | ModalScreen[dict\|None] | Edit agent: name, model, color, type |
| `DuplicateAgentScreen` | ModalScreen[dict\|None] | Cross-team duplication with inbox/context copy options |

## Widgets Reference

| Widget | Purpose | Key Messages |
|--------|---------|-------------|
| `TeamSidebar` | Tree of teams/agents with badges | `AgentSelected`, `TeamSelected`, `MainChatSelected`, `*ContextMenuRequested` |
| `SessionTabBar` | Tabbed agent sessions with close buttons | `TabActivated`, `TabClosed`, `TabContextMenuRequested` |
| `SessionView` | Scrollable output with text selection + streaming | `TodoWriteDetected` |
| `InputBar` | Multi-line input with history + autocomplete | `PromptSubmitted`, `CommandSubmitted`, `InterruptRequested` |
| `TaskPanel` | Slide-out task list with filter/sort | `TaskSelected` |
| `MessagePanel` | Slide-out inbox/broadcast/compose | `MessageComposed` |
| `ContextMenu` | Floating right-click menus | `ActionSelected` |
| `StatusBar` | Team/agent/task summary | (none) |

## Running & Testing

```bash
# Install deps and run
uv sync && uv run claude-litter

# CLI flags
uv run claude-litter --vim --theme light --debug

# Run all tests
uv run pytest tests/ -v

# Headless screenshot test (for widget/screen changes)
uv run python -c "
import anyio
from claude_litter.app import ClaudeLitterApp
async def main():
    app = ClaudeLitterApp()
    async with app.run_test(size=(120, 40)) as pilot:
        await pilot.pause(delay=0.5)
        app.save_screenshot('screenshot.svg')
anyio.run(main)
"
```

## Keybindings

| Key | Action |
|-----|--------|
| `Ctrl+N` | Create new team |
| `Ctrl+S` | Spawn agent |
| `Ctrl+T` | Toggle task panel |
| `Ctrl+Q` / `q` | Quit |
| `F1` | About |
| `F2` | Toggle message panel |
| `F3` | Settings |
| `Escape` | Close dialog / quit |
| `Tab` | Focus next |
| `Cmd+C` / `Ctrl+C` | Copy selected text |
