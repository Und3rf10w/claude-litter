---
name: Swarm Guide
description: This skill should be used when the user asks "how do I coordinate agents?", "set up a team", "work in parallel", "use swarm mode", "coordinate multiple Claude instances", or needs guidance on effective multi-agent collaboration patterns and best practices.
---

# Swarm Coordination Guide

## What is Swarm Mode?

Swarm mode enables multiple Claude Code instances to work together on a task in parallel. Instead of sequential agent execution, teammates run simultaneously in separate sessions (tmux or kitty), communicating via file-based messaging.

## Terminal Support

The plugin supports both **tmux** and **kitty** terminals:

| Feature           | tmux     | kitty                |
| ----------------- | -------- | -------------------- |
| Multiple sessions | Yes      | Yes                  |
| Spawn modes       | Sessions | Window, Split, Tab   |
| Session files     | No       | Yes (.kitty-session) |
| Auto-detection    | Yes      | Yes (via $KITTY_PID) |

### Kitty Prerequisites

If using kitty, add to `~/.config/kitty/kitty.conf`:

```
allow_remote_control yes
```

### Override Detection

```bash
export SWARM_MULTIPLEXER=tmux   # Force tmux
export SWARM_MULTIPLEXER=kitty  # Force kitty
```

## When to Use Swarm Mode

**Good candidates:**

- Large features with independent components (backend + frontend + tests)
- Tasks that benefit from parallel execution
- Work that naturally divides by expertise
- Multi-file refactoring across modules

**Not ideal for:**

- Simple single-file changes
- Tasks requiring tight coordination
- Quick fixes or small features
- Tasks where context sharing is critical

## Quick Start

### Option 1: Automated Orchestration

Just describe your task - the swarm-coordinator agent handles everything:

```
"Set up a team to implement user authentication with login, signup, and password reset"
```

### Option 2: Manual Setup

```bash
/swarm-create my-team                    # Create team structure
/task-create "Implement API endpoints"   # Create tasks
/task-create "Build UI components"
/swarm-spawn backend-dev backend         # Spawn teammates
/swarm-spawn frontend-dev frontend
/task-update 1 --assign backend-dev      # Assign work
/task-update 2 --assign frontend-dev
```

## Available Commands

| Command                          | Purpose                                   |
| -------------------------------- | ----------------------------------------- |
| `/swarm-create <team>`           | Create team directories and config        |
| `/swarm-spawn <name> <type>`     | Spawn teammate (tmux/kitty auto-detected) |
| `/swarm-message <to> <message>`  | Send message to teammate                  |
| `/swarm-inbox`                   | Check your inbox for messages             |
| `/swarm-status <team>`           | View team status and progress             |
| `/swarm-cleanup <team>`          | Clean up team resources                   |
| `/swarm-session <action> <team>` | Manage kitty session files (kitty only)   |
| `/task-create <subject>`         | Create a new task                         |
| `/task-list`                     | List all tasks                            |
| `/task-update <id> [options]`    | Update task status/assignment             |

## Kitty-Specific Features

### Spawn Modes

Set `SWARM_KITTY_MODE` before spawning:

```bash
export SWARM_KITTY_MODE=window  # Separate windows (default)
export SWARM_KITTY_MODE=split   # Splits within current tab
export SWARM_KITTY_MODE=tab     # Separate tabs
```

Or use `--mode` argument:

```bash
/swarm-spawn backend-dev backend --mode=split
```

### Session Files

Session files are stored with the team and can restore your entire swarm:

```bash
# Generate session file from team config
/swarm-session generate my-team

# Launch kitty with all teammates
/swarm-session launch my-team

# Or manually:
kitty --session ~/.claude/teams/my-team/swarm.kitty-session
```

### Window Identification

Kitty windows use user variables (`--var`) for reliable identification. This means:

- Windows can be found even if claude renames tabs
- Matching uses `var:swarm_<team>_<agent>` pattern
- Works with `kitten @ close-window --match "var:..."`

## Communication Patterns

### Team Lead → Teammates

```bash
/swarm-message backend-dev "Priority change: implement OAuth first"
```

### Broadcasting to All

The team-lead can broadcast:

```bash
# In team-lead session
source ~/.claude/plugins/claude-swarm/lib/swarm-utils.sh
broadcast_message "my-team" "Stand-up: share your progress" "team-lead"
```

### Teammates → Team Lead

Teammates should report completion:

```bash
/swarm-message team-lead "Task #1 complete. PR ready for review."
```

## Task Dependencies

Set up dependencies when tasks must be completed in order:

```bash
/task-create "Build API"                    # Task #1
/task-create "Write integration tests"      # Task #2
/task-update 2 --blocked-by 1               # #2 waits for #1
```

## Best Practices

### 1. Clear Initial Prompts

When spawning teammates, give them specific instructions:

```bash
/swarm-spawn api-dev backend --model=sonnet "You handle the REST API. Focus on /api/auth endpoints. Check task #1 for full requirements. Report to team-lead when done."
```

### 2. Right-Size Your Team

- 2-3 teammates: Small features
- 4-5 teammates: Medium features
- 6+ teammates: Large projects (more coordination overhead)

### 3. Model Selection

- `haiku`: Simple, well-defined tasks
- `sonnet`: Balanced complexity (default)
- `opus`: Complex reasoning, architecture

### 4. Regular Check-ins

Teammates should periodically:

```bash
/swarm-inbox          # Check for messages
/task-list            # See task status
```

### 5. Clear Completion Signals

When done, teammates should:

1. Mark task resolved: `/task-update <id> --status resolved`
2. Add completion comment: `/task-update <id> --comment "Done. See commit abc123"`
3. Notify team-lead: `/swarm-message team-lead "Task #<id> complete"`

## Monitoring Progress

### As Team Lead

```bash
/swarm-status my-team   # Overview (shows multiplexer type)
/task-list              # Task progress
/swarm-inbox            # Check for updates
```

### Attach to Teammate (tmux)

```bash
tmux attach -t swarm-my-team-backend-dev
# Detach with: Ctrl+B, then D
```

### View All Sessions

```bash
# tmux
tmux list-sessions | grep swarm

# kitty (check status instead)
/swarm-status my-team
```

## Cleanup

When finished:

```bash
/swarm-cleanup my-team           # Kill sessions/windows
/swarm-cleanup my-team --force   # Also remove files
```

## Troubleshooting

### Messages Not Delivered

Messages are file-based; teammates must check:

- Run `/swarm-inbox` manually
- Messages auto-deliver on session start (hook)

### Teammate Not Responding

**tmux:**

1. Check session exists: `tmux list-sessions`
2. Attach and check: `tmux attach -t swarm-<team>-<name>`
3. Respawn if needed: `/swarm-spawn`

**kitty:**

1. Check status: `/swarm-status <team>`
2. Use kitten to list: `kitten @ ls | jq '.[] | .tabs[].windows[] | select(.user_vars.swarm_team)'`
3. Respawn if needed: `/swarm-spawn`

### Task Assignment Issues

Verify agent name matches:

```bash
/swarm-status <team>   # See member names
/task-update <id> --assign <exact-name>
```

## Environment Variables

When inside a swarm session:

- `CLAUDE_CODE_TEAM_NAME` - Team name
- `CLAUDE_CODE_AGENT_ID` - Your UUID
- `CLAUDE_CODE_AGENT_NAME` - Your name
- `CLAUDE_CODE_AGENT_TYPE` - Your role type

Control variables:

- `SWARM_MULTIPLEXER` - Force tmux or kitty
- `SWARM_KITTY_MODE` - Kitty spawn mode (window/split/tab)

## File Locations

```
~/.claude/teams/<team>/
├── config.json              # Team configuration
├── swarm.kitty-session      # Kitty session file (if generated)
└── inboxes/
    ├── team-lead.json       # Inbox files
    ├── backend-dev.json
    └── ...

~/.claude/tasks/<team>/
├── 1.json                   # Task files
├── 2.json
└── ...
```
