# Swarm Coordination Guide

Detailed reference for swarm mode concepts, terminal support, and operational patterns.

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
listen_on unix:/tmp/kitty-$USER
```

> **Note:** Kitty automatically appends `-PID` to the socket path. So with the config above, the actual socket will be `/tmp/kitty-username-12345` (where 12345 is kitty's PID). The plugin handles this automatically.

**Important:** Restart kitty completely after changing config (not just reload). Verify with:

```bash
ls -la /tmp/kitty-$USER*  # Socket should exist (with -PID suffix)
kitten @ ls               # Should return JSON
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

## Kitty-Specific Features

### Spawn Modes

Set `SWARM_KITTY_MODE` before spawning:

```bash
export SWARM_KITTY_MODE=split   # Vertical splits within current tab (default)
export SWARM_KITTY_MODE=tab     # Separate tabs
export SWARM_KITTY_MODE=window  # Separate OS-level windows
```

### Session Files

Session files are stored with the team and can restore your entire swarm:

```bash
# Generate session file from team config
/claude-swarm:swarm-session generate my-team

# Launch kitty with all teammates
/claude-swarm:swarm-session launch my-team

# Or manually:
kitty --session ~/.claude/teams/my-team/swarm.kitty-session
```

### Window Identification

Kitty windows use user variables (`--var`) for reliable identification:

- Windows can be found even if claude renames tabs
- Matching uses `var:swarm_<team>_<agent>` pattern
- Works with `kitten @ close-window --match "var:..."`

## Task Dependencies

Set up dependencies when tasks must be completed in order:

```bash
/claude-swarm:task-create "Build API"                    # Task #1
/claude-swarm:task-create "Write integration tests"      # Task #2
/claude-swarm:task-update 2 --blocked-by 1               # #2 waits for #1
```

## Best Practices

### 1. Clear Initial Prompts

When spawning teammates, give them specific instructions:

```bash
/claude-swarm:swarm-spawn api-dev backend sonnet "You handle the REST API. Focus on /api/auth endpoints. Check task #1 for full requirements. Report to team-lead when done."
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
/claude-swarm:swarm-inbox          # Check for messages
/claude-swarm:task-list            # See task status
```

### 5. Clear Completion Signals

When done, teammates should:

1. Mark task completed: `/claude-swarm:task-update <id> --status completed`
2. Add completion comment: `/claude-swarm:task-update <id> --comment "Done. See commit abc123"`
3. Notify team-lead: `/claude-swarm:swarm-message team-lead "Task #<id> complete"`

## Monitoring Progress

### As Team Lead

```bash
/claude-swarm:swarm-status my-team   # Overview (shows multiplexer type)
/claude-swarm:task-list              # Task progress
/claude-swarm:swarm-inbox            # Check for updates
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
/claude-swarm:swarm-status my-team
```

## Team Lifecycle

Teams support suspend and resume for multi-day work:

### States

| State       | Description                     |
| ----------- | ------------------------------- |
| `active`    | Team running, members working   |
| `suspended` | Sessions closed, data preserved |

### Suspend a Team

```bash
/claude-swarm:swarm-cleanup my-team           # Soft: Kill sessions, keep data
```

This:

- Closes all teammate sessions/windows
- Marks members as "offline"
- Preserves all tasks, messages, and config

### Resume a Team

```bash
/claude-swarm:swarm-resume my-team
```

This:

- Changes team status to "active"
- Respawns each offline teammate with:
  - Their original model (haiku/sonnet/opus)
  - Context about assigned tasks
  - Notice of unread messages
- Teammates can continue where they left off

### Hard Cleanup (Delete)

```bash
/claude-swarm:swarm-cleanup my-team --force   # Kill sessions AND delete all data
```

## Troubleshooting

### Messages Not Delivered

Messages are file-based; teammates must check:

- Run `/claude-swarm:swarm-inbox` manually
- Messages auto-deliver on session start (hook)

### Teammate Not Responding

**tmux:**

1. Check session exists: `tmux list-sessions`
2. Attach and check: `tmux attach -t swarm-<team>-<name>`
3. Respawn if needed: `/claude-swarm:swarm-spawn`

**kitty:**

1. Check status: `/claude-swarm:swarm-status <team>`
2. Use kitten to list: `kitten @ ls | jq '.[] | .tabs[].windows[] | select(.user_vars.swarm_team)'`
3. Respawn if needed: `/claude-swarm:swarm-spawn`

### Task Assignment Issues

Verify agent name matches:

```bash
/claude-swarm:swarm-status <team>   # See member names
/claude-swarm:task-update <id> --assign <exact-name>
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
