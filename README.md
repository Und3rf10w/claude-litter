<div align="center">
  <img src="./claudelitterlogo.png" alt="Claude Litter" width="320" />
  <br />
  <em>A terminal control plane for Claude Code agent teams</em>
  <br /><br />

  <a href="https://www.python.org/downloads/"><img src="https://img.shields.io/badge/python-3.14%2B-blue?style=flat-square&logo=python&logoColor=white" alt="Python 3.14+" /></a>
  <a href="https://textual.textualize.io/"><img src="https://img.shields.io/badge/textual-3.0%2B-6c3483?style=flat-square" alt="Textual 3.0+" /></a>
  <a href="https://github.com/Und3rf10w/claude-litter/releases"><img src="https://img.shields.io/badge/version-0.1.0-22c55e?style=flat-square" alt="Version 0.1.0" /></a>
  <a href="https://claude.ai/code"><img src="https://img.shields.io/badge/Claude_Code-agent_teams-orange?style=flat-square" alt="Claude Code" /></a>
</div>

---

**Claude Litter** is a full-featured terminal UI for managing [Claude Code agent teams](https://claude.ai/code). It gives you a live sidebar of teams and agents, tabbed transcript sessions, a task panel with filtering and sorting, an inbox and compose workflow for inter-agent messaging, and filesystem watching that keeps the UI in sync as your agents work — all without leaving the terminal.

---

## Features

### Core UI
- **Team sidebar** with live status indicators (active / partial / inactive) and colored agent badges
- **Tabbed sessions** with full conversation transcript history loaded from JSONL files
- **Status bar** with team, agent, and task summary at a glance
- **10 built-in themes**: `textual-dark`, `textual-light`, `nord`, `gruvbox`, `dracula`, `tokyo-night`, `monokai`, `catppuccin-mocha`, `solarized-dark`, `solarized-light`

### Team Management
- Create, rename, suspend/resume, broadcast to, and delete teams
- Right-click context menus on teams, agents, and tabs

### Agent Management
- Spawn agents with model selection (Haiku / Sonnet / Opus) and type assignment
- Configure, duplicate (cross-team with inbox/context copy), kill, detach, and reattach agents
- **Task panel** with filtering (pending / in-progress / completed / blocked), sorting (ID / status / owner), and inline editing

### Messaging
- **Message panel** with inbox view, broadcast view, and compose form
- `/broadcast` command for team-wide messages

### Terminal Integration
- **Kitty terminal** pop-out: open agents in splits, tabs, or new windows
- **Text selection** with Cmd+C / right-click copy support
- **Live filesystem watching** — changes to team/task/inbox JSON files refresh the UI automatically

### Input and Customization
- **Command mode** via `/` prefix with Tab autocomplete
- **Vim mode** (`--vim` flag)
- **Debug logging** (`--debug` flag, writes to `~/.claude/claude-litter/debug.log`)

---

## Quick Start

```bash
git clone https://github.com/Und3rf10w/claude-litter
cd claude-litter
uv sync && uv run claude-litter
```

> Requires Python 3.14+ and [uv](https://docs.astral.sh/uv/). A Claude Code environment with teams under `~/.claude/teams/` must be running.

---

## Screenshots

> Screenshots and demo recordings are coming soon. In the meantime, generate a headless screenshot locally — see [Development](#development).

---

## CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--vim` | `false` | Enable vim keybindings |
| `--theme THEME` | `dark` | Color theme (`dark`, `light`, or any built-in theme name) |
| `--debug` | `false` | Debug logging to `~/.claude/claude-litter/debug.log` |
| `--version` | — | Print version and exit |

---

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

---

## Command Mode

Type `/` in the input bar to enter command mode. Tab completes available commands.

| Command | Action |
|---------|--------|
| `/spawn` | Spawn a new agent |
| `/kill` | Kill an agent |
| `/msg <to> <text>` | Send a message to an agent |
| `/broadcast <text>` | Broadcast to the whole team |
| `/task` | Task operations |
| `/team` | Team operations |
| `/kitty` | Kitty terminal pop-out |
| `/detach` | Detach session |
| `/vim` | Toggle vim mode |

---

## Architecture

```
src/claude_litter/
├── app.py                      # ClaudeLitterApp — entry point, keybindings, QuitScreen
├── config.py                   # Config dataclass (persisted to ~/.claude/claude-litter/config.json)
├── __main__.py                 # CLI entry point (argparse: --vim, --theme, --debug, --version)
│
├── models/
│   ├── team.py                 # Team, TeamMember frozen dataclasses
│   ├── task.py                 # Task, TaskStatus enum, TodoItem
│   └── message.py              # Message dataclass (from_agent <-> "from" key aliasing)
│
├── services/
│   ├── state.py                # StateManager — watchfiles.awatch on ~/.claude/ for live updates
│   ├── team_service.py         # TeamService — JSON CRUD with mkdir-based atomic file locking
│   ├── agent_manager.py        # AgentManager — claude-agent-sdk session management
│   ├── kitty.py                # KittyService — kitty terminal pop-out/import
│   └── claude_settings.py      # ClaudeSettings — reads ~/.claude/settings.json
│
├── screens/
│   ├── main.py                 # MainScreen — primary layout (sidebar + tabs + panels + input)
│   ├── create_team.py          # CreateTeamScreen (modal)
│   ├── spawn_agent.py          # SpawnAgentScreen (modal)
│   ├── task_detail.py          # TaskDetailScreen (modal, view/edit toggle)
│   ├── settings.py             # SettingsScreen (full-page, theme picker)
│   ├── about.py                # AboutScreen (modal, ASCII art)
│   ├── confirm.py              # ConfirmScreen (reusable yes/no modal)
│   ├── rename_team.py          # RenameTeamScreen (modal)
│   ├── broadcast_message.py    # BroadcastMessageScreen (modal)
│   ├── configure_agent.py      # ConfigureAgentScreen (modal, model/color/type)
│   └── duplicate_agent.py      # DuplicateAgentScreen (modal, cross-team copy)
│
├── widgets/
│   ├── sidebar.py              # TeamSidebar — Tree widget with status dots and agent badges
│   ├── tab_bar.py              # SessionTabBar — TabbedContent with close buttons and context menus
│   ├── session_view.py         # SessionView — RichLog with text selection and tool rendering
│   ├── input_bar.py            # InputBar — multi-line input, history, autocomplete, /command mode
│   ├── task_panel.py           # TaskPanel — slide-out panel with filter/sort and todo items
│   ├── message_panel.py        # MessagePanel — slide-out panel with inbox/broadcast/compose
│   ├── context_menu.py         # ContextMenu — floating right-click menus
│   └── status_bar.py           # StatusBar — team/agent/task summary line
│
└── styles/
    └── app.tcss                # Textual CSS — dark theme, slide-panel transitions, widget styling
```

**Plugins** live under `plugins/`:

| Plugin | Description |
|--------|-------------|
| `swarm-loop` | Multi-agent orchestration loop (bash). Requires `jq` and `perl`. |
| `team-overlord` | Team/task MCP server (Python / fastmcp). |

---

## Data Storage

All runtime state is stored as JSON files under `~/.claude/`. Override with the `CLAUDE_HOME` environment variable.

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
    └── debug.log                # Debug log (written when --debug is active)
```

---

## Development

### Running tests

```bash
uv run pytest tests/ -v
uv run pytest tests/ -v -k 'test_name'   # single test
```

Tests use the `tmp_claude_home` fixture from `conftest.py` to create an isolated `~/.claude/` structure. The real `~/.claude/` is never touched.

**Coverage spans 10 test files:**
- Models: team, task, message dataclasses and serialization round-trips
- Services: TeamService CRUD, file locking under concurrency, StateManager, AgentManager, KittyService
- App: initialization, keybindings, MainScreen composition
- Screens: all 11 screen classes — modal dismiss values, validation, edit modes
- Widgets: all 8 widget classes — rendering, messages, interactions, filtering, sorting
- Scaffold: package structure and import verification

### Headless screenshot

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

---

<div align="center">
  <a href="https://github.com/Und3rf10w/claude-litter">github.com/Und3rf10w/claude-litter</a>
  &nbsp;·&nbsp;
  Built by <a href="https://github.com/Und3rf10w">Und3rf10w</a>
</div>
