---
name: swarm-coordination
description: This skill should be used when the user asks anything to the effect of "set up a team", "coordinate agents", "swarm this task", "work in parallel", "spawn teammates", "create a swarm", "orchestrate multiple agents", "break down into parallel work", "divide this among agents", "multi-agent workflow", or describes a complex task that would benefit from multiple Claude Code instances working together. Provides step-by-step orchestration workflows using slash commands for creating teams, spawning teammates, assigning tasks, and coordinating work across tmux/kitty terminal multiplexers. Use this for any request involving parallel Claude Code instances, team coordination, or distributed workflows.
---

# Swarm Coordination

This skill provides comprehensive guidance for orchestrating teams of Claude Code instances working in parallel on complex tasks.

## Core Concepts

### Team Structure

A swarm team consists of:

1. **Team Lead** (you) - Orchestrates the team, assigns tasks, monitors progress
2. **Teammates** - Specialized Claude Code instances with specific roles
3. **Task List** - Shared queue of work items with status tracking
4. **Message System** - Communication channel between team members

### Agent Roles

Choose appropriate agent types:

- `worker` - General-purpose tasks
- `backend-developer` - API, server-side logic, database work
- `frontend-developer` - UI components, styling, user interactions
- `reviewer` - Code review, quality assurance
- `researcher` - Documentation, investigation, analysis
- `tester` - Test writing, validation, QA

### Model Selection

Pick models based on task complexity:

- `haiku` - Simple, fast, repetitive tasks
- `sonnet` - Balanced capability (default, recommended)
- `opus` - Complex reasoning, architectural decisions

## Orchestration Workflow

### Step 1: Analyze the Task

Break down the request into independent subtasks:

- Identify distinct components
- Map dependencies between tasks
- Determine optimal team size (2-6 teammates typically)
- Assign expertise requirements

### Step 2: Create the Team

Use the slash command (preferred):

```bash
/claude-swarm:swarm-create "team-name" "Team description"
```

Or use bash function:

```bash
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh"
create_team "team-name" "Team description"
```

### Step 3: Create Tasks

For each subtask:

```bash
/claude-swarm:task-create "Task subject" "Detailed description with requirements"
```

Set dependencies if needed:

```bash
/claude-swarm:task-update <task-id> --blocked-by <blocking-task-id>
```

### Step 4: Spawn Teammates

For each role:

```bash
/claude-swarm:swarm-spawn "agent-name" "agent-type" "model" "Initial prompt with task assignment"
```

**CRITICAL:** After spawning, verify success:

```bash
/claude-swarm:swarm-verify <team-name>
```

If spawns fail:

1. Check error messages
2. Run diagnostics: `/claude-swarm:swarm-diagnose <team-name>`
3. Verify multiplexer (tmux/kitty) availability
4. Retry failed spawns or adjust team plan

### Step 5: Assign Tasks

```bash
/claude-swarm:task-update <task-id> --assign "agent-name"
```

### Step 6: Monitor and Coordinate

Check progress:

```bash
/claude-swarm:swarm-status <team-name>
/claude-swarm:task-list
```

Communicate with team:

```bash
/claude-swarm:swarm-message "agent-name" "Your message"
/claude-swarm:swarm-inbox
```

### Step 7: Report to User

Provide clear summary:

- Team structure and roles
- Task assignments
- Progress monitoring commands
- Expected workflow

## Slash Commands (Recommended)

**Always prefer slash commands over bash functions** for better reliability:

| Command                                                    | Purpose                |
| ---------------------------------------------------------- | ---------------------- |
| `/claude-swarm:swarm-create <team> [desc]`                 | Create new team        |
| `/claude-swarm:swarm-spawn <name> [type] [model] [prompt]` | Spawn teammate         |
| `/claude-swarm:swarm-status <team>`                        | View team status       |
| `/claude-swarm:swarm-verify <team>`                        | Verify teammates alive |
| `/claude-swarm:swarm-message <to> <msg>`                   | Send message           |
| `/claude-swarm:swarm-inbox`                                | Check messages         |
| `/claude-swarm:task-create <subject> [desc]`               | Create task            |
| `/claude-swarm:task-update <id> [opts]`                    | Update task            |
| `/claude-swarm:task-list`                                  | List all tasks         |
| `/claude-swarm:swarm-diagnose <team>`                      | Diagnose issues        |
| `/claude-swarm:swarm-reconcile [team]`                     | Fix status mismatches  |
| `/claude-swarm:swarm-cleanup <team> [--force]`             | Clean up team          |

Use bash functions only when:

- Combining operations in complex scripts
- No slash command exists
- Debugging or low-level control needed

## Communication Patterns

### Sending Messages

Message specific teammate:

```bash
/claude-swarm:swarm-message "backend-dev" "API endpoints are ready for integration"
```

Broadcast to all (using bash):

```bash
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh"
broadcast_message "team-name" "Update: Database schema changed" "true"
```

### Checking Inbox

```bash
/claude-swarm:swarm-inbox
```

Teammates should check inbox regularly to receive coordination messages.

## Error Handling

### Spawn Failures

If spawn_teammate fails:

1. **Run diagnostics**:

   ```bash
   /claude-swarm:swarm-diagnose <team-name>
   ```

2. **Common issues**:

   - Multiplexer not available (install tmux or kitty)
   - Duplicate agent names (names must be unique)
   - Socket permission issues
   - Path traversal validation failures

3. **Recovery**:
   - Retry spawn once (transient failures)
   - Check error output for specifics
   - Adjust team plan if persistent failures
   - Reduce team size if necessary

### Status Mismatches

Config may diverge from reality (crashes, manual kills):

```bash
/claude-swarm:swarm-reconcile <team-name>
```

This will:

- Mark offline sessions as offline
- Report zombie config entries
- Suggest cleanup or resume actions

### Recovery Options

- **Respawn failed teammate**: Run spawn_teammate again with same name
- **Resume suspended team**: `/claude-swarm:swarm-resume <team-name>`
- **Remove dead teammate**: Update config or use cleanup

## Cleanup

Clean up when:

- Task is complete
- Setup failed unrecoverably
- User requests cleanup

Options:

```bash
/claude-swarm:swarm-cleanup "team-name"          # Soft: kills sessions only
/claude-swarm:swarm-cleanup "team-name" --force  # Hard: removes files too
```

**Before cleanup**:

- Verify tasks complete (check task list)
- Ask user about data preservation
- Send final messages to teammates

## Best Practices

### Planning

- Keep teams small (2-6 teammates optimal)
- Clearly define task boundaries
- Set explicit dependencies
- Choose appropriate agent types and models

### Communication

- Give teammates clear initial prompts
- Check inbox regularly
- Notify dependencies when tasks complete
- Use broadcast for team-wide updates

### Monitoring

- Run swarm-status periodically
- Verify spawns succeeded
- Check task progress
- Watch for blocked tasks

### Reliability

- Always use slash commands when available
- Verify multiplexer availability before spawning
- Run diagnostics when issues occur
- Use reconcile to fix status drift

## Environment Variables

When teammates are spawned, these variables are automatically set:

- `CLAUDE_CODE_TEAM_NAME` - Current team name
- `CLAUDE_CODE_AGENT_ID` - Unique agent UUID
- `CLAUDE_CODE_AGENT_NAME` - Agent name (e.g., "backend-dev")
- `CLAUDE_CODE_AGENT_TYPE` - Agent role type
- `CLAUDE_CODE_TEAM_LEAD_ID` - Team lead's agent UUID
- `CLAUDE_CODE_AGENT_COLOR` - Agent display color

User-configurable:

- `SWARM_MULTIPLEXER` - Force "tmux" or "kitty" (auto-detected by default)
- `SWARM_KITTY_MODE` - Kitty spawn mode: `split` (default), `tab`, or `window`

## See Also

- [Comprehensive Guide](references/guide.md) - Terminal support, kitty features, lifecycle, troubleshooting
- [Communication Patterns](references/communication.md) - Detailed messaging guide

## Progressive Disclosure

This overview covers essential swarm coordination concepts. For deeper details:

1. Review the Comprehensive Guide for terminal setup, kitty features, and troubleshooting
2. See Communication Patterns for messaging best practices
