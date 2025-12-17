#!/bin/bash
# Module: 02-file-lock.sh
# Description: Atomic file locking using mkdir (portable across platforms)
# Dependencies: 00-globals.sh
# Exports: acquire_file_lock, release_file_lock
#
# CRITICAL: These two functions MUST stay together. Never split them into separate files.

# Source guard (prevent double-loading)
[[ -n "${SWARM_FILE_LOCK_LOADED}" ]] && return 0
SWARM_FILE_LOCK_LOADED=1

# Dependency check
if [[ -z "$TEAMS_DIR" ]]; then
    echo "Error: 00-globals.sh must be sourced first" >&2
    return 1
fi

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
    while ! command mkdir "$lock_file" 2>/dev/null; do
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

# Export public API
export -f acquire_file_lock release_file_lock
