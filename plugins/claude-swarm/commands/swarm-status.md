---
description: Show status overview of a swarm team including members, tasks, and active sessions
argument-hint: <team_name>
---

# Swarm Status

Show status for a team.

## Arguments

- `$1` - Team name (required)

## Instructions

Execute the following script using bash explicitly:

```bash
bash << 'SCRIPT_EOF'
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null

if [[ -z "$1" ]]; then
    echo "Error: Team name required"
    echo "Usage: /swarm-status <team_name>"
    exit 1
fi

swarm_status "$1"
SCRIPT_EOF
```

Present the information clearly, highlighting:

1. Active vs inactive sessions
2. Open tasks that need attention
3. Any tasks that are blocked
4. Unread messages waiting for team-lead
