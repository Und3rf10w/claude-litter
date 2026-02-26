# Claude Swarm Hooks

This document provides comprehensive documentation for all hooks implemented in the Claude Swarm plugin. Hooks are event-driven automation that enables team coordination, heartbeat tracking, and automatic swarm orchestration.

## Table of Contents

- [Overview](#overview)
- [Hook Execution Environment](#hook-execution-environment)
- [Available Hooks](#available-hooks)
  - [Notification Hook (Heartbeat)](#notification-hook-heartbeat)
  - [SessionStart Hook](#sessionstart-hook)
  - [SessionEnd Hook](#sessionend-hook)
  - [PostToolUse Hook (ExitPlanMode)](#posttooluse-hook-exitplanmode)
  - [PreToolUse Hook (Task)](#pretooluse-hook-task)
  - [PreToolUse Hook (TaskUpdate)](#pretooluse-hook-taskupdate)
  - [PreToolUse Hook (SendMessage)](#pretooluse-hook-sendmessage)
  - [SubagentStart Hook](#subagentstart-hook)
  - [SubagentStop Hook](#subagentstop-hook)
- [Output Format](#output-format)
- [Exit Codes](#exit-codes)
- [Debugging Hooks](#debugging-hooks)

## Overview

Claude Swarm uses 9 hooks to enable seamless team coordination:

1. **Notification** - Throttled heartbeat updates for team member activity tracking
2. **SessionStart** - Auto-delivers messages and task reminders when sessions start
3. **SessionEnd** - Handles graceful member/team shutdowns
4. **PostToolUse:ExitPlanMode** - Detects swarm launch requests from approved plans
5. **PreToolUse:Task** - Injects team context into spawned subagents
6. **PreToolUse:TaskUpdate** (prompt-based) - Validates task status changes and assignments
7. **PreToolUse:SendMessage** (prompt-based) - Validates team communications
8. **SubagentStart** - Injects team context into spawned subagents
9. **SubagentStop** (prompt-based) - Ensures teammates complete work before stopping

All hooks are registered in `hooks/hooks.json` and use the `${CLAUDE_PLUGIN_ROOT}` variable for portability.

### Command vs Prompt-Based Hooks

Claude Swarm uses two types of hooks:

- **Command hooks** (1-5, 8): Fast, deterministic operations like heartbeat tracking and message delivery
- **Prompt-based hooks** (6-7, 9): Context-aware validation using LLM reasoning for complex decisions

## Hook Execution Environment

### Environment Variables

Hooks have access to the following environment variables:

- `CLAUDE_CODE_TEAM_NAME` - Current team name (e.g., "swarm-review")
- `CLAUDE_CODE_AGENT_ID` - Current agent's unique UUID
- `CLAUDE_CODE_AGENT_NAME` - Current agent name (e.g., "team-lead", "doc-reviewer")
- `CLAUDE_CODE_AGENT_TYPE` - Agent type (e.g., "team-lead", "reviewer", "developer")
- `CLAUDE_CODE_TEAM_LEAD_ID` - Team lead's agent UUID (for InboxPoller activation)
- `CLAUDE_PLUGIN_ROOT` - Plugin root directory path
- `SWARM_KEEP_ALIVE` - If "true", keeps teammates running when team-lead exits
- `KITTY_LISTEN_ON` - Kitty socket path (passed to spawned teammates)

### Working Directory

Hooks execute in the context of the Claude Code session's current working directory.

### Standard Input/Output

- **PreToolUse hooks** receive tool input via stdin (JSON format)
- **PostToolUse hooks** receive tool result via stdin (JSON format)
- **All hooks** can output to stdout; output is displayed to the agent as `<system-reminder>` tags
- **Errors** should be sent to stderr

### Dependencies

Most hooks source the shared utility library:

```bash
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null
```

This provides access to functions like:

- `update_member_status()`
- `send_message()`
- `broadcast_message()`
- `suspend_team()`
- `reconcile_team_status()`
- `mark_messages_read()`
- `format_messages_xml()`

## Available Hooks

### Notification Hook (Heartbeat)

**Script:** `hooks/notification-heartbeat.sh`

**Event:** `Notification`

**Purpose:** Updates the `lastSeen` timestamp for active team members to enable stale agent detection.

#### Behavior

- **Throttled:** Only updates every 60 seconds to minimize I/O
- **Fast path:** Most invocations exit in <1ms with just a stat check
- **Threshold:** 60-second update interval is sufficient for 5-minute stale detection
- **Lightweight:** Does not source swarm-utils.sh for performance

#### Algorithm

1. Check if `CLAUDE_CODE_TEAM_NAME` is set; exit if not
2. Check throttle file modification time
3. If last update was <60 seconds ago, exit immediately
4. Update throttle file timestamp with `touch`
5. Update `lastSeen` field in team config JSON using `jq`

#### Files Modified

- `/tmp/swarm-heartbeat-${TEAM_NAME}-${AGENT_NAME}` - Throttle marker file
- `~/.claude/teams/${TEAM_NAME}/config.json` - Team configuration

#### Example Output

None (silent operation).

#### Exit Codes

- `0` - Always exits successfully (failures are silent)

---

### SessionStart Hook

**Script:** `hooks/session-start.sh`

**Event:** `SessionStart`

**Purpose:** Auto-delivers unread messages and reminds teammates of assigned tasks when a session starts.

#### Behavior

1. **Updates member status** to "active" with current timestamp
2. **Reconciles team status** (team-lead only) - detects crashed agents
3. **Delivers unread messages** from inbox
4. **Shows assigned tasks** (teammates only)

#### Output Scenarios

##### For Team Members with Unread Messages:

```xml
<system-reminder>
# Team Updates for doc-reviewer

## Unread Messages (2)

<message>
  <from>team-lead</from>
  <timestamp>2025-12-17T01:45:30Z</timestamp>
  <content>Please review the HOOKS.md documentation when ready.</content>
</message>

<message>
  <from>code-fixer</from>
  <timestamp>2025-12-17T01:50:15Z</timestamp>
  <content>I've fixed the bug in swarm-utils.sh. Ready for testing.</content>
</message>

</system-reminder>
```

##### For Team Members with Assigned Tasks:

```xml
<system-reminder>
# Team Updates for hooks-documenter

## Your Assigned Tasks

- Task #5: Create HOOKS.md documentation
- Task #8: Review hook error handling

Use `/task-list` to see full details.

</system-reminder>
```

#### Files Read

- `~/.claude/teams/${TEAM_NAME}/inboxes/${AGENT_NAME}.json` - Inbox messages
- `~/.claude/tasks/${TEAM_NAME}/*.json` - Task files

#### Files Modified

- `~/.claude/teams/${TEAM_NAME}/config.json` - Member status and lastSeen
- `~/.claude/teams/${TEAM_NAME}/inboxes/${AGENT_NAME}.json` - Marks messages as read

#### Exit Codes

- `0` - Always exits successfully

---

### SessionEnd Hook

**Script:** `hooks/session-stop.sh`

**Event:** `SessionEnd`

**Purpose:** Handles graceful shutdown of team members or entire teams.

#### Behavior

##### For Team-Lead:

- If `SWARM_KEEP_ALIVE=true`:
  - Marks team-lead as offline
  - Broadcasts message to all teammates that team-lead is gone but they should continue
- If `SWARM_KEEP_ALIVE` is not set (default):
  - Marks team-lead as offline
  - **Suspends the entire team** (kills all teammate sessions, keeps data)

##### For Team Members:

- Marks member as offline
- Sends notification to team-lead about clean exit
- Note: Crashed agents (that don't run this hook) are detected by `reconcile_team_status()` in SessionStart

#### Example Output

None (silent operation, but messages are sent via swarm-utils functions).

#### Files Modified

- `~/.claude/teams/${TEAM_NAME}/config.json` - Member status updated to "offline"
- `~/.claude/teams/${TEAM_NAME}/inboxes/team-lead.json` - Notification sent to team-lead
- On team suspension: All teammate processes are terminated

#### Exit Codes

- `0` - Always exits successfully

---

### PostToolUse Hook (ExitPlanMode)

**Script:** `hooks/exit-plan-swarm.sh`

**Event:** `PostToolUse` (matcher: `ExitPlanMode`)

**Purpose:** Detects swarm launch requests in approved plans and coordinates team creation and teammate spawning.

#### Trigger Condition

This hook runs after the `ExitPlanMode` tool is used (i.e., when Claude exits plan mode after user approval).

#### Behavior

1. Reads the tool result from stdin
2. Checks for swarm launch indicators (e.g., `launchSwarm: true`)
3. If a swarm launch is detected, coordinates team creation and teammate spawning

#### Example Output

None (coordinates spawning silently).

#### Exit Codes

- `0` - Always exits successfully

---

### PreToolUse Hook (Task)

**Script:** `hooks/task-team-context.sh`

**Event:** `PreToolUse` (matcher: `Task`)

**Purpose:** Injects team context information when spawning subagents via the Task tool, reminding agents about team resources.

#### Trigger Condition

This hook runs before any `Task` tool use, but only outputs if `CLAUDE_CODE_TEAM_NAME` is set.

#### Behavior

1. Checks if agent is part of a team
2. If yes, outputs reminder about team resources and coordination options
3. Helps agents decide between Task tool (temporary subagents) vs `/swarm-spawn` (persistent teammates)

#### Example Output

```xml
<system-reminder>
# Team Context Available

You are in team 'swarm-review'. When spawning subagents via the Task tool, consider:

1. The subagent can use swarm commands if it needs team coordination
2. Team config is at: ~/.claude/teams/swarm-review/config.json
3. Tasks are at: ~/.claude/tasks/swarm-review/

If the subagent should be a full teammate (persistent, with inbox), use `/swarm-spawn` instead of the Task tool.
</system-reminder>
```

#### Input Format (stdin)

The hook receives the tool input as JSON (not currently used).

#### Exit Codes

- `0` - Always exits successfully

---

### PreToolUse Hook (TaskUpdate)

**Type:** Prompt-based

**Event:** `PreToolUse` (matcher: `TaskUpdate`)

**Purpose:** Validates task status changes and assignments before they are applied, ensuring logical status transitions and valid owners.

#### Trigger Condition

This hook runs before any `TaskUpdate` tool use.

#### Behavior

1. Reviews the task update for validity
2. Checks if status transitions are logical (pending → in_progress → completed)
3. Verifies new task owners exist and are appropriate
4. Checks if completing a task would unblock dependent tasks

#### Prompt Logic

The prompt-based hook asks the LLM to validate the update and respond with JSON:
- `{"ok": true}` if the update is valid
- `{"ok": false, "reason": "specific reason"}` if concerns exist

#### Exit Codes

- `0` - Update is valid, proceed
- Non-zero - Update has concerns

---

### PreToolUse Hook (SendMessage)

**Type:** Prompt-based

**Event:** `PreToolUse` (matcher: `SendMessage`)

**Purpose:** Validates team communications for effectiveness, checking recipient validity, message clarity, and broadcast necessity.

#### Trigger Condition

This hook runs before any `SendMessage` tool use.

#### Behavior

1. Checks if the recipient is valid and appropriate
2. Validates that the message is clear and actionable
3. For broadcasts, checks if team-wide notification is truly necessary
4. For task assignments, verifies sufficient context is provided
5. For shutdown requests, checks if work is actually complete

#### Prompt Logic

The prompt-based hook asks the LLM to validate the communication and respond with JSON:
- `{"ok": true}` if the communication is appropriate
- `{"ok": false, "reason": "specific reason"}` if the recipient is invalid or critical issues exist

#### Exit Codes

- `0` - Communication is valid, proceed
- Non-zero - Communication has issues

---

### SubagentStart Hook

**Script:** `hooks/subagent-start-context.sh`

**Event:** `SubagentStart`

**Purpose:** Injects team context into spawned subagents so they inherit awareness of the team, tasks, and communication channels.

#### Trigger Condition

This hook runs when a Task tool subagent is launched. It only outputs if the parent agent is part of a team (i.e., `CLAUDE_CODE_TEAM_NAME` is set or detectable via window variables).

#### Behavior

1. Determines team context from environment variables or kitty window variables
2. Gathers team config, member list, and task summary
3. Outputs JSON with `additionalContext` to inject into the subagent's initial context

#### Output Format

Returns JSON with `hookSpecificOutput.additionalContext` that is injected as the subagent's first message context.

#### Exit Codes

- `0` - Always exits successfully (no output means no injection)

---

### SubagentStop Hook

**Type:** Prompt-based

**Event:** `SubagentStop` (matcher: `*`)

**Purpose:** Ensures teammates complete their work before stopping, checking for incomplete tasks, unreported status, and unresolved blocking issues.

#### Trigger Condition

This hook runs when any subagent is about to stop.

#### Behavior

1. Checks if all assigned tasks are completed or properly handed off
2. Verifies the teammate has reported work status to team-lead
3. Checks for blocking issues that should be resolved first
4. Validates that task statuses have been updated appropriately

#### Prompt Logic

The prompt-based hook asks the LLM to validate and respond with JSON:
- `{"ok": true}` if work is complete and teammate should stop
- `{"ok": false, "reason": "specific reason why work is incomplete"}` if teammate should NOT stop

#### Exit Codes

- `0` - Teammate can stop
- Non-zero - Teammate should continue working

---

## Output Format

### System Reminders

All hooks use the `<system-reminder>` XML tag format for output:

```xml
<system-reminder>
# Heading

Content goes here...

</system-reminder>
```

This format ensures the output is displayed to the agent as context rather than user-facing messages.

### Message Format (SessionStart)

Messages in the inbox are formatted with XML structure:

```xml
<message>
  <from>sender-name</from>
  <timestamp>2025-12-17T01:45:30Z</timestamp>
  <content>Message content here.</content>
</message>
```

Multiple messages are grouped together under a "## Unread Messages (N)" heading.

## Exit Codes

All hooks follow a consistent exit code convention:

| Exit Code | Meaning | Usage                                          |
| --------- | ------- | ---------------------------------------------- |
| `0`       | Success | All hooks always exit with 0, even on failures |

### Rationale

All hooks exit with code `0` (success) even when encountering errors because:

1. **Non-blocking:** Hook failures should not block the main Claude Code workflow
2. **Graceful degradation:** If a hook fails (e.g., can't update config), the session continues
3. **Silent errors:** Hooks handle errors internally without exposing them to users
4. **Performance:** Hooks prioritize speed; failures are logged but don't interrupt

Example from `notification-heartbeat.sh`:

```bash
# Can't create temp file, skip silently
if [[ -z "$TMP" ]]; then
    exit 0  # Still exit successfully
fi
```

## Debugging Hooks

### Enable Verbose Output

To debug hooks, you can modify the scripts to output debug information:

```bash
# Add at the top of any hook script
set -x  # Enable bash tracing
exec 2>/tmp/swarm-hook-debug.log  # Redirect stderr to log file
```

### Manual Hook Testing

You can test hooks manually by setting environment variables and running them:

```bash
export CLAUDE_CODE_TEAM_NAME="test-team"
export CLAUDE_CODE_AGENT_NAME="test-agent"
export CLAUDE_PLUGIN_ROOT="${HOME}/.claude/plugins/marketplaces/claude-litter/plugins/claude-swarm"

# Test SessionStart hook
bash "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh"
```

### Common Debug Scenarios

#### Heartbeat Not Updating

Check the throttle file:

```bash
ls -la /tmp/swarm-heartbeat-*
```

Test manually:

```bash
rm /tmp/swarm-heartbeat-*  # Clear throttle
export CLAUDE_CODE_TEAM_NAME="your-team"
export CLAUDE_CODE_AGENT_NAME="your-agent"
bash hooks/notification-heartbeat.sh
```

Check the config file:

```bash
jq '.members[] | {name, lastSeen}' ~/.claude/teams/your-team/config.json
```

#### Messages Not Appearing

Check inbox file:

```bash
cat ~/.claude/teams/your-team/inboxes/your-agent.json | jq
```

Verify message format:

```bash
jq '[.[] | select(.read == false)]' ~/.claude/teams/your-team/inboxes/your-agent.json
```

Test SessionStart hook:

```bash
export CLAUDE_CODE_TEAM_NAME="your-team"
export CLAUDE_CODE_AGENT_NAME="your-agent"
bash hooks/session-start.sh
```

#### Team Not Suspending

Check if team-lead detection is working:

```bash
echo "AGENT_NAME: ${CLAUDE_CODE_AGENT_NAME}"
echo "AGENT_TYPE: ${CLAUDE_CODE_AGENT_TYPE}"
```

Test SessionEnd hook:

```bash
export CLAUDE_CODE_TEAM_NAME="your-team"
export CLAUDE_CODE_AGENT_NAME="team-lead"
bash hooks/session-stop.sh
```

Check team config after suspension:

```bash
jq '{status, suspendedAt, members: [.members[] | {name, status}]}' \
  ~/.claude/teams/your-team/config.json
```

#### Swarm Launch Not Detected

Test with sample input:

```bash
echo '{"launchSwarm": true, "teammateCount": 5}' | \
  bash hooks/exit-plan-swarm.sh
```

Check pattern matching:

```bash
echo '{"launchSwarm": true}' | grep -q '"launchSwarm".*true' && echo "Match"
```

#### Task Context Not Appearing

Verify team environment:

```bash
echo "Team: ${CLAUDE_CODE_TEAM_NAME}"
ls -la ~/.claude/teams/
```

Test PreToolUse hook:

```bash
export CLAUDE_CODE_TEAM_NAME="your-team"
echo '{}' | bash hooks/task-team-context.sh
```

### Hook Execution Logs

Claude Code may log hook execution. Check for logs in:

- `~/.claude/logs/` - Claude Code session logs
- `/tmp/swarm-hook-debug.log` - If you enabled debug output
- stderr output in your terminal

### Verifying Hook Registration

Check that hooks are properly registered:

```bash
cat plugins/claude-swarm/hooks/hooks.json | jq
```

Verify plugin is loaded:

```bash
claude-code config plugins list
```

### Performance Profiling

Time hook execution:

```bash
time bash hooks/notification-heartbeat.sh
time bash hooks/session-start.sh
```

Expected performance:

- **notification-heartbeat.sh**: <1ms (throttled path), ~50ms (update path)
- **session-start.sh**: ~100-500ms (depends on message count)
- **session-stop.sh**: ~100ms (member), ~500ms+ (team suspension)
- **exit-plan-swarm.sh**: <10ms
- **task-team-context.sh**: <10ms

## See Also

- **[Main README](../README.md)** - Overview, quick start, architecture, and troubleshooting
- **[Commands Reference](COMMANDS.md)** - Complete slash command documentation
- **[Integration Guide](INTEGRATION.md)** - CI/CD integration and external systems
- **Skills:**
  - **[Swarm Orchestration](../skills/swarm-orchestration/SKILL.md)** - Team-lead operations and management
  - **[Swarm Teammate](../skills/swarm-teammate/SKILL.md)** - Worker coordination protocol
  - **[Swarm Troubleshooting](../skills/swarm-troubleshooting/SKILL.md)** - Diagnostics and recovery
