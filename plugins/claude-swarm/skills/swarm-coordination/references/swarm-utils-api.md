# Swarm Utils API Reference

Complete reference for the `swarm-utils.sh` bash library functions. These functions provide programmatic control over swarm teams.

## Library Architecture

The swarm-utils library uses a modular architecture with 13 specialized modules organized by functional responsibility:

- **core/** - Global variables, utilities, file locking
- **multiplexer/** - Terminal multiplexer detection and control (kitty/tmux)
- **team/** - Team lifecycle, status management
- **communication/** - Message inbox system
- **tasks/** - Task management CRUD operations
- **spawn/** - Teammate spawning, cleanup, diagnostics

All modules are loaded automatically when you source `swarm-utils.sh`. The modular design improves maintainability while maintaining 100% backward compatibility with existing code.

## Setup

Source the library before using functions:

```bash
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh"
```

**Note:** Slash commands (e.g., `/claude-swarm:*`) are preferred over direct function calls for better reliability, validation, and error handling.

## Team Management

### create_team

Creates a new swarm team with directory structure and config.

```bash
create_team "<team-name>" "<description>"
```

**Parameters:**
- `team-name` (required): Unique identifier for the team (alphanumeric, hyphens, underscores)
- `description` (required): Human-readable description of team purpose

**Returns:**
- Exit code 0 on success
- Exit code 1 if team already exists or invalid parameters

**Creates:**
- `~/.claude/teams/<team-name>/` directory
- `~/.claude/teams/<team-name>/config.json` with team metadata
- `~/.claude/teams/<team-name>/inbox/` directory for messages
- `~/.claude/tasks/<team-name>/` directory for task list

**Example:**
```bash
create_team "auth-team" "Team implementing authentication features"
```

**Equivalent Slash Command:**
```bash
/claude-swarm:swarm-create "auth-team" "Team implementing authentication features"
```

---

### list_teams

Lists all existing swarm teams.

```bash
list_teams
```

**Parameters:** None

**Returns:**
- Prints team names, one per line
- Exit code 0 on success

**Example:**
```bash
teams=$(list_teams)
echo "Active teams: $teams"
```

**Equivalent Slash Command:**
```bash
/claude-swarm:swarm-list-teams
```

---

### cleanup_team

Cleans up a swarm team by killing sessions and optionally removing files.

```bash
cleanup_team "<team-name>" [--force]
```

**Parameters:**
- `team-name` (required): Name of team to clean up
- `--force` (optional): Also remove config and task files

**Behavior:**
- Without `--force`: Kills all team sessions (soft cleanup)
- With `--force`: Kills sessions AND removes all team files (hard cleanup)

**Example:**
```bash
# Soft cleanup (preserves data)
cleanup_team "auth-team"

# Hard cleanup (removes everything)
cleanup_team "auth-team" --force
```

**Equivalent Slash Command:**
```bash
/claude-swarm:swarm-cleanup "auth-team"
/claude-swarm:swarm-cleanup "auth-team" --force
```

---

## Teammate Management

### spawn_teammate

Spawns a new Claude Code instance as a teammate in tmux or kitty.

```bash
spawn_teammate "<team-name>" "<agent-name>" "<agent-type>" "<model>" "<initial-prompt>"
```

**Parameters:**
- `team-name` (required): Team to join
- `agent-name` (required): Unique name for this teammate
- `agent-type` (required): Role type (worker, backend-developer, frontend-developer, reviewer, researcher, tester)
- `model` (required): Model to use (haiku, sonnet, opus)
- `initial-prompt` (required): Initial instructions for the teammate

**Returns:**
- Exit code 0 on success
- Exit code 1 on failure (multiplexer unavailable, duplicate name, etc.)

**Behavior:**
- Creates tmux or kitty session named `swarm-<team>-<agent>`
- Sets up team environment variables
- Launches Claude Code with initial prompt
- Registers teammate in team config

**Example:**
```bash
spawn_teammate "auth-team" "backend-dev" "backend-developer" "sonnet" \
  "You are the backend developer. Implement JWT authentication endpoints. Check task #1 for details."
```

**Equivalent Slash Command:**
```bash
/claude-swarm:swarm-spawn "backend-dev" "backend-developer" "sonnet" \
  "You are the backend developer. Implement JWT authentication endpoints. Check task #1 for details."
```

**Important:** Always verify spawn success:
```bash
/claude-swarm:swarm-verify <team-name>
```

---

### swarm_status

Shows status of all teammates in a team.

```bash
swarm_status "<team-name>"
```

**Parameters:**
- `team-name` (required): Team to check

**Returns:**
- Prints formatted status table
- Exit code 0 on success

**Output Includes:**
- Agent names and types
- Online/offline status
- Assigned tasks
- Last activity

**Example:**
```bash
swarm_status "auth-team"
```

**Equivalent Slash Command:**
```bash
/claude-swarm:swarm-status "auth-team"
```

---

## Task Management

### create_task

Creates a new task in the team task list.

```bash
create_task "<team-name>" "<subject>" "<description>"
```

**Parameters:**
- `team-name` (required): Team owning the task
- `subject` (required): Short task title
- `description` (required): Detailed task description

**Returns:**
- Prints task ID
- Exit code 0 on success

**Creates:**
Task with:
- Unique numeric ID
- Status: "pending"
- Assignment: null
- Comments: []
- Blocked by: []
- Created timestamp

**Example:**
```bash
task_id=$(create_task "auth-team" "Implement JWT middleware" \
  "Create Express middleware to verify JWT tokens on protected routes")
echo "Created task #$task_id"
```

**Equivalent Slash Command:**
```bash
/claude-swarm:task-create "Implement JWT middleware" \
  "Create Express middleware to verify JWT tokens on protected routes"
```

---

### list_tasks

Lists all tasks for a team.

```bash
list_tasks "<team-name>"
```

**Parameters:**
- `team-name` (required): Team whose tasks to list

**Returns:**
- Prints formatted task list
- Exit code 0 on success

**Output Includes:**
- Task IDs
- Subjects
- Status
- Assignments
- Dependencies

**Example:**
```bash
list_tasks "auth-team"
```

**Equivalent Slash Command:**
```bash
/claude-swarm:task-list
```

---

### update_task

Updates task properties.

```bash
update_task "<team-name>" "<task-id>" [options]
```

**Parameters:**
- `team-name` (required): Team owning the task
- `task-id` (required): Numeric task ID
- `options`: One or more of:
  - `--status <status>`: Change status (pending, in-progress, blocked, in-review, completed)
  - `--assign <agent-name>`: Assign to teammate
  - `--blocked-by <task-id>`: Add dependency
  - `--comment <text>`: Add progress comment

**Returns:**
- Exit code 0 on success
- Exit code 1 if task not found or invalid parameters

**Examples:**
```bash
# Update status
update_task "auth-team" "1" --status "in-progress"

# Assign to teammate
update_task "auth-team" "1" --assign "backend-dev"

# Add comment
update_task "auth-team" "1" --comment "JWT implementation 50% complete"

# Set dependency
update_task "auth-team" "4" --blocked-by "1"

# Multiple updates
update_task "auth-team" "1" --status "completed" --comment "All tests passing"
```

**Equivalent Slash Command:**
```bash
/claude-swarm:task-update 1 --status "in-progress"
/claude-swarm:task-update 1 --assign "backend-dev"
/claude-swarm:task-update 1 --comment "JWT implementation 50% complete"
```

---

### assign_task

Assigns a task to a teammate (convenience wrapper for update_task).

```bash
assign_task "<team-name>" "<task-id>" "<agent-name>"
```

**Parameters:**
- `team-name` (required): Team owning the task
- `task-id` (required): Numeric task ID
- `agent-name` (required): Teammate to assign to

**Returns:**
- Exit code 0 on success
- Exit code 1 if task or agent not found

**Example:**
```bash
assign_task "auth-team" "1" "backend-dev"
```

**Equivalent:**
```bash
update_task "auth-team" "1" --assign "backend-dev"
# or
/claude-swarm:task-update 1 --assign "backend-dev"
```

---

### delete_task

Deletes a task from the task list.

```bash
delete_task "<team-name>" "<task-id>"
```

**Parameters:**
- `team-name` (required): Team owning the task
- `task-id` (required): Numeric task ID to delete

**Returns:**
- Exit code 0 on success
- Exit code 1 if task not found

**Example:**
```bash
delete_task "auth-team" "3"
```

**Equivalent Slash Command:**
```bash
/claude-swarm:task-delete 3
```

---

## Communication

### send_message

Sends a message to a specific teammate's inbox.

```bash
send_message "<team-name>" "<to-agent>" "<message>"
```

**Parameters:**
- `team-name` (required): Team context
- `to-agent` (required): Recipient agent name
- `message` (required): Message content

**Returns:**
- Exit code 0 on success
- Exit code 1 if agent not found

**Behavior:**
- Appends message to `~/.claude/teams/<team>/inbox/<agent>.json`
- Message includes sender, timestamp, and content

**Example:**
```bash
send_message "auth-team" "backend-dev" "API endpoints ready for integration"
```

**Equivalent Slash Command:**
```bash
/claude-swarm:swarm-message "backend-dev" "API endpoints ready for integration"
```

---

### broadcast_message

Sends a message to all teammates in a team.

```bash
broadcast_message "<team-name>" "<message>" "<exclude-self>"
```

**Parameters:**
- `team-name` (required): Team to broadcast to
- `message` (required): Message content
- `exclude-self` (required): "true" to exclude sender, "false" to include

**Returns:**
- Exit code 0 on success

**Example:**
```bash
broadcast_message "auth-team" "Database schema updated - please pull latest" "true"
```

**No Direct Slash Command Equivalent** (use bash function)

---

### read_inbox

Reads and optionally marks messages as read from an agent's inbox.

```bash
read_inbox "<team-name>" "<agent-name>" [mark-read]
```

**Parameters:**
- `team-name` (required): Team context
- `agent-name` (required): Agent whose inbox to read
- `mark-read` (optional): "true" to mark as read and clear inbox

**Returns:**
- Prints unread messages
- Exit code 0 on success

**Example:**
```bash
# View messages
read_inbox "auth-team" "team-lead"

# View and clear
read_inbox "auth-team" "team-lead" "true"
```

**Equivalent Slash Command:**
```bash
/claude-swarm:swarm-inbox
/claude-swarm:swarm-inbox --mark-read  # Mark as read
```

---

## Advanced Functions

### verify_team_health

Checks if all teammates are alive and responsive.

```bash
verify_team_health "<team-name>"
```

**Parameters:**
- `team-name` (required): Team to verify

**Returns:**
- Prints status for each teammate
- Exit code 0 if all alive
- Exit code 1 if any offline

**Example:**
```bash
if verify_team_health "auth-team"; then
    echo "All teammates healthy"
else
    echo "Some teammates offline"
fi
```

**Equivalent Slash Command:**
```bash
/claude-swarm:swarm-verify "auth-team"
```

---

### reconcile_team_status

Fixes mismatches between config and actual session state.

```bash
reconcile_team_status "<team-name>"
```

**Parameters:**
- `team-name` (required): Team to reconcile

**Returns:**
- Prints discovered issues and fixes applied
- Exit code 0 on success

**Behavior:**
- Detects offline sessions marked active
- Updates config to match reality
- Reports zombie entries
- Suggests recovery actions

**Example:**
```bash
reconcile_team_status "auth-team"
```

**Equivalent Slash Command:**
```bash
/claude-swarm:swarm-reconcile "auth-team"
```

---

### diagnose_team

Comprehensive health check and diagnostic report.

```bash
diagnose_team "<team-name>"
```

**Parameters:**
- `team-name` (required): Team to diagnose

**Returns:**
- Detailed diagnostic report
- Exit code 0 on success

**Checks:**
- Config validity
- Socket health
- Session status
- Task list state
- Inbox status
- Permission issues

**Example:**
```bash
diagnose_team "auth-team" > diagnosis.txt
```

**Equivalent Slash Command:**
```bash
/claude-swarm:swarm-diagnose "auth-team"
```

---

### resume_team

Resumes a suspended team by respawning offline teammates.

```bash
resume_team "<team-name>"
```

**Parameters:**
- `team-name` (required): Team to resume

**Returns:**
- Exit code 0 on success

**Behavior:**
- Identifies offline teammates
- Respawns them with task context
- Restores assignments
- Notifies team of resume

**Example:**
```bash
resume_team "auth-team"
```

**Equivalent Slash Command:**
```bash
/claude-swarm:swarm-resume "auth-team"
```

---

## Environment Variables

When a teammate is spawned, these environment variables are set:

| Variable | Description | Example |
|----------|-------------|---------|
| `CLAUDE_SWARM_TEAM` | Team name | `auth-team` |
| `CLAUDE_SWARM_AGENT` | Agent name | `backend-dev` |
| `CLAUDE_SWARM_ROLE` | Agent role/type | `backend-developer` |

Teammates can access these in their session:

```bash
echo "I am $CLAUDE_SWARM_AGENT in team $CLAUDE_SWARM_TEAM"
```

---

## File Locations

Understanding file structure for debugging:

```
~/.claude/
├── teams/
│   └── <team-name>/
│       ├── config.json              # Team metadata, teammate registry
│       └── inbox/
│           ├── team-lead.json       # Team lead's inbox
│           ├── backend-dev.json     # Backend dev's inbox
│           └── ...
├── tasks/
│   └── <team-name>/
│       └── tasks.json               # Task list with status, assignments
└── sockets/
    └── <session-id>                 # Unix sockets for communication
```

---

## Error Codes

Common exit codes:

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error (invalid parameters, not found, etc.) |
| 2 | Permission denied |
| 3 | Resource unavailable (multiplexer, socket, etc.) |

Check exit codes for error handling:

```bash
if ! spawn_teammate "team" "agent" "worker" "sonnet" "prompt"; then
    echo "Spawn failed with code $?"
    # Handle error
fi
```

---

## Best Practices

1. **Always source before use:**
```bash
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh"
```

2. **Prefer slash commands** for interactive use:
```bash
# Good for interactive
/claude-swarm:swarm-spawn "agent" "worker" "sonnet" "prompt"

# Good for scripting
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh"
spawn_teammate "team" "agent" "worker" "sonnet" "prompt"
```

3. **Check return codes:**
```bash
if create_team "my-team" "description"; then
    echo "Success"
else
    echo "Failed with code $?"
fi
```

4. **Verify after spawn:**
```bash
spawn_teammate "team" "agent" ...
verify_team_health "team"
```

5. **Use diagnostic tools:**
```bash
# Something wrong? Diagnose first
diagnose_team "team"
reconcile_team_status "team"
```

---

## See Also

- [Communication Patterns](communication.md) - Message workflows
- [Error Handling](error-handling.md) - Troubleshooting guide
- [Quick Start](../examples/quick-start.md) - Hands-on tutorial
