#!/bin/bash
# Module: 14-in-process.sh
# Description: In-process teammate spawning using Claude Code Task tool
# Dependencies: 00-globals, 01-utils, 05-team, 06-status
# Exports: spawn_teammate_in_process, list_in_process_teammates, kill_in_process_teammate

[[ -n "${SWARM_IN_PROCESS_LOADED}" ]] && return 0
SWARM_IN_PROCESS_LOADED=1

if [[ -z "$TEAMS_DIR" ]]; then
    echo "Error: 00-globals.sh must be sourced first" >&2
    return 1
fi

# In-process teammates directory (stores task output file paths)
IN_PROCESS_DIR="${CLAUDE_HOME}/in-process"

# ============================================
# IN-PROCESS TEAMMATE SPAWNING
# ============================================

# Spawn a teammate using Claude Code's Task tool with run_in_background
# This creates a background subagent that communicates via the file-based inbox
spawn_teammate_in_process() {
    local team_name="$1"
    local agent_name="$2"
    local agent_type="${3:-worker}"
    local model="${4:-sonnet}"
    local initial_prompt="${5:-}"
    local permission_mode="${6:-}"
    local plan_mode="${7:-}"
    local allowed_tools="${8:-}"
    local plugin_dir="${9:-}"
    shift 9 2>/dev/null || true
    local custom_env_vars=("$@")

    # Validate names
    validate_name "$team_name" "team" || return 1
    validate_name "$agent_name" "agent" || return 1

    # Validate model
    case "$model" in
        haiku|sonnet|opus) ;;
        *) model="sonnet" ;;
    esac

    local config_file="${TEAMS_DIR}/${team_name}/config.json"
    local agent_id
    local lead_id

    # Generate or get agent ID
    if [[ "$agent_name" == "team-lead" ]]; then
        agent_id=$(jq -r '.leadAgentId // ""' "$config_file")
        lead_id="$agent_id"
        if [[ -z "$agent_id" ]]; then
            echo -e "${RED}No leadAgentId found in team config${NC}" >&2
            return 1
        fi
        # Update existing team-lead member status
        if ! acquire_file_lock "$config_file"; then
            echo -e "${RED}Failed to acquire lock for team config${NC}" >&2
            return 1
        fi
        local tmp_file=$(mktemp)
        if [[ -z "$tmp_file" ]]; then
            release_file_lock
            echo -e "${RED}Failed to create temp file${NC}" >&2
            return 1
        fi
        trap "rm -f '$tmp_file'" INT TERM
        if jq --arg model "$model" '.members = [.members[] | if .name == "team-lead" then .model = $model | .status = "active" else . end]' \
           "$config_file" > "$tmp_file" && mv "$tmp_file" "$config_file"; then
            trap - INT TERM
            release_file_lock
            echo -e "${GREEN}Updated 'team-lead' in team '${team_name}'${NC}"
        else
            trap - INT TERM
            command rm -f "$tmp_file"
            release_file_lock
        fi
    else
        agent_id=$(generate_uuid)
        lead_id=$(jq -r '.leadAgentId // ""' "$config_file")
        if ! add_member "$team_name" "$agent_id" "$agent_name" "$agent_type" "blue" "$model"; then
            echo -e "${RED}Failed to add member to team config${NC}" >&2
            return 1
        fi
    fi

    # Get agent color
    local agent_color=$(jq -r --arg name "$agent_name" '.members[] | select(.name == $name) | .color // "blue"' "$config_file")

    # Default prompt if not provided
    if [[ -z "$initial_prompt" ]]; then
        initial_prompt="You are ${agent_name} in team '${team_name}'. Check your mailbox at ~/.claude/teams/${team_name}/inboxes/${agent_name}.json for messages. Send updates to team-lead when tasks complete. Use /claude-swarm:swarm-inbox to check for new messages."
    fi

    # Determine system prompt
    local system_prompt="$SWARM_TEAMMATE_SYSTEM_PROMPT"
    if [[ "$agent_name" == "team-lead" ]]; then
        system_prompt="$SWARM_TEAM_LEAD_SYSTEM_PROMPT"
    fi

    # Create in-process tracking directory
    mkdir -p "$IN_PROCESS_DIR"
    local tracking_file="${IN_PROCESS_DIR}/${team_name}-${agent_name}.json"

    # Build the full prompt with team context
    local full_prompt="# In-Process Teammate: ${agent_name}

## Team Context
- Team: ${team_name}
- Agent ID: ${agent_id}
- Agent Name: ${agent_name}
- Agent Type: ${agent_type}
- Team Lead ID: ${lead_id}

## Environment
Set these conceptually (you are running in-process, not in a separate terminal):
- CLAUDE_CODE_TEAM_NAME=${team_name}
- CLAUDE_CODE_AGENT_ID=${agent_id}
- CLAUDE_CODE_AGENT_NAME=${agent_name}
- CLAUDE_CODE_AGENT_TYPE=${agent_type}
- CLAUDE_CODE_TEAM_LEAD_ID=${lead_id}

## System Guidance
${system_prompt}

## Initial Task
${initial_prompt}

## Important
- You are running as an in-process teammate (background subagent)
- Use the file-based inbox at ~/.claude/teams/${team_name}/inboxes/${agent_name}.json
- Check inbox regularly with /claude-swarm:swarm-inbox
- Communicate via /claude-swarm:swarm-message
- Update task status via /claude-swarm:task-update"

    # Store tracking info (use jq to properly escape values and prevent JSON injection)
    if ! jq -n \
        --arg team_name "$team_name" \
        --arg agent_name "$agent_name" \
        --arg agent_id "$agent_id" \
        --arg agent_type "$agent_type" \
        --arg model "$model" \
        --arg started_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{
            team_name: $team_name,
            agent_name: $agent_name,
            agent_id: $agent_id,
            agent_type: $agent_type,
            model: $model,
            status: "pending",
            started_at: $started_at,
            mode: "in-process"
        }' > "$tracking_file"; then
        echo -e "${RED}Failed to create tracking file${NC}" >&2
        return 1
    fi

    echo -e "${GREEN}Prepared in-process teammate '${agent_name}' for team '${team_name}'${NC}"
    echo "  Agent ID: ${agent_id}"
    echo "  Model: ${model}"
    echo "  Mode: in-process (background subagent)"
    echo ""
    echo -e "${YELLOW}To spawn this teammate, use the Task tool:${NC}"
    echo ""
    echo "Task tool parameters:"
    echo "  subagent_type: general-purpose"
    echo "  model: ${model}"
    echo "  run_in_background: true"
    echo "  description: ${agent_name} - ${team_name}"
    echo ""
    echo "Prompt (stored in tracking file):"
    echo "  ${tracking_file}"
    echo ""
    echo -e "${CYAN}Note: In-process teammates run as background subagents.${NC}"
    echo -e "${CYAN}They use the same file-based inbox as terminal teammates.${NC}"

    # Update member status
    update_member_status "$team_name" "$agent_name" "active"

    return 0
}

# List in-process teammates for a team
list_in_process_teammates() {
    local team_name="$1"

    echo "In-process teammates for team '${team_name}':"
    echo "----------------------------------------"

    if [[ ! -d "$IN_PROCESS_DIR" ]]; then
        echo "No in-process teammates found"
        return 0
    fi

    local found=0
    for tracking_file in "${IN_PROCESS_DIR}/${team_name}-"*.json; do
        if [[ -f "$tracking_file" ]]; then
            local agent_name=$(jq -r '.agent_name' "$tracking_file")
            local status=$(jq -r '.status' "$tracking_file")
            local started=$(jq -r '.started_at' "$tracking_file")
            echo "  - ${agent_name} (status: ${status}, started: ${started})"
            found=1
        fi
    done

    if [[ $found -eq 0 ]]; then
        echo "No in-process teammates found"
    fi
}

# Kill/cleanup an in-process teammate
kill_in_process_teammate() {
    local team_name="$1"
    local agent_name="$2"

    local tracking_file="${IN_PROCESS_DIR}/${team_name}-${agent_name}.json"

    if [[ -f "$tracking_file" ]]; then
        rm -f "$tracking_file"
        echo -e "${GREEN}Removed in-process tracking for '${agent_name}'${NC}"
    else
        echo -e "${YELLOW}No in-process tracking found for '${agent_name}'${NC}"
    fi
}

# Export public API
export -f spawn_teammate_in_process list_in_process_teammates kill_in_process_teammate
export IN_PROCESS_DIR
