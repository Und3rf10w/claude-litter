# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Litter is a Claude Code plugin marketplace that enables multi-agent coordination. The primary plugin is **claude-swarm**, which spawns parallel Claude Code teammates in kitty or tmux terminals, manages tasks, and coordinates work across multiple instances.

## Repository Structure

```
claude-litter/
├── .claude-plugin/
│   └── marketplace.json       # Marketplace manifest
├── plugins/
│   └── claude-swarm/          # Main swarm plugin (v1.8.1)
│       ├── .claude-plugin/
│       │   └── plugin.json    # Plugin manifest
│       ├── commands/          # 17+ slash commands (.md files)
│       ├── hooks/
│       │   ├── hooks.json     # Hook configuration
│       │   └── *.sh           # Hook scripts
│       ├── lib/               # Modular library (13 modules)
│       │   ├── swarm-utils.sh # Entry point (sources all modules)
│       │   ├── swarm-onboarding.sh # Onboarding wizard
│       │   ├── core/          # 00-globals, 01-utils, 02-file-lock
│       │   ├── multiplexer/   # 03-multiplexer, 04-registry
│       │   ├── team/          # 05-team, 06-status, 10-lifecycle
│       │   ├── communication/ # 07-messaging
│       │   ├── tasks/         # 08-tasks
│       │   └── spawn/         # 09-spawn, 11-cleanup, 12-kitty-session, 13-diagnostics
│       ├── skills/
│       │   ├── swarm-orchestration/    # User/orchestrator delegation workflow
│       │   ├── swarm-team-lead/        # Spawned team-lead coordination
│       │   ├── swarm-teammate/         # Worker coordination
│       │   └── swarm-troubleshooting/  # Diagnostics & recovery
│       └── docs/
└── README.md
```

## Architecture

### Core Library: `plugins/claude-swarm/lib/`

The library uses a modular architecture with 13 modules loaded in dependency order:

| Level | Module                          | Functions                                                               |
| ----- | ------------------------------- | ----------------------------------------------------------------------- |
| 0     | `core/00-globals.sh`            | Global vars, colors, `SWARM_KITTY_MODE`, `SWARM_TEAMMATE_SYSTEM_PROMPT` |
| 1     | `core/01-utils.sh`              | `generate_uuid`, `validate_name`, `kitten_cmd`                          |
| 1     | `core/02-file-lock.sh`          | `acquire_file_lock`, `release_file_lock`                                |
| 2     | `multiplexer/03-multiplexer.sh` | `detect_multiplexer`, `find_kitty_socket`, `validate_kitty_socket`      |
| 3     | `multiplexer/04-registry.sh`    | `register_window`, `unregister_window`, `get_registered_windows`        |
| 3     | `team/05-team.sh`               | `create_team`, `add_member`, `get_team_config`, `list_teams`            |
| 4     | `team/06-status.sh`             | `update_member_status`, `get_live_agents`, `swarm_status`               |
| 4     | `communication/07-messaging.sh` | `send_message`, `read_inbox`, `broadcast_message`                       |
| 5     | `tasks/08-tasks.sh`             | `create_task`, `get_task`, `update_task`, `list_tasks`                  |
| 5     | `spawn/09-spawn.sh`             | `spawn_teammate`, `spawn_teammate_kitty`, `spawn_teammate_tmux`         |
| 6     | `team/10-lifecycle.sh`          | `suspend_team`, `resume_team`                                           |
| 6     | `spawn/12-kitty-session.sh`     | `generate_kitty_session`, `launch_kitty_session`                        |
| 7     | `spawn/11-cleanup.sh`           | `cleanup_team`                                                          |
| 7     | `spawn/13-diagnostics.sh`       | `diagnose_team`, `verify_teammates`                                     |

Each module has source guards to prevent double-loading:

```bash
[[ -n "${SWARM_MODULE_LOADED}" ]] && return 0
SWARM_MODULE_LOADED=1
```

Commands source the entry point:

```bash
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null
```

### Data Storage

All state stored as JSON files under `~/.claude/`:

```
~/.claude/
├── teams/<team-name>/
│   ├── config.json              # Team config, member list, status
│   ├── .window_registry.json    # Kitty window tracking
│   ├── swarm.kitty-session      # Generated session file
│   └── inboxes/
│       └── <agent-name>.json    # Message inbox per agent
└── tasks/<team-name>/
    └── <id>.json                # Individual task files
```

### Hooks System

5 hooks defined in `hooks/hooks.json`:

| Event                    | Script                    | Purpose                              |
| ------------------------ | ------------------------- | ------------------------------------ |
| SessionStart             | session-start.sh          | Auto-deliver unread messages         |
| SessionEnd               | session-stop.sh           | Notify team-lead when teammate exits |
| Notification             | notification-heartbeat.sh | Update `lastSeen` timestamps         |
| PostToolUse:ExitPlanMode | exit-plan-swarm.sh        | Handle swarm launches from plan mode |
| PreToolUse:Task          | task-team-context.sh      | Inject team context into subagents   |

### Environment Variables

Set automatically for spawned teammates:

- `CLAUDE_CODE_TEAM_NAME` - Current team name
- `CLAUDE_CODE_AGENT_ID` - Unique agent UUID
- `CLAUDE_CODE_AGENT_NAME` - Agent name (e.g., "backend-dev")
- `CLAUDE_CODE_AGENT_TYPE` - Role type (worker, backend-developer, etc.)
- `CLAUDE_CODE_TEAM_LEAD_ID` - Team lead's agent ID
- `CLAUDE_CODE_AGENT_COLOR` - Agent color for display

User-configurable:

- `SWARM_MULTIPLEXER` - Force "tmux" or "kitty"
- `SWARM_KITTY_MODE` - split (default), tab, or window (os-window)
- `KITTY_LISTEN_ON` - Override kitty socket path
- `CLAUDE_CODE_TEAMMATE_COMMAND` - Override claude binary path for spawning (CC native)

### Skills Architecture

The plugin uses a **4-skill architecture** optimized for role-based context loading:

#### 1. swarm-orchestration

**Purpose**: User/orchestrator workflow for creating and delegating to teams
**Auto-triggers on**: "set up team", "create swarm", "spawn teammates", "assign tasks", "coordinate agents", "swarm this task"
**Covers**:

- Delegation mode vs direct mode
- Creating teams (auto-spawns team-lead by default)
- Briefing team-lead with requirements
- Monitoring progress and responding to escalations
- High-level task creation
- Slash command reference for orchestrators

**Key concept**: By default, users DELEGATE to a spawned team-lead who handles coordination. Users set direction, monitor, and answer escalations.

#### 2. swarm-team-lead

**Purpose**: Guidance for spawned team-leads on coordination
**Auto-triggers via**: `CLAUDE_CODE_IS_TEAM_LEAD=true` environment variable
**Covers**:

- Monitoring teammates and team status
- Spawning and verifying workers
- Handling teammate messages and questions
- Task assignment and dependency management
- Communication patterns (broadcast, messaging)
- Unblocking workers

**When used**: Auto-loads for spawned team-leads. Also useful for direct mode (`--no-lead`) where user is team-lead.

#### 3. swarm-teammate

**Purpose**: Worker coordination protocol and identity
**Auto-triggers via**: `CLAUDE_CODE_TEAM_NAME` environment variable (workers only, not team-lead)
**Covers**:

- Teammate identity and role awareness
- Communication protocol (inbox checking, messaging)
- Task update procedures
- Coordination with team-lead and peers
- Working within swarm context

#### 4. swarm-troubleshooting

**Purpose**: Diagnostics, error recovery, and problem-solving
**Auto-triggers on**: "spawn failed", "diagnose team", "fix swarm", "status mismatch", "recovery", "swarm not working"
**Covers**:

- Troubleshooting delegated teams (who diagnoses what)
- Spawn failure diagnosis and recovery
- Status mismatch reconciliation
- Multiplexer troubleshooting (kitty/tmux)
- Socket issues and connectivity problems

#### Design Rationale

**Delegation Model**:

- User creates team → team-lead auto-spawns
- User briefs team-lead → team-lead coordinates everything
- User monitors and answers escalations
- Minimal user involvement in day-to-day coordination

**Token Optimization**:

- **Workers load swarm-teammate**: Only worker-relevant guidance
- **Team-lead loads swarm-team-lead**: Coordination guidance without orchestration overhead
- **Orchestrator loads swarm-orchestration**: Delegation workflow, not coordination details
- **Troubleshooting loads on-demand**: Only when diagnosing issues

#### Triggering Logic

**Environment-based auto-trigger**:

- swarm-team-lead: Loads when `CLAUDE_CODE_IS_TEAM_LEAD=true`
- swarm-teammate: Loads when `CLAUDE_CODE_TEAM_NAME` is set (and not team-lead)

**Explicit trigger phrases**:

- swarm-orchestration: "set up", "create", "spawn", "assign", "coordinate", "swarm"
- swarm-troubleshooting: "fail", "diagnose", "fix", "mismatch", "recovery", "not working"

#### System Prompts

`lib/core/00-globals.sh` defines system prompts for spawned agents:

- `SWARM_TEAMMATE_SYSTEM_PROMPT` - For workers, references swarm-teammate skill
- `SWARM_TEAM_LEAD_SYSTEM_PROMPT` - For spawned team-leads, references swarm-team-lead skill

Both prompts instruct the agent to load the appropriate skill first.

## Key Implementation Patterns

### Concurrent Access Protection

All JSON file updates use mkdir-based atomic locking:

```bash
acquire_file_lock "$config_file"
# ... modify file ...
release_file_lock
```

### Input Validation

`validate_name()` prevents path traversal and injection:

- No ".." or "/" in names
- No names starting with "-"
- Max 100 characters

### Kitty Window Identification

Uses user variables (`--var`) for reliable window matching even after title changes:

```bash
kitten_cmd launch --var "swarm_${team}_${agent}=true" ...
kitten_cmd close-window --match "var:swarm_${team}_${agent}"
```

### Model Validation

All spawn functions validate model parameter:

```bash
case "$model" in
    haiku|sonnet|opus) ;;
    *) model="sonnet" ;;
esac
```

## Shell Requirements

### Bash Dependency

**All swarm commands and library functions require bash:**

- Command files use bash-specific syntax (`[[ ]]`, arrays, `printf %q`)
- Hook scripts have `#!/bin/bash` shebangs
- Library modules use bash features throughout (process substitution, associative arrays, regex matching)
- Entry point (`swarm-utils.sh`) validates bash availability before loading modules

**Commands execute with explicit bash invocation:**

All command files wrap their scripts in bash heredocs:

```bash
bash << 'SCRIPT_EOF'
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null
# ... command logic ...
SCRIPT_EOF
```

This ensures commands execute in bash regardless of user's default shell (zsh on macOS).

### Multiplexer Requirements and Limitations

#### Kitty (Full Support)

**Features available:**

- Window variables (`swarm_team`, `swarm_agent`) for context detection
- Automatic team/agent detection for team-leads
- Split, tab, and window spawn modes
- Session file generation and launching
- All commands work seamlessly

**Setup requirements:**

- Running inside kitty terminal
- Remote control enabled in `~/.config/kitty/kitty.conf`:
  ```
  allow_remote_control yes
  listen_on unix:/tmp/kitty-$USER
  ```

#### Tmux (Partial Support)

**Features available:**

- Spawning teammates in separate sessions
- Task management and messaging
- All core swarm functionality

**Limitations:**

- No window variables (tmux has no equivalent to kitty user vars)
- Team-leads cannot rely on automatic team detection
- Commands will error instead of silently defaulting to "default" team

**Workaround for team-leads in tmux:**

Set team context manually in your shell:

```bash
export CLAUDE_CODE_TEAM_NAME="your-team-name"
```

Or always provide explicit team names when running commands:

- `/swarm-status your-team-name`
- `/swarm-verify your-team-name`

**Note**: Spawned teammates (in both kitty and tmux) always have correct environment variables and work identically.

### Error Messages

When commands cannot determine team context, they now error with:

```
Error: Cannot determine team. Run this command from a swarm window or set CLAUDE_CODE_TEAM_NAME
```

**Previous behavior (v1.6.2 and earlier)**: Commands silently defaulted to "default" team, causing operations to affect the wrong team.

**New behavior**: Commands fail explicitly, preventing data corruption.

### Known Limitations

1. **Team-leads in tmux** cannot rely on automatic team detection via window variables
2. **Window variables** (`swarm_team`, `swarm_agent`) only work in kitty
3. **Commands require explicit team names** or environment variables when window vars unavailable
4. **Hook changes** require Claude Code restart (hooks load at session start only)
5. **Non-bash shells** will fail with clear error message when sourcing swarm-utils.sh

## Command Development

Commands are markdown files in `plugins/claude-swarm/commands/`. They use bash execution syntax to call swarm-utils functions:

```markdown
---
description: Brief description shown in /help
argument-hint: <required> [optional]
---

Command instructions that Claude follows...
```

## Testing Changes

1. **Library changes**: Test functions directly in bash
2. **Command changes**: Use `/claude-swarm:<command>` in Claude Code
3. **Hook changes**: Restart Claude Code (hooks load at session start)
4. **Full integration**: Create test team, spawn teammates, verify status

## Common Operations

```bash
# Source library for testing
source plugins/claude-swarm/lib/swarm-utils.sh 1>/dev/null

# Check multiplexer detection
detect_multiplexer

# Find kitty socket
find_kitty_socket

# List teams
list_teams

# Get team status (verbose)
swarm_status "team-name"
```
