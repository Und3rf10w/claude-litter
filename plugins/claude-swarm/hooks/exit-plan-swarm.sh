#!/bin/bash
# PostToolUse:ExitPlanMode hook: Handle swarm launch from plan mode
# When ExitPlanMode is called with launchSwarm=true, this provides guidance

# Read tool result from stdin
TOOL_RESULT=$(cat)

# Check if this was a swarm launch request
# The tool result will include launchSwarm info if requested
if echo "$TOOL_RESULT" | grep -q '"launchSwarm".*true'; then
    # Use sed for portability (grep -oP is GNU-only, fails on macOS)
    teammate_count=$(echo "$TOOL_RESULT" | sed -n 's/.*"teammateCount":[[:space:]]*\([0-9]*\).*/\1/p')
    if [[ -z "$teammate_count" ]]; then
        echo "Note: Could not detect teammate count from plan, defaulting to 3" >&2
        teammate_count=3
    fi

    echo "<system-reminder>
# Swarm Launch Detected

The user approved plan mode with swarm launch (${teammate_count} teammates requested).

## Orchestration Options

**Delegation Mode (Recommended):**
1. \`/swarm-create <team-name>\` - Creates team and auto-spawns team-lead
2. \`/task-create <subject>\` - Create high-level tasks
3. \`/swarm-message team-lead \"<brief>\"\` - Brief team-lead with requirements
4. Team-lead handles spawning ${teammate_count} workers and coordination
5. Monitor with \`/swarm-status\` and \`/swarm-inbox\`

**Direct Mode (--no-lead):**
1. \`/swarm-create <team-name> --no-lead\` - Creates team without team-lead
2. \`/task-create <subject>\` - Create tasks from the plan
3. \`/swarm-spawn <name> <type>\` - Spawn ${teammate_count} teammates yourself
4. \`/task-update <id> --assign <name>\` - Assign tasks yourself
5. You coordinate everything directly

Claude Code will invoke the swarm-orchestration skill automatically for guidance.
</system-reminder>"
fi

exit 0
