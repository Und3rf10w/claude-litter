# Claude Litter 🐱

> A swarm of Claude Code instances working together like a litter of kittens

**Claude Litter** is a plugin marketplace for Claude Code that enables multi-agent coordination. Spawn parallel Claude Code teammates in **kitty** or **tmux**, assign tasks, and coordinate work across multiple instances.

## Why "Litter"?

Because when you're running multiple Claude instances in kitty terminal, you've got yourself a _litter_ of kittens! 🐱🐱🐱

## Features

- **Multi-agent swarms** - Spawn multiple Claude Code instances working in parallel
- **Kitty & tmux support** - Native support for both terminal multiplexers
- **Task management** - Create, assign, and track tasks across teammates
- **Message passing** - File-based inbox system for inter-agent communication
- **Session files** - Save and restore entire swarm configurations (kitty)
- **Auto-detection** - Automatically detects kitty vs tmux environment

---

## Installation & Setup

### Prerequisites

- **Claude Code** installed and running ([installation guide](https://docs.anthropic.com/en/docs/claude-code))
- **Terminal multiplexer**: Either kitty (recommended) or tmux
- **jq** for JSON processing: `brew install jq` (macOS) or `apt install jq` (Linux)

### Step 1: Add the Claude Litter Marketplace

Open Claude Code and run:

```
/plugin marketplace add Und3rf10w/claude-litter
```

This adds the Claude Litter marketplace from GitHub. Claude Code will:

1. Clone the repository to `~/.claude/plugins/marketplaces/claude-litter/`
2. Register the marketplace for plugin discovery
3. Make the `claude-swarm` plugin available for installation

### Step 2: Install the Claude Swarm Plugin

```
/plugin install claude-swarm@claude-litter
```

This installs the swarm plugin, which includes:

- 17 slash commands for team/task management
- 1 agent (swarm-coordinator) for automated orchestration
- 1 skill (swarm-guide) for guidance
- 5 hooks for session lifecycle events

### Step 3: Configure Your Terminal

#### For Kitty Users (Recommended)

Kitty requires remote control and socket listener enabled for Claude Code to spawn teammates.

**1. Edit your kitty config:**

```bash
# Open kitty.conf
vim ~/.config/kitty/kitty.conf
```

**2. Add these lines:**

```conf
# Required for Claude Litter swarm functionality
allow_remote_control yes
listen_on unix:/tmp/kitty-$USER
```

I would generally recommend you add this line too so that you can use SHIFT + Enter to insert a new line in Claude Code:

```conf
map shift+enter send_text all \n
```

**3. Restart kitty completely** (not just reload config):

- macOS: `Cmd+Q` then reopen kitty
- Linux: Close all kitty windows and reopen

**4. Verify the socket exists:**

```bash
# Should show the socket file (may have a PID suffix like kitty-username-12345)
ls -la /tmp/kitty-$USER*
```

**5. Test remote control:**

```bash
# Should return JSON with window information
kitten @ ls
```

If `kitten @ ls` works, you're ready to go!

#### For tmux Users

tmux works out of the box - no additional configuration needed. Just ensure tmux is installed:

```bash
# macOS
brew install tmux

# Linux
apt install tmux
```

### Step 4: Verify Installation

In Claude Code, run:

```
/plugin
```

You should see `claude-swarm` listed under installed plugins. You can also verify the commands are available:

```
/claude-swarm:swarm-create test-team "Testing installation"
/claude-swarm:swarm-status test-team
/claude-swarm:swarm-cleanup test-team --force
```

### Alternative: Install from Local Clone

If you prefer to clone the repository manually:

```bash
# Clone to the marketplaces directory
git clone https://github.com/Und3rf10w/claude-litter.git ~/.claude/plugins/marketplaces/claude-litter

# In Claude Code, add the local marketplace
/plugin marketplace add ~/.claude/plugins/marketplaces/claude-litter

# Install the plugin
/plugin install claude-swarm@claude-litter
```

### Alternative: Team/Project Installation

To automatically install Claude Litter for all team members working on a project, add to your project's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "claude-litter": {
      "source": {
        "source": "github",
        "repo": "Und3rf10w/claude-litter"
      }
    }
  },
  "enabledPlugins": {
    "claude-litter": {
      "claude-swarm": true
    }
  }
}
```

When team members trust the repository folder, Claude Code automatically:

1. Installs the Claude Litter marketplace
2. Installs and enables the claude-swarm plugin

### Updating the Plugin

To update to the latest version:

```
/plugin marketplace update claude-litter
```

Or enable auto-updates:

1. Run `/plugin` to open the plugin manager
2. Select **Marketplaces**
3. Choose **claude-litter**
4. Select **Enable auto-update**

---

## Kitty Advanced Configuration

> Basic kitty setup is covered in [Installation & Setup](#installation--setup). This section covers additional options.

### Spawn Modes

Control how teammates spawn in kitty by setting `SWARM_KITTY_MODE`:

```bash
# In your shell profile (~/.zshrc or ~/.bashrc)
export SWARM_KITTY_MODE=split   # Options: window, split, tab
```

| Mode     | Behavior                                         |
| -------- | ------------------------------------------------ |
| `window` | Each teammate in separate kitty window (default) |
| `split`  | Teammates in splits within current tab           |
| `tab`    | Each teammate in separate tab                    |

### Socket Path Override

If your kitty socket is in a non-standard location:

```bash
export KITTY_LISTEN_ON=unix:/path/to/your/socket
```

The plugin automatically detects sockets matching `/tmp/kitty-$USER-*` (kitty appends a PID).

---

## Quick Start

### Option 1: Automated (Recommended)

Just describe your task - the swarm-coordinator agent handles everything:

```
"Set up a team to implement user authentication with login, signup, and password reset"
```

Claude will automatically:

1. Create a team
2. Break down the task
3. Spawn teammates
4. Assign work

### Option 2: Manual Setup

```bash
# Create a team
/claude-swarm:swarm-create my-feature "Implementing new feature"

# Create tasks
/claude-swarm:task-create "Build API endpoints" "REST API for user management"
/claude-swarm:task-create "Create UI components" "React forms and pages"
/claude-swarm:task-create "Write tests" "Unit and integration tests"

# Spawn teammates
/claude-swarm:swarm-spawn backend-dev backend-developer sonnet
/claude-swarm:swarm-spawn frontend-dev frontend-developer sonnet
/claude-swarm:swarm-spawn tester tester haiku

# Assign tasks
/claude-swarm:task-update 1 --assign backend-dev
/claude-swarm:task-update 2 --assign frontend-dev
/claude-swarm:task-update 3 --assign tester --blocked-by 1

# Check status
/claude-swarm:swarm-status my-feature
```

---

## Team Lifecycle

Teams support suspend and resume functionality, allowing you to pause work and continue later.

### Team States

| State       | Description                                |
| ----------- | ------------------------------------------ |
| `active`    | Team is running, members are working       |
| `suspended` | Sessions closed, data preserved, resumable |
| `archived`  | Permanently stored (future feature)        |

### Suspending a Team

When you're done working (or need to take a break):

```bash
# Soft cleanup: Kill sessions, preserve data
/claude-swarm:swarm-cleanup my-team

# Hard cleanup: Delete everything permanently
/claude-swarm:swarm-cleanup my-team --force
```

**What happens on suspend:**

- All teammate sessions are closed
- Team and member status set to "suspended"/"offline"
- All data preserved (config, tasks, messages)

### Resuming a Team

To continue where you left off:

```bash
/claude-swarm:swarm-resume my-team
```

**What happens on resume:**

- Team status changes to "active"
- Each offline teammate is respawned with:
  - Their original model (haiku/sonnet/opus)
  - Context about assigned tasks
  - Notification of unread messages
- Teammates can pick up where they left off

### Automatic Behavior

**When team-lead exits:**

- By default: All teammates are killed, team is suspended
- With `SWARM_KEEP_ALIVE=true`: Teammates keep running

**When a teammate exits:**

- Team-lead is notified via inbox
- Teammate marked as offline

### Example Workflow

```bash
# Day 1: Start working
/claude-swarm:swarm-create feature-x "New dashboard"
/claude-swarm:swarm-spawn api-dev backend-developer sonnet
/claude-swarm:task-create "Build API" "REST endpoints for dashboard"
/claude-swarm:task-update 1 --assign api-dev

# End of day: Suspend (or just close Claude Code)
/claude-swarm:swarm-cleanup feature-x

# Day 2: Resume work
/claude-swarm:swarm-resume feature-x
# api-dev respawns with context about Task #1
```

---

## Commands Reference

### Team Management

| Command                       | Description       | Usage                                         |
| ----------------------------- | ----------------- | --------------------------------------------- |
| `/claude-swarm:swarm-create`  | Create a new team | `/swarm-create <team> [description]`          |
| `/claude-swarm:swarm-spawn`   | Spawn a teammate  | `/swarm-spawn <name> [type] [model] [prompt]` |
| `/claude-swarm:swarm-status`  | View team status  | `/swarm-status <team>`                        |
| `/claude-swarm:swarm-cleanup` | Suspend/delete    | `/swarm-cleanup <team> [--force]`             |
| `/claude-swarm:swarm-resume`  | Resume suspended  | `/swarm-resume <team>`                        |

### Task Management

| Command                     | Description    | Usage                                                 |
| --------------------------- | -------------- | ----------------------------------------------------- |
| `/claude-swarm:task-create` | Create a task  | `/task-create <subject> [description]`                |
| `/claude-swarm:task-list`   | List all tasks | `/task-list`                                          |
| `/claude-swarm:task-update` | Update a task  | `/task-update <id> [--status] [--assign] [--comment]` |

### Communication

| Command                       | Description      | Usage                           |
| ----------------------------- | ---------------- | ------------------------------- |
| `/claude-swarm:swarm-message` | Send a message   | `/swarm-message <to> <message>` |
| `/claude-swarm:swarm-inbox`   | Check your inbox | `/swarm-inbox [mark_read]`      |

### Kitty-Specific

| Command                       | Description          | Usage                                            |
| ----------------------------- | -------------------- | ------------------------------------------------ |
| `/claude-swarm:swarm-session` | Manage session files | `/swarm-session <generate\|launch\|save> <team>` |

---

## Agent Types

When spawning teammates, choose an appropriate type:

| Type                 | Best For                     |
| -------------------- | ---------------------------- |
| `worker`             | General purpose tasks        |
| `backend-developer`  | APIs, databases, server code |
| `frontend-developer` | UI, React, CSS, UX           |
| `reviewer`           | Code review, quality checks  |
| `researcher`         | Documentation, investigation |
| `tester`             | Writing and running tests    |

## Model Selection

| Model    | Use Case                                  |
| -------- | ----------------------------------------- |
| `haiku`  | Simple, well-defined tasks (fast & cheap) |
| `sonnet` | Balanced complexity (default)             |
| `opus`   | Complex reasoning, architecture decisions |

---

## Kitty Session Files

Save and restore entire swarm configurations:

```bash
# Generate session file from current team
/claude-swarm:swarm-session generate my-team

# Launch a new kitty instance with all teammates
/claude-swarm:swarm-session launch my-team

# Or launch manually
kitty --session ~/.claude/teams/my-team/swarm.kitty-session
```

### Session File Location

```
~/.claude/teams/<team>/swarm.kitty-session
```

### Window Identification

Kitty windows use user variables (`--var`) for reliable identification:

- Windows survive title changes by Claude
- Pattern: `var:swarm_<team>_<agent>`
- Commands can target windows even after Claude renames them

---

## Communication Patterns

### team-lead → Teammates

```bash
/claude-swarm:swarm-message backend-dev "Priority change: implement OAuth first"
```

### Teammates → team-lead

```bash
/claude-swarm:swarm-message team-lead "Task #1 complete. PR ready for review."
```

### Check Messages

```bash
/claude-swarm:swarm-inbox
```

Messages are delivered:

- Automatically on session start (via hook)
- Manually via `/swarm-inbox`

---

## File Structure

```
~/.claude/
├── teams/<team>/
│   ├── config.json              # Team configuration
│   ├── swarm.kitty-session      # Kitty session file (if generated)
│   └── inboxes/
│       ├── team-lead.json       # Message inboxes
│       ├── backend-dev.json
│       └── ...
└── tasks/<team>/
    ├── 1.json                   # Task files
    ├── 2.json
    └── ...
```

---

## Environment Variables

### Set by the Plugin

When inside a swarm session, these are automatically set:

| Variable                 | Description            |
| ------------------------ | ---------------------- |
| `CLAUDE_CODE_TEAM_NAME`  | Current team name      |
| `CLAUDE_CODE_AGENT_ID`   | Your unique agent UUID |
| `CLAUDE_CODE_AGENT_NAME` | Your agent name        |
| `CLAUDE_CODE_AGENT_TYPE` | Your role type         |

### User Configuration

| Variable            | Description                    | Default                 |
| ------------------- | ------------------------------ | ----------------------- |
| `SWARM_MULTIPLEXER` | Force `tmux` or `kitty`        | Auto-detect             |
| `SWARM_KITTY_MODE`  | Kitty spawn mode               | `window`                |
| `KITTY_LISTEN_ON`   | Kitty socket path override     | `unix:/tmp/kitty-$USER` |
| `SWARM_KEEP_ALIVE`  | Keep teammates when lead exits | `false`                 |

---

## Best Practices

### 1. Right-Size Your Team

| Team Size | Use Case                                    |
| --------- | ------------------------------------------- |
| 2-3       | Small features, bug fixes                   |
| 4-5       | Medium features                             |
| 6+        | Large projects (more coordination overhead) |

### 2. Clear Task Descriptions

Give teammates specific, actionable instructions:

```bash
/claude-swarm:swarm-spawn api-dev backend-developer sonnet "You handle the REST API. Focus on /api/auth endpoints. Check task #1 for requirements. Report to team-lead when done."
```

### 3. Use Dependencies

Prevent work on tasks that depend on others:

```bash
/claude-swarm:task-update 3 --blocked-by 1
/claude-swarm:task-update 3 --blocked-by 2
```

### 4. Regular Check-ins

Teammates should periodically:

```bash
/claude-swarm:swarm-inbox    # Check for messages
/claude-swarm:task-list      # See task updates
```

### 5. Clear Completion Signals

When done with a task:

```bash
/claude-swarm:task-update 1 --status resolved --comment "Done. See commit abc123"
/claude-swarm:swarm-message team-lead "Task #1 complete"
```

---

## Troubleshooting

### Kitty Remote Control Not Working

1. Verify config:

   ```bash
   grep -E 'allow_remote_control|listen_on' ~/.config/kitty/kitty.conf
   ```

2. Test connection:

   ```bash
   kitten @ ls
   ```

3. Restart kitty after config changes (full restart, not just reload)

### "device not configured" Error from Claude Code

If you see `Error: open /dev/tty: device not configured` when spawning teammates:

1. Ensure `listen_on unix:/tmp/kitty-$USER` is in your kitty.conf
2. Restart kitty completely
3. Verify socket exists:

   ```bash
   ls -la /tmp/kitty-$USER
   ```

4. Test socket connection:

   ```bash
   kitten @ --to unix:/tmp/kitty-$USER ls
   ```

### Messages Not Delivered

Messages are file-based. Recipients must:

- Run `/swarm-inbox` manually, OR
- Start a new session (auto-delivered via hook)

### Teammate Not Responding

```bash
# Check status
/claude-swarm:swarm-status my-team

# List kitty windows
kitten @ ls | jq '.[] | .tabs[].windows[] | select(.user_vars.swarm_team)'

# Respawn if needed
/claude-swarm:swarm-spawn <name> <type>
```

### Force tmux Instead of Kitty

```bash
export SWARM_MULTIPLEXER=tmux
```

---

## Hooks

Claude Swarm includes 5 lifecycle hooks that automate coordination and monitoring:

### SessionStart Hook

**Trigger:** When a teammate Claude Code session starts
**Action:** Automatically delivers unread inbox messages

This ensures teammates see important messages from team-lead immediately upon starting their session, without needing to manually run `/swarm-inbox`.

### SessionEnd Hook

**Trigger:** When a teammate Claude Code session ends
**Action:** Notifies team-lead via inbox message

When a teammate exits, team-lead is informed so they can reassign work or respawn the teammate if needed.

### Notification Hook

**Trigger:** Periodic notifications during Claude Code operation
**Action:** Updates heartbeat timestamp for health monitoring

Each active teammate periodically updates their heartbeat file. Use `/swarm-diagnose` to detect stale agents that may be hung or idle.

### PostToolUse:ExitPlanMode Hook

**Trigger:** When Claude exits plan mode
**Action:** Detects swarm launch requests and coordinates spawning

When you approve a plan that includes creating a swarm team, this hook automatically handles the team creation and teammate spawning process.

### PreToolUse:Task Hook

**Trigger:** Before spawning a subagent with the Task tool
**Action:** Injects team context (team name, agent ID, agent name, role)

When teammates spawn their own subagents, those subagents automatically inherit the team context, ensuring proper coordination across nested agents.

---

## Plugin Contents

### Commands (17)

**Team Management:**

- swarm-create, swarm-spawn, swarm-status, swarm-cleanup, swarm-resume
- swarm-onboard, swarm-diagnose, swarm-verify, swarm-reconcile
- swarm-list-teams, swarm-message, swarm-inbox, swarm-session

**Task Management:**

- task-create, task-list, task-update, task-delete

### Agents (1)

- **swarm-coordinator** - Orchestrates team creation and task breakdown

### Skills (1)

- **swarm-guide** - Comprehensive guide to swarm coordination patterns

### Hooks (5)

- **SessionStart** - Auto-deliver unread messages on session start
- **SessionEnd** - Notify team-lead when teammate ends session
- **Notification** - Heartbeat tracking for agent health monitoring
- **PostToolUse:ExitPlanMode** - Handle swarm launch requests from plan mode
- **PreToolUse:Task** - Inject team context into subagents before task execution
