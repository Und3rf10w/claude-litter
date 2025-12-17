#!/bin/bash
# claude-swarm utilities - Main entry point
# Sources all modular components in correct dependency order
# All shared functions for swarm management

# Determine library directory (use realpath for robustness across sourcing contexts)
# Handle both absolute and relative sourcing, symlinks, and different working directories
# Support both bash (BASH_SOURCE) and zsh (${(%):-%x})
if [[ -n "${BASH_SOURCE[0]}" ]]; then
    SWARM_SCRIPT_PATH="${BASH_SOURCE[0]}"
elif [[ -n "${ZSH_VERSION}" ]]; then
    SWARM_SCRIPT_PATH="${(%):-%x}"
else
    SWARM_SCRIPT_PATH="$0"
fi

if [[ -z "$SWARM_SCRIPT_PATH" ]]; then
    # Final fallback: assume we're already in the lib directory
    SWARM_LIB_DIR="$(pwd)"
elif command -v realpath &>/dev/null; then
    # GNU/Linux and modern macOS realpath (preferred - canonicalizes path)
    SWARM_LIB_DIR="$(dirname "$(realpath "$SWARM_SCRIPT_PATH")")"
elif [[ $(readlink -f /dev/null 2>/dev/null) ]]; then
    # macOS/BSD readlink -f (check if supported first)
    SWARM_LIB_DIR="$(dirname "$(readlink -f "$SWARM_SCRIPT_PATH" 2>/dev/null)")"
else
    # Fallback: cd+pwd method (preserves symlinks but resolves relative paths)
    SWARM_LIB_DIR="$(cd "$(dirname "$SWARM_SCRIPT_PATH")" 2>/dev/null && pwd)"
fi

# ============================================
# LOAD MODULES IN DEPENDENCY ORDER
# ============================================

# Level 0: Globals (no dependencies)
source "${SWARM_LIB_DIR}/core/00-globals.sh" 2>&1

# Level 1: Core utilities
source "${SWARM_LIB_DIR}/core/01-utils.sh" 2>&1
source "${SWARM_LIB_DIR}/core/02-file-lock.sh" 2>&1

# Level 2: Multiplexer
source "${SWARM_LIB_DIR}/multiplexer/03-multiplexer.sh" 2>&1

# Level 3: Registry and Team
source "${SWARM_LIB_DIR}/multiplexer/04-registry.sh" 2>&1
source "${SWARM_LIB_DIR}/team/05-team.sh" 2>&1

# Level 4: Status and Messaging
source "${SWARM_LIB_DIR}/team/06-status.sh" 2>&1
source "${SWARM_LIB_DIR}/communication/07-messaging.sh" 2>&1

# Level 5: Tasks and Spawn
source "${SWARM_LIB_DIR}/tasks/08-tasks.sh" 2>&1
source "${SWARM_LIB_DIR}/spawn/09-spawn.sh" 2>&1

# Level 6: Lifecycle and Sessions
source "${SWARM_LIB_DIR}/team/10-lifecycle.sh" 2>&1
source "${SWARM_LIB_DIR}/spawn/12-kitty-session.sh" 2>&1

# Level 7: Cleanup and Diagnostics
source "${SWARM_LIB_DIR}/spawn/11-cleanup.sh" 2>&1
source "${SWARM_LIB_DIR}/spawn/13-diagnostics.sh" 2>&1
