---
description: "View swarm loop progress and status"
allowed-tools: ["Read(.claude/swarm-loop/**)", "Read(.claude/swarm-loop.local.md)", "Glob", "TaskList"]
---

# Swarm Status

Display the current status of all active swarm loop instances.

1. Use Glob to find all active instances:
```
Glob: .claude/swarm-loop/*/state.json
```
If no files are found, report that no swarm loop is currently active and stop.

2. Read each state file found. For each instance, display a brief summary row:

| Instance ID | Goal | Iteration | Phase | Mode |
|---|---|---|---|---|
| `<id>` | `<goal>` | `<n>` | `<phase>` | `<mode>` |

3. For the current session's instance (match state field `session_id` against `$CLAUDE_CODE_SESSION_ID` if available, or show all if the env var is unavailable), display detailed status:

   - **Goal**: The objective being worked on
   - **Iteration**: Current iteration number
   - **Phase**: Current phase (initial, working, delivering, refining, rejected, complete)
   - **Autonomy Health**: `autonomy_health` field value
   - **Permission Failures**: Count of entries in `permission_failures` array
   - **Mode**: `<mode>` (profile)
   - **Compact Mode**: Whether `compact_on_iteration` is enabled
   - **Min Iterations**: `min_iterations` value (0 = disabled)
   - **Max Iterations**: `max_iterations` value (0 = unlimited)
   - **Sentinel Timeout**: `sentinel_timeout` value in seconds

4. Call `TaskList` to get live task status. Display tasks grouped by status (in_progress, pending, completed) with their owners and any blocked-by dependencies.

5. If `.claude/swarm-loop/<id>/heartbeat.json` exists for the selected instance, read it and display:
   - **Last Heartbeat**: timestamp of last heartbeat
   - **Team Active**: `team_active` status from the heartbeat file

6. Read the last 50 lines of `.claude/swarm-loop/<id>/log.md` and display as **Recent Activity**.

7. If `.claude/swarm-loop.local.md` exists, read it and display the active configuration settings under **Config**.

Format all of this as a clean, readable dashboard.
