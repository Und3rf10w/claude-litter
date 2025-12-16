#!/bin/bash
# PostToolUse:ExitPlanMode hook: Handle swarm launch from plan mode
# When ExitPlanMode is called with launchSwarm=true, this provides guidance

# Read tool result from stdin
TOOL_RESULT=$(cat)

# Check if this was a swarm launch request
# The tool result will include launchSwarm info if requested
if echo "$TOOL_RESULT" | grep -q '"launchSwarm":\s*true'; then
    teammate_count=$(echo "$TOOL_RESULT" | grep -oP '"teammateCount":\s*\K\d+' || echo "3")

    echo "<system-reminder>
# Swarm Launch Detected

The user approved plan mode with swarm launch (${teammate_count} teammates requested).

Use the swarm-coordinator agent or these commands:
1. \`/swarm-create <team-name>\` - Create the team
2. \`/task-create <subject>\` - Create tasks from the plan
3. \`/swarm-spawn <name> <type>\` - Spawn ${teammate_count} teammates
4. \`/task-update <id> --assign <name>\` - Assign tasks

Or simply describe the task to the swarm-coordinator agent for automated orchestration.
</system-reminder>"
fi

exit 0
