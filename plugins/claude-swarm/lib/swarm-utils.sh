#!/bin/bash
# claude-swarm utilities
# All shared functions for swarm management

CLAUDE_HOME="${HOME}/.claude"
TEAMS_DIR="${CLAUDE_HOME}/teams"
TASKS_DIR="${CLAUDE_HOME}/tasks"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

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

# Auto-detect or use override
SWARM_MULTIPLEXER="${SWARM_MULTIPLEXER:-$(detect_multiplexer)}"

# Kitty spawn mode: window, split, tab, session
SWARM_KITTY_MODE="${SWARM_KITTY_MODE:-window}"

# Default allowed tools for teammates (safe operations for swarm coordination)
# These tools are pre-approved so teammates can work autonomously
# Override with SWARM_ALLOWED_TOOLS environment variable
# Note: Use comma-separated patterns to avoid zsh glob expansion issues with (*)
# The variable should be quoted when passed to --allowedTools
SWARM_DEFAULT_ALLOWED_TOOLS="${SWARM_ALLOWED_TOOLS:-Read(*),Glob(*),Grep(*),SlashCommand(*),Bash(*)}"

# System prompt for teammates - appended to default Claude Code behavior
# Provides guidance on slash commands, communication patterns, and swarm conventions
SWARM_TEAMMATE_SYSTEM_PROMPT='You are a teammate in a Claude Code swarm. Follow these guidelines:

## Communication
- Use /claude-swarm:swarm-message <to> <message> to message ANY teammate (not just team-lead)
- Use /claude-swarm:swarm-inbox to check for messages from teammates
- Reply to messages by messaging the sender directly
- When tasks complete, notify both team-lead AND any teammates who may be waiting

## Slash Commands (PREFERRED)
ALWAYS use slash commands instead of bash functions:
- /claude-swarm:task-list - View all tasks
- /claude-swarm:task-update <id> --status <status> - Update task status
- /claude-swarm:task-update <id> --comment <text> - Add progress comment
- /claude-swarm:swarm-status <team> - View team status
- /claude-swarm:swarm-message <to> <message> - Send message to teammate
- /claude-swarm:swarm-inbox - Check your inbox

## Working Style
- Check your inbox regularly for messages from teammates
- Update task status as you progress (add comments for major milestones)
- When blocked, message the relevant teammate or team-lead
- Coordinate with teammates working on related tasks'

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
        cat /proc/sys/kernel/random/uuid
    elif command -v python3 &>/dev/null; then
        python3 -c "import uuid; print(uuid.uuid4())"
    elif command -v python &>/dev/null; then
        python -c "import uuid; print(uuid.uuid4())"
    else
        # Fallback: timestamp + random number (less unique)
        echo "$(date +%s)-$(( RANDOM * RANDOM ))"
    fi
}

# Kitty socket for remote control (required when running from Claude Code)
# Per kitty docs: "If {kitty_pid} is present, then it is replaced by the PID...
# otherwise the PID is appended to the value, with a hyphen."
# So listen_on unix:/tmp/kitty-$USER creates /tmp/kitty-username-12345

# Helper function to find the kitty socket
find_kitty_socket() {
    local user=$(whoami)

    # Priority 1: Check if KITTY_LISTEN_ON is set explicitly (passed from parent or env)
    if [[ -n "$KITTY_LISTEN_ON" ]]; then
        if validate_kitty_socket "$KITTY_LISTEN_ON"; then
            export SWARM_KITTY_SOCKET_CACHE="$KITTY_LISTEN_ON"
            echo "$KITTY_LISTEN_ON"
            return 0
        else
            echo -e "${YELLOW}Warning: KITTY_LISTEN_ON is set but socket is not responding${NC}" >&2
        fi
    fi

    # Priority 2: Check cached socket (validated on each use)
    if [[ -n "$SWARM_KITTY_SOCKET_CACHE" ]]; then
        if validate_kitty_socket "$SWARM_KITTY_SOCKET_CACHE"; then
            echo "$SWARM_KITTY_SOCKET_CACHE"
            return 0
        else
            # Cache is stale, clear it
            unset SWARM_KITTY_SOCKET_CACHE
        fi
    fi

    # Priority 3: If KITTY_PID is set, construct exact socket path
    # This is most reliable when running inside a kitty window
    if [[ -n "$KITTY_PID" ]]; then
        local exact_socket="/tmp/kitty-${user}-${KITTY_PID}"
        if [[ -S "$exact_socket" ]]; then
            local socket_uri="unix:$exact_socket"
            if validate_kitty_socket "$socket_uri"; then
                export SWARM_KITTY_SOCKET_CACHE="$socket_uri"
                export KITTY_LISTEN_ON="$socket_uri"  # Export for teammates
                echo "$socket_uri"
                return 0
            fi
        fi
    fi

    # Priority 4: Discovery - find kitty sockets with PID suffix (most common)
    # Pattern: /tmp/kitty-username-* (kitty appends -PID)
    local socket
    for socket in $(ls -t /tmp/kitty-${user}-* 2>/dev/null); do
        if [[ -S "$socket" ]]; then
            local socket_uri="unix:$socket"
            if validate_kitty_socket "$socket_uri"; then
                export SWARM_KITTY_SOCKET_CACHE="$socket_uri"
                export KITTY_LISTEN_ON="$socket_uri"  # Export for teammates
                echo "$socket_uri"
                return 0
            fi
        fi
    done

    # Priority 5: Check for socket without PID suffix (rare, explicit config)
    if [[ -S "/tmp/kitty-${user}" ]]; then
        local socket_uri="unix:/tmp/kitty-${user}"
        if validate_kitty_socket "$socket_uri"; then
            export SWARM_KITTY_SOCKET_CACHE="$socket_uri"
            export KITTY_LISTEN_ON="$socket_uri"
            echo "$socket_uri"
            return 0
        fi
    fi

    # Priority 6: Check common alternative locations
    for socket in /tmp/mykitty /tmp/kitty; do
        if [[ -S "$socket" ]]; then
            local socket_uri="unix:$socket"
            if validate_kitty_socket "$socket_uri"; then
                export SWARM_KITTY_SOCKET_CACHE="$socket_uri"
                export KITTY_LISTEN_ON="$socket_uri"
                echo "$socket_uri"
                return 0
            fi
        fi
    done

    # No socket found - provide helpful error guidance
    echo -e "${RED}Error: Could not find a valid kitty socket${NC}" >&2
    echo -e "${YELLOW}Troubleshooting steps:${NC}" >&2
    echo -e "  1. Ensure you're running inside kitty terminal (not iTerm2, Terminal.app, etc.)" >&2
    echo -e "  2. Enable remote control in kitty.conf: allow_remote_control yes" >&2
    echo -e "  3. Enable listening in kitty.conf: listen_on unix:/tmp/kitty-\$USER" >&2
    echo -e "     (Note: kitty will append -PID, creating /tmp/kitty-${user}-12345)" >&2
    echo -e "  4. Restart kitty completely after config changes" >&2
    echo -e "  5. Or set socket manually: export KITTY_LISTEN_ON=unix:/tmp/kitty-${user}-\$KITTY_PID" >&2
    echo -e "  6. Check existing sockets: ls -la /tmp/kitty-${user}*" >&2
    return 1
}

# Validate that a kitty socket is healthy and responsive
validate_kitty_socket() {
    local socket="$1"

    if [[ -z "$socket" ]]; then
        return 1
    fi

    # Test socket health with a simple ls command
    if kitten @ --to "$socket" ls &>/dev/null; then
        return 0
    else
        return 1
    fi
}

# Helper function for kitten @ commands with socket
kitten_cmd() {
    local socket=$(find_kitty_socket)
    if [[ -n "$socket" ]]; then
        kitten @ --to "$socket" "$@"
    else
        # Fallback to direct kitten @ (may fail without TTY)
        kitten @ "$@"
    fi
}

# Wait for Claude Code to be ready in a window
# Uses polling instead of hardcoded sleep for more reliable startup detection
wait_for_claude_ready() {
    local swarm_var="$1"
    local max_wait="${2:-15}"  # Maximum wait time in seconds (default 15)
    local poll_interval=0.5     # Check every 0.5 seconds

    local elapsed=0
    echo "  Waiting for Claude Code to start (max ${max_wait}s)..."

    while (( $(echo "$elapsed < $max_wait" | bc -l) )); do
        # Check if window exists and is responsive
        if kitten_cmd ls 2>/dev/null | jq -e --arg var "$swarm_var" '.[].tabs[].windows[] | select(.user_vars[$var] != null)' &>/dev/null; then
            # Window exists, give it a moment to fully initialize
            sleep 1
            echo "  Claude Code is ready (took ${elapsed}s)"
            return 0
        fi

        sleep "$poll_interval"
        elapsed=$(echo "$elapsed + $poll_interval" | bc -l)
    done

    # Timeout reached
    echo "  Warning: Claude Code may not be fully ready yet (waited ${max_wait}s)"
    return 1
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
# FILE LOCKING (portable atomic locking)
# ============================================

# Acquire a file lock using mkdir (atomic on POSIX systems)
# Usage: acquire_file_lock "/path/to/file.json" [max_attempts] [stale_threshold_sec]
# Returns: 0 on success, 1 on failure
# Side effect: Sets ACQUIRED_LOCK_FILE for cleanup
acquire_file_lock() {
    local target_file="$1"
    local max_attempts="${2:-50}"
    local stale_threshold="${3:-60}"
    local lock_file="${target_file}.lock"

    # Clean up stale locks older than threshold
    if [[ -d "$lock_file" ]]; then
        local lock_age=$(( $(date +%s) - $(stat -f %m "$lock_file" 2>/dev/null || stat -c %Y "$lock_file" 2>/dev/null || echo 0) ))
        if [[ $lock_age -gt $stale_threshold ]]; then
            rmdir "$lock_file" 2>/dev/null || true
        fi
    fi

    local attempt=0
    while ! mkdir "$lock_file" 2>/dev/null; do
        ((attempt++))
        if [[ $attempt -ge $max_attempts ]]; then
            echo -e "${RED}Failed to acquire lock for ${target_file}${NC}" >&2
            return 1
        fi
        sleep 0.1
    done

    # Store lock path for cleanup
    ACQUIRED_LOCK_FILE="$lock_file"
    return 0
}

# Release a file lock
# Usage: release_file_lock [lock_file]
# If no argument provided, uses ACQUIRED_LOCK_FILE
release_file_lock() {
    local lock_file="${1:-$ACQUIRED_LOCK_FILE}"
    if [[ -n "$lock_file" ]]; then
        rmdir "$lock_file" 2>/dev/null || true
        if [[ "$lock_file" == "$ACQUIRED_LOCK_FILE" ]]; then
            unset ACQUIRED_LOCK_FILE
        fi
    fi
}

# ============================================
# WINDOW REGISTRY (for kitty window tracking)
# ============================================

# Register a kitty window in the team registry
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

    if jq --arg agent "$agent_name" \
       --arg var "$swarm_var" \
       --arg ts "$timestamp" \
       '. += [{"agent": $agent, "swarm_var": $var, "registered_at": $ts}]' \
       "$registry_file" >| "$tmp_file" && command mv "$tmp_file" "$registry_file"; then
        release_file_lock
        return 0
    else
        rm -f "$tmp_file"
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

    if jq --arg agent "$agent_name" \
       'map(select(.agent != $agent))' \
       "$registry_file" >| "$tmp_file" && command mv "$tmp_file" "$registry_file"; then
        release_file_lock
        return 0
    else
        rm -f "$tmp_file"
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
        cat "$registry_file"
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

    local live_windows=$(kitten_cmd ls 2>/dev/null | jq -r '.[].tabs[].windows[].user_vars | keys[]' 2>/dev/null || echo "")
    local tmp_file=$(mktemp)

    # Keep only entries that still exist in live windows
    jq --argjson live "$(echo "$live_windows" | jq -R . | jq -s .)" \
       '[.[] | select(.swarm_var as $var | $live | index($var) != null)]' \
       "$registry_file" >| "$tmp_file" && command mv "$tmp_file" "$registry_file"
}

# ============================================
# TEAM MANAGEMENT
# ============================================

create_team() {
    local team_name="$1"
    local description="${2:-Team $team_name}"

    # Validate team name
    validate_name "$team_name" "team" || return 1

    local team_dir="${TEAMS_DIR}/${team_name}"

    if [[ -d "$team_dir" ]]; then
        echo -e "${YELLOW}Team '${team_name}' already exists${NC}"
        return 1
    fi

    mkdir -p "${team_dir}/inboxes"
    mkdir -p "${TASKS_DIR}/${team_name}"

    # Create config with current session as team-lead
    local lead_id="${CLAUDE_CODE_AGENT_ID:-$(generate_uuid)}"
    local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    # Use jq to properly escape values and prevent JSON injection
    jq -n \
        --arg teamName "$team_name" \
        --arg description "$description" \
        --arg leadId "$lead_id" \
        --arg timestamp "$timestamp" \
        '{
            teamName: $teamName,
            description: $description,
            status: "active",
            leadAgentId: $leadId,
            members: [{
                agentId: $leadId,
                name: "team-lead",
                type: "team-lead",
                color: "cyan",
                model: "sonnet",
                status: "active",
                lastSeen: $timestamp
            }],
            createdAt: $timestamp,
            suspendedAt: null,
            resumedAt: null
        }' > "${team_dir}/config.json"

    # Initialize team-lead inbox
    echo "[]" > "${team_dir}/inboxes/team-lead.json"

    echo -e "${GREEN}Created team '${team_name}'${NC}"
    echo "  Config: ${team_dir}/config.json"
    echo "  Tasks: ${TASKS_DIR}/${team_name}/"
}

add_member() {
    local team_name="$1"
    local agent_id="$2"
    local agent_name="$3"
    local agent_type="${4:-worker}"
    local agent_color="${5:-blue}"
    local agent_model="${6:-sonnet}"

    # Validate names
    validate_name "$team_name" "team" || return 1
    validate_name "$agent_name" "agent" || return 1

    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        echo -e "${RED}Team '${team_name}' not found${NC}"
        return 1
    fi

    # Acquire lock for concurrent access protection
    if ! acquire_file_lock "$config_file"; then
        echo -e "${RED}Failed to acquire lock for team config${NC}" >&2
        return 1
    fi

    # Add member to config with status tracking
    local tmp_file=$(mktemp)
    local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    if jq --arg id "$agent_id" \
       --arg name "$agent_name" \
       --arg type "$agent_type" \
       --arg color "$agent_color" \
       --arg model "$agent_model" \
       --arg ts "$timestamp" \
       '.members += [{"agentId": $id, "name": $name, "type": $type, "color": $color, "model": $model, "status": "active", "lastSeen": $ts}]' \
       "$config_file" >| "$tmp_file" && command mv "$tmp_file" "$config_file"; then
        release_file_lock

        # Initialize inbox for new member
        echo "[]" > "${TEAMS_DIR}/${team_name}/inboxes/${agent_name}.json"

        echo -e "${GREEN}Added '${agent_name}' to team '${team_name}'${NC}"
    else
        rm -f "$tmp_file"
        release_file_lock
        echo -e "${RED}Failed to add member to team config${NC}" >&2
        return 1
    fi
}

get_team_config() {
    local team_name="$1"
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ -f "$config_file" ]]; then
        cat "$config_file"
    else
        echo "{}"
    fi
}

list_team_members() {
    local team_name="$1"
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        echo -e "${RED}Team '${team_name}' not found${NC}"
        return 1
    fi

    jq -r '.members[] | "\(.name) (\(.type)) - \(.agentId)"' "$config_file"
}

# ============================================
# STATUS MANAGEMENT
# ============================================

update_team_status() {
    local team_name="$1"
    local new_status="$2"  # active, suspended, archived
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        echo -e "${RED}Team '${team_name}' not found${NC}"
        return 1
    fi

    local tmp_file=$(mktemp)
    local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    case "$new_status" in
        suspended)
            jq --arg status "$new_status" --arg ts "$timestamp" \
               '.status = $status | .suspendedAt = $ts' \
               "$config_file" >| "$tmp_file" && command mv "$tmp_file" "$config_file"
            ;;
        active)
            jq --arg status "$new_status" --arg ts "$timestamp" \
               '.status = $status | .resumedAt = $ts' \
               "$config_file" >| "$tmp_file" && command mv "$tmp_file" "$config_file"
            ;;
        *)
            jq --arg status "$new_status" \
               '.status = $status' \
               "$config_file" >| "$tmp_file" && command mv "$tmp_file" "$config_file"
            ;;
    esac

    echo -e "${CYAN}Team '${team_name}' status: ${new_status}${NC}"
}

update_member_status() {
    local team_name="$1"
    local member_name="$2"
    local new_status="$3"  # active, offline
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        return 1
    fi

    # Acquire lock for concurrent access protection
    if ! acquire_file_lock "$config_file"; then
        echo -e "${RED}Failed to acquire lock for team config${NC}" >&2
        return 1
    fi

    local tmp_file=$(mktemp)
    local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    if jq --arg name "$member_name" --arg status "$new_status" --arg ts "$timestamp" \
       '(.members[] | select(.name == $name)) |= (.status = $status | .lastSeen = $ts)' \
       "$config_file" >| "$tmp_file" && command mv "$tmp_file" "$config_file"; then
        release_file_lock
    else
        rm -f "$tmp_file"
        release_file_lock
        return 1
    fi
}

get_member_status() {
    local team_name="$1"
    local member_name="$2"
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        echo "unknown"
        return 1
    fi

    jq -r --arg name "$member_name" '.members[] | select(.name == $name) | .status // "unknown"' "$config_file"
}

get_team_status() {
    local team_name="$1"
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        echo "not_found"
        return 1
    fi

    jq -r '.status // "unknown"' "$config_file"
}

# Get live agents from the current multiplexer
# Returns newline-separated list of agent names with active sessions
get_live_agents() {
    local team_name="$1"
    local live_agents=""

    case "$SWARM_MULTIPLEXER" in
        kitty)
            live_agents=$(kitten_cmd ls 2>/dev/null | jq -r --arg team "$team_name" \
                '.[].tabs[].windows[] | select(.user_vars.swarm_team == $team) | .user_vars.swarm_agent' \
                2>/dev/null || true)
            ;;
        tmux)
            live_agents=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | \
                grep "swarm-${team_name}" | sed 's/swarm-[^-]*-//' || true)
            ;;
    esac

    echo "$live_agents"
}

# Format a single member's status for display
# Returns: display_line|is_mismatch (0 or 1)
format_member_status() {
    local name="$1"
    local type="$2"
    local config_status="$3"
    local live_agents="$4"  # newline-separated list

    local window_status=""
    local status_icon=""
    local is_mismatch=0

    if [[ "$name" == "team-lead" ]]; then
        window_status="(you)"
        status_icon=""
    elif echo "$live_agents" | grep -q "^${name}$"; then
        window_status="window exists"
        if [[ "$config_status" == "active" ]]; then
            status_icon="${GREEN}✓${NC}"
        else
            status_icon="${YELLOW}⚠️${NC}"
            is_mismatch=1
        fi
    else
        window_status="no window"
        if [[ "$config_status" == "offline" ]]; then
            status_icon="${GREEN}✓${NC}"
        else
            status_icon="${RED}✗${NC}"
            is_mismatch=1
        fi
    fi

    # Return format: display_line|is_mismatch
    printf "  %-25s config: %-8s %s %s|%d" "$name ($type)" "$config_status" "$window_status" "$status_icon" "$is_mismatch"
}

# Get task summary for a team
# Returns: active_count|completed_count
# Active = pending, in-progress, blocked, in-review
# Completed = completed
get_task_summary() {
    local team_name="$1"
    local tasks_dir="${TASKS_DIR}/${team_name}"

    if [[ ! -d "$tasks_dir" ]]; then
        echo "0|0"
        return 0
    fi

    local active=$(find "$tasks_dir" -name "*.json" -exec jq -r 'select(.status == "pending" or .status == "in-progress" or .status == "blocked" or .status == "in-review") | .id' {} \; 2>/dev/null | wc -l | tr -d ' ')
    local completed=$(find "$tasks_dir" -name "*.json" -exec jq -r 'select(.status == "completed") | .id' {} \; 2>/dev/null | wc -l | tr -d ' ')

    echo "${active}|${completed}"
}

# Get context for a member (for resume prompts)
get_member_context() {
    local team_name="$1"
    local member_name="$2"
    local tasks_dir="${TASKS_DIR}/${team_name}"
    local inbox_file="${TEAMS_DIR}/${team_name}/inboxes/${member_name}.json"

    local context=""

    # Get assigned tasks
    if [[ -d "$tasks_dir" ]]; then
        local assigned_tasks=""
        # Use find instead of glob to avoid zsh "no matches found" error
        while IFS= read -r task_file; do
            [[ -z "$task_file" ]] && continue
            local owner=$(jq -r '.owner // ""' "$task_file")
            if [[ "$owner" == "$member_name" ]]; then
                local id=$(jq -r '.id' "$task_file")
                local subject=$(jq -r '.subject' "$task_file")
                local task_status=$(jq -r '.status' "$task_file")
                assigned_tasks="${assigned_tasks}\n  - Task #${id} [${task_status}]: ${subject}"
            fi
        done < <(find "$tasks_dir" -maxdepth 1 -name "*.json" -type f 2>/dev/null)
        if [[ -n "$assigned_tasks" ]]; then
            context="${context}Your assigned tasks:${assigned_tasks}\n\n"
        fi
    fi

    # Get unread message count
    if [[ -f "$inbox_file" ]]; then
        local unread_count=$(jq '[.[] | select(.read == false)] | length' "$inbox_file")
        if [[ "$unread_count" -gt 0 ]]; then
            context="${context}You have ${unread_count} unread message(s). Use /claude-swarm:swarm-inbox to read them.\n\n"
        fi
    fi

    echo -e "$context"
}

# ============================================
# TEAM LIFECYCLE
# ============================================

suspend_team() {
    local team_name="$1"
    local kill_sessions="${2:-true}"
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        echo -e "${RED}Team '${team_name}' not found${NC}"
        return 1
    fi

    local current_status=$(get_team_status "$team_name")
    if [[ "$current_status" == "suspended" ]]; then
        echo -e "${YELLOW}Team '${team_name}' is already suspended${NC}"
        return 0
    fi

    echo -e "${CYAN}Suspending team '${team_name}'...${NC}"

    # Read members into array (handles names with spaces/special chars)
    local -a members=()
    while IFS= read -r member; do
        [[ -n "$member" ]] && members+=("$member")
    done < <(jq -r '.members[].name' "$config_file")

    # Mark all members as offline
    for member in "${members[@]}"; do
        update_member_status "$team_name" "$member" "offline"
    done

    # Kill sessions if requested
    if [[ "$kill_sessions" == "true" ]]; then
        case "$SWARM_MULTIPLEXER" in
            kitty)
                # Use registry + live query for comprehensive cleanup
                for member in "${members[@]}"; do
                    if [[ "$member" != "team-lead" ]]; then
                        local swarm_var="swarm_${team_name}_${member}"
                        if kitten_cmd close-window --match "var:${swarm_var}" 2>/dev/null; then
                            echo -e "${YELLOW}  Closed: ${member}${NC}"
                            unregister_window "$team_name" "$member"
                        fi
                    fi
                done
                ;;
            tmux)
                for member in "${members[@]}"; do
                    if [[ "$member" != "team-lead" ]]; then
                        local session_name="swarm-${team_name}-${member}"
                        tmux kill-session -t "$session_name" 2>/dev/null && \
                            echo -e "${YELLOW}  Closed: ${member}${NC}"
                    fi
                done
                ;;
        esac
    fi

    # Update team status
    update_team_status "$team_name" "suspended"

    echo -e "${GREEN}Team '${team_name}' suspended${NC}"
    echo "  Data preserved in: ${TEAMS_DIR}/${team_name}/"
    echo "  Resume with: /claude-swarm:swarm-resume ${team_name}"
}

resume_team() {
    local team_name="$1"
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        echo -e "${RED}Team '${team_name}' not found${NC}"
        return 1
    fi

    local current_status=$(get_team_status "$team_name")
    if [[ "$current_status" == "active" ]]; then
        echo -e "${YELLOW}Team '${team_name}' is already active${NC}"
        return 0
    fi

    echo -e "${CYAN}Resuming team '${team_name}'...${NC}"

    # Mark team as active
    update_team_status "$team_name" "active"

    # Mark current session as active (using CLAUDE_CODE_AGENT_NAME if set, otherwise assume team-lead)
    local current_agent="${CLAUDE_CODE_AGENT_NAME:-team-lead}"
    update_member_status "$team_name" "$current_agent" "active"

    # Get offline members (excluding current agent)
    local offline_members=$(jq -r --arg current "$current_agent" '.members[] | select(.status == "offline" and .name != $current) | "\(.name)|\(.type)|\(.model // "sonnet")"' "$config_file")

    if [[ -z "$offline_members" ]]; then
        echo -e "${GREEN}Team '${team_name}' resumed (no teammates to respawn)${NC}"
        return 0
    fi

    # Respawn each offline member with context
    echo -e "${BLUE}Respawning teammates...${NC}"
    while IFS='|' read -r member_name member_type member_model; do
        if [[ -n "$member_name" ]]; then
            local context=$(get_member_context "$team_name" "$member_name")
            local resume_prompt="You are ${member_name} resuming work on team '${team_name}'. ${context}Check your inbox and tasks to continue where you left off."

            echo -e "  Spawning ${member_name} (${member_type}, ${member_model})..."

            # Spawn without re-adding to team (already exists)
            case "$SWARM_MULTIPLEXER" in
                kitty)
                    spawn_teammate_kitty_resume "$team_name" "$member_name" "$member_type" "$member_model" "$resume_prompt"
                    ;;
                tmux)
                    spawn_teammate_tmux_resume "$team_name" "$member_name" "$member_type" "$member_model" "$resume_prompt"
                    ;;
                *)
                    echo -e "${RED}No multiplexer available${NC}"
                    return 1
                    ;;
            esac
        fi
    done <<< "$offline_members"

    echo -e "${GREEN}Team '${team_name}' resumed${NC}"
}

# Spawn teammate without adding to team (for resume)
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

    local swarm_var="swarm_${team_name}_${agent_name}"
    local window_title="swarm-${team_name}-${agent_name}"

    # Check if window already exists
    if kitten_cmd ls 2>/dev/null | jq -e --arg var "$swarm_var" '.[].tabs[].windows[] | select(.user_vars[$var] != null)' &>/dev/null; then
        echo -e "${YELLOW}    Window for '${agent_name}' already exists${NC}"
        update_member_status "$team_name" "$agent_name" "active"
        return 0
    fi

    # Determine launch type
    local launch_type="window"
    local location_arg=""
    case "$SWARM_KITTY_MODE" in
        split) launch_type="window"; location_arg="--location=vsplit" ;;
        tab) launch_type="tab" ;;
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
        --env "KITTY_LISTEN_ON=${kitty_socket}" \
        claude --model "$model" --dangerously-skip-permissions \
        --append-system-prompt "$SWARM_TEAMMATE_SYSTEM_PROMPT" -- "$initial_prompt"

    # Wait for Claude Code to be ready, then register
    if wait_for_claude_ready "$swarm_var" 10; then
        register_window "$team_name" "$agent_name" "$swarm_var"
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
    local safe_prompt=$(printf %q "$initial_prompt")
    local safe_system_prompt=$(printf %q "$SWARM_TEAMMATE_SYSTEM_PROMPT")

    # Set environment variables and launch claude with prompt as CLI argument
    # Pass initial_prompt as CLI argument - more reliable than send-keys
    tmux send-keys -t "$session_name" "export CLAUDE_CODE_TEAM_NAME=$safe_team_val CLAUDE_CODE_AGENT_ID=$safe_id_val CLAUDE_CODE_AGENT_NAME=$safe_name_val CLAUDE_CODE_AGENT_TYPE=$safe_type_val && claude --model $model --dangerously-skip-permissions --append-system-prompt $safe_system_prompt -- $safe_prompt" Enter

    # Update status
    update_member_status "$team_name" "$agent_name" "active"

    echo -e "${GREEN}    Resumed: ${agent_name}${NC}"
}

# ============================================
# MESSAGING
# ============================================

send_message() {
    local team_name="$1"
    local to="$2"
    local message="$3"
    local from="${CLAUDE_CODE_AGENT_NAME:-${CLAUDE_CODE_AGENT_ID:-team-lead}}"
    local color="${4:-blue}"
    local inbox_file="${TEAMS_DIR}/${team_name}/inboxes/${to}.json"

    if [[ ! -f "$inbox_file" ]]; then
        echo -e "${RED}Inbox for '${to}' not found in team '${team_name}'${NC}"
        return 1
    fi

    # Acquire lock for concurrent access protection
    if ! acquire_file_lock "$inbox_file"; then
        echo -e "${RED}Failed to acquire lock for inbox${NC}" >&2
        return 1
    fi

    local tmp_file=$(mktemp)
    if [[ -z "$tmp_file" ]]; then
        echo -e "${RED}Failed to create temp file${NC}" >&2
        release_file_lock
        return 1
    fi

    local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    if jq --arg from "$from" \
          --arg text "$message" \
          --arg color "$color" \
          --arg ts "$timestamp" \
          '. += [{"from": $from, "text": $text, "color": $color, "read": false, "timestamp": $ts}]' \
          "$inbox_file" >| "$tmp_file" && command mv "$tmp_file" "$inbox_file"; then
        release_file_lock
        echo -e "${GREEN}Message sent to '${to}'${NC}"

        # Send real-time notification to active teammate
        notify_active_teammate "$team_name" "$to" "$from"
    else
        rm -f "$tmp_file"
        release_file_lock
        echo -e "${RED}Failed to update inbox${NC}" >&2
        return 1
    fi
}

# Notify an active teammate via multiplexer
# Called after message is queued to provide real-time notification
notify_active_teammate() {
    local team_name="$1"
    local agent_name="$2"
    local from="$3"

    # Skip if messaging self
    if [[ "$agent_name" == "$from" ]]; then
        return 0
    fi

    # Check if teammate is active
    local live_agents=$(get_live_agents "$team_name")
    if ! echo "$live_agents" | grep -q "^${agent_name}$"; then
        return 0  # Not active, skip notification
    fi

    case "$SWARM_MULTIPLEXER" in
        kitty)
            local swarm_var="swarm_${team_name}_${agent_name}"
            kitten_cmd send-text --match "var:${swarm_var}" "/claude-swarm:swarm-inbox\r"
            ;;
        tmux)
            local safe_team="${team_name//[^a-zA-Z0-9_-]/_}"
            local safe_agent="${agent_name//[^a-zA-Z0-9_-]/_}"
            local session="swarm-${safe_team}-${safe_agent}"
            tmux display-message -t "$session" "📬 New message from ${from}" 2>/dev/null || true
            ;;
    esac
}

read_inbox() {
    local team_name="$1"
    local agent_name="${2:-${CLAUDE_CODE_AGENT_NAME:-team-lead}}"
    local inbox_file="${TEAMS_DIR}/${team_name}/inboxes/${agent_name}.json"

    if [[ ! -f "$inbox_file" ]]; then
        echo "[]"
        return
    fi

    cat "$inbox_file"
}

read_unread_messages() {
    local team_name="$1"
    local agent_name="${2:-${CLAUDE_CODE_AGENT_NAME:-team-lead}}"
    local inbox_file="${TEAMS_DIR}/${team_name}/inboxes/${agent_name}.json"

    if [[ ! -f "$inbox_file" ]]; then
        echo "[]"
        return
    fi

    jq '[.[] | select(.read == false)]' "$inbox_file"
}

mark_messages_read() {
    local team_name="$1"
    local agent_name="${2:-${CLAUDE_CODE_AGENT_NAME:-team-lead}}"
    local inbox_file="${TEAMS_DIR}/${team_name}/inboxes/${agent_name}.json"

    if [[ ! -f "$inbox_file" ]]; then
        return 1
    fi

    # Acquire lock for concurrent access protection
    if ! acquire_file_lock "$inbox_file"; then
        echo -e "${RED}Failed to acquire lock for inbox${NC}" >&2
        return 1
    fi

    local tmp_file=$(mktemp)
    if jq '[.[] | .read = true]' "$inbox_file" >| "$tmp_file" && command mv "$tmp_file" "$inbox_file"; then
        release_file_lock
        return 0
    else
        rm -f "$tmp_file"
        release_file_lock
        return 1
    fi
}

broadcast_message() {
    local team_name="$1"
    local message="$2"
    local exclude="${3:-}"  # Agent to exclude (usually self)
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        echo -e "${RED}Team '${team_name}' not found${NC}"
        return 1
    fi

    local failed_count=0
    local success_count=0

    # Read members using while loop (handles names with spaces/special chars)
    while IFS= read -r member; do
        [[ -n "$member" ]] || continue
        if [[ "$member" != "$exclude" ]]; then
            if send_message "$team_name" "$member" "$message"; then
                ((success_count++))
            else
                echo -e "${YELLOW}Warning: Failed to send message to '${member}'${NC}" >&2
                ((failed_count++))
            fi
        fi
    done < <(jq -r '.members[].name' "$config_file")

    if [[ $failed_count -gt 0 ]]; then
        echo -e "${YELLOW}Broadcast completed with ${failed_count} failure(s) and ${success_count} success(es)${NC}" >&2
        return 1
    fi

    return 0
}

format_messages_xml() {
    local messages="$1"

    echo "$messages" | jq -r '.[] | "<teammate-message teammate_id=\"\(.from)\" color=\"\(.color)\">\n\(.text)\n</teammate-message>\n"'
}

# ============================================
# TASK MANAGEMENT
# ============================================

create_task() {
    local team_name="${1:-${CLAUDE_CODE_TEAM_NAME:-default}}"
    local subject="$2"
    local description="$3"
    local tasks_dir="${TASKS_DIR}/${team_name}"

    mkdir -p "$tasks_dir"

    # Find next task ID
    # Use find instead of glob to avoid zsh "no matches found" error
    local max_id=0
    while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        local id=$(basename "$f" .json)
        if [[ "$id" =~ ^[0-9]+$ ]] && [[ $id -gt $max_id ]]; then
            max_id=$id
        fi
    done < <(find "$tasks_dir" -maxdepth 1 -name "*.json" -type f 2>/dev/null)
    local new_id=$((max_id + 1))

    local task_file="${tasks_dir}/${new_id}.json"
    local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    # Use jq to properly escape values and prevent JSON injection
    jq -n \
        --arg id "$new_id" \
        --arg subject "$subject" \
        --arg description "$description" \
        --arg timestamp "$timestamp" \
        '{
            id: $id,
            subject: $subject,
            description: $description,
            status: "pending",
            owner: null,
            references: [],
            blocks: [],
            blockedBy: [],
            comments: [],
            createdAt: $timestamp
        }' > "$task_file"

    echo -e "${GREEN}Created task #${new_id}: ${subject}${NC}"
    echo "$new_id"
}

get_task() {
    local team_name="${1:-${CLAUDE_CODE_TEAM_NAME:-default}}"
    local task_id="$2"
    local task_file="${TASKS_DIR}/${team_name}/${task_id}.json"

    if [[ -f "$task_file" ]]; then
        cat "$task_file"
    else
        echo "null"
    fi
}

update_task() {
    local team_name="${1:-${CLAUDE_CODE_TEAM_NAME:-default}}"
    local task_id="$2"
    local task_file="${TASKS_DIR}/${team_name}/${task_id}.json"
    shift 2

    if [[ ! -f "$task_file" ]]; then
        echo -e "${RED}Task #${task_id} not found${NC}"
        return 1
    fi

    # Acquire lock for concurrent access protection
    if ! acquire_file_lock "$task_file"; then
        echo -e "${RED}Failed to acquire lock for task #${task_id}${NC}" >&2
        return 1
    fi

    local tmp_file=$(mktemp)
    command cp "$task_file" "$tmp_file"

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --status)
                jq --arg val "$2" '.status = $val' "$tmp_file" > "${tmp_file}.new" && command mv "${tmp_file}.new" "$tmp_file"
                shift 2
                ;;
            --owner|--assign)
                jq --arg val "$2" '.owner = $val' "$tmp_file" > "${tmp_file}.new" && command mv "${tmp_file}.new" "$tmp_file"
                shift 2
                ;;
            --comment)
                local author="${CLAUDE_CODE_AGENT_NAME:-${CLAUDE_CODE_AGENT_ID:-unknown}}"
                local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
                jq --arg author "$author" --arg content "$2" --arg ts "$timestamp" \
                   '.comments += [{"author": $author, "content": $content, "timestamp": $ts}]' \
                   "$tmp_file" > "${tmp_file}.new" && command mv "${tmp_file}.new" "$tmp_file"
                shift 2
                ;;
            --blocked-by)
                jq --arg val "$2" '.blockedBy += [$val]' "$tmp_file" > "${tmp_file}.new" && command mv "${tmp_file}.new" "$tmp_file"
                shift 2
                ;;
            *)
                shift
                ;;
        esac
    done

    if command mv "$tmp_file" "$task_file"; then
        release_file_lock
        echo -e "${GREEN}Updated task #${task_id}${NC}"
    else
        rm -f "$tmp_file"
        release_file_lock
        echo -e "${RED}Failed to update task #${task_id}${NC}" >&2
        return 1
    fi
}

list_tasks() {
    local team_name="${1:-${CLAUDE_CODE_TEAM_NAME:-default}}"
    local tasks_dir="${TASKS_DIR}/${team_name}"

    if [[ ! -d "$tasks_dir" ]]; then
        echo "No tasks found for team '${team_name}'"
        return
    fi

    echo "Tasks for team '${team_name}':"
    echo "--------------------------------"

    # Use find instead of glob to avoid zsh "no matches found" error
    local task_count=0
    while IFS= read -r task_file; do
        [[ -z "$task_file" ]] && continue
        ((task_count++))
        local id=$(jq -r '.id' "$task_file")
        local subject=$(jq -r '.subject' "$task_file")
        local task_status=$(jq -r '.status' "$task_file")
        local owner=$(jq -r '.owner // "unassigned"' "$task_file")
        local blocked_by=$(jq -r '.blockedBy | if length > 0 then " [blocked by #" + (. | join(", #")) + "]" else "" end' "$task_file")

        local status_color="${NC}"
        if [[ "$task_status" == "pending" ]]; then
            status_color="${NC}"  # white/default
        elif [[ "$task_status" == "in-progress" ]]; then
            status_color="${BLUE}"
        elif [[ "$task_status" == "blocked" ]]; then
            status_color="${RED}"
        elif [[ "$task_status" == "in-review" ]]; then
            status_color="${YELLOW}"
        elif [[ "$task_status" == "completed" ]]; then
            status_color="${GREEN}"
        fi

        echo -e "#${id} ${status_color}[${task_status}]${NC} ${subject} (${owner})${blocked_by}"
    done < <(find "$tasks_dir" -maxdepth 1 -name "*.json" -type f 2>/dev/null | sort)

    if [[ $task_count -eq 0 ]]; then
        echo "  (no tasks yet)"
    fi
}

assign_task() {
    local team_name="${1:-${CLAUDE_CODE_TEAM_NAME:-default}}"
    local task_id="$2"
    local assignee="$3"

    update_task "$team_name" "$task_id" --owner "$assignee"

    # Notify assignee
    send_message "$team_name" "$assignee" "You have been assigned task #${task_id}. Use TaskGet to see full details."
}

# ============================================
# TMUX SESSION MANAGEMENT
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

    # Generate UUID for agent
    local agent_id=$(generate_uuid)

    # Add to team config (include model for resume capability)
    add_member "$team_name" "$agent_id" "$agent_name" "$agent_type" "blue" "$model"

    # Sanitize session name (tmux doesn't allow certain characters)
    local safe_team="${team_name//[^a-zA-Z0-9_-]/_}"
    local safe_agent="${agent_name//[^a-zA-Z0-9_-]/_}"
    local session_name="swarm-${safe_team}-${safe_agent}"

    # Check if session exists
    if tmux has-session -t "$session_name" 2>/dev/null; then
        echo -e "${YELLOW}Session '${session_name}' already exists${NC}"
        return 1
    fi

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
    local safe_prompt=$(printf %q "$initial_prompt")
    local safe_system_prompt=$(printf %q "$SWARM_TEAMMATE_SYSTEM_PROMPT")

    # Set environment variables and launch claude with prompt as CLI argument
    # Pass initial_prompt as CLI argument - more reliable than send-keys
    tmux send-keys -t "$session_name" "export CLAUDE_CODE_TEAM_NAME=$safe_team_val CLAUDE_CODE_AGENT_ID=$safe_id_val CLAUDE_CODE_AGENT_NAME=$safe_name_val CLAUDE_CODE_AGENT_TYPE=$safe_type_val && claude --model $model --dangerously-skip-permissions --append-system-prompt $safe_system_prompt -- $safe_prompt" Enter

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

    # Generate UUID for agent
    local agent_id=$(generate_uuid)

    # Add to team config (include model for resume capability)
    add_member "$team_name" "$agent_id" "$agent_name" "$agent_type" "blue" "$model"

    # Use user variable for identification (persists even if title changes)
    local swarm_var="swarm_${team_name}_${agent_name}"
    local window_title="swarm-${team_name}-${agent_name}"

    # Check if window already exists using user variable
    if kitten_cmd ls 2>/dev/null | jq -e --arg var "$swarm_var" '.[].tabs[].windows[] | select(.user_vars[$var] != null)' &>/dev/null; then
        echo -e "${YELLOW}Kitty window for '${agent_name}' already exists${NC}"
        return 1
    fi

    # Default prompt if not provided
    if [[ -z "$initial_prompt" ]]; then
        initial_prompt="You are ${agent_name} in team '${team_name}'. Check your mailbox at ~/.claude/teams/${team_name}/inboxes/${agent_name}.json for messages. Send updates to team-lead when tasks complete. Use /swarm-inbox to check for new messages."
    fi

    # Determine launch type based on SWARM_KITTY_MODE
    local launch_type="window"
    local location_arg=""
    case "$SWARM_KITTY_MODE" in
        split)
            launch_type="window"
            location_arg="--location=vsplit"
            ;;
        tab)
            launch_type="tab"
            ;;
        window|*)
            launch_type="window"
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
        --env "KITTY_LISTEN_ON=${kitty_socket}" \
        claude --model "$model" --dangerously-skip-permissions \
        --append-system-prompt "$SWARM_TEAMMATE_SYSTEM_PROMPT" -- "$initial_prompt"

    # Wait for Claude Code to be ready, then register
    if wait_for_claude_ready "$swarm_var" 10; then
        register_window "$team_name" "$agent_name" "$swarm_var"
    else
        echo -e "${YELLOW}Warning: Claude Code may not be fully initialized for ${agent_name}${NC}" >&2
    fi

    echo -e "${GREEN}Spawned teammate '${agent_name}' in kitty ${launch_type}${NC}"
    echo "  Agent ID: ${agent_id}"
    echo "  Model: ${model}"
    echo "  Mode: ${SWARM_KITTY_MODE}"
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

# ============================================
# KITTY SESSION FILE MANAGEMENT
# ============================================

generate_kitty_session() {
    local team_name="$1"
    local session_file="${TEAMS_DIR}/${team_name}/swarm.kitty-session"
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        echo -e "${RED}Team '${team_name}' not found${NC}"
        return 1
    fi

    # Generate session file header
    cat > "$session_file" << EOF
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
        local swarm_var="swarm_${team_name}_${name}"

        if [[ "$first" == "true" ]]; then
            echo "# First window (${name})" >> "$session_file"
            echo "launch --title \"swarm-${team_name}-${name}\" --var \"${swarm_var}=true\" --var \"swarm_team=${team_name}\" --var \"swarm_agent=${name}\" --env CLAUDE_CODE_TEAM_NAME=${team_name} --env CLAUDE_CODE_AGENT_ID=${id} --env CLAUDE_CODE_AGENT_NAME=${name} --env CLAUDE_CODE_AGENT_TYPE=${type} claude" >> "$session_file"
            first=false
        else
            echo "" >> "$session_file"
            echo "# Split window (${name})" >> "$session_file"
            echo "launch --location=vsplit --title \"swarm-${team_name}-${name}\" --var \"${swarm_var}=true\" --var \"swarm_team=${team_name}\" --var \"swarm_agent=${name}\" --env CLAUDE_CODE_TEAM_NAME=${team_name} --env CLAUDE_CODE_AGENT_ID=${id} --env CLAUDE_CODE_AGENT_NAME=${name} --env CLAUDE_CODE_AGENT_TYPE=${type} claude" >> "$session_file"
        fi
    done < <(jq -r '.members[] | "\(.name)|\(.agentId)|\(.type)|\(.model // "sonnet")"' "$config_file")

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

# ============================================
# MULTIPLEXER-AGNOSTIC WRAPPERS
# ============================================

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

# ============================================
# CLEANUP
# ============================================

cleanup_team() {
    local team_name="$1"
    local force="${2:-false}"

    # Check if team exists
    if [[ ! -d "${TEAMS_DIR}/${team_name}" ]]; then
        echo -e "${RED}Team '${team_name}' not found${NC}"
        return 1
    fi

    if [[ "$force" == "true" ]] || [[ "$force" == "--force" ]]; then
        # Hard cleanup: kill sessions AND delete all data
        echo -e "${CYAN}Hard cleanup for team '${team_name}'...${NC}"

        # Kill sessions based on multiplexer
        case "$SWARM_MULTIPLEXER" in
            kitty)
                # Use registry + live query for comprehensive cleanup
                declare -A closed_agents

                # First, close all registered windows
                while IFS= read -r line; do
                    [[ -n "$line" ]] || continue
                    local agent=$(echo "$line" | jq -r '.agent')
                    local swarm_var=$(echo "$line" | jq -r '.swarm_var')
                    if kitten_cmd close-window --match "var:${swarm_var}" 2>/dev/null; then
                        echo -e "${YELLOW}  Closed (registry): ${agent}${NC}"
                        closed_agents["$agent"]=1
                        unregister_window "$team_name" "$agent"
                    fi
                done < <(get_registered_windows "$team_name" | jq -c '.[]')

                # Then, query live windows to catch any unregistered ones
                while IFS= read -r agent; do
                    [[ -n "$agent" ]] || continue
                    if [[ -z "${closed_agents[$agent]}" ]]; then
                        local swarm_var="swarm_${team_name}_${agent}"
                        if kitten_cmd close-window --match "var:${swarm_var}" 2>/dev/null; then
                            echo -e "${YELLOW}  Closed (live query): ${agent}${NC}"
                        fi
                    fi
                done < <(kitten_cmd ls 2>/dev/null | jq -r --arg team "$team_name" '.[].tabs[].windows[] | select(.user_vars.swarm_team == $team) | .user_vars.swarm_agent' 2>/dev/null)
                ;;
            tmux)
                # Use while read to handle session names properly
                while IFS= read -r session; do
                    [[ -n "$session" ]] || continue
                    tmux kill-session -t "$session"
                    echo -e "${YELLOW}  Closed: ${session}${NC}"
                done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep "swarm-${team_name}")
                ;;
        esac

        # Remove team directory
        if [[ -d "${TEAMS_DIR}/${team_name}" ]]; then
            rm -rf "${TEAMS_DIR}/${team_name}"
            echo -e "${YELLOW}  Removed team directory${NC}"
        fi

        # Remove tasks directory
        if [[ -d "${TASKS_DIR}/${team_name}" ]]; then
            rm -rf "${TASKS_DIR}/${team_name}"
            echo -e "${YELLOW}  Removed tasks directory${NC}"
        fi

        echo -e "${GREEN}Team '${team_name}' deleted${NC}"
    else
        # Soft cleanup: suspend team (kill sessions, keep data)
        suspend_team "$team_name" "true"
    fi
}

# ============================================
# STATUS
# ============================================

swarm_status() {
    local team_name="$1"
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    # Validate team exists
    if [[ ! -f "$config_file" ]]; then
        echo -e "${RED}Team '${team_name}' not found${NC}"
        return 1
    fi

    # Header
    echo -e "${CYAN}=== Team: ${team_name} ===${NC}"
    echo -e "${BLUE}Multiplexer:${NC} ${SWARM_MULTIPLEXER}"
    echo ""

    # Team description
    local description=$(jq -r '.description' "$config_file")
    echo -e "${BLUE}Description:${NC} ${description}"
    echo ""

    # Members section - using helper functions
    echo -e "${BLUE}Members (config vs live):${NC}"
    local live_agents=$(get_live_agents "$team_name")
    local mismatch_count=0

    while IFS='|' read -r name type config_status; do
        [[ -z "$name" ]] && continue

        local result=$(format_member_status "$name" "$type" "$config_status" "$live_agents")
        local display_line="${result%|*}"
        local is_mismatch="${result##*|}"

        echo "$display_line"
        mismatch_count=$((mismatch_count + is_mismatch))
    done < <(jq -r '.members[] | "\(.name)|\(.type)|\(.status)"' "$config_file")

    # Mismatch warning
    if [[ $mismatch_count -gt 0 ]]; then
        echo ""
        echo -e "${YELLOW}  ⚠️  ${mismatch_count} status mismatch(es) detected. Run /claude-swarm:swarm-reconcile to fix.${NC}"
    fi
    echo ""

    # Session file (kitty only)
    if [[ "$SWARM_MULTIPLEXER" == "kitty" ]]; then
        local session_file="${TEAMS_DIR}/${team_name}/swarm.kitty-session"
        if [[ -f "$session_file" ]]; then
            echo -e "${BLUE}Session File:${NC} ${session_file}"
            echo ""
        fi
    fi

    # Task summary - using helper function
    echo -e "${BLUE}Tasks:${NC}"
    local task_summary=$(get_task_summary "$team_name")
    local active="${task_summary%|*}"
    local completed="${task_summary#*|}"

    if [[ "$active" == "0" && "$completed" == "0" ]]; then
        echo "  (no tasks)"
    else
        echo "  Active: ${active}"
        echo "  Completed: ${completed}"
    fi
}


# ============================================
# LIFECYCLE ROBUSTNESS
# ============================================

# Check for stale agents (no activity in 5 minutes)
check_heartbeats() {
    local team_name="$1"
    local stale_threshold="${2:-300}"  # Default: 5 minutes (300 seconds)
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        echo "[]"
        return 1
    fi

    local now=$(date +%s)
    local stale_agents="[]"

    # Find members with stale heartbeats
    while IFS='|' read -r name last_seen status; do
        if [[ "$status" == "active" ]] && [[ -n "$last_seen" ]]; then
            # Convert ISO timestamp to epoch
            local last_seen_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$last_seen" +%s 2>/dev/null || date -d "$last_seen" +%s 2>/dev/null || echo "0")
            local elapsed=$((now - last_seen_epoch))

            if [[ $elapsed -gt $stale_threshold ]]; then
                stale_agents=$(echo "$stale_agents" | jq --arg name "$name" --arg elapsed "$elapsed" '. += [{"name": $name, "staleSec": ($elapsed | tonumber)}]')
            fi
        fi
    done < <(jq -r '.members[] | "\(.name)|\(.lastSeen // "")|\(.status)"' "$config_file")

    echo "$stale_agents"
}

# Detect crashed agents (marked active in config but no live session)
detect_crashed_agents() {
    local team_name="$1"
    local config_file="${TEAMS_DIR}/${team_name}/config.json"

    if [[ ! -f "$config_file" ]]; then
        echo "[]"
        return 1
    fi

    local crashed_agents="[]"

    # Get active members from config
    local active_members=$(jq -r '.members[] | select(.status == "active") | .name' "$config_file")

    # Check each active member for live session
    while IFS= read -r member_name; do
        [[ -z "$member_name" ]] && continue

        local has_session=false

        case "$SWARM_MULTIPLEXER" in
            kitty)
                local swarm_var="swarm_${team_name}_${member_name}"
                if kitten_cmd ls 2>/dev/null | jq -e --arg var "$swarm_var" '.[].tabs[].windows[] | select(.user_vars[$var] != null)' &>/dev/null; then
                    has_session=true
                fi
                ;;
            tmux)
                local safe_team="${team_name//[^a-zA-Z0-9_-]/_}"
                local safe_member="${member_name//[^a-zA-Z0-9_-]/_}"
                local session_name="swarm-${safe_team}-${safe_member}"
                if tmux has-session -t "$session_name" 2>/dev/null; then
                    has_session=true
                fi
                ;;
        esac

        if [[ "$has_session" == "false" ]]; then
            crashed_agents=$(echo "$crashed_agents" | jq --arg name "$member_name" '. += [$name]')
        fi
    done <<< "$active_members"

    echo "$crashed_agents"
}

# Reconcile team status: compare config vs reality and update config
reconcile_team_status() {
    local team_name="$1"
    local config_file="${TEAMS_DIR}/${team_name}/config.json"
    local verbose="${2:-false}"

    if [[ ! -f "$config_file" ]]; then
        [[ "$verbose" == "true" ]] && echo -e "${RED}Team '${team_name}' not found${NC}" >&2
        return 1
    fi

    local changes=0

    # Detect crashed agents
    local crashed=$(detect_crashed_agents "$team_name")
    local crashed_count=$(echo "$crashed" | jq 'length')

    if [[ "$crashed_count" -gt 0 ]]; then
        [[ "$verbose" == "true" ]] && echo -e "${YELLOW}Found ${crashed_count} crashed agent(s)${NC}" >&2

        # Mark crashed agents as offline
        while IFS= read -r member_name; do
            [[ -z "$member_name" ]] && continue
            update_member_status "$team_name" "$member_name" "offline"
            [[ "$verbose" == "true" ]] && echo -e "${YELLOW}  Marked ${member_name} as offline (no session found)${NC}" >&2
            ((changes++))
        done < <(echo "$crashed" | jq -r '.[]')
    fi

    # Check for stale heartbeats
    local stale=$(check_heartbeats "$team_name")
    local stale_count=$(echo "$stale" | jq 'length')

    if [[ "$stale_count" -gt 0 ]]; then
        [[ "$verbose" == "true" ]] && echo -e "${YELLOW}Found ${stale_count} stale agent(s)${NC}" >&2

        while IFS='|' read -r name stale_sec; do
            [[ -z "$name" ]] && continue
            [[ "$verbose" == "true" ]] && echo -e "${YELLOW}  ${name} stale for ${stale_sec}s${NC}" >&2
        done < <(echo "$stale" | jq -r '.[] | "\(.name)|\(.staleSec)"')
    fi

    [[ "$verbose" == "true" ]] && [[ "$changes" -eq 0 ]] && echo -e "${GREEN}Team status is consistent${NC}" >&2

    return 0
}

# ============================================
# UTILITY FUNCTIONS
# ============================================

# List all teams in the teams directory
list_teams() {
    if [[ ! -d "$TEAMS_DIR" ]]; then
        echo "No teams directory found at ${TEAMS_DIR}"
        return 0
    fi

    local team_count=0
    echo "Available teams:"
    echo "----------------"

    while IFS= read -r team_dir; do
        [[ -z "$team_dir" ]] && continue
        local team_name=$(basename "$team_dir")
        local config_file="${team_dir}/config.json"

        if [[ -f "$config_file" ]]; then
            ((team_count++))
            local team_status=$(jq -r '.status // "unknown"' "$config_file")
            local member_count=$(jq -r '.members | length' "$config_file")
            local description=$(jq -r '.description // ""' "$config_file" | head -c 50)

            local status_color="${NC}"
            if [[ "$team_status" == "active" ]]; then
                status_color="${GREEN}"
            elif [[ "$team_status" == "suspended" ]]; then
                status_color="${YELLOW}"
            fi

            echo -e "  ${team_name} ${status_color}[${team_status}]${NC} - ${member_count} members"
            [[ -n "$description" ]] && echo "    ${description}"
        fi
    done < <(find "$TEAMS_DIR" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort)

    if [[ $team_count -eq 0 ]]; then
        echo "  (no teams found)"
    fi
    echo ""
    echo "Total: ${team_count} team(s)"
}

# Delete a task by ID
delete_task() {
    local team_name="${1:-${CLAUDE_CODE_TEAM_NAME:-default}}"
    local task_id="$2"
    local task_file="${TASKS_DIR}/${team_name}/${task_id}.json"

    if [[ -z "$task_id" ]]; then
        echo -e "${RED}Error: task_id is required${NC}"
        echo "Usage: delete_task [team_name] <task_id>"
        return 1
    fi

    if [[ ! -f "$task_file" ]]; then
        echo -e "${RED}Task #${task_id} not found in team '${team_name}'${NC}"
        return 1
    fi

    # Get task info before deletion for confirmation message
    local subject=$(jq -r '.subject // "Unknown"' "$task_file")

    if rm -f "$task_file"; then
        echo -e "${GREEN}Deleted task #${task_id}: ${subject}${NC}"
    else
        echo -e "${RED}Failed to delete task #${task_id}${NC}"
        return 1
    fi
}

# Export functions for use in other scripts
export -f find_kitty_socket validate_kitty_socket kitten_cmd wait_for_claude_ready detect_multiplexer generate_uuid validate_name
export -f register_window unregister_window get_registered_windows clean_window_registry
export -f create_team add_member get_team_config list_team_members
export -f update_team_status update_member_status get_member_status get_team_status
export -f get_live_agents format_member_status get_task_summary
export -f check_heartbeats detect_crashed_agents reconcile_team_status
export -f get_member_context suspend_team resume_team
export -f spawn_teammate_kitty_resume spawn_teammate_tmux_resume
export -f send_message notify_active_teammate read_inbox read_unread_messages mark_messages_read broadcast_message format_messages_xml
export -f create_task get_task update_task list_tasks assign_task
export -f spawn_teammate spawn_teammate_tmux spawn_teammate_kitty
export -f list_swarm_sessions list_swarm_sessions_tmux list_swarm_sessions_kitty
export -f kill_swarm_session kill_swarm_session_tmux kill_swarm_session_kitty
export -f generate_kitty_session launch_kitty_session save_kitty_session
export -f cleanup_team swarm_status
export -f acquire_file_lock release_file_lock
export -f list_teams delete_task
