#!/bin/bash
# Module: 12-kitty-session.sh
# Description: Kitty session file generation
# Dependencies: 00-globals, 05-team
# Exports: generate_kitty_session, launch_kitty_session, save_kitty_session

[[ -n "${SWARM_KITTY_SESSION_LOADED}" ]] && return 0
SWARM_KITTY_SESSION_LOADED=1

if [[ -z "$TEAMS_DIR" ]]; then
    echo "Error: 00-globals.sh must be sourced first" >&2
    return 1
fi

generate_kitty_session() {
    local team_name="$1"
    local session_file="${TEAMS_DIR}/${team_name}/swarm.kitty-session"
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        echo -e "${RED}Team '${team_name}' not found${NC}"
        return 1
    fi

    # Get team-lead ID for InboxPoller activation
    local lead_id=$(jq -r '.leadAgentId // ""' "$config_file")

    # Get kitty socket for teammates to inherit
    local kitty_socket=$(find_kitty_socket)

    # Generate session file header
    command cat > "$session_file" << EOF
# Auto-generated swarm session for team: ${team_name}
# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Usage: kitty --session ${session_file}

layout splits
cd $(pwd)

EOF

    # Add launch commands for each member
    local first=true
    while IFS= read -r line; do
        local name=$(echo "$line" | cut -d'|' -f1)
        local id=$(echo "$line" | cut -d'|' -f2)
        local type=$(echo "$line" | cut -d'|' -f3)
        local model=$(echo "$line" | cut -d'|' -f4)
        local color=$(echo "$line" | cut -d'|' -f5)
        local swarm_var="swarm_${team_name}_${name}"

        if [[ "$first" == "true" ]]; then
            echo "# First window (${name})" >> "$session_file"
            echo "launch --title \"swarm-${team_name}-${name}\" --var \"${swarm_var}=true\" --var \"swarm_team=${team_name}\" --var \"swarm_agent=${name}\" --env CLAUDE_CODE_TEAM_NAME=${team_name} --env CLAUDE_CODE_AGENT_ID=${id} --env CLAUDE_CODE_AGENT_NAME=${name} --env CLAUDE_CODE_AGENT_TYPE=${type} --env CLAUDE_CODE_TEAM_LEAD_ID=${lead_id} --env CLAUDE_CODE_AGENT_COLOR=${color} --env KITTY_LISTEN_ON=${kitty_socket} claude --model ${model}" >> "$session_file"
            first=false
        else
            echo "" >> "$session_file"
            echo "# Split window (${name})" >> "$session_file"
            echo "launch --location=vsplit --title \"swarm-${team_name}-${name}\" --var \"${swarm_var}=true\" --var \"swarm_team=${team_name}\" --var \"swarm_agent=${name}\" --env CLAUDE_CODE_TEAM_NAME=${team_name} --env CLAUDE_CODE_AGENT_ID=${id} --env CLAUDE_CODE_AGENT_NAME=${name} --env CLAUDE_CODE_AGENT_TYPE=${type} --env CLAUDE_CODE_TEAM_LEAD_ID=${lead_id} --env CLAUDE_CODE_AGENT_COLOR=${color} --env KITTY_LISTEN_ON=${kitty_socket} claude --model ${model}" >> "$session_file"
        fi
    done < <(jq -r '.members[] | "\(.name)|\(.agentId)|\(.type)|\(.model // "sonnet")|\(.color // "blue")"' "$config_file")

    echo -e "${GREEN}Generated kitty session: ${session_file}${NC}"
    echo "$session_file"
}

launch_kitty_session() {
    local team_name="$1"
    local session_file="${TEAMS_DIR}/${team_name}/swarm.kitty-session"

    # Generate if doesn't exist
    if [[ ! -f "$session_file" ]]; then
        generate_kitty_session "$team_name"
    fi

    echo -e "${GREEN}Launching kitty with session: ${session_file}${NC}"
    kitty --session "$session_file" &
}

save_kitty_session() {
    local team_name="$1"
    local session_file="${TEAMS_DIR}/${team_name}/swarm.kitty-session"

    # This creates a session file from the current kitty state
    # Note: Requires the swarm windows to be the only ones, or manual cleanup
    echo -e "${YELLOW}Saving current kitty state to: ${session_file}${NC}"
    echo "Note: Use Ctrl+Shift+E in kitty, then type: save_as_session --relocatable ${session_file}"
}


# Export public API
export -f generate_kitty_session launch_kitty_session save_kitty_session
