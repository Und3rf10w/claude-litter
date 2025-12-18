#!/bin/bash
# Module: 09-spawn.sh
# Description: Teammate spawning in kitty/tmux
# Dependencies: 00-globals, 01-utils, 03-multiplexer, 04-registry, 05-team, 06-status
# Exports: spawn_teammate, spawn_teammate_kitty, spawn_teammate_tmux, and variants

[[ -n "${SWARM_SPAWN_LOADED}" ]] && return 0
SWARM_SPAWN_LOADED=1

if [[ -z "$TEAMS_DIR" ]]; then
    echo "Error: 00-globals.sh must be sourced first" >&2
    return 1
fi

spawn_teammate_kitty_resume() {
    local team_name="$1"
    local agent_name="$2"
    local agent_type="$3"
    local model="$4"
    local initial_prompt="$5"

    # Validate model (prevent injection via model parameter)
    case "$model" in
        haiku|sonnet|opus) ;;
        *) model="sonnet" ;;
    esac

    # Get existing agent ID from config
    local config_file="${TEAMS_DIR}/${team_name}/config.json"
    local agent_id=$(jq -r --arg name "$agent_name" '.members[] | select(.name == $name) | .agentId' "$config_file")

    # Get team-lead ID and agent color for InboxPoller activation
    local lead_id=$(jq -r '.leadAgentId // ""' "$config_file")
    local agent_color=$(jq -r --arg name "$agent_name" '.members[] | select(.name == $name) | .color // "blue"' "$config_file")

    local swarm_var="swarm_${team_name}_${agent_name}"
    local window_title="swarm-${team_name}-${agent_name}"

    # Check if window already exists
    if kitten_cmd ls 2>/dev/null | jq -e --arg var "$swarm_var" '.[].tabs[].windows[] | select(.user_vars[$var] != null)' &>/dev/null; then
        echo -e "${YELLOW}    Window for '${agent_name}' already exists${NC}"
        update_member_status "$team_name" "$agent_name" "active"
        return 0
    fi

    # Determine launch type (default is split)
    local launch_type="window"
    local location_arg="--location=vsplit"
    case "$SWARM_KITTY_MODE" in
        tab) launch_type="tab"; location_arg="" ;;
        window|os-window) launch_type="os-window"; location_arg="" ;;
    esac

    # Get kitty socket for passing to teammate
    local kitty_socket=$(find_kitty_socket)

    # Launch with default allowed tools (comma-separated, quoted)
    # Pass initial_prompt as CLI argument - more reliable than send-text
    # Pass KITTY_LISTEN_ON so teammates can discover the socket
    # shellcheck disable=SC2086
    kitten_cmd launch --type="$launch_type" $location_arg \
        --cwd "$(pwd)" \
        --title "$window_title" \
        --var "${swarm_var}=true" \
        --var "swarm_team=${team_name}" \
        --var "swarm_agent=${agent_name}" \
        --env "CLAUDE_CODE_TEAM_NAME=${team_name}" \
        --env "CLAUDE_CODE_AGENT_ID=${agent_id}" \
        --env "CLAUDE_CODE_AGENT_NAME=${agent_name}" \
        --env "CLAUDE_CODE_AGENT_TYPE=${agent_type}" \
        --env "CLAUDE_CODE_TEAM_LEAD_ID=${lead_id}" \
        --env "CLAUDE_CODE_AGENT_COLOR=${agent_color}" \
        --env "KITTY_LISTEN_ON=${kitty_socket}" \
        claude --model "$model" --dangerously-skip-permissions \
        --append-system-prompt "$SWARM_TEAMMATE_SYSTEM_PROMPT" -- "$initial_prompt"

    # Wait for Claude Code to be ready, then register
    if wait_for_claude_ready "$swarm_var" 10; then
        if ! register_window "$team_name" "$agent_name" "$swarm_var"; then
            echo -e "${YELLOW}    Warning: Window spawned but registration failed${NC}" >&2
        fi
    else
        echo -e "${YELLOW}    Warning: Claude Code may not be fully initialized for ${agent_name}${NC}" >&2
    fi

    # Update status
    update_member_status "$team_name" "$agent_name" "active"

    echo -e "${GREEN}    Resumed: ${agent_name}${NC}"
}

spawn_teammate_tmux_resume() {
    local team_name="$1"
    local agent_name="$2"
    local agent_type="$3"
    local model="$4"
    local initial_prompt="$5"

    # Validate model (prevent injection via model parameter)
    case "$model" in
        haiku|sonnet|opus) ;;
        *) model="sonnet" ;;
    esac

    # Get existing agent ID from config
    local config_file="${TEAMS_DIR}/${team_name}/config.json"
    local agent_id=$(jq -r --arg name "$agent_name" '.members[] | select(.name == $name) | .agentId' "$config_file")

    # Get team-lead ID and agent color for InboxPoller activation
    local lead_id=$(jq -r '.leadAgentId // ""' "$config_file")
    local agent_color=$(jq -r --arg name "$agent_name" '.members[] | select(.name == $name) | .color // "blue"' "$config_file")

    # Sanitize session name (tmux doesn't allow certain characters)
    local safe_team="${team_name//[^a-zA-Z0-9_-]/_}"
    local safe_agent="${agent_name//[^a-zA-Z0-9_-]/_}"
    local session_name="swarm-${safe_team}-${safe_agent}"

    # Check if session exists
    if tmux has-session -t "$session_name" 2>/dev/null; then
        echo -e "${YELLOW}    Session '${session_name}' already exists${NC}"
        update_member_status "$team_name" "$agent_name" "active"
        return 0
    fi

    # Create session with default shell first (avoid command injection)
    # Use -c to inherit current working directory
    tmux new-session -d -s "$session_name" -c "$(pwd)"

    # Safely escape variables using printf %q
    local safe_team_val=$(printf %q "$team_name")
    local safe_id_val=$(printf %q "$agent_id")
    local safe_name_val=$(printf %q "$agent_name")
    local safe_type_val=$(printf %q "$agent_type")
    local safe_lead_id=$(printf %q "$lead_id")
    local safe_agent_color=$(printf %q "$agent_color")
    local safe_prompt=$(printf %q "$initial_prompt")
    local safe_system_prompt=$(printf %q "$SWARM_TEAMMATE_SYSTEM_PROMPT")

    # Set environment variables and launch claude with prompt as CLI argument
    # Pass initial_prompt as CLI argument - more reliable than send-keys
    tmux send-keys -t "$session_name" "export CLAUDE_CODE_TEAM_NAME=$safe_team_val CLAUDE_CODE_AGENT_ID=$safe_id_val CLAUDE_CODE_AGENT_NAME=$safe_name_val CLAUDE_CODE_AGENT_TYPE=$safe_type_val CLAUDE_CODE_TEAM_LEAD_ID=$safe_lead_id CLAUDE_CODE_AGENT_COLOR=$safe_agent_color && claude --model $model --dangerously-skip-permissions --append-system-prompt $safe_system_prompt -- $safe_prompt" Enter

    # Update status
    update_member_status "$team_name" "$agent_name" "active"

    echo -e "${GREEN}    Resumed: ${agent_name}${NC}"
}

# ============================================

spawn_teammate_tmux() {
    local team_name="$1"
    local agent_name="$2"
    local agent_type="${3:-worker}"
    local model="${4:-sonnet}"
    local initial_prompt="${5:-}"

    # Validate names
    validate_name "$team_name" "team" || return 1
    validate_name "$agent_name" "agent" || return 1

    # Validate model (prevent injection via model parameter)
    case "$model" in
        haiku|sonnet|opus) ;;
        *) model="sonnet" ;;
    esac

    # Acquire spawn lock to prevent TOCTOU race (check-then-spawn)
    local spawn_lock="${TEAMS_DIR}/${team_name}/.spawn.lock"
    if ! acquire_file_lock "$spawn_lock" 10 60; then
        echo -e "${RED}Failed to acquire spawn lock (another spawn in progress?)${NC}" >&2
        return 1
    fi

    # Sanitize session name (tmux doesn't allow certain characters)
    local safe_team="${team_name//[^a-zA-Z0-9_-]/_}"
    local safe_agent="${agent_name//[^a-zA-Z0-9_-]/_}"
    local session_name="swarm-${safe_team}-${safe_agent}"

    # Check if session exists (now protected by lock)
    if tmux has-session -t "$session_name" 2>/dev/null; then
        release_file_lock
        echo -e "${YELLOW}Session '${session_name}' already exists${NC}"
        return 1
    fi

    # Generate UUID for agent
    local agent_id=$(generate_uuid)

    # Add to team config (include model for resume capability)
    # Note: add_member uses its own lock on config file - this is safe since spawn lock is different
    if ! add_member "$team_name" "$agent_id" "$agent_name" "$agent_type" "blue" "$model"; then
        release_file_lock
        echo -e "${RED}Failed to add member to team config${NC}" >&2
        return 1
    fi

    # Get team-lead ID and agent color for InboxPoller activation
    local config_file="${TEAMS_DIR}/${team_name}/config.json"
    local lead_id=$(jq -r '.leadAgentId // ""' "$config_file")
    local agent_color=$(jq -r --arg name "$agent_name" '.members[] | select(.name == $name) | .color // "blue"' "$config_file")

    # Default prompt if not provided
    if [[ -z "$initial_prompt" ]]; then
        initial_prompt="You are ${agent_name} in team '${team_name}'. Check your mailbox at ~/.claude/teams/${team_name}/inboxes/${agent_name}.json for messages. Send updates to team-lead when tasks complete. Use /swarm-inbox to check for new messages."
    fi

    # Create session with default shell first (avoid command injection)
    # Use -c to inherit current working directory
    tmux new-session -d -s "$session_name" -c "$(pwd)"

    # Safely escape variables using printf %q
    local safe_team_val=$(printf %q "$team_name")
    local safe_id_val=$(printf %q "$agent_id")
    local safe_name_val=$(printf %q "$agent_name")
    local safe_type_val=$(printf %q "$agent_type")
    local safe_lead_id=$(printf %q "$lead_id")
    local safe_agent_color=$(printf %q "$agent_color")
    local safe_system_prompt=$(printf %q "$SWARM_TEAMMATE_SYSTEM_PROMPT")

    # Set environment variables in the session
    tmux send-keys -t "$session_name" "export CLAUDE_CODE_TEAM_NAME=$safe_team_val CLAUDE_CODE_AGENT_ID=$safe_id_val CLAUDE_CODE_AGENT_NAME=$safe_name_val CLAUDE_CODE_AGENT_TYPE=$safe_type_val CLAUDE_CODE_TEAM_LEAD_ID=$safe_lead_id CLAUDE_CODE_AGENT_COLOR=$safe_agent_color" Enter

    # Write prompt to temporary file for safer passing (defense-in-depth against command injection)
    local prompt_file=$(mktemp)
    echo "$initial_prompt" > "$prompt_file"

    # Launch claude with prompt from file (safer than command line argument)
    tmux send-keys -t "$session_name" "claude --model $model --dangerously-skip-permissions --append-system-prompt $safe_system_prompt < $prompt_file; rm -f $prompt_file" Enter

    # Release spawn lock now that session is created
    release_file_lock

    echo -e "${GREEN}Spawned teammate '${agent_name}' in tmux session '${session_name}'${NC}"
    echo "  Agent ID: ${agent_id}"
    echo "  Model: ${model}"
    echo "  Attach with: tmux attach -t ${session_name}"
}

list_swarm_sessions_tmux() {
    local team_name="$1"

    echo "Tmux sessions for team '${team_name}':"
    echo "----------------------------------------"
    tmux list-sessions 2>/dev/null | grep "swarm-${team_name}" || echo "No active sessions"
}

kill_swarm_session_tmux() {
    local team_name="$1"
    local agent_name="$2"
    local session_name="swarm-${team_name}-${agent_name}"

    if tmux has-session -t "$session_name" 2>/dev/null; then
        tmux kill-session -t "$session_name"
        echo -e "${GREEN}Killed tmux session '${session_name}'${NC}"
    else
        echo -e "${YELLOW}Session '${session_name}' not found${NC}"
    fi
}

# ============================================
# KITTY SESSION MANAGEMENT
# ============================================

spawn_teammate_kitty() {
    local team_name="$1"
    local agent_name="$2"
    local agent_type="${3:-worker}"
    local model="${4:-sonnet}"
    local initial_prompt="${5:-}"

    # Validate names
    validate_name "$team_name" "team" || return 1
    validate_name "$agent_name" "agent" || return 1

    # Validate model (prevent injection via model parameter)
    case "$model" in
        haiku|sonnet|opus) ;;
        *) model="sonnet" ;;
    esac

    # Acquire spawn lock to prevent TOCTOU race (check-then-spawn)
    local spawn_lock="${TEAMS_DIR}/${team_name}/.spawn.lock"
    if ! acquire_file_lock "$spawn_lock" 10 60; then
        echo -e "${RED}Failed to acquire spawn lock (another spawn in progress?)${NC}" >&2
        return 1
    fi

    # Use user variable for identification (persists even if title changes)
    local swarm_var="swarm_${team_name}_${agent_name}"
    local window_title="swarm-${team_name}-${agent_name}"

    # Check if window already exists using user variable (now protected by lock)
    if kitten_cmd ls 2>/dev/null | jq -e --arg var "$swarm_var" '.[].tabs[].windows[] | select(.user_vars[$var] != null)' &>/dev/null; then
        release_file_lock
        echo -e "${YELLOW}Kitty window for '${agent_name}' already exists${NC}"
        return 1
    fi

    # Generate UUID for agent
    local agent_id=$(generate_uuid)

    # Add to team config (include model for resume capability)
    # Note: add_member uses its own lock on config file - this is safe since spawn lock is different
    if ! add_member "$team_name" "$agent_id" "$agent_name" "$agent_type" "blue" "$model"; then
        release_file_lock
        echo -e "${RED}Failed to add member to team config${NC}" >&2
        return 1
    fi

    # Get team-lead ID and agent color for InboxPoller activation
    local config_file="${TEAMS_DIR}/${team_name}/config.json"
    local lead_id=$(jq -r '.leadAgentId // ""' "$config_file")
    local agent_color=$(jq -r --arg name "$agent_name" '.members[] | select(.name == $name) | .color // "blue"' "$config_file")

    # Default prompt if not provided
    if [[ -z "$initial_prompt" ]]; then
        initial_prompt="You are ${agent_name} in team '${team_name}'. Check your mailbox at ~/.claude/teams/${team_name}/inboxes/${agent_name}.json for messages. Send updates to team-lead when tasks complete. Use /swarm-inbox to check for new messages."
    fi

    # Determine launch type based on SWARM_KITTY_MODE
    # Note: kitty types are: os-window (new OS window), tab, window (pane/split)
    # Default is split (vertical split in current window)
    local launch_type="window"
    local location_arg="--location=vsplit"
    case "$SWARM_KITTY_MODE" in
        tab)
            launch_type="tab"
            location_arg=""
            ;;
        window|os-window)
            launch_type="os-window"
            location_arg=""
            ;;
        split|*)
            launch_type="window"
            location_arg="--location=vsplit"
            ;;
    esac

    # Get kitty socket for passing to teammate
    local kitty_socket=$(find_kitty_socket)

    # Launch new kitty window/tab with env vars AND user variable for identification
    # --var sets a persistent user variable that survives title changes
    # Pass initial_prompt as CLI argument - more reliable than send-text
    # Pass KITTY_LISTEN_ON so teammates can discover the socket
    # shellcheck disable=SC2086
    kitten_cmd launch --type="$launch_type" $location_arg \
        --cwd "$(pwd)" \
        --title "$window_title" \
        --var "${swarm_var}=true" \
        --var "swarm_team=${team_name}" \
        --var "swarm_agent=${agent_name}" \
        --env "CLAUDE_CODE_TEAM_NAME=${team_name}" \
        --env "CLAUDE_CODE_AGENT_ID=${agent_id}" \
        --env "CLAUDE_CODE_AGENT_NAME=${agent_name}" \
        --env "CLAUDE_CODE_AGENT_TYPE=${agent_type}" \
        --env "CLAUDE_CODE_TEAM_LEAD_ID=${lead_id}" \
        --env "CLAUDE_CODE_AGENT_COLOR=${agent_color}" \
        --env "KITTY_LISTEN_ON=${kitty_socket}" \
        claude --model "$model" --dangerously-skip-permissions \
        --append-system-prompt "$SWARM_TEAMMATE_SYSTEM_PROMPT" -- "$initial_prompt"

    # Wait for Claude Code to be ready, then register
    if wait_for_claude_ready "$swarm_var" 10; then
        if ! register_window "$team_name" "$agent_name" "$swarm_var"; then
            echo -e "${YELLOW}Warning: Window spawned but registration failed${NC}" >&2
        fi
    else
        echo -e "${YELLOW}Warning: Claude Code may not be fully initialized for ${agent_name}${NC}" >&2
    fi

    # Release spawn lock now that window is launched
    release_file_lock

    echo -e "${GREEN}Spawned teammate '${agent_name}' in kitty ${launch_type}${NC}"
    echo "  Agent ID: ${agent_id}"
    echo "  Model: ${model}"
    echo "  Mode: ${SWARM_KITTY_MODE:-split}"
    echo "  Match with: var:${swarm_var}"
}

list_swarm_sessions_kitty() {
    local team_name="$1"

    echo "Kitty windows for team '${team_name}':"
    echo "----------------------------------------"
    # Match using user variable swarm_team instead of title
    kitten_cmd ls 2>/dev/null | jq -r --arg team "$team_name" \
        '.[].tabs[].windows[] | select(.user_vars.swarm_team == $team) | "  - \(.user_vars.swarm_agent) (id: \(.id))"' 2>/dev/null || echo "No active windows"
}

kill_swarm_session_kitty() {
    local team_name="$1"
    local agent_name="$2"
    local swarm_var="swarm_${team_name}_${agent_name}"

    # Use user variable match for reliable identification
    if kitten_cmd close-window --match "var:${swarm_var}" 2>/dev/null; then
        echo -e "${GREEN}Closed kitty window for '${agent_name}'${NC}"
    else
        echo -e "${YELLOW}Window for '${agent_name}' not found${NC}"
    fi
}

spawn_teammate() {
    case "$SWARM_MULTIPLEXER" in
        kitty)
            spawn_teammate_kitty "$@"
            ;;
        tmux)
            spawn_teammate_tmux "$@"
            ;;
        *)
            echo -e "${RED}No multiplexer available. Install tmux or use kitty terminal.${NC}"
            echo "Set SWARM_MULTIPLEXER=tmux or SWARM_MULTIPLEXER=kitty to override detection."
            return 1
            ;;
    esac
}

list_swarm_sessions() {
    case "$SWARM_MULTIPLEXER" in
        kitty)
            list_swarm_sessions_kitty "$@"
            ;;
        tmux)
            list_swarm_sessions_tmux "$@"
            ;;
        *)
            echo -e "${YELLOW}No multiplexer detected${NC}"
            ;;
    esac
}

kill_swarm_session() {
    case "$SWARM_MULTIPLEXER" in
        kitty)
            kill_swarm_session_kitty "$@"
            ;;
        tmux)
            kill_swarm_session_tmux "$@"
            ;;
        *)
            echo -e "${YELLOW}No multiplexer detected${NC}"
            ;;
    esac
}


# Export public API
export -f spawn_teammate_kitty_resume spawn_teammate_tmux_resume spawn_teammate_tmux spawn_teammate_kitty list_swarm_sessions_kitty list_swarm_sessions_tmux kill_swarm_session_kitty kill_swarm_session_tmux spawn_teammate list_swarm_sessions kill_swarm_session
