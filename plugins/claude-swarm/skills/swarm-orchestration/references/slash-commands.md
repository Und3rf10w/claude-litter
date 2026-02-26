# Slash Commands Reference

Comprehensive reference for all slash commands used in swarm orchestration. Always prefer slash commands over bash functions for better reliability and error handling.

## Who Runs These Commands?

Commands can be run by either the **orchestrator** (user) or the **team-lead** depending on the orchestration mode:

| Role | Delegation Mode (Default) | Direct Mode (`--no-lead`) |
|------|---------------------------|---------------------------|
| **User/Orchestrator** | `swarm-create`, `task-create` (high-level), `swarm-status`, `swarm-inbox`, `swarm-message` (to team-lead), `swarm-cleanup` | All commands |
| **Team-lead** | `swarm-spawn`, `swarm-verify`, `task-create` (detailed), `task-update`, `swarm-message` (to workers), `swarm-broadcast`, `swarm-send-text` | N/A (user is team-lead) |
| **Workers** | `swarm-inbox`, `swarm-message`, `task-update` (own tasks), `task-list` | Same |

**Note:** In delegation mode, team-lead handles most coordination commands. In direct mode, the user handles everything.

## Team Management Commands

### `/claude-swarm:swarm-create`

Create a new swarm team.

**Syntax:**

```bash
/claude-swarm:swarm-create "<team-name>" "[description]" [--no-lead] [--lead-model <model>]
```

**Parameters:**

| Parameter       | Required | Description                                       |
| --------------- | -------- | ------------------------------------------------- |
| `team-name`     | Yes      | Unique team identifier (kebab-case recommended)   |
| `description`   | No       | Human-readable team description                   |
| `--no-lead`     | No       | Skip auto-spawning team-lead window               |
| `--lead-model`  | No       | Model for team-lead (haiku/sonnet/opus, default: sonnet) |

**Examples:**

```bash
# Create team with auto-spawned team-lead (default)
/claude-swarm:swarm-create "auth-feature"

# With description
/claude-swarm:swarm-create "payment-system" "Implementing Stripe payment processing"

# With opus model for team-lead
/claude-swarm:swarm-create "complex-feature" "Complex work" --lead-model opus

# Without auto-spawning team-lead
/claude-swarm:swarm-create "remote-team" "Remote setup" --no-lead
```

**What It Does:**

- Creates team directory: `~/.claude/teams/<team-name>/`
- Initializes config.json with team metadata
- Creates task directory: `~/.claude/tasks/<team-name>/`
- Sets up inbox system
- Auto-spawns team-lead window (unless `--no-lead` specified)
- Designates you as team-lead

**Notes:**

- Team names must be unique
- Use kebab-case for consistency
- Avoid special characters except hyphens
- Max length: 100 characters

---

### `/claude-swarm:swarm-status`

View comprehensive team status.

**Syntax:**

```bash
/claude-swarm:swarm-status "<team-name>"
```

**Parameters:**

| Parameter   | Required | Description           |
| ----------- | -------- | --------------------- |
| `team-name` | Yes      | Name of team to check |

**Example:**

```bash
/claude-swarm:swarm-status "payment-system"
```

**Output:**

- Multiplexer type (tmux/kitty)
- Team description
- Member list with status (config vs live)
- Status mismatches (if any)
- Session file location (kitty only)
- Task summary (active/completed counts)

**Notes:**

- Shows real-time comparison of config vs live sessions
- Highlights status mismatches
- Use regularly to monitor team health

---

### `/claude-swarm:swarm-verify`

Verify all teammates are alive and responsive.

**Syntax:**

```bash
/claude-swarm:swarm-verify "<team-name>"
```

**Parameters:**

| Parameter   | Required | Description            |
| ----------- | -------- | ---------------------- |
| `team-name` | Yes      | Name of team to verify |

**Example:**

```bash
/claude-swarm:swarm-verify "payment-system"
```

**What It Does:**

- Checks each teammate's session/window exists
- Verifies sessions are responsive
- Reports any missing or crashed teammates

**When to Use:**

- Immediately after spawning teammates
- When status looks suspicious
- Before assigning critical tasks
- After system disruptions

---

### `/claude-swarm:swarm-cleanup`

Clean up a team by terminating sessions and optionally removing data.

**Syntax:**

```bash
/claude-swarm:swarm-cleanup "<team-name>" [--force]
```

**Parameters:**

| Parameter   | Required | Description                              |
| ----------- | -------- | ---------------------------------------- |
| `team-name` | Yes      | Name of team to clean up                 |
| `--force`   | No       | Also delete all team data (irreversible) |

**Examples:**

```bash
# Soft cleanup (sessions only)
/claude-swarm:swarm-cleanup "payment-system"

# Hard cleanup (sessions + data)
/claude-swarm:swarm-cleanup "payment-system" --force
```

**Cleanup Types:**

| Type               | Sessions | Config    | Tasks     | Messages  | Reversible       |
| ------------------ | -------- | --------- | --------- | --------- | ---------------- |
| **Soft** (default) | Killed   | Preserved | Preserved | Preserved | Yes (use resume) |
| **Hard** (--force) | Killed   | Deleted   | Deleted   | Deleted   | No               |

**Before Cleanup:**

- Verify all tasks complete
- Save important data/messages
- Confirm with user if using --force
- Send final messages to teammates

**After Soft Cleanup:**

Team can be resumed with `/claude-swarm:swarm-resume <team>` (covered in swarm-troubleshooting skill).

---

## Spawning Commands

### `/claude-swarm:swarm-spawn`

Spawn a new teammate in the team.

**Syntax:**

```bash
/claude-swarm:swarm-spawn "<agent-name>" "[agent-type]" "[model]" "[initial-prompt]" [KEY=VALUE...]
```

**Parameters:**

| Parameter        | Required | Default  | Description                           |
| ---------------- | -------- | -------- | ------------------------------------- |
| `agent-name`     | Yes      | -        | Unique name for this teammate         |
| `agent-type`     | No       | `worker` | Role type (see table below)           |
| `model`          | No       | `sonnet` | Claude model to use                   |
| `initial-prompt` | No       | Generic  | Initial instructions for teammate     |
| `KEY=VALUE`      | No       | -        | Custom environment variables to set   |

**Agent Types:**

| Type                 | Use For                         |
| -------------------- | ------------------------------- |
| `worker`             | General-purpose tasks           |
| `backend-developer`  | Server-side, API, database work |
| `frontend-developer` | UI, components, styling         |
| `reviewer`           | Code review, QA                 |
| `researcher`         | Documentation, analysis         |
| `tester`             | Test writing, validation        |

**Models:**

| Model    | Speed    | Capability | Cost    | Best For                        |
| -------- | -------- | ---------- | ------- | ------------------------------- |
| `haiku`  | Fastest  | Basic      | Lowest  | Simple, repetitive tasks        |
| `sonnet` | Balanced | Good       | Medium  | Most tasks (recommended)        |
| `opus`   | Slowest  | Best       | Highest | Complex reasoning, architecture |

**Examples:**

```bash
# Minimal (uses defaults)
/claude-swarm:swarm-spawn "backend-dev"

# Specify type and model
/claude-swarm:swarm-spawn "api-dev" "backend-developer" "opus"

# Full specification with prompt
/claude-swarm:swarm-spawn "backend-dev" "backend-developer" "sonnet" "You are the backend developer. Work on Task #2: Implement Stripe integration. Check task list for details. Message team-lead when complete."

# With custom environment variables
/claude-swarm:swarm-spawn "tester" "tester" "sonnet" "Run integration tests" ENVIRONMENT=staging DEBUG=true

# With API configuration
/claude-swarm:swarm-spawn "integrations" "backend-developer" "opus" "Build integrations" API_ENDPOINT=https://api.staging.example.com
```

**Custom Environment Variables:**

- Pass `KEY=VALUE` arguments after the initial prompt
- Variables are exported in the teammate's session
- Available to bash commands and scripts
- **Security note:** For sensitive credentials, use `.env` files instead (command-line args visible in process listings)

**Initial Prompt Best Practices:**

Include:

- ✓ Role identity ("You are the backend developer")
- ✓ Task assignment ("Work on Task #2")
- ✓ How to get details ("Check task list")
- ✓ What to do when done ("Message team-lead")
- ✓ Any special instructions

**After Spawning:**

Always verify with `/claude-swarm:swarm-verify <team>`.

**Notes:**

- Agent names must be unique within team
- Spawns happen in background (tmux) or splits/tabs/windows (kitty)
- Environment variables auto-set for each teammate
- Failed spawns require diagnosis (see swarm-troubleshooting skill)

---

## Communication Commands

### `/claude-swarm:swarm-message`

Send a message to a specific teammate.

**Syntax:**

```bash
/claude-swarm:swarm-message "<to>" "<message>"
```

**Parameters:**

| Parameter | Required | Description            |
| --------- | -------- | ---------------------- |
| `to`      | Yes      | Recipient's agent name |
| `message` | Yes      | Message text           |

**Examples:**

```bash
# Simple notification
/claude-swarm:swarm-message "backend-dev" "Task #1 complete. You're unblocked."

# Detailed message with context
/claude-swarm:swarm-message "backend-dev" "API design ready in docs/payment-api.md. Key endpoints: POST /payments, GET /payments/:id. Webhook handling required. Start implementation when ready."

# Question/request
/claude-swarm:swarm-message "frontend-dev" "What UI framework are you using for the checkout form? Need to ensure backend data format matches."
```

**Message Best Practices:**

**Good messages:**

- Reference specific files and line numbers
- Include task IDs
- Provide actionable information
- Give context for blockers
- Be specific about requirements

**Poor messages:**

- Vague ("done", "working on it")
- No context ("it's broken")
- Missing details ("need help")

**When Recipients See Messages:**

- On next `/claude-swarm:swarm-inbox` call
- Automatically on session start (via hook)
- Via real-time notification (if teammate is active in kitty)

---

### `/claude-swarm:swarm-inbox`

Check your inbox for messages from teammates.

**Syntax:**

```bash
/claude-swarm:swarm-inbox [mark-read]
```

**Parameters:**

| Parameter   | Required | Default | Description                         |
| ----------- | -------- | ------- | ----------------------------------- |
| `mark-read` | No       | `true`  | Mark messages as read after viewing |

**Examples:**

```bash
# Check inbox (marks read)
/claude-swarm:swarm-inbox

# Check without marking read
/claude-swarm:swarm-inbox false
```

**Output Format:**

```
=== Inbox for team-lead in team payment-system ===

Unread messages: 2

<teammate-message teammate_id="backend-dev" color="blue">
Task #2 complete. Stripe integration done. All tests passing.
See backend/services/payment.ts for implementation.
</teammate-message>

<teammate-message teammate_id="frontend-dev" color="green">
Blocked on Task #3: Need API endpoint URLs. Where is the base URL configured?
</teammate-message>

(Messages marked as read)
```

**When to Check:**

- After completing major task steps
- Periodically during long-running work
- When expecting updates
- Before starting new work

**As Team Lead:**

Check your inbox frequently! Teammates message you with:

- Completion notifications
- Blocker reports
- Questions
- Progress updates

---

### `/claude-swarm:swarm-broadcast`

Broadcast a message to all teammates simultaneously.

**Syntax:**

```bash
/claude-swarm:swarm-broadcast "<message>" [--exclude <agent-name>]
```

**Parameters:**

| Parameter   | Required | Description                                           |
| ----------- | -------- | ----------------------------------------------------- |
| `message`   | Yes      | Message to broadcast to all teammates                 |
| `--exclude` | No       | Exclude a specific teammate (defaults to sender)      |

**Examples:**

```bash
# Broadcast to all teammates
/claude-swarm:swarm-broadcast "Database migration required - pull latest and run migrations"

# Exclude a specific teammate
/claude-swarm:swarm-broadcast "UI redesign approved" --exclude frontend-dev
```

**How It Works:**

- Sends message to all team members' inboxes
- By default excludes the sender
- Recipients see message on next `/swarm-inbox` or session start

**Use Cases:**

- Team-wide announcements
- Breaking changes
- Coordination checkpoints
- Critical updates

**Best Practices:**

- Use sparingly (goes to everyone)
- Include context and action items
- For routine updates, message specific teammates instead

---

### `/claude-swarm:swarm-send-text`

Send text directly to a teammate's terminal.

**Syntax:**

```bash
/claude-swarm:swarm-send-text "<target>" "<text>"
```

**Parameters:**

| Parameter | Required | Description                                      |
| --------- | -------- | ------------------------------------------------ |
| `target`  | Yes      | Teammate name or "all" for all active teammates  |
| `text`    | Yes      | Text to send (use `\r` for Enter key)            |

**Examples:**

```bash
# Trigger inbox check for a teammate
/claude-swarm:swarm-send-text backend-dev "/swarm-inbox"

# Send to all teammates with Enter key
/claude-swarm:swarm-send-text all "/swarm-inbox\r"

# Trigger a command
/claude-swarm:swarm-send-text frontend-dev "echo 'Starting work'\r"
```

**How It Works:**

- Text appears in teammate's terminal as if they typed it
- Works with both kitty and tmux
- Only sends to active teammates
- Automatically skips sending to self
- Use `\r` at end to simulate pressing Enter

**Use Cases:**

- Trigger inbox checks after sending messages
- Send coordination commands
- Provide input to waiting terminals

**Important Notes:**

- Text is sent directly to terminal - use with care
- Inactive teammates won't receive the text
- For persistent communication, use `/swarm-message` instead

---

## Task Management Commands

### `/claude-swarm:task-create`

Create a new task in the team task list.

**Syntax:**

```bash
/claude-swarm:task-create "<subject>" "[description]"
```

**Parameters:**

| Parameter     | Required | Description                       |
| ------------- | -------- | --------------------------------- |
| `subject`     | Yes      | Brief task title/summary          |
| `description` | No       | Detailed requirements and context |

**Examples:**

```bash
# Minimal
/claude-swarm:task-create "Implement login endpoint"

# With detailed description
/claude-swarm:task-create "Implement Stripe integration" "Integrate Stripe payment gateway using stripe npm package. Implement charge creation, refunds, and webhook handling. Add to backend/services/payment.ts. Use test keys from .env.example."
```

**Description Best Practices:**

Include:

- ✓ Specific deliverables
- ✓ File paths affected
- ✓ Acceptance criteria
- ✓ Constraints or requirements
- ✓ Links to documentation
- ✓ Dependencies (which tasks must complete first)

**Returns:**

Task ID number (e.g., `#1`, `#2`) - use this for updates and assignments.

---

### `/claude-swarm:task-update`

Update task properties (status, assignment, comments, dependencies).

**Syntax:**

```bash
/claude-swarm:task-update "<task-id>" [options...]
```

**Parameters:**

| Parameter | Required | Description                |
| --------- | -------- | -------------------------- |
| `task-id` | Yes      | Task ID number (without #) |

**Options:**

| Option         | Value                                                 | Description             |
| -------------- | ----------------------------------------------------- | ----------------------- |
| `--status`     | `pending\|in_progress\|blocked\|in_review\|completed` | Change task status      |
| `--assign`     | `<agent-name>`                                        | Assign to teammate      |
| `--comment`    | `<text>`                                              | Add progress comment    |
| `--blocked-by` | `<task-id>`                                           | Add blocking dependency |

**Examples:**

```bash
# Assign task
/claude-swarm:task-update 1 --assign "backend-dev"

# Update status
/claude-swarm:task-update 1 --status "in_progress"

# Add progress comment
/claude-swarm:task-update 1 --comment "API endpoints implemented, working on webhook handling"

# Mark as completed with comment
/claude-swarm:task-update 1 --status "completed" --comment "All requirements met. Tests passing. Ready for review."

# Set dependency
/claude-swarm:task-update 2 --blocked-by 1

# Multiple updates at once
/claude-swarm:task-update 3 --status "blocked" --comment "Waiting for design mockups"
```

**Task Statuses:**

| Status        | Meaning                     | When to Use                                      |
| ------------- | --------------------------- | ------------------------------------------------ |
| `pending`     | Not started                 | Initial state, waiting for assignment            |
| `in_progress` | Actively working            | Teammate is currently working on it              |
| `blocked`     | Cannot proceed              | Waiting for dependency, information, or resource |
| `in_review`   | Work complete, needs review | Implementation done, awaiting approval           |
| `completed`   | Fully done                  | Work finished and approved                       |

**Notes:**

- Comments are timestamped and attributed automatically
- Multiple `--blocked-by` can be added
- Status changes are logged in task history
- Use `--comment` frequently for progress visibility

---

### `/claude-swarm:task-list`

List all tasks for the current team with optional filtering.

**Syntax:**

```bash
/claude-swarm:task-list [--status <status>] [--owner <name>] [--blocked]
```

**Parameters:**

| Parameter   | Required | Description                                                    |
| ----------- | -------- | -------------------------------------------------------------- |
| `--status`  | No       | Filter by status: pending, in_progress, blocked, in_review, completed |
| `--owner`   | No       | Filter by assigned teammate (also accepts `--assignee`)        |
| `--blocked` | No       | Show only tasks with blocking dependencies                     |

**Examples:**

```bash
# List all tasks (no filter)
/claude-swarm:task-list

# Filter by status
/claude-swarm:task-list --status in_progress

# Filter by owner
/claude-swarm:task-list --owner backend-dev

# Show only blocked tasks
/claude-swarm:task-list --blocked

# Combine filters
/claude-swarm:task-list --status pending --owner frontend-dev
```

**Output Format:**

```
Tasks for team 'payment-system':
--------------------------------
#1 [completed] Design payment API (api-designer)
#2 [in_progress] Implement Stripe integration (backend-dev)
#3 [pending] Build payment UI (unassigned)
#4 [blocked] Write integration tests (qa-engineer) [blocked by #2, #3]
```

**Status Colors:**

- **Pending** - Normal text
- **In-progress** - Blue
- **Blocked** - Red
- **In-review** - Yellow
- **Completed** - Green

**When to Check:**

- To see what's available (pending/unassigned)
- To monitor progress (in_progress)
- To identify blockers (blocked)
- Before assigning new work

**Filter Behavior:**

- Filters combine with AND logic
- Status values must match exactly
- Owner filter matches agent name

---

## Troubleshooting Commands

The following commands are documented in the **swarm-troubleshooting** skill:

- `/claude-swarm:swarm-diagnose` - Diagnose team health and issues
- `/claude-swarm:swarm-reconcile` - Fix status mismatches
- `/claude-swarm:swarm-resume` - Resume suspended team

Use the swarm-troubleshooting skill when:

- Spawns fail
- Status shows mismatches
- Teammates aren't responsive
- Recovery is needed

---

## Command Comparison: Slash vs Bash

**Why prefer slash commands?**

| Aspect                | Slash Commands            | Bash Functions       |
| --------------------- | ------------------------- | -------------------- |
| **Reliability**       | ✓ Better error handling   | Basic error handling |
| **User Experience**   | ✓ Clear output formatting | Raw output           |
| **Context Awareness** | ✓ Auto-uses team env vars | Must specify team    |
| **Validation**        | ✓ Validates inputs        | Limited validation   |
| **Discovery**         | ✓ Shows in `/help`        | Hidden in library    |

**When to use bash functions:**

- Combining multiple operations in scripts
- Building custom workflows
- Debugging or low-level control
- When specific function isn't available as slash command

**Sourcing bash library:**

```bash
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null
```

Then call functions directly: `create_team`, `spawn_teammate`, `send_message`, etc.

---

## Quick Reference

### Common Workflow Commands

```bash
# 1. Setup
/claude-swarm:swarm-create "<team>" "<description>"

# 2. Define work
/claude-swarm:task-create "<subject>" "<description>"
/claude-swarm:task-update <id> --blocked-by <blocking-id>

# 3. Spawn team
/claude-swarm:swarm-spawn "<name>" "<type>" "<model>" "<prompt>"
/claude-swarm:swarm-spawn "<name>" "<type>" "<model>" "<prompt>" KEY=VALUE...  # with env vars
/claude-swarm:swarm-verify "<team>"

# 4. Assign work
/claude-swarm:task-update <id> --assign "<name>"

# 5. Monitor
/claude-swarm:swarm-status "<team>"
/claude-swarm:task-list
/claude-swarm:task-list --status in_progress --owner "<name>"  # with filters
/claude-swarm:swarm-inbox

# 6. Communicate
/claude-swarm:swarm-message "<to>" "<message>"
/claude-swarm:swarm-broadcast "<message>"                       # to all
/claude-swarm:swarm-send-text "<target>" "<text>"               # to terminal

# 7. Cleanup
/claude-swarm:swarm-cleanup "<team>"
```

### Emergency Commands

```bash
# Something's wrong
/claude-swarm:swarm-diagnose "<team>"

# Fix status mismatches
/claude-swarm:swarm-reconcile "<team>"

# Nuclear option (kills sessions + deletes data)
/claude-swarm:swarm-cleanup "<team>" --force
```

---

## Tips and Best Practices

### Command Tips

1. **Use tab completion** - Most terminals support tab completion for slash commands
2. **Quote arguments** - Always quote strings with spaces: `"my message"`
3. **Check output** - Slash commands provide clear success/error messages
4. **Chain related commands** - Update status then add comment in one call

### Workflow Tips

1. **Verify after spawning** - Always run `swarm-verify` after `swarm-spawn`
2. **Regular status checks** - Make `swarm-status` and `task-list` routine
3. **Descriptive messages** - Include file paths and task IDs in messages
4. **Update as you go** - Add task comments for major milestones
5. **Clean inbox frequently** - Don't let messages pile up

### Error Handling

1. **Read error messages** - Slash commands provide specific error details
2. **Run diagnostics** - Use `swarm-diagnose` when things seem wrong
3. **Check prerequisites** - Verify multiplexer and setup before debugging
4. **Consult troubleshooting skill** - See swarm-troubleshooting for recovery procedures

---

## See Also

- [Swarm Orchestration Skill](../SKILL.md) - Complete workflow guide
- [Setup Guide](setup-guide.md) - Terminal and multiplexer configuration
- **swarm-troubleshooting skill** - Diagnose and fix issues
- **swarm-teammate skill** - Commands from teammate perspective

---

**Quick Help:**

```bash
# In Claude Code, get command help
/help | grep swarm

# Check specific command syntax
/claude-swarm:swarm-create --help
```
