#!/bin/bash
# Module: 02-file-lock.sh
# Description: Atomic file locking using mkdir (portable across platforms)
# Dependencies: 00-globals.sh
# Exports: acquire_file_lock, release_file_lock, release_all_locks
#
# CRITICAL: These functions MUST stay together. Never split them into separate files.
#
# Lock Stack Design:
#   Uses a bash array (_SWARM_LOCK_STACK) as a LIFO stack to support nested locks.
#   acquire_file_lock pushes onto the stack; release_file_lock pops from the stack.
#   This ensures nested lock/unlock pairs work correctly even when functions call
#   other functions that also acquire locks.
#
#   Example:
#     acquire_file_lock "config.json"   # stack: [config.json.lock]
#     acquire_file_lock "inbox.json"    # stack: [config.json.lock, inbox.json.lock]
#     release_file_lock                 # pops inbox.json.lock
#     release_file_lock                 # pops config.json.lock
#
#   IMPORTANT: Callers should NOT set their own trap for release_file_lock.
#   The lock module manages its own EXIT trap to clean up all held locks.

# Source guard (prevent double-loading)
[[ -n "${SWARM_FILE_LOCK_LOADED}" ]] && return 0
SWARM_FILE_LOCK_LOADED=1

# Dependency check
if [[ -z "$TEAMS_DIR" ]]; then
    echo "Error: 00-globals.sh must be sourced first" >&2
    return 1
fi

# ============================================
# LOCK STACK (supports nested acquire/release)
# ============================================

# Global lock stack array
declare -a _SWARM_LOCK_STACK=()

# Legacy compatibility: ACQUIRED_LOCK_FILE always reflects the top of the stack
ACQUIRED_LOCK_FILE=""

# Global EXIT trap to release all locks on unexpected exit
_swarm_lock_cleanup() {
    local i
    for (( i=${#_SWARM_LOCK_STACK[@]}-1; i>=0; i-- )); do
        rmdir "${_SWARM_LOCK_STACK[$i]}" 2>/dev/null || true
    done
    _SWARM_LOCK_STACK=()
    ACQUIRED_LOCK_FILE=""
}
trap '_swarm_lock_cleanup' EXIT

# ============================================
# FILE LOCKING (portable atomic locking)
# ============================================

# Acquire a file lock using mkdir (atomic on POSIX systems)
# Usage: acquire_file_lock "/path/to/file.json" [max_attempts] [stale_threshold_sec]
# Returns: 0 on success, 1 on failure
# Side effect: Pushes lock onto _SWARM_LOCK_STACK
acquire_file_lock() {
    local target_file="$1"
    local max_attempts="${2:-50}"
    local stale_threshold="${3:-60}"
    local lock_file="${target_file}.lock"

    # Clean up stale locks older than threshold
    if [[ -d "$lock_file" ]]; then
        local lock_age=$(( $(date +%s) - $(stat -f %m "$lock_file" 2>/dev/null || stat -c %Y "$lock_file" 2>/dev/null || echo 0) ))
        if [[ $lock_age -gt $stale_threshold ]]; then
            if ! rmdir "$lock_file" 2>/dev/null; then
                # rmdir failed (permissions or not empty), try more aggressive cleanup
                echo -e "${YELLOW}Warning: Stale lock exists but rmdir failed, attempting rm -rf${NC}" >&2
                if ! command rm -rf "$lock_file" 2>/dev/null; then
                    echo -e "${RED}Error: Cannot remove stale lock ${lock_file} (check permissions)${NC}" >&2
                    # Continue anyway - maybe the lock will be released by its owner
                fi
            fi
        fi
    fi

    local attempt=0
    while ! command mkdir "$lock_file" 2>/dev/null; do
        ((attempt++))
        if [[ $attempt -ge $max_attempts ]]; then
            echo -e "${RED}Failed to acquire lock for ${target_file}${NC}" >&2
            return 1
        fi
        sleep 0.1
    done

    # Push lock onto stack
    _SWARM_LOCK_STACK+=("$lock_file")
    # Legacy compatibility: always points to most recently acquired lock
    ACQUIRED_LOCK_FILE="$lock_file"
    return 0
}

# Release a file lock
# Usage: release_file_lock [lock_file]
# If no argument provided, pops and releases the most recently acquired lock (LIFO)
# If lock_file is provided, releases that specific lock and removes it from the stack
release_file_lock() {
    local lock_file="$1"

    if [[ -n "$lock_file" ]]; then
        # Explicit lock file: release it and remove from stack
        rmdir "$lock_file" 2>/dev/null || true
        # Remove from stack (find and splice out)
        local new_stack=()
        local i
        for (( i=0; i<${#_SWARM_LOCK_STACK[@]}; i++ )); do
            if [[ "${_SWARM_LOCK_STACK[$i]}" != "$lock_file" ]]; then
                new_stack+=("${_SWARM_LOCK_STACK[$i]}")
            fi
        done
        _SWARM_LOCK_STACK=("${new_stack[@]}")
    else
        # No argument: pop the most recent lock (LIFO)
        local stack_len=${#_SWARM_LOCK_STACK[@]}
        if [[ $stack_len -gt 0 ]]; then
            local top_lock="${_SWARM_LOCK_STACK[$((stack_len - 1))]}"
            rmdir "$top_lock" 2>/dev/null || true
            # Pop from stack
            unset '_SWARM_LOCK_STACK[-1]'
        fi
    fi

    # Update legacy variable to reflect current top of stack
    local new_len=${#_SWARM_LOCK_STACK[@]}
    if [[ $new_len -gt 0 ]]; then
        ACQUIRED_LOCK_FILE="${_SWARM_LOCK_STACK[$((new_len - 1))]}"
    else
        ACQUIRED_LOCK_FILE=""
    fi
}

# Release all held locks (for explicit cleanup)
# Usage: release_all_locks
release_all_locks() {
    local i
    for (( i=${#_SWARM_LOCK_STACK[@]}-1; i>=0; i-- )); do
        rmdir "${_SWARM_LOCK_STACK[$i]}" 2>/dev/null || true
    done
    _SWARM_LOCK_STACK=()
    ACQUIRED_LOCK_FILE=""
}

# Export public API
export -f acquire_file_lock release_file_lock release_all_locks
