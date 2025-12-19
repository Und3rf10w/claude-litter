---
description: Create a new swarm team with directories, config, and initialize the current session as team-lead
argument-hint: <team_name> [description] [--no-lead] [--lead-model <model>]
---

# Create Swarm Team

Create a new team called `$1`.

## Arguments

- `$1` - Team name (required)
- `$2` - Team description (optional)
- `--no-lead` - Don't auto-spawn team-lead window (optional)
- `--lead-model <model>` - Model for team-lead (haiku/sonnet/opus, default: sonnet)

## Instructions

Execute the following script using bash explicitly:

```bash
bash << 'SCRIPT_EOF'
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null

# Parse arguments
TEAM_NAME=""
DESCRIPTION=""
NO_LEAD="false"
LEAD_MODEL="sonnet"

# First two positional args
TEAM_NAME="$1"
DESCRIPTION="$2"
shift 2 2>/dev/null || shift $# 2>/dev/null

# Parse optional flags
while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-lead)
            NO_LEAD="true"
            shift
            ;;
        --lead-model)
            LEAD_MODEL="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

# Validate model
case "$LEAD_MODEL" in
    haiku|sonnet|opus) ;;
    *)
        echo "Error: Invalid model '$LEAD_MODEL'. Must be haiku, sonnet, or opus." >&2
        exit 1
        ;;
esac

# Create the team
if ! create_team "$TEAM_NAME" "$DESCRIPTION"; then
    exit 1
fi

# Auto-spawn team-lead unless --no-lead is specified
if [[ "$NO_LEAD" != "true" ]]; then
    echo ""
    echo "Spawning team-lead window..."

    # Use the team-lead system prompt from globals (includes skill loading instruction)
    LEAD_PROMPT="${SWARM_TEAM_LEAD_SYSTEM_PROMPT}"

    # Spawn team-lead with CLAUDE_CODE_IS_TEAM_LEAD environment variable and plugin directory
    if spawn_teammate "$TEAM_NAME" "team-lead" "team-lead" "$LEAD_MODEL" "$LEAD_PROMPT" "" "" "" "$CLAUDE_PLUGIN_ROOT" "CLAUDE_CODE_IS_TEAM_LEAD=true"; then
        # Update team config to mark that team-lead has been spawned
        config_file="${TEAMS_DIR}/${TEAM_NAME}/config.json"
        if [[ -f "$config_file" ]]; then
            acquire_file_lock "$config_file"
            tmp_file=$(mktemp)
            if jq '.hasSpawnedLead = true' "$config_file" > "$tmp_file" && mv "$tmp_file" "$config_file"; then
                release_file_lock
                echo ""
                echo "Team-lead spawned successfully"
            else
                rm -f "$tmp_file"
                release_file_lock
                echo "Warning: Failed to update hasSpawnedLead flag in config" >&2
            fi
        fi
    else
        echo "Warning: Failed to spawn team-lead window" >&2
    fi
else
    # Set user vars on current window so team-lead can check inbox
    if [[ "$SWARM_MULTIPLEXER" == "kitty" ]]; then
        set_current_window_vars "swarm_team=${TEAM_NAME}" "swarm_agent=team-lead"
    fi
fi
SCRIPT_EOF
```

After running, report:

1. Team name and location
2. Whether team-lead was auto-spawned or if current session is team-lead
3. If team-lead was spawned, mention the window/session was created
4. Next steps: create tasks with `/task-create` and spawn teammates with `/swarm-spawn`

## Examples

**Create team with auto-spawned team-lead:**
```
/swarm-create my-team "My awesome team"
```

**Create team without spawning team-lead:**
```
/swarm-create my-team "Development team" --no-lead
```

**Create team with haiku model for team-lead:**
```
/swarm-create my-team "Fast team" --lead-model haiku
```
