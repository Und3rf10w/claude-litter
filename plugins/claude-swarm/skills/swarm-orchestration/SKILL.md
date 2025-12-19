---
name: swarm-orchestration
description: This skill should be used when the user asks to "set up a team", "create a swarm", "spawn teammates", "assign tasks", "coordinate agents", "work in parallel", "divide work among agents", "orchestrate multiple agents", or describes a complex task that would benefit from multiple Claude Code instances working together. Provides comprehensive guidance for team leads on creating teams, spawning teammates, assigning work, and monitoring progress across tmux/kitty terminal multiplexers.
---

# Swarm Orchestration

This skill provides comprehensive guidance for orchestrating teams of Claude Code instances working in parallel on complex tasks. You are the team lead responsible for breaking down work, spawning teammates, and coordinating execution.

## Quick Start Example

Here's a minimal example of creating a 3-person team to build an authentication feature:

```bash
# 1. Create the team
/claude-swarm:swarm-create "auth-team" "Building user authentication"

# 2. Create tasks
/claude-swarm:task-create "Backend API" "Implement JWT auth endpoints"
/claude-swarm:task-create "Frontend UI" "Build login/signup forms"
/claude-swarm:task-create "Integration Tests" "Test full auth flow"

# 3. Spawn teammates
/claude-swarm:swarm-spawn "backend-dev" "backend-developer" "sonnet" "Work on task #1: implement JWT auth endpoints in /api/auth. Message me when done."

/claude-swarm:swarm-spawn "frontend-dev" "frontend-developer" "sonnet" "Work on task #2: build login/signup forms in /pages/auth. Message me when done."

/claude-swarm:swarm-spawn "qa-engineer" "tester" "sonnet" "Work on task #3: write integration tests for auth flow. Message me when done."

# 4. Verify spawns succeeded
/claude-swarm:swarm-verify auth-team

# 5. Assign tasks
/claude-swarm:task-update 1 --assign backend-dev
/claude-swarm:task-update 2 --assign frontend-dev
/claude-swarm:task-update 3 --assign qa-engineer

# 6. Monitor progress
/claude-swarm:swarm-inbox        # Check for messages
/claude-swarm:task-list          # View task progress
/claude-swarm:swarm-status auth-team
```

That's it! The team is working. Check inbox regularly for completion notifications and blockers.

## When to Use Swarm Orchestration

Use swarm orchestration when:

- **Large features** require independent components (backend + frontend + tests)
- **Parallel execution** would significantly speed up completion
- **Work naturally divides** by expertise or module boundaries
- **Multi-file refactoring** spans across distinct subsystems
- **Complex tasks** benefit from specialized focus areas

**Not ideal for:**

- Simple single-file changes
- Tasks requiring tight coordination at every step
- Quick fixes or trivial features
- Situations where context sharing is critical

## Core Concepts

### Team Structure

A swarm team consists of:

1. **Team Lead (you)** - Orchestrates the team, assigns tasks, monitors progress, unblocks teammates
2. **Teammates** - Specialized Claude Code instances with specific roles and responsibilities
3. **Task List** - Shared queue of work items with status tracking and dependencies
4. **Message System** - Communication channel for coordination and updates

### Agent Roles

Choose appropriate agent types when spawning teammates:

| Role                 | Use For                                    | Expertise               |
| -------------------- | ------------------------------------------ | ----------------------- |
| `worker`             | General-purpose tasks, utilities, scripts  | Balanced capabilities   |
| `backend-developer`  | API endpoints, server logic, database work | Server-side development |
| `frontend-developer` | UI components, styling, user interactions  | Client-side development |
| `reviewer`           | Code review, quality assurance, validation | Best practices, testing |
| `researcher`         | Documentation, investigation, analysis     | Research and planning   |
| `tester`             | Test writing, validation, QA               | Testing frameworks      |

### Model Selection

Pick models based on task complexity and cost considerations:

| Model    | Use For                                    | Characteristics         |
| -------- | ------------------------------------------ | ----------------------- |
| `haiku`  | Simple, repetitive, well-defined tasks     | Fast, cost-effective    |
| `sonnet` | Balanced complexity (default, recommended) | Good quality/cost ratio |
| `opus`   | Complex reasoning, architectural decisions | Highest capability      |

## Orchestration Workflow

### Step 1: Analyze the Task

Before creating a team, break down the user's request:

**Task Analysis Checklist:**

- ✓ Identify distinct components that can work independently
- ✓ Map dependencies between subtasks (what must complete before what)
- ✓ Determine optimal team size (2-6 teammates typically)
- ✓ Assign expertise requirements to each component
- ✓ Estimate which tasks can run in parallel

**Example Analysis:**

User: "Implement payment processing system"

Breakdown:

- Task 1: Design payment API (researcher) - no dependencies
- Task 2: Implement Stripe integration (backend-developer) - depends on Task 1
- Task 3: Build payment UI (frontend-developer) - depends on Task 1
- Task 4: Write integration tests (tester) - depends on Tasks 2 & 3

Optimal team: 4 teammates (can run Tasks 2 & 3 in parallel after Task 1)

### Step 2: Create the Team

Use the slash command to create your team:

```bash
/claude-swarm:swarm-create "team-name" "Team description"
```

**Team Naming Best Practices:**

- Use descriptive, kebab-case names: `payment-feature`, `auth-refactor`
- Keep names under 50 characters
- Avoid special characters beyond hyphens

**Example:**

```bash
/claude-swarm:swarm-create "payment-system" "Implementing payment processing with Stripe"
```

This initializes:

- Team configuration in `~/.claude/teams/payment-system/`
- Task directory in `~/.claude/tasks/payment-system/`
- Inbox system for team communication
- You are automatically designated as team-lead

### Step 3: Create Tasks

For each subtask identified in your analysis:

```bash
/claude-swarm:task-create "Task subject" "Detailed description with requirements"
```

**Task Description Best Practices:**

- Be specific about deliverables and acceptance criteria
- Reference file paths, functions, or modules involved
- Specify any constraints or requirements
- Link to relevant documentation

**Example:**

```bash
/claude-swarm:task-create "Design payment API" "Design REST endpoints for payment processing. Define request/response schemas, error handling, and webhook integration. Document in docs/payment-api.md"

/claude-swarm:task-create "Implement Stripe integration" "Integrate Stripe payment gateway using stripe npm package. Implement charge creation, refunds, and webhook handling. Add to backend/services/payment.ts"

/claude-swarm:task-create "Build payment UI" "Create checkout form and payment status pages. Use existing form components. Implement in frontend/pages/checkout.tsx"
```

**Set Dependencies (if needed):**

```bash
/claude-swarm:task-update 2 --blocked-by 1
/claude-swarm:task-update 3 --blocked-by 1
```

This ensures Task 2 and 3 wait for Task 1 to complete.

### Step 4: Spawn Teammates

For each role, spawn a teammate with a clear initial prompt:

```bash
/claude-swarm:swarm-spawn "agent-name" "agent-type" "model" "Initial prompt with task assignment"
```

**Spawning Best Practices:**

- Give teammates clear, specific instructions in the initial prompt
- Reference their assigned task number
- Tell them to check `/claude-swarm:task-list` for details
- Remind them to message you when done
- Explain their role and responsibilities

**Example:**

```bash
/claude-swarm:swarm-spawn "api-designer" "researcher" "sonnet" "You are the API designer. Work on Task #1: Design payment API endpoints. Research best practices for payment APIs, define endpoints, schemas, and error handling. Document your design in docs/payment-api.md. Message team-lead when complete."

/claude-swarm:swarm-spawn "backend-dev" "backend-developer" "sonnet" "You are the backend developer. Work on Task #2: Implement Stripe integration. Wait for Task #1 to complete (check task list). Once unblocked, integrate Stripe SDK, implement payment processing, and add webhook handling. Message team-lead when complete."

/claude-swarm:swarm-spawn "frontend-dev" "frontend-developer" "sonnet" "You are the frontend developer. Work on Task #3: Build payment UI. Wait for Task #1 to complete (check task list). Once unblocked, create checkout form and payment status pages. Coordinate with api-designer for endpoint details. Message team-lead when complete."
```

**CRITICAL: Verify Spawns Succeeded**

Immediately after spawning, verify all teammates are alive:

```bash
/claude-swarm:swarm-verify payment-system
```

If spawns fail, use the **swarm-troubleshooting** skill for detailed recovery procedures.

### Step 5: Assign Tasks

Explicitly assign tasks to teammates:

```bash
/claude-swarm:task-update 1 --assign "api-designer"
/claude-swarm:task-update 2 --assign "backend-dev"
/claude-swarm:task-update 3 --assign "frontend-dev"
```

This creates clear ownership and accountability.

### Step 6: Monitor and Coordinate

As team lead, you're responsible for:

**Active Monitoring:**

Check progress regularly:

```bash
/claude-swarm:swarm-status payment-system
/claude-swarm:task-list
```

**Check Your Inbox:**

```bash
/claude-swarm:swarm-inbox
```

Teammates will message you with:

- Completion notifications
- Questions or clarifications
- Blocker reports
- Progress updates

**Respond to Teammates:**

```bash
/claude-swarm:swarm-message "backend-dev" "Stripe test keys are in .env.example. Copy to .env and use pk_test_... for testing."
```

**Unblock Dependencies:**

When Task #1 completes, notify blocked teammates:

```bash
/claude-swarm:swarm-message "backend-dev" "Task #1 complete. API design ready in docs/payment-api.md. You're unblocked - start implementation."
/claude-swarm:swarm-message "frontend-dev" "Task #1 complete. API spec ready - you can start UI development."
```

**Handle Blockers:**

If a teammate reports being blocked:

1. Assess the blocker (missing info, dependency, technical issue)
2. Provide the solution or delegate to another teammate
3. Update task status if needed
4. Follow up to ensure unblocked

### Step 7: Review and Integration

As tasks complete:

1. Review deliverables
2. Request changes if needed
3. Coordinate integration between components
4. Run final validation

**Example Review:**

```bash
/claude-swarm:swarm-message "backend-dev" "Reviewed your Stripe integration. Looks good, but please add error logging for webhook failures. Update Task #2 when done."
```

### Step 8: Completion and Cleanup

When work is complete:

1. Verify all tasks completed: `/claude-swarm:task-list`
2. Collect final updates from teammates
3. Clean up the team:

```bash
/claude-swarm:swarm-cleanup "team-name"          # Soft: kills sessions only
/claude-swarm:swarm-cleanup "team-name" --force  # Hard: removes files too
```

**Before cleanup:**

- Verify tasks complete (check task list)
- Ask user about data preservation
- Send final messages to teammates

### Step 9: Report to User

Provide clear summary:

- Team structure and roles
- Task assignments and completion
- Work delivered
- Any issues encountered

## Slash Commands Reference

**Always prefer slash commands over bash functions** for reliability:

| Command                                                    | Purpose                |
| ---------------------------------------------------------- | ---------------------- |
| `/claude-swarm:swarm-create <team> [desc]`                 | Create new team        |
| `/claude-swarm:swarm-spawn <name> [type] [model] [prompt]` | Spawn teammate         |
| `/claude-swarm:swarm-status <team>`                        | View team status       |
| `/claude-swarm:swarm-verify <team>`                        | Verify teammates alive |
| `/claude-swarm:swarm-message <to> <msg>`                   | Send message to one    |
| `/claude-swarm:swarm-broadcast <msg> [--exclude]`          | Broadcast to all       |
| `/claude-swarm:swarm-send-text <target> <text>`            | Send to terminal       |
| `/claude-swarm:swarm-inbox`                                | Check messages         |
| `/claude-swarm:swarm-consult <message>`                    | Ask team-lead          |
| `/claude-swarm:task-create <subject> [desc]`               | Create task            |
| `/claude-swarm:task-update <id> [opts]`                    | Update task            |
| `/claude-swarm:task-list [--status] [--owner] [--blocked]` | List tasks with filter |
| `/claude-swarm:swarm-cleanup <team> [--force]`             | Clean up team          |

For troubleshooting commands (diagnose, reconcile, recovery), see the **swarm-troubleshooting** skill.

See [Slash Commands Reference](references/slash-commands.md) for detailed options.

## Communication Patterns

### Sending Messages

**Message specific teammate:**

```bash
/claude-swarm:swarm-message "backend-dev" "API endpoints are ready for integration. See docs/payment-api.md for details."
```

**Broadcast to all teammates:**

When you need to notify everyone (breaking changes, coordination checkpoints):

```bash
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null
broadcast_message "payment-system" "Database schema updated - please pull latest migrations before continuing" "true"
```

The third parameter (`"true"`) excludes you (team-lead) from the broadcast.

### Effective Communication

**Good message examples:**

- ✓ "Task #3 complete. User auth middleware added to /middleware/auth.ts. Protected routes configured. Ready for testing."
- ✓ "Blocked on Task #7: Need design mockups for dashboard. Current placeholder is in /components/Dashboard.tsx lines 45-120."
- ✓ "Integration issue: API returns 401 on /api/users endpoint. Expected JWT in Authorization header. See auth.test.ts:89 for failing test."

**Poor message examples:**

- ✗ "Done with the auth stuff."
- ✗ "Blocked. Need designs."
- ✗ "API not working."

**Key principles:**

- Reference specific files, line numbers, and task IDs
- Include context for blockers
- Be proactive about potential issues
- Provide actionable information

## Advanced Features (v1.7.0+)

### Broadcasting Messages to All Teammates

**New Command**: `/claude-swarm:swarm-broadcast <message> [--exclude <agent-name>]`

When you need to notify everyone simultaneously (breaking changes, critical updates):

```bash
/claude-swarm:swarm-broadcast "Database migration required - pull latest and run migrations before continuing"
```

**Arguments:**
- `<message>` - Message to broadcast to all teammates (required)
- `--exclude <agent-name>` - Optionally exclude a specific teammate (defaults to excluding the sender)

**Use cases:**
- Team-wide announcements
- Breaking changes or critical updates
- Coordination checkpoints
- System-wide configuration changes
- Critical blocker resolution

**Examples:**

```bash
# Broadcast to all teammates
/claude-swarm:swarm-broadcast "API v2 is now deployed"

# Broadcast excluding a specific teammate
/claude-swarm:swarm-broadcast "UI redesign approved - update all components" --exclude frontend-dev

# Broadcast with multi-word message
/claude-swarm:swarm-broadcast "Please review PR #42 before proceeding with your tasks"
```

**Best practices:**
- Use sparingly (every message goes to all teammates simultaneously)
- Include context and action items
- Reference relevant documentation or task numbers
- For routine updates, message specific teammates instead
- By default excludes the sender (use `--exclude` to change)

**How it works:**
- Sends message to all team members' inboxes
- Recipients see the message when they run `/swarm-inbox`
- Messages auto-deliver on next session start (via SessionStart hook)
- Supports multi-word messages without quotes

### Consulting Team-Lead

**New Command**: `/claude-swarm:swarm-consult <message>`

Teammates ask the team-lead questions or report blockers with immediate notification:

```bash
/claude-swarm:swarm-consult "Should I proceed with refactoring the API module?"
/claude-swarm:swarm-consult "Blocked on database schema - can you help?"
```

**How it works:**
- Sends message to team-lead's inbox
- Automatically triggers team-lead's inbox if they're active
- If team-lead is offline, message waits for next inbox check
- Team-lead responds via `/swarm-message`

**Use cases:**
- Ask for guidance or clarification
- Report blockers
- Request permission for major decisions
- Escalate issues
- Get unstuck

**Examples:**

```bash
# Ask a question
/claude-swarm:swarm-consult "Need clarification on task #5 - which endpoint should I modify?"

# Report blocker
/claude-swarm:swarm-consult "Blocked on database schema - can you help?"

# Request decision
/claude-swarm:swarm-consult "Should we refactor the auth module or proceed with current implementation?"
```

**Features:**
- Prevents team-lead from consulting themselves
- Works with both kitty and tmux
- Graceful fallback if team-lead offline
- Clear response when team-lead is notified

### Sending Text to Teammate Terminals

**New Command**: `/claude-swarm:swarm-send-text <target> <text>`

Send text directly to a teammate's terminal (they see it typed in their session):

```bash
/claude-swarm:swarm-send-text backend-dev "/swarm-inbox"
/claude-swarm:swarm-send-text all "/swarm-inbox\r"
```

**Arguments:**
- `<target>` - Teammate name or "all" for all active teammates (required)
- `<text>` - Text to send to terminal (required, use `\r` for Enter key)

**Use cases:**
- Trigger inbox checks for teammates with new messages
- Send coordination commands to active teammates
- Provide input to teammates waiting for user input
- Broadcast commands to all active teammates
- Wake up inactive terminals with commands

**Examples:**

```bash
# Send command to specific teammate
/claude-swarm:swarm-send-text backend-dev "/swarm-inbox"

# Send text with Enter key to all teammates
/claude-swarm:swarm-send-text all "/swarm-inbox\r"

# Trigger a command for a teammate
/claude-swarm:swarm-send-text frontend-dev "echo 'Starting work'\r"
```

**How it works:**
- Text appears in teammate's terminal as if they typed it
- Works with both kitty and tmux terminals
- Uses kitty user variables or tmux session names for targeting
- Only sends to active teammates (won't affect offline sessions)
- Automatically skips sending to self
- Use `\r` at end to simulate pressing Enter

**Important notes:**
- Text is sent directly to terminal - use with care
- Inactive teammates won't receive the text
- For persistent communication, use `/swarm-message` instead

### Filtering Task Lists

**Enhanced Command**: `/claude-swarm:task-list [--status STATUS] [--owner NAME] [--blocked]`

View tasks with granular filtering to focus on what matters:

```bash
/claude-swarm:task-list --status in-progress      # Only in-progress tasks
/claude-swarm:task-list --owner backend-dev       # Tasks for specific teammate
/claude-swarm:task-list --status blocked          # Find all blockers
/claude-swarm:task-list --blocked --owner frontend-dev  # Blocked tasks for one person
```

**Filter options:**
- `--status <status>` - Filter by status: pending, in-progress, blocked, in-review, completed
- `--owner <name>` or `--assignee <name>` - Filter by teammate name
- `--blocked` - Show only tasks with blocking dependencies

**Use cases:**
- Monitor specific teammate progress
- Find blocked tasks quickly
- Focus on in-progress work
- Identify pending tasks
- Check for tasks awaiting review

**Examples:**

```bash
# List all completed tasks
/claude-swarm:task-list --status completed

# Show pending work for frontend-dev
/claude-swarm:task-list --status pending --owner frontend-dev

# Find all blockers in the team
/claude-swarm:task-list --blocked

# Combine filters
/claude-swarm:task-list --status in-progress --owner backend-dev
```

**How it works:**
- Filters task list based on specified criteria
- Combines multiple filters with AND logic
- Status values: pending, in-progress, blocked, in-review, completed

### Custom Environment Variables

**Enhancement to**: `/claude-swarm:swarm-spawn`

Pass custom environment variables to spawned teammates for configuration:

```bash
/claude-swarm:swarm-spawn "api-dev" "backend-developer" "sonnet" "Initial prompt here" API_KEY=sk_test_123 ENV=staging DEBUG=true
```

**How to use:**
- Pass environment variables as additional arguments after the initial prompt
- Each argument should be in format: `KEY=VALUE` (no spaces around the equals sign)
- Values are safely escaped and exported in teammate's session
- Works with both kitty and tmux

**Examples:**

```bash
# Spawn with feature flags
/claude-swarm:swarm-spawn "tester" "tester" "sonnet" "Run integration tests" FEATURE_FLAG_NEW_API=true ENVIRONMENT=testing

# Spawn with API configuration
/claude-swarm:swarm-spawn "integrations" "backend-developer" "opus" "Build integrations" API_ENDPOINT=https://api.staging.example.com DB_HOST=localhost

# Spawn with credentials (team-specific)
/claude-swarm:swarm-spawn "deploy" "worker" "sonnet" "Deploy to staging" AWS_REGION=us-east-1 DEPLOY_ENV=staging
```

**Use cases:**
- Team-specific configuration
- Environment selectors (dev, staging, prod)
- Feature flags
- API endpoints and connections
- Tool-specific settings

**Security notes:**
- Command line arguments are visible in process listings
- For sensitive credentials, consider using:
  - `.env` files that teammates can source
  - Secrets management systems
  - Credential vaults or environment files
- Team members should NOT see sensitive values
- Keep sensitive data in separate configuration outside the command

**How it works:**
- Variables are exported as environment variables in the teammate's session
- Available to use in bash commands and scripts
- Override any team-level environment variables
- Work alongside standard CLAUDE_CODE_* variables

### Permission Mode Control

**New Feature**: Control what Claude Code capabilities teammates can access

Configure permissions and plan mode when spawning teammates:

```bash
/claude-swarm:swarm-spawn "reviewer" "reviewer" "sonnet" "Review code" PERMISSION_MODE PLAN_MODE ALLOWED_TOOLS
```

**Permission controls:**
- `permission_mode` - Controls which tools teammates can use (ask/skip)
- `plan_mode` (true/false) - Enable/disable EnterPlanMode skill
- `allowed_tools` - Pattern of tools teammates can access

**How to use:**
- Pass as additional arguments after initial prompt (after any env vars)
- Examples:
  ```bash
  # Restrict to skip/deny unknown tools
  /claude-swarm:swarm-spawn "reviewer" "reviewer" "sonnet" "Review" skip unknown

  # Enable plan mode for architect
  /claude-swarm:swarm-spawn "architect" "researcher" "opus" "Design" ask true

  # Restrict tool access patterns
  /claude-swarm:swarm-spawn "readonly-auditor" "reviewer" "haiku" "Audit" skip "^Edit|^Write|^Delete"
  ```

**Use cases:**
- Restrict reviewers from modifying code
- Prevent accidental deletions or dangerous operations
- Control which Claude Code features teammates can use
- Implement graduated access control
- Audit-only roles without modification capability

**Permission mode options:**
- `ask` - Ask teammate for permission before using tool
- `skip` - Skip unknown/restricted tools silently

**Plan mode:**
- `true` or `enable` - Teammate can use EnterPlanMode
- `false` - Teammate cannot enter plan mode

**Allowed tools:**
- Specify tool patterns (regex-compatible)
- Examples: `Read|Glob`, `^Bash`, `^Edit|^Write`
- Restrict to specific operations

**Security benefits:**
- Prevent accidental destructive actions
- Control access to sensitive operations
- Implement principle of least privilege
- Role-based capability restriction
- Audit trail for permission checks

### Team-Lead Auto-Spawn on Team Creation

**Enhanced Command**: `/claude-swarm:swarm-create <team-name> [description] [--no-lead] [--lead-model <model>]`

**New behavior (v1.7.0+)**: Team-lead window automatically spawns when creating a team

Previous behavior (v1.6.2): Required manual `/swarm-spawn` for team-lead context

**Usage:**

```bash
# Create team and auto-spawn team-lead (default)
/claude-swarm:swarm-create "payment-system" "Building payment processing system"

# Create team without auto-spawning team-lead
/claude-swarm:swarm-create "research-project" "Market research" --no-lead

# Create team with specific model for team-lead
/claude-swarm:swarm-create "complex-feature" "Complex feature" --lead-model opus
```

**New Options:**
- `--no-lead` - Skip auto-spawn (useful if setting up remotely)
- `--lead-model <model>` - Specify model for team-lead (haiku/sonnet/opus, default: sonnet)

**What happens automatically:**
- Team directory created in `~/.claude/teams/<team-name>/`
- Team config initialized with empty members list
- Team-lead window spawned in current terminal (kitty/tmux)
- Team-lead has full environment variables set automatically
- Ready to start spawning teammates immediately

**Benefits:**
- **Faster setup**: One command creates team and team-lead context
- **Automatic detection**: Team-lead knows team name immediately
- **Immediate productivity**: Start assigning tasks right away
- **Optional**: Use `--no-lead` if needed for edge cases

**Workflow improvement:**

**Old (v1.6.2)**:
```bash
/swarm-create "team-name"
/swarm-spawn "team-lead-window" "worker" "sonnet" "You are team-lead"
# Now team-lead has context
```

**New (v1.7.0)**:
```bash
/swarm-create "team-name"
# Team-lead already spawned and ready!
```

**Examples:**

```bash
# Quick team setup
/claude-swarm:swarm-create "auth-feature" "User authentication system"

# Complex project with power
/claude-swarm:swarm-create "ai-infrastructure" "AI infrastructure overhaul" --lead-model opus

# Remote setup without auto-spawn
/claude-swarm:swarm-create "offshore-team" "Remote team project" --no-lead
```

## Monitoring Progress

### Team Status Overview

```bash
/claude-swarm:swarm-status payment-system
```

Shows:

- Active teammates and their status
- Task assignments
- Overall progress
- Status mismatches (if any)

### Task List

```bash
/claude-swarm:task-list
```

Shows:

- All tasks with current status
- Assignments
- Dependencies (blocked-by relationships)
- Comments and progress updates

### Regular Check-ins

As team lead, check progress regularly:

- After major milestones
- When dependencies complete
- If teammate hasn't updated in a while
- When approaching deadlines

## Environment Variables

When teammates are spawned, these variables are automatically set:

| Variable                   | Description                      |
| -------------------------- | -------------------------------- |
| `CLAUDE_CODE_TEAM_NAME`    | Current team name                |
| `CLAUDE_CODE_AGENT_ID`     | Unique agent UUID                |
| `CLAUDE_CODE_AGENT_NAME`   | Agent name (e.g., "backend-dev") |
| `CLAUDE_CODE_AGENT_TYPE`   | Agent role type                  |
| `CLAUDE_CODE_TEAM_LEAD_ID` | Your (team lead's) UUID          |
| `CLAUDE_CODE_AGENT_COLOR`  | Agent display color              |

User-configurable:

| Variable            | Description                                             |
| ------------------- | ------------------------------------------------------- |
| `SWARM_MULTIPLEXER` | Force "tmux" or "kitty" (auto-detected by default)      |
| `SWARM_KITTY_MODE`  | Kitty spawn mode: `split` (default), `tab`, or `window` |

## Best Practices

### Planning

- ✓ Keep teams small (2-6 teammates optimal)
- ✓ Clearly define task boundaries and deliverables
- ✓ Set explicit dependencies with `--blocked-by`
- ✓ Choose appropriate agent types and models
- ✓ Provide detailed initial prompts to teammates

### Communication

- ✓ Give teammates clear, specific instructions
- ✓ Check inbox regularly for updates and blockers
- ✓ Notify dependencies when tasks complete
- ✓ Use broadcast sparingly (only for team-wide updates)
- ✓ Include file paths, line numbers, and context in messages

### Monitoring

- ✓ Run `swarm-status` periodically
- ✓ Verify spawns succeeded immediately after spawning
- ✓ Check task progress regularly
- ✓ Watch for blocked tasks and unblock promptly
- ✓ Respond quickly to teammate messages

### Reliability

- ✓ Always use slash commands when available
- ✓ Verify multiplexer availability before spawning
- ✓ For issues, use the **swarm-troubleshooting** skill
- ✓ Gracefully handle spawn failures (retry or adjust plan)

## Terminal Support

The plugin supports both **tmux** and **kitty**:

| Feature           | tmux          | kitty                |
| ----------------- | ------------- | -------------------- |
| Multiple sessions | Yes           | Yes                  |
| Spawn modes       | Sessions only | Window, Split, Tab   |
| Session files     | No            | Yes (.kitty-session) |
| Auto-detection    | Yes           | Yes (via $KITTY_PID) |

For kitty setup requirements, see [Setup Guide](references/setup-guide.md).

## Example: Complete Workflow

**Scenario:** Implement user authentication system

**1. Analyze:**

- Task A: Design auth flow (researcher)
- Task B: Implement backend auth (backend-developer) - depends on A
- Task C: Create login UI (frontend-developer) - depends on A
- Task D: Write auth tests (tester) - depends on B & C

**2. Create Team:**

```bash
/claude-swarm:swarm-create "auth-feature" "Implementing user authentication system"
```

**3. Create Tasks:**

```bash
/claude-swarm:task-create "Design auth flow" "Design authentication architecture, token strategy, and session management. Document in docs/auth-design.md"
/claude-swarm:task-create "Implement backend auth" "Build JWT auth, login/logout endpoints, middleware. In backend/auth/"
/claude-swarm:task-create "Create login UI" "Build login form, signup page, protected route handling. In frontend/pages/auth/"
/claude-swarm:task-create "Write auth tests" "Integration tests for auth flow, unit tests for middleware. In tests/auth/"
/claude-swarm:task-update 2 --blocked-by 1
/claude-swarm:task-update 3 --blocked-by 1
/claude-swarm:task-update 4 --blocked-by 2
/claude-swarm:task-update 4 --blocked-by 3
```

**4. Spawn Teammates:**

```bash
/claude-swarm:swarm-spawn "auth-designer" "researcher" "sonnet" "You are the auth architect. Work on Task #1: Design authentication flow. Research JWT best practices, design token refresh strategy, plan session management. Document in docs/auth-design.md. Message team-lead when complete."

/claude-swarm:swarm-spawn "backend-dev" "backend-developer" "sonnet" "You are the backend developer. Work on Task #2: Implement backend auth. Wait for Task #1 (check task list). Build JWT auth system, login/logout endpoints, auth middleware. Message team-lead when complete."

/claude-swarm:swarm-spawn "frontend-dev" "frontend-developer" "sonnet" "You are the frontend developer. Work on Task #3: Create login UI. Wait for Task #1 (check task list). Build login/signup forms, implement protected routes. Message team-lead when complete."

/claude-swarm:swarm-spawn "qa-engineer" "tester" "sonnet" "You are the QA engineer. Work on Task #4: Write auth tests. Wait for Tasks #2 and #3 (check task list). Write integration tests for full auth flow and unit tests for middleware. Message team-lead when complete."

/claude-swarm:swarm-verify auth-feature
```

**5. Assign Tasks:**

```bash
/claude-swarm:task-update 1 --assign "auth-designer"
/claude-swarm:task-update 2 --assign "backend-dev"
/claude-swarm:task-update 3 --assign "frontend-dev"
/claude-swarm:task-update 4 --assign "qa-engineer"
```

**6. Monitor:**

```bash
/claude-swarm:swarm-inbox     # Check for messages
/claude-swarm:task-list        # Check progress
/claude-swarm:swarm-status auth-feature
```

**7. Coordinate:**

When auth-designer completes:

```bash
/claude-swarm:swarm-message "backend-dev" "Task #1 complete. Auth design ready in docs/auth-design.md. You're unblocked - start backend implementation."
/claude-swarm:swarm-message "frontend-dev" "Task #1 complete. Auth design ready. You're unblocked - start UI development."
```

**8. Review & Complete:**

Check deliverables, test integration, report to user.

**9. Cleanup:**

```bash
/claude-swarm:swarm-cleanup "auth-feature"
```

This complete example demonstrates the full orchestration lifecycle from analysis to cleanup.

## See Also

- **swarm-troubleshooting** - Error handling, spawn failures, diagnostics, recovery
- **swarm-teammate** - Guidance for teammates on effective participation
- [Setup Guide](references/setup-guide.md) - Terminal setup, kitty configuration, prerequisites
- [Slash Commands Reference](references/slash-commands.md) - Detailed command documentation

## Progressive Disclosure

This skill covers the core orchestration workflow for team-leads. For specific scenarios:

1. **Troubleshooting**: Use the swarm-troubleshooting skill for spawn failures, status issues, and recovery
2. **Teammate guidance**: Refer teammates to the swarm-teammate skill
3. **Setup details**: Review the Setup Guide for terminal configuration
4. **Command options**: See Slash Commands Reference for all command parameters
