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
# EXPORT ALL VARIABLES
# ============================================

export CLAUDE_HOME TEAMS_DIR TASKS_DIR
export RED GREEN YELLOW BLUE CYAN NC
export SWARM_KITTY_MODE SWARM_DEFAULT_ALLOWED_TOOLS SWARM_TEAMMATE_SYSTEM_PROMPT
