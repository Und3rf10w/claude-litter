#!/bin/bash
# Module: 03-multiplexer.sh
# Description: Multiplexer detection and kitty socket management
# Dependencies: 00-globals.sh, 01-utils.sh
# Exports: find_kitty_socket, validate_kitty_socket, kitten_cmd, wait_for_claude_ready

# Source guard (prevent double-loading)
[[ -n "${SWARM_MULTIPLEXER_LOADED}" ]] && return 0
SWARM_MULTIPLEXER_LOADED=1

# Dependency check
if [[ -z "$TEAMS_DIR" ]]; then
    echo "Error: 00-globals.sh must be sourced first" >&2
    return 1
fi

# Auto-detect or use override
SWARM_MULTIPLEXER="${SWARM_MULTIPLEXER:-$(detect_multiplexer)}"

# ============================================
# KITTY SOCKET DISCOVERY AND VALIDATION
# ============================================

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
    for socket in $(command ls -t /tmp/kitty-${user}-* 2>/dev/null); do
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
    echo -e "  6. Check existing sockets: command ls -la /tmp/kitty-${user}*" >&2
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
# Uses bash integer arithmetic with deciseconds to avoid bc dependency
wait_for_claude_ready() {
    local swarm_var="$1"
    local max_wait="${2:-15}"  # Maximum wait time in seconds (default 15)

    # Convert to deciseconds (tenths of a second) for integer arithmetic
    local max_wait_ds=$((max_wait * 10))
    local elapsed_ds=0
    local poll_interval_ds=5  # 0.5 seconds = 5 deciseconds

    echo "  Waiting for Claude Code to start (max ${max_wait}s)..."

    while (( elapsed_ds < max_wait_ds )); do
        # Check if window exists in active tab (scoped to prevent false positives from other tabs)
        # Note: During spawn, the active tab is where we just spawned the window
        if kitten_cmd ls 2>/dev/null | jq -e --arg var "$swarm_var" \
            '.[].tabs[] | select(.is_active == true) | .windows[] | select(.user_vars[$var] != null)' &>/dev/null; then
            # Window exists, give it a moment to fully initialize
            sleep 1
            local elapsed_sec=$((elapsed_ds / 10))
            echo "  Claude Code is ready (took ${elapsed_sec}s)"
            return 0
        fi

        sleep 0.5
        ((elapsed_ds += poll_interval_ds))
    done

    # Timeout reached
    echo "  Warning: Claude Code may not be fully ready yet (waited ${max_wait}s)"
    return 1
}

# Export public API
export -f find_kitty_socket validate_kitty_socket kitten_cmd wait_for_claude_ready
