#!/bin/bash
# Module: 04-registry.sh
# Description: Kitty window registry management for tracking spawned teammates
# Dependencies: 00-globals, 01-utils, 02-file-lock
# Exports: register_window, unregister_window, get_registered_windows, clean_window_registry

[[ -n "${SWARM_04_REGISTRY_LOADED}" ]] && return 0
SWARM_04_REGISTRY_LOADED=1

if [[ -z "$TEAMS_DIR" ]]; then
    echo "Error: 00-globals.sh must be sourced first" >&2
    return 1
fi

register_window() {
    local team_name="$1"
    local agent_name="$2"
    local swarm_var="$3"
    local registry_file="${TEAMS_DIR}/${team_name}/.window_registry.json"

    # Initialize registry if it doesn't exist
    if [[ ! -f "$registry_file" ]]; then
        echo "[]" > "$registry_file"
    fi

    # Acquire lock for concurrent access protection
    if ! acquire_file_lock "$registry_file"; then
        echo -e "${RED}Failed to acquire lock for window registry${NC}" >&2
        return 1
    fi

    local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    local tmp_file=$(mktemp)

    if [[ -z "$tmp_file" ]]; then
        release_file_lock
        echo -e "${RED}Failed to create temp file${NC}" >&2
        return 1
    fi

    # Add trap to ensure cleanup on interrupt
    register_temp_file "$tmp_file"
    trap "rm -f '$tmp_file'" INT TERM

    if jq --arg agent "$agent_name" \
       --arg var "$swarm_var" \
       --arg ts "$timestamp" \
       '. += [{"agent": $agent, "swarm_var": $var, "registered_at": $ts}]' \
       "$registry_file" >| "$tmp_file" && command mv "$tmp_file" "$registry_file"; then
        trap - INT TERM
        unregister_temp_file "$tmp_file"
        release_file_lock
        return 0
    else
        trap - INT TERM
        unregister_temp_file "$tmp_file"
        command rm -f "$tmp_file"
        release_file_lock
        echo -e "${RED}Failed to update window registry${NC}" >&2
        return 1
    fi
}

# Unregister a kitty window from the team registry
unregister_window() {
    local team_name="$1"
    local agent_name="$2"
    local registry_file="${TEAMS_DIR}/${team_name}/.window_registry.json"

    if [[ ! -f "$registry_file" ]]; then
        return 0
    fi

    # Acquire lock for concurrent access protection
    if ! acquire_file_lock "$registry_file"; then
        echo -e "${RED}Failed to acquire lock for window registry${NC}" >&2
        return 1
    fi

    local tmp_file=$(mktemp)

    if [[ -z "$tmp_file" ]]; then
        release_file_lock
        echo -e "${RED}Failed to create temp file${NC}" >&2
        return 1
    fi

    # Add trap to ensure cleanup on interrupt
    register_temp_file "$tmp_file"
    trap "rm -f '$tmp_file'" INT TERM

    if jq --arg agent "$agent_name" \
       'map(select(.agent != $agent))' \
       "$registry_file" >| "$tmp_file" && command mv "$tmp_file" "$registry_file"; then
        trap - INT TERM
        unregister_temp_file "$tmp_file"
        release_file_lock
        return 0
    else
        trap - INT TERM
        unregister_temp_file "$tmp_file"
        command rm -f "$tmp_file"
        release_file_lock
        echo -e "${RED}Failed to update window registry${NC}" >&2
        return 1
    fi
}

# Get all registered windows for a team
get_registered_windows() {
    local team_name="$1"
    local registry_file="${TEAMS_DIR}/${team_name}/.window_registry.json"

    if [[ -f "$registry_file" ]]; then
        command cat "$registry_file"
    else
        echo "[]"
    fi
}

# Clean stale entries from registry (windows that no longer exist)
clean_window_registry() {
    local team_name="$1"
    local registry_file="${TEAMS_DIR}/${team_name}/.window_registry.json"

    if [[ ! -f "$registry_file" ]]; then
        return 0
    fi

    # Query only windows for this specific team (scoped to prevent cross-team pollution)
    local live_windows=$(kitten_cmd ls 2>/dev/null | jq -r --arg team "$team_name" \
        '.[].tabs[].windows[] | select(.user_vars.swarm_team == $team) | .user_vars | keys[]' 2>/dev/null || echo "")

    local tmp_file=$(mktemp)

    if [[ -z "$tmp_file" ]]; then
        echo -e "${RED}Failed to create temp file for registry cleanup${NC}" >&2
        return 1
    fi

    # Add trap to ensure cleanup on interrupt
    register_temp_file "$tmp_file"
    trap "rm -f '$tmp_file'" INT TERM

    # Build live windows JSON array with validation
    local live_json
    if [[ -z "$live_windows" ]]; then
        live_json="[]"
    elif ! live_json=$(echo "$live_windows" | jq -R . 2>/dev/null | jq -s . 2>/dev/null); then
        echo -e "${YELLOW}Warning: Failed to parse live windows list${NC}" >&2
        trap - INT TERM
        unregister_temp_file "$tmp_file"
        command rm -f "$tmp_file"
        return 1
    fi

    # Keep only entries that still exist in live windows (with error checking)
    if ! jq --argjson live "$live_json" \
       '[.[] | select(.swarm_var as $var | $live | index($var) != null)]' \
       "$registry_file" > "$tmp_file" 2>/dev/null; then
        echo -e "${RED}Error: Registry cleanup jq filter failed${NC}" >&2
        trap - INT TERM
        unregister_temp_file "$tmp_file"
        command rm -f "$tmp_file"
        return 1
    fi

    if command mv "$tmp_file" "$registry_file"; then
        trap - INT TERM
        unregister_temp_file "$tmp_file"
        return 0
    else
        trap - INT TERM
        unregister_temp_file "$tmp_file"
        command rm -f "$tmp_file"
        echo -e "${RED}Failed to update window registry${NC}" >&2
        return 1
    fi
}


# Export public API
export -f register_window unregister_window get_registered_windows clean_window_registry
