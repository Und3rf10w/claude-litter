#!/bin/bash
# Module: 01-utils.sh
# Description: Utility functions used across modules
# Dependencies: 00-globals.sh
# Exports: generate_uuid, validate_name, detect_multiplexer

# Source guard (prevent double-loading)
[[ -n "${SWARM_UTILS_LOADED}" ]] && return 0
SWARM_UTILS_LOADED=1

# Dependency check
if [[ -z "$TEAMS_DIR" ]]; then
    echo "Error: 00-globals.sh must be sourced first" >&2
    return 1
fi

# ============================================
# TERMINAL MULTIPLEXER DETECTION
# ============================================

detect_multiplexer() {
    # Check if inside kitty and remote control is available
    if [[ -n "$KITTY_PID" ]] && command -v kitten &>/dev/null; then
        echo "kitty"
    elif command -v tmux &>/dev/null; then
        echo "tmux"
    else
        echo "none"
    fi
}

# ============================================
# UUID GENERATION (portable across macOS/Linux)
# ============================================

generate_uuid() {
    # Try multiple methods for cross-platform compatibility
    # 1. uuidgen (macOS built-in, common on Linux)
    # 2. /proc/sys/kernel/random/uuid (Linux)
    # 3. Python (almost always available)
    # 4. Fallback: timestamp + random (less unique but works)
    if command -v uuidgen &>/dev/null; then
        uuidgen | tr '[:upper:]' '[:lower:]'
    elif [[ -f /proc/sys/kernel/random/uuid ]]; then
        command cat /proc/sys/kernel/random/uuid
    elif command -v python3 &>/dev/null; then
        python3 -c "import uuid; print(uuid.uuid4())"
    elif command -v python &>/dev/null; then
        python -c "import uuid; print(uuid.uuid4())"
    else
        # Fallback: timestamp + random number (less unique)
        echo "$(date +%s)-$(( RANDOM * RANDOM ))"
    fi
}

# ============================================
# INPUT VALIDATION
# ============================================

# Validate team/agent names to prevent path traversal and other issues
# Returns 0 if valid, 1 if invalid (prints error message)
validate_name() {
    local name="$1"
    local type="${2:-name}"  # "team" or "agent" for error messages

    # Check for empty name
    if [[ -z "$name" ]]; then
        echo -e "${RED}Error: ${type} name cannot be empty${NC}" >&2
        return 1
    fi

    # Check for path traversal attempts
    if [[ "$name" == *".."* ]] || [[ "$name" == *"/"* ]] || [[ "$name" == *"\\"* ]]; then
        echo -e "${RED}Error: ${type} name cannot contain '..' or path separators${NC}" >&2
        return 1
    fi

    # Check for names that start with dash (could be interpreted as flags)
    if [[ "$name" == -* ]]; then
        echo -e "${RED}Error: ${type} name cannot start with '-'${NC}" >&2
        return 1
    fi

    # Check for overly long names (filesystem limit)
    if [[ ${#name} -gt 100 ]]; then
        echo -e "${RED}Error: ${type} name too long (max 100 characters)${NC}" >&2
        return 1
    fi

    return 0
}

# ============================================
# KITTY USER VAR HELPERS
# ============================================

# Get a user var from the current kitty window
# Usage: get_current_window_var "var_name"
# Returns: value of the var, or empty string if not found
get_current_window_var() {
    local var_name="$1"

    if [[ "$SWARM_MULTIPLEXER" != "kitty" ]]; then
        echo ""
        return 1
    fi

    kitten_cmd ls 2>/dev/null | jq -r --arg var "$var_name" \
        '.[].tabs[] | select(.is_active == true) | .windows[] | select(.is_focused == true) | .user_vars[$var] // ""' 2>/dev/null || echo ""
}

# Set user vars on the current kitty window
# Usage: set_current_window_vars "var1=value1" "var2=value2" ...
set_current_window_vars() {
    if [[ "$SWARM_MULTIPLEXER" != "kitty" ]]; then
        return 1
    fi

    kitten_cmd set-user-vars "$@" 2>/dev/null
}

# Export public API
export -f detect_multiplexer generate_uuid validate_name get_current_window_var set_current_window_vars
