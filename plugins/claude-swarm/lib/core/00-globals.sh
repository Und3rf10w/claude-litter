#!/bin/bash
# Module: 00-globals.sh
# Description: Global variables, colors, and environment configuration
# Dependencies: None
# Exports: Global variables only (no functions)

# Source guard (prevent double-loading)
[[ -n "${SWARM_GLOBALS_LOADED}" ]] && return 0
SWARM_GLOBALS_LOADED=1

# ============================================
# DIRECTORY PATHS
# ============================================

CLAUDE_HOME="${HOME}/.claude"
TEAMS_DIR="${CLAUDE_HOME}/teams"
TASKS_DIR="${CLAUDE_HOME}/tasks"

# ============================================
# COLORS FOR OUTPUT
# ============================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# ============================================
# CONFIGURATION VARIABLES
# ============================================

# Kitty spawn mode: split (default), tab, window (os-window)
SWARM_KITTY_MODE="${SWARM_KITTY_MODE:-split}"

# Default allowed tools for teammates (safe operations for swarm coordination)
# These tools are pre-approved so teammates can work autonomously
# Override with SWARM_ALLOWED_TOOLS environment variable
# Note: Use comma-separated patterns to avoid zsh glob expansion issues with (*)
# The variable should be quoted when passed to --allowedTools
SWARM_DEFAULT_ALLOWED_TOOLS="${SWARM_ALLOWED_TOOLS:-Read(*),Glob(*),Grep(*),SlashCommand(*),Bash(*)}"

# System prompt for teammates - appended to default Claude Code behavior
# Provides guidance on slash commands, communication patterns, and swarm conventions
# Note: Detailed guidance is available in the swarm-teammate skill (auto-loads via CLAUDE_CODE_TEAM_NAME)
SWARM_TEAMMATE_SYSTEM_PROMPT='You are a teammate in a Claude Code swarm. The swarm-teammate skill will auto-load with detailed guidance.

ALWAYS load the swarm-teammate skill first.

## Quick Reference

### Check Inbox FIRST
/claude-swarm:swarm-inbox

### Essential Commands
- /claude-swarm:task-list - View all tasks
- /claude-swarm:task-update <id> --assign <name> - Claim task
- /claude-swarm:task-update <id> --status <status> - Update status
- /claude-swarm:task-update <id> --comment <text> - Add progress
- /claude-swarm:swarm-message <to> <message> - Message teammate

### Core Workflow
1. Check inbox regularly
2. Claim tasks (--assign your-name, --status in-progress)
3. Update progress frequently (--comment)
4. Complete and notify (--status completed, message dependencies)

### Communication
- Message ANY teammate (not just team-lead)
- Reply promptly to messages
- Notify when you complete work others depend on
- Coordinate with teammates working on related tasks

For detailed guidance, examples, and best practices, the swarm-teammate skill provides comprehensive documentation.'

# ============================================
# EXPORT ALL VARIABLES
# ============================================

export CLAUDE_HOME TEAMS_DIR TASKS_DIR
export RED GREEN YELLOW BLUE CYAN NC
export SWARM_KITTY_MODE SWARM_DEFAULT_ALLOWED_TOOLS SWARM_TEAMMATE_SYSTEM_PROMPT
