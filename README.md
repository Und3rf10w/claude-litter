# Claude Litter

> A Textual TUI for managing Claude Code agent teams

**Claude Litter** is a terminal manager (`claude-litter`) for [Claude Code's agent teams](https://code.claude.com/docs/en/agent-teams).

It gives you a sidebar tree of teams and agents, tabbed sessions with full transcript history, a task panel with filtering and sorting, a message panel with inbox and compose, and live filesystem watching so the UI updates automatically as agents work.

## Features

- **Team sidebar** with live status indicators (active/partial/inactive) and colored agent badges
- **Tabbed sessions** with full conversation transcript loading from JSONL files
- **Task panel** with filtering (pending/in-progress/completed/blocked), sorting (ID/status/owner), and inline editing
- **Message panel** with inbox view, broadcast view, and compose form
- **Agent spawning** with model selection (Haiku/Sonnet/Opus) and type assignment
- **Right-click context menus** on agents, tabs, and teams
- **Team management**: create, rename, suspend/resume, broadcast, delete
- **Agent management**: spawn, configure, duplicate (cross-team), kill, detach/reattach
- **Kitty terminal integration** (pop-out agents to splits/tabs/windows)
- **Live filesystem watching** — changes to team/task/inbox JSON files refresh the UI automatically
- **Text selection** with Cmd+C / right-click copy support
- **10 built-in themes**: textual-dark/light, nord, gruvbox, dracula, tokyo-night, monokai, catppuccin-mocha, solarized-dark/light
- **Vim mode** (`--vim` flag)
- **Debug logging** (`--debug` flag, writes to `~/.claude/claude-litter/debug.log`)

## Requirements

- Python 3.14+
- [uv](https://docs.astral.sh/uv/) (recommended) or pip
- A running Claude Code environment with teams under `~/.claude/teams/`

## Installation

```bash
# Clone and install
git clone <repo-url>
cd claude-litter
uv sync

# Run the TUI
uv run claude-litter

# Or install in editable mode
pip install -e .
claude-litter
```

## CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--vim` | false | Enable vim keybindings |
| `--theme` | dark | Color theme (dark, light) |
| `--debug` | false | Debug logging to `~/.claude/claude-litter/debug.log` |
| `--version` | — | Print version and exit |

## Keybindings

| Key | Action |
|-----|--------|
| `Ctrl+N` | Create new team |
| `Ctrl+S` | Spawn agent |
| `Ctrl+T` | Toggle task panel |
| `Ctrl+Q` | Quit |
| `F1` | About |
| `F2` | Toggle message panel |
| `F3` | Settings |
| `Escape` | Close dialog / quit |
| `Tab` | Focus next widget |
| `Cmd+C` / `Ctrl+C` | Copy selected text |

## Command Mode

Type `/` in the input bar to enter command mode (autocomplete with Tab):

| Command | Action |
|---------|--------|
| `/spawn` | Spawn a new agent |
| `/kill` | Kill an agent |
| `/msg <to> <text>` | Send a message |
| `/broadcast <text>` | Broadcast to team |
| `/task` | Task operations |
| `/team` | Team operations |
| `/kitty` | Kitty pop-out |
| `/detach` | Detach session |
| `/vim` | Toggle vim mode |

## Data Storage

All state stored as JSON files under `~/.claude/`:

```
~/.claude/
├── teams/<team-name>/
│   ├── config.json              # Team config: name, members, leadAgentId, leadSessionId
│   └── inboxes/
│       └── <agent-name>.json    # Message inbox per agent
├── tasks/<team-name>/
│   └── <id>.json                # Individual task files (auto-incrementing numeric IDs)
└── claude-litter/
    ├── config.json              # TUI preferences (vim_mode, theme)
    └── debug.log                # Debug log (when --debug is used)
```

## Architecture

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
│   ├── agent_manager.py    # AgentManager — claude-agent-sdk session management
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

## Development

### Running tests

```bash
# Run all tests
uv run pytest tests/ -v
```

### Test coverage

10 test files covering:

- Models (team, task, message dataclasses, serialization round-trips)
- Services (TeamService CRUD, file locking under concurrency, StateManager, AgentManager, KittyService)
- App (initialization, keybindings, MainScreen composition)
- Screens (all 11 screen classes — modal dismiss values, validation, edit modes)
- Widgets (all 8 widget classes — rendering, messages, interactions, filtering, sorting)
- Scaffold (package structure and import verification)

### Headless screenshot test

```bash
uv run python -c "
import anyio
from claude_litter.app import ClaudeLitterApp
async def main():
    app = ClaudeLitterApp()
    async with app.run_test(size=(120, 40)) as pilot:
        await pilot.pause(delay=0.5)
        app.save_screenshot('screenshot.svg')
        print('Screenshot saved')
anyio.run(main)
"
```

