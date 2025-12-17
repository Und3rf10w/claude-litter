# Claude Swarm

Multi-agent swarm coordination for Claude Code - spawn parallel teammates in tmux/kitty, assign tasks, and coordinate work across multiple Claude Code instances.

## Overview

Claude Swarm enables you to orchestrate teams of Claude Code instances working together on complex tasks. Each teammate runs in its own terminal session (tmux or kitty), with shared task lists, message passing, and coordinated workflows.

**Key Features:**

- **Team Management** - Create teams with specialized agent roles (backend-dev, frontend-dev, reviewer, etc.)
- **Task Coordination** - Shared task list with status tracking, assignments, and dependencies
- **Message Passing** - Asynchronous communication between team members
- **Session Persistence** - Suspend and resume teams with full context preservation
- **Health Monitoring** - Automatic heartbeat tracking and crash detection
- **Terminal Integration** - Seamless kitty and tmux support

## Quick Start

### Prerequisites

**Required:**
- **Terminal multiplexer**: kitty (recommended) or tmux
- **jq**: JSON processor for configuration management

**For kitty users** (recommended for best experience):
```bash
# Add to ~/.config/kitty/kitty.conf
allow_remote_control yes
listen_on unix:/tmp/kitty-${USER}
```

**Note on Kitty Sockets:** Kitty creates sockets like `/tmp/kitty-$USER-$PID` where `$PID` is the kitty process ID. Claude Swarm automatically discovers the correct socket by searching for the most recent one. This allows multiple kitty instances to coexist without conflicts.

### Creating Your First Swarm

```bash
# 1. Create a team
/claude-swarm:swarm-create "my-project" "Building a new feature"

# 2. Create tasks
/claude-swarm:task-create "Implement API endpoints" "Build REST API with authentication"
/claude-swarm:task-create "Build UI components" "Create React components for dashboard"

# 3. Spawn teammates
/claude-swarm:swarm-spawn backend-dev backend-developer sonnet "Focus on task #1"
/claude-swarm:swarm-spawn frontend-dev frontend-developer sonnet "Focus on task #2"

# 4. Assign tasks
/claude-swarm:task-update 1 --assign backend-dev
/claude-swarm:task-update 2 --assign frontend-dev

# 5. Monitor progress
/claude-swarm:swarm-status my-project
/claude-swarm:task-list
```

### Basic Workflow

**As team-lead:**
```bash
# Check team status
/claude-swarm:swarm-status my-project

# Send messages to teammates
/claude-swarm:swarm-message backend-dev "API schema updated, see docs/"

# Monitor tasks
/claude-swarm:task-list
```

**As teammate:**
```bash
# Check your inbox
/claude-swarm:swarm-inbox

# Update task progress
/claude-swarm:task-update 1 --status in-progress
/claude-swarm:task-update 1 --comment "Completed authentication middleware"

# Notify team-lead when done
/claude-swarm:swarm-message team-lead "Task #1 complete, PR ready"
```

## Documentation

### Core Documentation

- **[Commands Reference](docs/COMMANDS.md)** - Complete reference for all 17 slash commands
- **[Hooks Documentation](docs/HOOKS.md)** - Event-driven automation and lifecycle hooks
- **[Integration Guide](docs/INTEGRATION.md)** - Integrate with CI/CD, external systems, and custom tools

### Skills

- **[Swarm Coordination Skill](skills/swarm-coordination/SKILL.md)** - Comprehensive orchestration guide for team-leads

## Components

### Slash Commands (17)

**Team Management:**
- `/claude-swarm:swarm-create` - Create new team
- `/claude-swarm:swarm-spawn` - Spawn teammate
- `/claude-swarm:swarm-status` - View team status
- `/claude-swarm:swarm-verify` - Verify teammates alive
- `/claude-swarm:swarm-cleanup` - Suspend or delete team
- `/claude-swarm:swarm-resume` - Resume suspended team
- `/claude-swarm:swarm-list-teams` - List all teams
- `/claude-swarm:swarm-onboard` - Interactive onboarding wizard
- `/claude-swarm:swarm-diagnose` - Diagnose team health
- `/claude-swarm:swarm-reconcile` - Fix status mismatches

**Communication:**
- `/claude-swarm:swarm-message` - Send message to teammate
- `/claude-swarm:swarm-inbox` - Check your inbox

**Task Management:**
- `/claude-swarm:task-create` - Create new task
- `/claude-swarm:task-list` - List all tasks
- `/claude-swarm:task-update` - Update task status/assignment
- `/claude-swarm:task-delete` - Delete task

**Kitty-Specific:**
- `/claude-swarm:swarm-session` - Generate/launch kitty session files

### Hooks (5)

- **Notification Hook** - Heartbeat updates for activity tracking
- **SessionStart Hook** - Auto-deliver messages and task reminders
- **SessionEnd Hook** - Graceful shutdown handling
- **PostToolUse:ExitPlanMode Hook** - Swarm launch guidance after plan approval
- **PreToolUse:Task Hook** - Inject team context into subagents

### Agents (1)

- **swarm-coordinator** - Automated swarm orchestration agent

### Skills (1)

- **swarm-coordination** - Orchestration workflows and best practices

## Agent Types

Choose appropriate agent types when spawning teammates:

- `worker` - General-purpose tasks
- `backend-developer` - API, server-side logic, database work
- `frontend-developer` - UI components, styling, user interactions
- `reviewer` - Code review, quality assurance
- `researcher` - Documentation, investigation, analysis
- `tester` - Test writing, validation, QA

## Model Selection

- `haiku` - Fast, cost-effective for simple repetitive tasks
- `sonnet` - Balanced capability (recommended default)
- `opus` - Complex reasoning and architectural decisions

## Architecture

### Team Structure

```
~/.claude/
├── teams/
│   └── <team-name>/
│       ├── config.json          # Team configuration and member status
│       ├── inboxes/             # Message inboxes for each member
│       │   ├── team-lead.json
│       │   ├── backend-dev.json
│       │   └── frontend-dev.json
│       └── swarm.kitty-session  # Kitty session file (if using kitty)
└── tasks/
    └── <team-name>/
        ├── 1.json               # Task files
        ├── 2.json
        └── 3.json
```

### Library Architecture

The swarm-utils library uses a modular architecture for better maintainability:

```
plugins/claude-swarm/lib/
├── swarm-utils.sh              # Main entry point (sources all modules)
├── core/
│   ├── 00-globals.sh          # Global variables and configuration
│   ├── 01-utils.sh            # Utility functions (UUID, validation)
│   └── 02-file-lock.sh        # Atomic file locking
├── multiplexer/
│   ├── 03-multiplexer.sh      # Kitty/tmux detection and control
│   └── 04-registry.sh         # Window registry tracking
├── team/
│   ├── 05-team.sh             # Team creation and management
│   ├── 06-status.sh           # Status management and live agents
│   └── 10-lifecycle.sh        # Suspend/resume operations
├── communication/
│   └── 07-messaging.sh        # Message inbox system
├── tasks/
│   └── 08-tasks.sh            # Task CRUD operations
└── spawn/
    ├── 09-spawn.sh            # Teammate spawning
    ├── 11-cleanup.sh          # Team cleanup
    ├── 12-kitty-session.sh    # Session file generation
    └── 13-diagnostics.sh      # Health checks and diagnostics
```

**Key Features:**
- **Modular design** - 13 specialized modules organized by functional responsibility
- **Clear dependencies** - Numbered files ensure proper load order (00 → 13)
- **Backward compatible** - All existing code continues to work unchanged
- **Source guards** - Prevents double-loading of modules
- **Maintainable** - Each module averages ~160 lines (down from 2090 line monolith)

All modules load automatically when you source `${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh`.

### Environment Variables

When teammates are spawned, these variables are automatically set:

- `CLAUDE_CODE_TEAM_NAME` - Current team name
- `CLAUDE_CODE_AGENT_ID` - Unique agent UUID
- `CLAUDE_CODE_AGENT_NAME` - Agent name (e.g., "backend-dev")
- `CLAUDE_CODE_AGENT_TYPE` - Agent role type
- `CLAUDE_CODE_TEAM_LEAD_ID` - Team lead's agent UUID (for InboxPoller)
- `CLAUDE_CODE_AGENT_COLOR` - Agent display color

## Best Practices

### Planning

- Keep teams small (2-6 teammates optimal)
- Clearly define task boundaries
- Set explicit dependencies between tasks
- Choose appropriate agent types and models

### Communication

- Give teammates clear initial prompts with task context
- Check inbox regularly for coordination messages
- Notify dependencies when tasks complete
- Use `/swarm-status` to monitor overall progress

### Monitoring

- Run `/swarm-verify` after spawning to confirm success
- Use `/swarm-diagnose` when issues occur
- Check `/task-list` regularly to track progress
- Run `/swarm-reconcile` to fix status drift

### Cleanup

- Suspend teams with `/swarm-cleanup <team>` to preserve data
- Resume with `/swarm-resume <team>` to continue work
- Use `--force` flag only for permanent deletion

## Troubleshooting

### Spawn Failures

**Issue:** Teammates fail to spawn

**Solutions:**
1. Run `/claude-swarm:swarm-diagnose <team>` for detailed diagnostics
2. Verify multiplexer is available: `which kitty` or `which tmux`
3. For kitty: Check socket with `ls /tmp/kitty-$(whoami)-*`
4. For kitty: Verify config has `allow_remote_control yes` and `listen_on unix:/tmp/kitty-${USER}`
5. Check for duplicate agent names (must be unique)

### Status Mismatches

**Issue:** Config says "active" but no session exists

**Solutions:**
1. Run `/claude-swarm:swarm-reconcile <team>` to auto-fix
2. Check for crashed agents with `/swarm-diagnose`
3. Manual verification: `/swarm-verify <team>`

### Messages Not Delivered

**Issue:** Teammate not receiving messages

**Solutions:**
1. Verify inbox file exists: `ls ~/.claude/teams/<team>/inboxes/`
2. Check message format: `cat ~/.claude/teams/<team>/inboxes/<agent>.json | jq`
3. Teammate should run `/swarm-inbox` to check manually
4. Messages auto-deliver on SessionStart hook

### Kitty Socket Not Found

**Issue:** "Could not find a valid kitty socket"

**Solutions:**
1. Ensure running inside kitty (not Terminal.app or iTerm2)
2. Add to `~/.config/kitty/kitty.conf`:
   ```
   allow_remote_control yes
   listen_on unix:/tmp/kitty-${USER}
   ```
3. Restart kitty after config changes
4. Manually set: `export KITTY_LISTEN_ON=unix:/tmp/kitty-$(whoami)`
5. Verify socket exists: `ls -la /tmp/kitty-$(whoami)-*`

### Team Won't Suspend

**Issue:** `/swarm-cleanup` doesn't kill sessions

**Solutions:**
1. Verify you're running as team-lead (not teammate)
2. Check `SWARM_KEEP_ALIVE` env var (if set, teammates stay alive)
3. Use `--force` flag for permanent deletion
4. Manual cleanup: Kill windows via kitty/tmux directly

## Advanced Usage

### CI/CD Integration

See [Integration Guide](docs/INTEGRATION.md) for examples of:
- Creating teams from GitHub Actions
- Sending notifications from deployment pipelines
- Monitoring team health from external systems
- Building custom dashboards

### Custom Tooling

```bash
# Access swarm utilities in custom scripts
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh"

# Use any exported function
create_team "my-team" "Custom workflow"
send_message "my-team" "backend-dev" "Deploy to staging"
```

### Onboarding New Users

```bash
# Interactive setup wizard
/claude-swarm:swarm-onboard

# Skip demo, just check prerequisites
/claude-swarm:swarm-onboard --skip-demo
```

## Contributing

This plugin is part of the Claude Code ecosystem. For bugs, feature requests, or contributions, please refer to the Claude Code documentation.

## License

See the main Claude Code license.

## Version

Current version: 1.4.1

## Support

- **Onboarding:** `/claude-swarm:swarm-onboard` - Interactive setup wizard
- **Diagnostics:** `/claude-swarm:swarm-diagnose <team>` - Health checks
- **Documentation:** See [docs/](docs/) directory for detailed guides
