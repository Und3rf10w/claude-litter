---
description: Change the display color of an agent in a swarm team
argument-hint: <agent_name> <color>
---

# Swarm Color

Change the display color of an agent in a swarm team.

## Arguments

- `$1` - Agent name (required)
- `$2` - New color (required: blue, green, yellow, red, cyan, magenta, white)

## Instructions

Execute the following script using bash explicitly:

```bash
bash << 'SCRIPT_EOF'
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null

# Priority: env vars (teammates) > user vars (team-lead) > error
if [[ -n "$CLAUDE_CODE_TEAM_NAME" ]]; then
    TEAM="$CLAUDE_CODE_TEAM_NAME"
else
    TEAM="$(get_current_window_var 'swarm_team')"
fi

AGENT_NAME="$1"
NEW_COLOR="$2"

if [[ -z "$TEAM" ]]; then
    echo "Error: Cannot determine team. Run this command from a swarm window or set CLAUDE_CODE_TEAM_NAME" >&2
    exit 1
fi

if [[ -z "$AGENT_NAME" ]]; then
    echo "Error: Agent name required" >&2
    echo "Usage: /swarm-color <agent_name> <color>" >&2
    exit 1
fi

if [[ -z "$NEW_COLOR" ]]; then
    echo "Error: Color required" >&2
    echo "Usage: /swarm-color <agent_name> <color>" >&2
    echo "Valid colors: blue, green, yellow, red, cyan, magenta, white" >&2
    exit 1
fi

update_agent_color "$TEAM" "$AGENT_NAME" "$NEW_COLOR"
SCRIPT_EOF
```

After running, report:

1. The agent name whose color was updated
2. The new color value
3. Note that the change will be visible in future messages and spawns

## Examples

**Change agent color to green:**
```
/swarm-color backend-dev green
```

**Change team-lead color to cyan:**
```
/swarm-color team-lead cyan
```
