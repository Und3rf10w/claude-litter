---
description: "View swarm loop progress and status"
allowed-tools: ["Read(.claude/swarm-loop.local.state.json)", "Read(.claude/swarm-loop.local.log.md)", "Read(.claude/swarm-loop.local.heartbeat.json)", "Read(.claude/swarm-loop.local.md)", "TaskList"]
---

# Swarm Status

Display the current status of the swarm loop.

1. Read `.claude/swarm-loop.local.state.json`. If the file does not exist, report that no swarm loop is currently active and stop.

2. From the state file, extract and display:
   - **Goal**: The objective being worked on
   - **Iteration**: Current iteration number
   - **Phase**: Current phase (initial, working, delivering, refining, rejected, complete)
   - **Autonomy Health**: `autonomy_health` field value
   - **Permission Failures**: Count of entries in `permission_failures` array
   - **Mode**: `<mode>` (profile)
   - **Compact Mode**: Whether `compact_on_iteration` is enabled
   - **Sentinel Timeout**: `sentinel_timeout` value in seconds

3. Call `TaskList` to get live task status. Display tasks grouped by status (in_progress, pending, completed) with their owners and any blocked-by dependencies.

4. If `.claude/swarm-loop.local.heartbeat.json` exists, read it and display:
   - **Last Heartbeat**: timestamp of last heartbeat
   - **Team Active**: `team_active` status from the heartbeat file

5. Read the last 50 lines of `.claude/swarm-loop.local.log.md` and display as **Recent Activity**.

6. If `.claude/swarm-loop.local.md` exists, read it and display the active configuration settings under **Config**.

Format all of this as a clean, readable dashboard.
