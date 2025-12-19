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
    local permission_mode="${6:-}"
    local plan_mode="${7:-}"
    local allowed_tools="${8:-}"
    local plugin_dir="${9:-}"
    shift 9 2>/dev/null || true
    # Remaining arguments are custom environment variables in KEY=VALUE format
    local custom_env_vars=("$@")

    # Validate names
    validate_name "$team_name" "team" || return 1
    validate_name "$agent_name" "agent" || return 1

    # Validate model (prevent injection via model parameter)
    case "$model" in
        haiku|sonnet|opus) ;;
        *) model="sonnet" ;;
    esac

    # Sanitize session name (tmux doesn't allow certain characters)
    local safe_team="${team_name//[^a-zA-Z0-9_-]/_}"
    local safe_agent="${agent_name//[^a-zA-Z0-9_-]/_}"
    local session_name="swarm-${safe_team}-${safe_agent}"

    # Check if session already exists
    if tmux has-session -t "$session_name" 2>/dev/null; then
        echo -e "${YELLOW}Session '${session_name}' already exists${NC}"
        return 1
    fi

    local config_file="${TEAMS_DIR}/${team_name}/config.json"
    local agent_id
    local lead_id

    # If spawning team-lead, use existing leadAgentId from config (created by create_team)
    if [[ "$agent_name" == "team-lead" ]]; then
        agent_id=$(jq -r '.leadAgentId // ""' "$config_file")
        lead_id="$agent_id"
        if [[ -z "$agent_id" ]]; then
            echo -e "${RED}No leadAgentId found in team config${NC}" >&2
            return 1
        fi
        # Update existing team-lead member status instead of adding duplicate
        local tmp_file=$(mktemp)
        if jq --arg model "$model" '.members = [.members[] | if .name == "team-lead" then .model = $model | .status = "active" else . end]' \
           "$config_file" > "$tmp_file" && mv "$tmp_file" "$config_file"; then
            echo -e "${GREEN}Updated 'team-lead' in team '${team_name}'${NC}"
        fi
    else
        # Generate UUID for non-team-lead agents
        agent_id=$(generate_uuid)
        lead_id=$(jq -r '.leadAgentId // ""' "$config_file")
        # Add to team config (include model for resume capability)
        if ! add_member "$team_name" "$agent_id" "$agent_name" "$agent_type" "blue" "$model"; then
            echo -e "${RED}Failed to add member to team config${NC}" >&2
            return 1
        fi
    fi

    # Get agent color for InboxPoller activation
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

    # Build custom environment variable exports
    local custom_env_exports=""
    for env_var in "${custom_env_vars[@]}"; do
        if [[ "$env_var" =~ ^[A-Za-z_][A-Za-z0-9_]*=.* ]]; then
            local key="${env_var%%=*}"
            local value="${env_var#*=}"
            local safe_value=$(printf %q "$value")
            custom_env_exports+=" ${key}=${safe_value}"
        fi
    done

    # Set environment variables in the session
    tmux send-keys -t "$session_name" "export CLAUDE_CODE_TEAM_NAME=$safe_team_val CLAUDE_CODE_AGENT_ID=$safe_id_val CLAUDE_CODE_AGENT_NAME=$safe_name_val CLAUDE_CODE_AGENT_TYPE=$safe_type_val CLAUDE_CODE_TEAM_LEAD_ID=$safe_lead_id CLAUDE_CODE_AGENT_COLOR=$safe_agent_color${custom_env_exports}" Enter

    # Build Claude Code permission arguments
    local claude_cmd="claude --model $model"

    # Add permission mode flags
    if [[ -n "$permission_mode" ]]; then
        case "$permission_mode" in
            skip|dangerously-skip-permissions)
                claude_cmd+=" --dangerously-skip-permissions"
                ;;
            ask|ask-always)
                # Default behavior, no flag needed
                ;;
        esac
    else
        # Default to skip permissions for swarm teammates
        claude_cmd+=" --dangerously-skip-permissions"
    fi

    # Add plan mode flag (uses permission-mode plan)
    if [[ "$plan_mode" == "true" || "$plan_mode" == "enable" ]]; then
        claude_cmd+=" --permission-mode plan"
    fi

    # Add allowed tools (safely escape)
    if [[ -n "$allowed_tools" ]]; then
        local safe_allowed_tools=$(printf %q "$allowed_tools")
        claude_cmd+=" --allowed-tools $safe_allowed_tools"
    fi

    # Add plugin directory (safely escape)
    if [[ -n "$plugin_dir" ]]; then
        local safe_plugin_dir=$(printf %q "$plugin_dir")
        claude_cmd+=" --plugin-dir $safe_plugin_dir"
    fi

    # Add system prompt
    claude_cmd+=" --append-system-prompt $safe_system_prompt"

    # Write prompt to temporary file for safer passing (defense-in-depth against command injection)
    local prompt_file=$(mktemp)
    echo "$initial_prompt" > "$prompt_file"

    # Launch claude with prompt from file (safer than command line argument)
    tmux send-keys -t "$session_name" "$claude_cmd < $prompt_file; rm -f $prompt_file" Enter

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
    local permission_mode="${6:-}"
    local plan_mode="${7:-}"
    local allowed_tools="${8:-}"
    local plugin_dir="${9:-}"
    shift 9 2>/dev/null || true
    # Remaining arguments are custom environment variables in KEY=VALUE format
    local custom_env_vars=("$@")

    # Validate names
    validate_name "$team_name" "team" || return 1
    validate_name "$agent_name" "agent" || return 1

    # Validate model (prevent injection via model parameter)
    case "$model" in
        haiku|sonnet|opus) ;;
        *) model="sonnet" ;;
    esac

    # Use user variable for identification (persists even if title changes)
    local swarm_var="swarm_${team_name}_${agent_name}"
    local window_title="swarm-${team_name}-${agent_name}"

    # Check if window already exists using user variable
    if kitten_cmd ls 2>/dev/null | jq -e --arg var "$swarm_var" '.[].tabs[].windows[] | select(.user_vars[$var] != null)' &>/dev/null; then
        echo -e "${YELLOW}Kitty window for '${agent_name}' already exists${NC}"
        return 1
    fi

    local config_file="${TEAMS_DIR}/${team_name}/config.json"
    local agent_id
    local lead_id

    # If spawning team-lead, use existing leadAgentId from config (created by create_team)
    if [[ "$agent_name" == "team-lead" ]]; then
        agent_id=$(jq -r '.leadAgentId // ""' "$config_file")
        lead_id="$agent_id"
        if [[ -z "$agent_id" ]]; then
            echo -e "${RED}No leadAgentId found in team config${NC}" >&2
            return 1
        fi
        # Update existing team-lead member status instead of adding duplicate
        local tmp_file=$(mktemp)
        if jq --arg model "$model" '.members = [.members[] | if .name == "team-lead" then .model = $model | .status = "active" else . end]' \
           "$config_file" > "$tmp_file" && mv "$tmp_file" "$config_file"; then
            echo -e "${GREEN}Updated 'team-lead' in team '${team_name}'${NC}"
        fi
    else
        # Generate UUID for non-team-lead agents
        agent_id=$(generate_uuid)
        lead_id=$(jq -r '.leadAgentId // ""' "$config_file")
        # Add to team config (include model for resume capability)
        if ! add_member "$team_name" "$agent_id" "$agent_name" "$agent_type" "blue" "$model"; then
            echo -e "${RED}Failed to add member to team config${NC}" >&2
            return 1
        fi
    fi

    # Get agent color for InboxPoller activation
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

    # Build custom environment variable arguments for kitty launch
    local custom_env_args=()
    for env_var in "${custom_env_vars[@]}"; do
        if [[ "$env_var" =~ ^[A-Za-z_][A-Za-z0-9_]*=.* ]]; then
            custom_env_args+=("--env" "$env_var")
        fi
    done

    # Build Claude Code permission arguments
    local claude_args=("--model" "$model")

    # Add permission mode flags
    if [[ -n "$permission_mode" ]]; then
        case "$permission_mode" in
            skip|dangerously-skip-permissions)
                claude_args+=("--dangerously-skip-permissions")
                ;;
            ask|ask-always)
                # Default behavior, no flag needed
                ;;
            *)
                echo -e "${YELLOW}Warning: Unknown permission mode '${permission_mode}', using default${NC}" >&2
                ;;
        esac
    else
        # Default to skip permissions for swarm teammates
        claude_args+=("--dangerously-skip-permissions")
    fi

    # Add plan mode flag (uses permission-mode plan)
    if [[ "$plan_mode" == "true" || "$plan_mode" == "enable" ]]; then
        claude_args+=("--permission-mode" "plan")
    fi

    # Add allowed tools
    if [[ -n "$allowed_tools" ]]; then
        claude_args+=("--allowed-tools" "$allowed_tools")
    fi

    # Add plugin directory
    if [[ -n "$plugin_dir" ]]; then
        claude_args+=("--plugin-dir" "$plugin_dir")
    fi

    # Add system prompt
    claude_args+=("--append-system-prompt" "$SWARM_TEAMMATE_SYSTEM_PROMPT")

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
        "${custom_env_args[@]}" \
        claude "${claude_args[@]}" -- "$initial_prompt"

    # Wait for Claude Code to be ready, then register
    if wait_for_claude_ready "$swarm_var" 10; then
        if ! register_window "$team_name" "$agent_name" "$swarm_var"; then
            echo -e "${YELLOW}Warning: Window spawned but registration failed${NC}" >&2
        fi
    else
        echo -e "${YELLOW}Warning: Claude Code may not be fully initialized for ${agent_name}${NC}" >&2
    fi

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
