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
# Kitty creates sockets like /tmp/kitty-$USER-$PID, so we need to find it dynamically

# Helper function to find the kitty socket
find_kitty_socket() {
    # First check if KITTY_LISTEN_ON is set explicitly
    if [[ -n "$KITTY_LISTEN_ON" ]]; then
        echo "$KITTY_LISTEN_ON"
        return 0
    fi

    # Find the most recent kitty socket
    local socket=$(ls -t /tmp/kitty-$(whoami)-* 2>/dev/null | head -1)
    if [[ -S "$socket" ]]; then
        echo "unix:$socket"
        return 0
    fi

    # Fallback to simple pattern (in case kitty config uses exact name)
    if [[ -S "/tmp/kitty-$(whoami)" ]]; then
        echo "unix:/tmp/kitty-$(whoami)"
        return 0
    fi

    return 1
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

    # Add member to config with status tracking
    local tmp_file=$(mktemp)
    local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    jq --arg id "$agent_id" \
       --arg name "$agent_name" \
       --arg type "$agent_type" \
       --arg color "$agent_color" \
       --arg model "$agent_model" \
       --arg ts "$timestamp" \
       '.members += [{"agentId": $id, "name": $name, "type": $type, "color": $color, "model": $model, "status": "active", "lastSeen": $ts}]' \
       "$config_file" >| "$tmp_file" && command mv "$tmp_file" "$config_file"

    # Initialize inbox for new member
    echo "[]" > "${TEAMS_DIR}/${team_name}/inboxes/${agent_name}.json"

    echo -e "${GREEN}Added '${agent_name}' to team '${team_name}'${NC}"
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

    local tmp_file=$(mktemp)
    local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    jq --arg name "$member_name" --arg status "$new_status" --arg ts "$timestamp" \
       '(.members[] | select(.name == $name)) |= (.status = $status | .lastSeen = $ts)' \
       "$config_file" >| "$tmp_file" && command mv "$tmp_file" "$config_file"
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
        local json_files=("$tasks_dir"/*.json)
        if [[ -e "${json_files[0]}" ]]; then
            for task_file in "${json_files[@]}"; do
                if [[ -f "$task_file" ]]; then
                    local owner=$(jq -r '.owner // ""' "$task_file")
                    if [[ "$owner" == "$member_name" ]]; then
                        local id=$(jq -r '.id' "$task_file")
                        local subject=$(jq -r '.subject' "$task_file")
                        local status=$(jq -r '.status' "$task_file")
                        assigned_tasks="${assigned_tasks}\n  - Task #${id} [${status}]: ${subject}"
                    fi
                fi
            done
        fi
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
                for member in "${members[@]}"; do
                    if [[ "$member" != "team-lead" ]]; then
                        local swarm_var="swarm_${team_name}_${member}"
                        kitten_cmd close-window --match "var:${swarm_var}" 2>/dev/null && \
                            echo -e "${YELLOW}  Closed: ${member}${NC}"
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

    # Mark current session (team-lead) as active
    update_member_status "$team_name" "team-lead" "active"

    # Get offline members (excluding team-lead)
    local offline_members=$(jq -r '.members[] | select(.status == "offline" and .name != "team-lead") | "\(.name)|\(.type)|\(.model // "sonnet")"' "$config_file")

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

    # Launch with default allowed tools (comma-separated, quoted)
    # shellcheck disable=SC2086
    kitten_cmd launch --type="$launch_type" $location_arg \
        --title "$window_title" \
        --var "${swarm_var}=true" \
        --var "swarm_team=${team_name}" \
        --var "swarm_agent=${agent_name}" \
        --env "CLAUDE_CODE_TEAM_NAME=${team_name}" \
        --env "CLAUDE_CODE_AGENT_ID=${agent_id}" \
        --env "CLAUDE_CODE_AGENT_NAME=${agent_name}" \
        --env "CLAUDE_CODE_AGENT_TYPE=${agent_type}" \
        claude --model "$model" --dangerously-skip-permissions

    # Wait and send prompt
    echo "    Waiting for Claude Code to start..."
    sleep 4

    kitten_cmd send-text --match "var:${swarm_var}" -- "$initial_prompt"
    sleep 0.5
    kitten_cmd send-text --match "var:${swarm_var}" $'\r'

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
    tmux new-session -d -s "$session_name"

    # Safely escape variables using printf %q
    local safe_team_val=$(printf %q "$team_name")
    local safe_id_val=$(printf %q "$agent_id")
    local safe_name_val=$(printf %q "$agent_name")
    local safe_type_val=$(printf %q "$agent_type")

    # Set environment variables and launch claude using send-keys (safe)
    # Include default allowed tools for swarm coordination
    tmux send-keys -t "$session_name" "export CLAUDE_CODE_TEAM_NAME=$safe_team_val CLAUDE_CODE_AGENT_ID=$safe_id_val CLAUDE_CODE_AGENT_NAME=$safe_name_val CLAUDE_CODE_AGENT_TYPE=$safe_type_val && claude --model $model --dangerously-skip-permissions" Enter

    sleep 1
    # Use -l flag to send prompt as literal text (prevents key sequence injection)
    tmux send-keys -t "$session_name" -l "$initial_prompt"
    tmux send-keys -t "$session_name" Enter

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
    local lock_file="${inbox_file}.lock"

    if [[ ! -f "$inbox_file" ]]; then
        echo -e "${RED}Inbox for '${to}' not found in team '${team_name}'${NC}"
        return 1
    fi

    # Atomic file locking using mkdir (mkdir is atomic)
    # Clean up stale locks older than 60 seconds
    if [[ -d "$lock_file" ]]; then
        local lock_age=$(( $(date +%s) - $(stat -f %m "$lock_file" 2>/dev/null || stat -c %Y "$lock_file" 2>/dev/null || echo 0) ))
        if [[ $lock_age -gt 60 ]]; then
            rmdir "$lock_file" 2>/dev/null || true
        fi
    fi

    local max_attempts=50
    local attempt=0
    while ! mkdir "$lock_file" 2>/dev/null; do
        ((attempt++))
        if [[ $attempt -ge $max_attempts ]]; then
            echo -e "${RED}Failed to acquire lock for inbox${NC}" >&2
            return 1
        fi
        sleep 0.1
    done

    # Function to clean up lock - called explicitly, not via trap
    _cleanup_lock() {
        rmdir "$lock_file" 2>/dev/null || true
    }

    local tmp_file=$(mktemp)
    if [[ -z "$tmp_file" ]]; then
        echo -e "${RED}Failed to create temp file${NC}" >&2
        _cleanup_lock
        return 1
    fi

    local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    if jq --arg from "$from" \
          --arg text "$message" \
          --arg color "$color" \
          --arg ts "$timestamp" \
          '. += [{"from": $from, "text": $text, "color": $color, "read": false, "timestamp": $ts}]' \
          "$inbox_file" >| "$tmp_file" && command mv "$tmp_file" "$inbox_file"; then
        _cleanup_lock
        echo -e "${GREEN}Message sent to '${to}'${NC}"
    else
        rm -f "$tmp_file"
        _cleanup_lock
        echo -e "${RED}Failed to update inbox${NC}" >&2
        return 1
    fi
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

    local tmp_file=$(mktemp)
    jq '[.[] | .read = true]' "$inbox_file" >| "$tmp_file" && command mv "$tmp_file" "$inbox_file"
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

    # Read members using while loop (handles names with spaces/special chars)
    while IFS= read -r member; do
        [[ -n "$member" ]] || continue
        if [[ "$member" != "$exclude" ]]; then
            send_message "$team_name" "$member" "$message"
        fi
    done < <(jq -r '.members[].name' "$config_file")
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
    local max_id=0
    local json_files=("$tasks_dir"/*.json)
    if [[ -e "${json_files[0]}" ]]; then
        for f in "${json_files[@]}"; do
            if [[ -f "$f" ]]; then
                local id=$(basename "$f" .json)
                if [[ "$id" =~ ^[0-9]+$ ]] && [[ $id -gt $max_id ]]; then
                    max_id=$id
                fi
            fi
        done
    fi
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
            status: "open",
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

    command mv "$tmp_file" "$task_file"
    echo -e "${GREEN}Updated task #${task_id}${NC}"
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

    local json_files=("$tasks_dir"/*.json)
    if [[ -e "${json_files[0]}" ]]; then
        for task_file in "${json_files[@]}"; do
            if [[ -f "$task_file" ]]; then
                local id=$(jq -r '.id' "$task_file")
                local subject=$(jq -r '.subject' "$task_file")
                local status=$(jq -r '.status' "$task_file")
                local owner=$(jq -r '.owner // "unassigned"' "$task_file")
                local blocked_by=$(jq -r '.blockedBy | if length > 0 then " [blocked by #" + (. | join(", #")) + "]" else "" end' "$task_file")

                local status_color="${NC}"
                if [[ "$status" == "open" ]]; then
                    status_color="${YELLOW}"
                elif [[ "$status" == "resolved" ]]; then
                    status_color="${GREEN}"
                fi

                echo -e "#${id} ${status_color}[${status}]${NC} ${subject} (${owner})${blocked_by}"
            fi
        done
    else
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
    tmux new-session -d -s "$session_name"

    # Safely escape variables using printf %q
    local safe_team_val=$(printf %q "$team_name")
    local safe_id_val=$(printf %q "$agent_id")
    local safe_name_val=$(printf %q "$agent_name")
    local safe_type_val=$(printf %q "$agent_type")

    # Set environment variables and launch claude using send-keys (safe)
    # Include default allowed tools for swarm coordination
    tmux send-keys -t "$session_name" "export CLAUDE_CODE_TEAM_NAME=$safe_team_val CLAUDE_CODE_AGENT_ID=$safe_id_val CLAUDE_CODE_AGENT_NAME=$safe_name_val CLAUDE_CODE_AGENT_TYPE=$safe_type_val && claude --model $model --dangerously-skip-permissions" Enter

    # Give it a moment to start
    sleep 1

    # Send initial prompt
    # Use -l flag to send prompt as literal text (prevents key sequence injection)
    tmux send-keys -t "$session_name" -l "$initial_prompt"
    tmux send-keys -t "$session_name" Enter

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

    # Launch new kitty window/tab with env vars AND user variable for identification
    # --var sets a persistent user variable that survives title changes
    # --allowedTools uses comma-separated, quoted patterns to avoid zsh glob expansion
    # shellcheck disable=SC2086
    kitten_cmd launch --type="$launch_type" $location_arg \
        --title "$window_title" \
        --var "${swarm_var}=true" \
        --var "swarm_team=${team_name}" \
        --var "swarm_agent=${agent_name}" \
        --env "CLAUDE_CODE_TEAM_NAME=${team_name}" \
        --env "CLAUDE_CODE_AGENT_ID=${agent_id}" \
        --env "CLAUDE_CODE_AGENT_NAME=${agent_name}" \
        --env "CLAUDE_CODE_AGENT_TYPE=${agent_type}" \
        claude --model "$model" --dangerously-skip-permissions

    # Wait for Claude Code to fully initialize (it takes several seconds)
    echo "  Waiting for Claude Code to start..."
    sleep 4

    # Send initial prompt using user variable match (works even if title changes)
    # Use \r (carriage return) to actually submit, not \n (which just adds a line)
    kitten_cmd send-text --match "var:${swarm_var}" -- "$initial_prompt"
    sleep 0.5
    kitten_cmd send-text --match "var:${swarm_var}" $'\r'

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
cd ${HOME}

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
                # Use while read to handle names with spaces/special chars
                while IFS= read -r agent; do
                    [[ -n "$agent" ]] || continue
                    local swarm_var="swarm_${team_name}_${agent}"
                    kitten_cmd close-window --match "var:${swarm_var}" 2>/dev/null
                    echo -e "${YELLOW}  Closed: ${agent}${NC}"
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

    if [[ ! -f "$config_file" ]]; then
        echo -e "${RED}Team '${team_name}' not found${NC}"
        return 1
    fi

    echo -e "${CYAN}=== Team: ${team_name} ===${NC}"
    echo -e "${BLUE}Multiplexer:${NC} ${SWARM_MULTIPLEXER}"
    echo ""

    # Team info
    local description=$(jq -r '.description' "$config_file")
    echo -e "${BLUE}Description:${NC} ${description}"
    echo ""

    # Members
    echo -e "${BLUE}Members:${NC}"
    jq -r '.members[] | "  - \(.name) (\(.type))"' "$config_file"
    echo ""

    # Active sessions (based on multiplexer)
    echo -e "${BLUE}Active Sessions:${NC}"
    case "$SWARM_MULTIPLEXER" in
        kitty)
            local windows=$(kitten_cmd ls 2>/dev/null | jq -r --arg team "$team_name" '.[].tabs[].windows[] | select(.user_vars.swarm_team == $team) | .user_vars.swarm_agent' 2>/dev/null || true)
            if [[ -n "$windows" ]]; then
                echo "$windows" | sed 's/^/  - /'
            else
                echo "  (none)"
            fi
            ;;
        tmux)
            local sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep "swarm-${team_name}" || true)
            if [[ -n "$sessions" ]]; then
                echo "$sessions" | sed 's/^/  - /'
            else
                echo "  (none)"
            fi
            ;;
        *)
            echo "  (no multiplexer)"
            ;;
    esac
    echo ""

    # Session file (kitty only)
    if [[ "$SWARM_MULTIPLEXER" == "kitty" ]]; then
        local session_file="${TEAMS_DIR}/${team_name}/swarm.kitty-session"
        if [[ -f "$session_file" ]]; then
            echo -e "${BLUE}Session File:${NC} ${session_file}"
            echo ""
        fi
    fi

    # Task summary
    echo -e "${BLUE}Tasks:${NC}"
    local tasks_dir="${TASKS_DIR}/${team_name}"
    if [[ -d "$tasks_dir" ]]; then
        local open=$(find "$tasks_dir" -name "*.json" -exec jq -r 'select(.status == "open") | .id' {} \; 2>/dev/null | wc -l | tr -d ' ')
        local resolved=$(find "$tasks_dir" -name "*.json" -exec jq -r 'select(.status == "resolved") | .id' {} \; 2>/dev/null | wc -l | tr -d ' ')
        echo "  Open: ${open}"
        echo "  Resolved: ${resolved}"
    else
        echo "  (no tasks)"
    fi
}

# Export functions for use in other scripts
export -f find_kitty_socket kitten_cmd detect_multiplexer generate_uuid validate_name
export -f create_team add_member get_team_config list_team_members
export -f update_team_status update_member_status get_member_status get_team_status
export -f get_member_context suspend_team resume_team
export -f spawn_teammate_kitty_resume spawn_teammate_tmux_resume
export -f send_message read_inbox read_unread_messages mark_messages_read broadcast_message format_messages_xml
export -f create_task get_task update_task list_tasks assign_task
export -f spawn_teammate spawn_teammate_tmux spawn_teammate_kitty
export -f list_swarm_sessions list_swarm_sessions_tmux list_swarm_sessions_kitty
export -f kill_swarm_session kill_swarm_session_tmux kill_swarm_session_kitty
export -f generate_kitty_session launch_kitty_session save_kitty_session
export -f cleanup_team swarm_status
