# Claude Swarm Commands Reference

Comprehensive reference for all 17 Claude Swarm slash commands.

## Command Overview

| Category | Command | Description |
|----------|---------|-------------|
| **Team Management** | `/claude-swarm:swarm-create` | Create a new swarm team with configuration and directories |
| | `/claude-swarm:swarm-spawn` | Spawn a new teammate Claude Code instance in kitty or tmux |
| | `/claude-swarm:swarm-status` | View comprehensive status of team, members, and tasks |
| | `/claude-swarm:swarm-cleanup` | Suspend or permanently delete a team (kills sessions) |
| | `/claude-swarm:swarm-resume` | Resume a suspended team by respawning offline teammates |
| | `/claude-swarm:swarm-list-teams` | List all available teams with status and member counts |
| | `/claude-swarm:swarm-onboard` | Interactive onboarding wizard for new users |
| | `/claude-swarm:swarm-diagnose` | Diagnose team health, detect crashes, check socket status |
| | `/claude-swarm:swarm-verify` | Verify all teammates are alive and update their status |
| | `/claude-swarm:swarm-reconcile` | Fix status mismatches between config and reality |
| **Communication** | `/claude-swarm:swarm-message` | Send a message to another team member's inbox |
| | `/claude-swarm:swarm-inbox` | Check your inbox for messages from teammates |
| **Task Management** | `/claude-swarm:task-create` | Create a new task in the team task list |
| | `/claude-swarm:task-list` | List all tasks for the current team |
| | `/claude-swarm:task-update` | Update task status, assignment, or add comments |
| | `/claude-swarm:task-delete` | Delete a task from the task list (permanent) |
| **Kitty-Specific** | `/claude-swarm:swarm-session` | Generate, launch, or save kitty session files |

## Detailed Command Reference

### Team Management Commands

#### `/claude-swarm:swarm-create <team_name> [description]`
**Purpose:** Create a new swarm team

**Arguments:**
- `team_name` (required) - Unique name for the team
- `description` (optional) - Brief description of the team's purpose

**What it does:**
- Creates team directory at `~/.claude/teams/<team_name>/`
- Initializes `config.json` with team metadata
- Creates `inboxes/` subdirectory for messages
- Registers current session as team-lead
- Creates tasks directory at `~/.claude/tasks/<team_name>/`

**Usage:**
```bash
/claude-swarm:swarm-create api-redesign "Refactoring the REST API"
```

---

#### `/claude-swarm:swarm-spawn <name> [type] [model] [prompt]`
**Purpose:** Spawn a new teammate in a separate terminal session

**Arguments:**
- `name` (required) - Unique name for the teammate (e.g., "backend-dev")
- `type` (optional) - Agent role type: worker, backend-developer, frontend-developer, reviewer, researcher, tester (default: worker)
- `model` (optional) - Claude model: haiku, sonnet, opus (default: sonnet)
- `prompt` (optional) - Initial instructions for the teammate

**What it does:**
- Opens new kitty window/tab/split or tmux session
- Starts Claude Code with team environment variables set
- Registers teammate in team config
- Delivers any unread messages via SessionStart hook

**Usage:**
```bash
/claude-swarm:swarm-spawn backend-dev backend-developer sonnet "Focus on /api/auth endpoints. Check task #1."
```

---

#### `/claude-swarm:swarm-status <team_name>`
**Purpose:** View comprehensive team status

**Arguments:**
- `team_name` (required) - Name of the team to check

**What it shows:**
- Team name, description, and status (active/suspended)
- List of all members with their status (active/offline/crashed)
- Task summary (total, open, in-progress, resolved, blocked)
- Recent activity and heartbeats

**Usage:**
```bash
/claude-swarm:swarm-status api-redesign
```

---

#### `/claude-swarm:swarm-cleanup <team_name> [--force]`
**Purpose:** Suspend or permanently delete a team

**Arguments:**
- `team_name` (required) - Name of the team to clean up
- `--force` (optional) - Permanently delete all files (cannot be undone)

**What it does:**
- **Without --force:** Kills all teammate sessions, marks team as suspended, preserves all data (resumable)
- **With --force:** Kills sessions AND deletes team directory, task files, and all data (permanent)

**Usage:**
```bash
# Suspend (resumable)
/claude-swarm:swarm-cleanup api-redesign

# Permanent deletion
/claude-swarm:swarm-cleanup api-redesign --force
```

---

#### `/claude-swarm:swarm-resume <team_name>`
**Purpose:** Resume a suspended team

**Arguments:**
- `team_name` (required) - Name of the suspended team

**What it does:**
- Changes team status from suspended to active
- Respawns each offline teammate with:
  - Their original model (haiku/sonnet/opus)
  - Context about assigned tasks
  - Notification of unread messages
- Teammates can pick up where they left off

**Usage:**
```bash
/claude-swarm:swarm-resume api-redesign
```

---

#### `/claude-swarm:swarm-list-teams`
**Purpose:** List all available teams

**No arguments required**

**What it shows:**
- Team names and descriptions
- Team status (active/suspended/archived)
- Number of members in each team
- Total team count

**Usage:**
```bash
/claude-swarm:swarm-list-teams
```

---

#### `/claude-swarm:swarm-onboard [--skip-demo]`
**Purpose:** Interactive onboarding wizard for new Claude Swarm users

**Arguments:**
- `--skip-demo` (optional) - Skip the guided walkthrough and just show prerequisites

**What it does:**
- **Phase 1:** Check prerequisites (multiplexer, jq, kitty socket)
- **Phase 2:** Guide kitty configuration if needed
- **Phase 3:** Explain core concepts
- **Phase 4:** Optional guided walkthrough creating a test team
- **Phase 5:** Show available commands and offer to create first real team

**Usage:**
```bash
# Full onboarding with demo
/claude-swarm:swarm-onboard

# Prerequisites check only
/claude-swarm:swarm-onboard --skip-demo
```

---

#### `/claude-swarm:swarm-diagnose <team_name>`
**Purpose:** Comprehensive team health diagnostics

**Arguments:**
- `team_name` (required) - Team to diagnose

**What it checks:**
- Team configuration validity (JSON syntax, required fields)
- Socket health (kitty) or tmux availability
- Crashed agents (config says active, but no live session)
- Stale heartbeats (>5 minutes since last activity)
- Directory structure (team dir, inboxes, tasks)
- Status consistency between config and reality

**Usage:**
```bash
/claude-swarm:swarm-diagnose api-redesign
```

---

#### `/claude-swarm:swarm-verify [team_name]`
**Purpose:** Verify all teammates are alive and update status

**Arguments:**
- `team_name` (optional) - Team to verify (defaults to current team if in swarm session)

**What it does:**
- Checks which teammates have active sessions
- Updates config status for each member (active/offline)
- Reports which teammates are alive, which are offline
- Suggests respawning or reconciliation if needed

**Usage:**
```bash
/claude-swarm:swarm-verify api-redesign
```

---

#### `/claude-swarm:swarm-reconcile [team_name] [--auto-fix]`
**Purpose:** Fix status mismatches between config and reality

**Arguments:**
- `team_name` (optional) - Team to reconcile (defaults to current team)
- `--auto-fix` (optional) - Automatically fix issues without prompting

**What it does:**
- Detects crashed agents (marked active but no session)
- Marks crashed agents as offline in config
- Optionally asks if you want to respawn them
- Updates team status if all members are offline

**Usage:**
```bash
# Interactive mode
/claude-swarm:swarm-reconcile api-redesign

# Auto-fix mode
/claude-swarm:swarm-reconcile api-redesign --auto-fix
```

---

### Communication Commands

#### `/claude-swarm:swarm-message <to> <message>`
**Purpose:** Send a message to another team member

**Arguments:**
- `to` (required) - Recipient agent name (e.g., "team-lead", "backend-dev")
- `message` (required) - Message content

**What it does:**
- Writes message to recipient's inbox file: `~/.claude/teams/<team>/inboxes/<recipient>.json`
- Message includes: sender name, timestamp, content
- Recipient sees message on next SessionStart or manual `/swarm-inbox` check

**Usage:**
```bash
/claude-swarm:swarm-message team-lead "Task #1 complete. PR ready for review."
/claude-swarm:swarm-message backend-dev "Please implement OAuth first, changed priority"
```

---

#### `/claude-swarm:swarm-inbox [mark_read]`
**Purpose:** Check your inbox for messages

**Arguments:**
- `mark_read` (optional) - If "mark_read", marks all messages as read after displaying

**What it does:**
- Reads your inbox file: `~/.claude/teams/<team>/inboxes/<your-name>.json`
- Displays unread messages with sender, timestamp, and content
- Optionally marks messages as read to clear them

**Usage:**
```bash
# View messages
/claude-swarm:swarm-inbox

# View and mark as read
/claude-swarm:swarm-inbox mark_read
```

---

### Task Management Commands

#### `/claude-swarm:task-create <subject> [description]`
**Purpose:** Create a new task in the team task list

**Arguments:**
- `subject` (required) - Brief task title
- `description` (optional) - Detailed task description

**What it does:**
- Creates task file: `~/.claude/tasks/<team>/<id>.json`
- Assigns unique sequential task ID
- Initializes task with: subject, description, status (open), created timestamp
- Tasks are visible to all team members via `/task-list`

**Usage:**
```bash
/claude-swarm:task-create "Implement OAuth" "Add OAuth2 authentication to /api/auth endpoints"
```

---

#### `/claude-swarm:task-list`
**Purpose:** List all tasks for the current team

**No arguments required**

**What it shows:**
- All tasks with: ID, subject, status, assigned agent
- Task dependencies (blocked-by relationships)
- Comments and activity history

**Usage:**
```bash
/claude-swarm:task-list
```

---

#### `/claude-swarm:task-update <task_id> [options]`
**Purpose:** Update a task's status, assignment, or add comments

**Arguments:**
- `task_id` (required) - Task ID to update
- `--status <status>` (optional) - New status: pending, in-progress, blocked, in-review, completed
- `--assign <agent>` (optional) - Assign task to agent (e.g., "backend-dev")
- `--blocked-by <id>` (optional) - Mark task as blocked by another task ID
- `--comment <text>` (optional) - Add comment to task activity log

**What it does:**
- Updates task JSON file with new values
- Appends to activity log with timestamp and agent name
- Validates status transitions and assignments

**Usage:**
```bash
# Assign task
/claude-swarm:task-update 1 --assign backend-dev

# Update status
/claude-swarm:task-update 1 --status in-progress

# Add comment
/claude-swarm:task-update 1 --comment "Completed OAuth flow, testing now"

# Mark dependency
/claude-swarm:task-update 3 --blocked-by 1
```

---

#### `/claude-swarm:task-delete <task_id>`
**Purpose:** Delete a task from the task list

**Arguments:**
- `task_id` (required) - ID of the task to delete

**What it does:**
- Permanently removes task file: `~/.claude/tasks/<team>/<id>.json`
- Cannot be undone - task data is lost
- Suggests using `/task-list` to view remaining tasks

**Usage:**
```bash
/claude-swarm:task-delete 5
```

---

### Kitty-Specific Commands

#### `/claude-swarm:swarm-session <action> <team_name>`
**Purpose:** Manage kitty session files

**Arguments:**
- `action` (required) - Action to perform: generate, launch, or save
- `team_name` (required) - Team name

**Actions:**
- **generate** - Create session file from current team config
- **launch** - Launch a new kitty instance with all teammates using session file
- **save** - Alias for generate

**What it does:**
- Creates `~/.claude/teams/<team>/swarm.kitty-session` file
- Session file includes: layouts, environment variables, window titles
- Windows tagged with `--var swarm_<team>_<agent>` for reliable identification

**Usage:**
```bash
# Generate session file
/claude-swarm:swarm-session generate api-redesign

# Launch kitty with session
/claude-swarm:swarm-session launch api-redesign

# Or manually launch
kitty --session ~/.claude/teams/api-redesign/swarm.kitty-session
```

---

## Tips and Best Practices

### Command Combinations

**Starting a new project:**
```bash
/claude-swarm:swarm-create my-project "New feature development"
/claude-swarm:task-create "Setup API" "Initialize REST endpoints"
/claude-swarm:task-create "Build UI" "Create React components"
/claude-swarm:swarm-spawn backend-dev backend-developer sonnet
/claude-swarm:swarm-spawn frontend-dev frontend-developer sonnet
/claude-swarm:task-update 1 --assign backend-dev
/claude-swarm:task-update 2 --assign frontend-dev
```

**Checking team health:**
```bash
/claude-swarm:swarm-status my-project
/claude-swarm:swarm-diagnose my-project
/claude-swarm:swarm-verify my-project
```

**Suspending and resuming:**
```bash
# End of day
/claude-swarm:swarm-cleanup my-project

# Next day
/claude-swarm:swarm-resume my-project
```

**Coordinating work:**
```bash
/claude-swarm:task-list
/claude-swarm:swarm-message backend-dev "Check task #3, changed priority"
/claude-swarm:swarm-inbox
/claude-swarm:task-update 3 --status in-progress --comment "Working on this now"
```

### Command Frequency

**Use frequently:**
- `/task-list` - Stay aware of team progress
- `/swarm-inbox` - Check for messages (or rely on SessionStart hook)
- `/swarm-status` - Quick team overview

**Use when needed:**
- `/swarm-diagnose` - When something seems wrong
- `/swarm-verify` - After spawning teammates or suspecting crashes
- `/swarm-reconcile` - When diagnose detects mismatches

**Use once per session:**
- `/swarm-onboard` - First time setup only
- `/swarm-create` - Start of new project
- `/swarm-cleanup` - End of work session

### Aliases and Shortcuts

Since all commands start with `/claude-swarm:`, you may want to create shell aliases:

```bash
# Add to ~/.zshrc or ~/.bashrc
alias swarm-create='/claude-swarm:swarm-create'
alias swarm-status='/claude-swarm:swarm-status'
alias task-list='/claude-swarm:task-list'
# etc.
```

---

## Environment Variables

Commands automatically read these variables when available:

| Variable | Description | Usage |
|----------|-------------|-------|
| `CLAUDE_CODE_TEAM_NAME` | Current team name | Auto-set by spawn, used by task/message commands |
| `CLAUDE_CODE_AGENT_ID` | Your unique agent UUID | Auto-set by spawn |
| `CLAUDE_CODE_AGENT_NAME` | Your agent name | Auto-set by spawn, used for message sender |
| `CLAUDE_CODE_AGENT_TYPE` | Your role type | Auto-set by spawn |
| `SWARM_MULTIPLEXER` | Force tmux or kitty | Set by user to override auto-detection |
| `SWARM_KITTY_MODE` | Kitty spawn mode | Set by user: window, split, or tab |
| `KITTY_LISTEN_ON` | Kitty socket path | Set by user to override default |

---

## Related Documentation

- **[Main README](../README.md)** - Installation, setup, quick start, agent types, best practices, troubleshooting
- **[Hooks Documentation](HOOKS.md)** - Event-driven automation and lifecycle hooks
- **[Integration Guide](INTEGRATION.md)** - CI/CD integration, external systems, custom tooling
- **[Swarm Coordination Skill](../skills/swarm-coordination/SKILL.md)** - Orchestration workflows and best practices
