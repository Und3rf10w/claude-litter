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
│   └── claude-swarm/          # Main swarm plugin (v1.5.3)
│       ├── .claude-plugin/
│       │   └── plugin.json    # Plugin manifest
│       ├── commands/          # 17 slash commands (.md files)
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
│       │   ├── swarm-orchestration/    # Team-lead operations
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

### Skills Architecture

The plugin uses a **3-skill architecture** optimized for role-based context loading:

#### 1. swarm-orchestration (~3,000 words, ~2,000 tokens)

**Purpose**: Team-lead operations for creating and managing swarms
**Auto-triggers on**: "set up team", "create swarm", "spawn teammates", "assign tasks", "coordinate agents", "swarm this task"
**Covers**:

- Analyzing tasks for swarm suitability
- Creating teams and spawning teammates
- Assigning tasks and monitoring progress
- Normal workflow orchestration
- Communication patterns
- Slash command reference (via references/)

#### 2. swarm-teammate (~2,000 words, ~1,200 tokens)

**Purpose**: Worker coordination protocol and teammate identity
**Auto-triggers via**: `CLAUDE_CODE_TEAM_NAME` environment variable (spawned teammates)
**Covers**:

- Teammate identity and role awareness
- Communication protocol (inbox checking, messaging)
- Task update procedures
- Coordination with team-lead and peers
- Working within swarm context

#### 3. swarm-troubleshooting (~5,500 words, ~3,500 tokens)

**Purpose**: Diagnostics, error recovery, and problem-solving
**Auto-triggers on**: "spawn failed", "diagnose team", "fix swarm", "status mismatch", "recovery", "swarm not working"
**Covers**:

- Spawn failure diagnosis and recovery
- Status mismatch reconciliation
- Multiplexer troubleshooting (kitty/tmux)
- Socket issues and connectivity problems
- Detailed error recovery procedures
- Advanced diagnostics reference (via references/)

#### Design Rationale

**Token Optimization**:

- **Workers load only swarm-teammate**: Saves ~2,000 tokens per worker (no orchestration content)
- **Team-lead loads swarm-orchestration**: Gets setup/management guidance without troubleshooting overhead
- **Troubleshooting loads on-demand**: Heavy diagnostics (~3,500 tokens) only when needed

**Expected Savings**:

- 5-teammate swarm: **13,000 tokens saved** (62% reduction: from 21,000 to 8,000 tokens)
- Workers: 3,500 → 1,200 tokens (66% reduction)
- Team-lead: 3,500 → 2,000 tokens (43% reduction)
- Team-lead with troubleshooting: 3,500 → 5,500 tokens (57% increase, but only when diagnosing issues)

**Progressive Disclosure**:
Each skill follows the three-tier loading pattern:

1. **SKILL.md** - Core guidance, auto-loaded
2. **references/** - Detailed reference docs, manually loaded
3. **examples/** - Practical examples, on-demand

#### Triggering Logic

**Explicit trigger phrases** (case-insensitive, partial match):

- swarm-orchestration: "set up", "create", "spawn", "assign", "coordinate", "swarm"
- swarm-troubleshooting: "fail", "diagnose", "fix", "mismatch", "recovery", "not working"

**Environment-based auto-trigger**:

- swarm-teammate: Automatically loads when `CLAUDE_CODE_TEAM_NAME` is set (all spawned teammates)

**No overlap**: Trigger phrases are mutually exclusive to prevent multi-skill loading

#### SWARM_TEAMMATE_SYSTEM_PROMPT Integration

`lib/core/00-globals.sh` defines the system prompt for spawned teammates:

```bash
SWARM_TEAMMATE_SYSTEM_PROMPT="You are a teammate in a Claude Code swarm..."
```

**Integration requirement**: After skills are created, update this prompt to reference swarm-teammate skill by name, ensuring teammates load appropriate guidance automatically.

**Example integration**:

```bash
SWARM_TEAMMATE_SYSTEM_PROMPT="You are a teammate in a Claude Code swarm. Follow the swarm-teammate skill guidelines..."
```

#### Cross-References

Skills reference each other when appropriate:

- **swarm-orchestration → swarm-troubleshooting**: "If spawn fails, see swarm-troubleshooting skill"
- **swarm-teammate → swarm-orchestration**: "For team setup questions, ask team-lead or see swarm-orchestration"
- **swarm-troubleshooting → swarm-orchestration**: "After recovery, return to swarm-orchestration for normal operations"

#### Validation Criteria

When testing the implementation, verify:

1. **Triggering**: Each skill loads with appropriate phrases, no unwanted multi-loading
2. **Content**: No unnecessary duplication (only essential overlaps like slash command lists)
3. **Token counts**: Verify actual token usage matches estimates (±10%)
4. **Environment integration**: `CLAUDE_CODE_TEAM_NAME` triggers swarm-teammate automatically
5. **References**: Progressive disclosure works (references/ loads only when requested)
6. **Cross-references**: Skills reference each other appropriately without creating dependency cycles

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
