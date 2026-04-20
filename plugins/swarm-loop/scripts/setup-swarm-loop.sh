#!/bin/bash

# Swarm Loop Setup Script v2.0
# Creates structured state file, narrative log, and hook-based safety for the swarm loop

set -euo pipefail

# Parse arguments
PROMPT_PARTS=()
COMPLETION_PROMISE=""
SOFT_BUDGET=10
MIN_ITERATIONS=0
MAX_ITERATIONS=0
VERIFY_CMD=""
SAFE_MODE="true"
MODE="default"
PROMPT_FILE=""
TEAM_NAME=""

while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help)
      cat << 'HELP_EOF'
Swarm Loop — Orchestrated multi-agent iterative development

USAGE:
  /swarm-loop [GOAL...] [OPTIONS]

ARGUMENTS:
  GOAL...    The goal to accomplish (can be multiple words)

OPTIONS:
  --completion-promise '<text>'  Promise phrase — loop runs until this is true
  --soft-budget <n>              Iteration count for a progress checkpoint (default: 10, 0 to disable)
  --min-iterations <n>           Hard minimum — promise suppressed until N iterations complete (default: 0, disabled)
  --max-iterations <n>           Hard ceiling — force-stop after N iterations (default: 0, unlimited)
  --verify '<command>'           Shell command that must pass for completion (exit 0 = pass)
  --safe-mode true|false         Enable/disable safe mode (default: true). Safe mode generates
                                 PermissionRequest and SubagentStart hooks for autonomous operation.
  --mode <name>                  Profile to use for orchestrator prompts (default: default).
                                 Available profiles are in the profiles/ directory of the plugin.
  --team-name '<name>'           Base team name (random suffix appended for uniqueness).
                                 Default: derived from goal text.
  --prompt-file <path>           Read the goal/prompt from a file instead of positional arguments.
                                 Supports multiline markdown content. Overrides positional GOAL words.
  -h, --help                     Show this help

DESCRIPTION:
  Starts an orchestrated multi-agent loop. Each iteration, Claude:
    1. Reads progress from structured state + narrative log
    2. Decomposes remaining work into parallel subtasks using native TaskCreate
    3. Sends work to teammates in the persistent team (created once for entire loop)
    4. Monitors teammate messages, persists results immediately, and re-plans
    5. Writes the instance sentinel file to signal iteration complete
    6. Repeats until the completion promise is genuinely fulfilled

  The completion promise is the primary exit mechanism. Use --min-iterations to
  force a minimum number of passes, and --max-iterations for a hard ceiling.

EXAMPLES:
  /swarm-loop Build a REST API with auth and tests --completion-promise 'All endpoints work and tests pass'
  /swarm-loop Refactor auth to JWT --completion-promise 'JWT auth working' --verify 'npm test'
  /swarm-loop Migrate to TypeScript --completion-promise 'All files converted' --soft-budget 20
  /swarm-loop Thorough refactor --completion-promise 'All refactored' --min-iterations 3 --max-iterations 10

MONITORING:
  /swarm-status                               View current progress
  cat .claude/swarm-loop/<id>/state.json      Raw state
  cat .claude/swarm-loop/<id>/log.md          Narrative history
  /cancel-swarm                               Stop the loop

CONFIGURATION:
  /swarm-settings                  View/edit loop configuration (.claude/swarm-loop.local.md)

HELP_EOF
      exit 0
      ;;
    --completion-promise)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --completion-promise requires a text argument" >&2
        echo "   Example: --completion-promise 'All tests pass'" >&2
        exit 1
      fi
      COMPLETION_PROMISE="$2"
      shift 2
      ;;
    --soft-budget)
      if [[ -z "${2:-}" ]] || ! [[ "$2" =~ ^[0-9]+$ ]]; then
        echo "Error: --soft-budget requires a non-negative integer (0 disables checkpoint)" >&2
        exit 1
      fi
      SOFT_BUDGET="$2"
      shift 2
      ;;
    --min-iterations)
      if [[ -z "${2:-}" ]] || ! [[ "$2" =~ ^[0-9]+$ ]]; then
        echo "Error: --min-iterations requires a non-negative integer (0 disables)" >&2
        exit 1
      fi
      MIN_ITERATIONS="$2"
      shift 2
      ;;
    --max-iterations)
      if [[ -z "${2:-}" ]] || ! [[ "$2" =~ ^[0-9]+$ ]]; then
        echo "Error: --max-iterations requires a non-negative integer (0 = unlimited)" >&2
        exit 1
      fi
      MAX_ITERATIONS="$2"
      shift 2
      ;;
    --verify)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --verify requires a command" >&2
        echo "   Example: --verify 'npm test'" >&2
        exit 1
      fi
      VERIFY_CMD="$2"
      shift 2
      ;;
    --safe-mode)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --safe-mode requires true or false" >&2
        exit 1
      fi
      case "$2" in
        true|false) SAFE_MODE="$2" ;;
        *) echo "Error: --safe-mode must be 'true' or 'false', got '$2'" >&2; exit 1 ;;
      esac
      shift 2
      ;;
    --mode)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --mode requires a profile name" >&2
        exit 1
      fi
      MODE="$2"
      shift 2
      ;;
    --team-name)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --team-name requires a name" >&2
        exit 1
      fi
      TEAM_NAME="$2"
      shift 2
      ;;
    --prompt-file)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --prompt-file requires a file path" >&2
        exit 1
      fi
      if [[ ! -f "$2" ]]; then
        echo "Error: prompt file not found: $2" >&2
        exit 1
      fi
      PROMPT_FILE="$2"
      shift 2
      ;;
    *)
      PROMPT_PARTS+=("$1")
      shift
      ;;
  esac
done

GOAL="${PROMPT_PARTS[*]:-}"

# ── Prompt-file helpers ──────────────────────────────────────────
# Strip surrounding single or double quotes from a value, with leading/trailing whitespace trim.
_strip_quotes() {
  local val="$1"
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  if [[ "$val" =~ ^\'(.*)\'$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  elif [[ "$val" =~ ^\"(.*)\"$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  else
    printf '%s' "$val"
  fi
}

# Pre-process a prompt file so that known flags land on their own lines.
# $ARGUMENTS often arrives as a single line with the goal and flags concatenated.
# The line-oriented parser below only matches flags at line-start, so we split them.
_preprocess_prompt_file() {
  local file="$1"
  perl -0777 -pe '
    s/\r//g;
    my $flag_re = "completion-promise|soft-budget|min-iterations|max-iterations|safe-mode|verify|mode|team-name";
    s/[^\S\n]+(--(?:$flag_re)(?:=\s*(?:'"'"'[^'"'"']*'"'"'|"[^"]*"|\S+)|\s+(?:'"'"'[^'"'"']*'"'"'|"[^"]*"|\S+)))/\n$1/gx;
  ' "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
}

# If --prompt-file was given, read the file and extract flags + goal from its content.
# Lines starting with -- are parsed as flags. Everything else is the goal text.
# This avoids shell expansion issues with multiline/special-char prompts.
if [[ -n "$PROMPT_FILE" ]]; then
  _preprocess_prompt_file "$PROMPT_FILE"
  _goal_lines=()
  while IFS= read -r _line || [[ -n "$_line" ]]; do
    _line="${_line//$'\r'/}"
    case "$_line" in
      --completion-promise\ *)  COMPLETION_PROMISE="$(_strip_quotes "${_line#--completion-promise }")" ;;
      --completion-promise=*)   COMPLETION_PROMISE="$(_strip_quotes "${_line#--completion-promise=}")" ;;
      --soft-budget\ *)         SOFT_BUDGET="${_line#--soft-budget }" ;;
      --soft-budget=*)          SOFT_BUDGET="${_line#--soft-budget=}" ;;
      --min-iterations\ *)      MIN_ITERATIONS="${_line#--min-iterations }" ;;
      --min-iterations=*)       MIN_ITERATIONS="${_line#--min-iterations=}" ;;
      --max-iterations\ *)      MAX_ITERATIONS="${_line#--max-iterations }" ;;
      --max-iterations=*)       MAX_ITERATIONS="${_line#--max-iterations=}" ;;
      --verify\ *)              VERIFY_CMD="$(_strip_quotes "${_line#--verify }")" ;;
      --verify=*)               VERIFY_CMD="$(_strip_quotes "${_line#--verify=}")" ;;
      --safe-mode\ *)           SAFE_MODE="${_line#--safe-mode }" ;;
      --safe-mode=*)            SAFE_MODE="${_line#--safe-mode=}" ;;
      --mode\ *)                MODE="${_line#--mode }" ;;
      --mode=*)                 MODE="${_line#--mode=}" ;;
      --team-name\ *)           TEAM_NAME="$(_strip_quotes "${_line#--team-name }")" ;;
      --team-name=*)            TEAM_NAME="$(_strip_quotes "${_line#--team-name=}")" ;;
      --*)                      ;;  # skip unknown flags
      *)                        [[ -n "$_line" ]] && _goal_lines+=("$_line") ;;
    esac
  done < "$PROMPT_FILE"
  rm -f "$PROMPT_FILE"
  # Join goal lines with newlines (preserves multiline markdown)
  GOAL="$(printf '%s\n' "${_goal_lines[@]+"${_goal_lines[@]}"}")"
  # Trim trailing newline
  GOAL="${GOAL%$'\n'}"
fi

if [[ -z "$GOAL" ]]; then
  echo "Error: No goal provided" >&2
  echo "" >&2
  echo "   Usage: /swarm-loop <GOAL> --completion-promise '<condition>'" >&2
  echo "" >&2
  echo "   The goal text goes first, followed by any flags:" >&2
  echo "" >&2
  echo "   Examples:" >&2
  echo "     /swarm-loop Build a REST API --completion-promise 'API complete'" >&2
  echo "     /swarm-loop Fix all lint errors --completion-promise 'Zero lint errors'" >&2
  echo "" >&2
  echo "   With --prompt-file, the file should contain the goal text (one or more lines)" >&2
  echo "   with optional flags on their own lines starting with '--':" >&2
  echo "" >&2
  echo "     Build a REST API with auth and tests" >&2
  echo "     --completion-promise 'All endpoints work and tests pass'" >&2
  echo "     --max-iterations 5" >&2
  echo "" >&2
  echo "   For help: /swarm-loop --help" >&2
  exit 1
fi

if [[ -z "$COMPLETION_PROMISE" ]]; then
  echo "Error: --completion-promise is required" >&2
  echo "" >&2
  echo "   The completion promise is the ONLY way to stop the loop." >&2
  echo "   It should describe a verifiable condition that's true when the goal is met." >&2
  echo "" >&2
  echo "   Examples:" >&2
  echo "     --completion-promise 'All tests pass and code is documented'" >&2
  echo "     --completion-promise 'Migration complete and verified'" >&2
  echo "     --completion-promise 'DONE'" >&2
  exit 1
fi

# Create state directory
mkdir -p .claude

# Resolve session ID early — needed for duplicate instance detection below.
SESSION_ID="${CLAUDE_CODE_SESSION_ID:-}"
if [[ -z "$SESSION_ID" ]]; then
  SESSION_ID="swarm-$(head -c 8 /dev/urandom | od -A n -t x1 | tr -d ' \n')-$(date +%s)"
fi

# Guard against concurrent loops — use a lockfile with noclobber for atomic check-and-create.
# This prevents TOCTOU races where two invocations could both pass a simple -f check.
LOCKFILE=".claude/swarm-loop.local.lock"
if ! (set -o noclobber; echo $$ > "$LOCKFILE") 2>/dev/null; then
  # Lock exists — check if the holding process is still alive
  LOCK_PID=$(cat "$LOCKFILE" 2>/dev/null)
  if [[ -n "$LOCK_PID" ]] && ! kill -0 "$LOCK_PID" 2>/dev/null; then
    # Stale lock from a killed process — reclaim it
    rm -f "$LOCKFILE"
    if ! (set -o noclobber; echo $$ > "$LOCKFILE") 2>/dev/null; then
      echo "Error: Failed to reclaim stale lockfile" >&2
      exit 1
    fi
  else
    # Lock is held by a live process, or state file indicates active loop
    for _sf in .claude/swarm-loop/*/state.json; do
      [[ -f "$_sf" ]] || continue
      _existing_session=$(jq -r '.session_id // ""' "$_sf" 2>/dev/null)
      if [[ "$_existing_session" == "$SESSION_ID" ]]; then
        EXISTING_GOAL=$(jq -r '.goal // "unknown"' "$_sf" 2>/dev/null)
        EXISTING_ITER=$(jq -r '.iteration // "?"' "$_sf" 2>/dev/null)
        echo "Error: A swarm loop is already active for this session!" >&2
        echo "" >&2
        echo "   Goal: $EXISTING_GOAL" >&2
        echo "   Iteration: $EXISTING_ITER" >&2
        echo "" >&2
        echo "   To stop it first: /cancel-swarm" >&2
        echo "   To check status:  /swarm-status" >&2
        exit 1
      fi
    done
    echo "Error: Another swarm loop is being set up concurrently" >&2
    exit 1
  fi
fi
# The lockfile is removed on ALL exit paths (success and failure) because the state
# file is the durable guard once written. The lock only protects the setup transaction
# itself — after setup completes, the state file's existence prevents concurrent loops.
# A crashed setup that never writes the state file will have its lock cleaned up by the
# trap, leaving no stale lock — the state-file check (below) is the authoritative guard.
trap 'rm -f "$LOCKFILE" ".claude/settings.local.json.tmp.$$"' EXIT

# Also check if state file already exists (lockfile was stale from a crashed setup)
for _sf in .claude/swarm-loop/*/state.json; do
  [[ -f "$_sf" ]] || continue
  _existing_session=$(jq -r '.session_id // ""' "$_sf" 2>/dev/null)
  if [[ "$_existing_session" == "$SESSION_ID" ]]; then
    EXISTING_GOAL=$(jq -r '.goal // "unknown"' "$_sf" 2>/dev/null)
    EXISTING_ITER=$(jq -r '.iteration // "?"' "$_sf" 2>/dev/null)
    echo "Error: A swarm loop is already active for this session!" >&2
    echo "" >&2
    echo "   Goal: $EXISTING_GOAL" >&2
    echo "   Iteration: $EXISTING_ITER" >&2
    echo "" >&2
    echo "   To stop it first: /cancel-swarm" >&2
    echo "   To check status:  /swarm-status" >&2
    exit 1
  fi
done

# Stale instance-dir cleanup happens after INSTANCE_DIR is derived below

# Read optional config from .claude/swarm-loop.local.md
# Parse YAML frontmatter values using grep/sed — no yq dependency
LOCAL_CONFIG=".claude/swarm-loop.local.md"
COMPACT_ON_ITERATION="false"
CLEAR_ON_ITERATION="false"
SENTINEL_TIMEOUT=600
CLASSIFIER_ENABLED="true"
CLASSIFIER_MODEL="sonnet"
CLASSIFIER_EFFORT="auto"
CLASSIFIER_PRE_TOOL_USE="true"
CLASSIFIER_TASK_COMPLETED="false"
TEAMMATES_ISOLATION="worktree"
TEAMMATES_MAX_COUNT=8
NOTIFICATIONS_ENABLED="false"
NOTIFICATIONS_CHANNEL=""

if [[ -f "$LOCAL_CONFIG" ]]; then
  # Extract frontmatter between --- markers
  FRONTMATTER=$(awk '/^---/{if(++c==1){next}else{exit}} c==1' "$LOCAL_CONFIG" 2>/dev/null || true)
  if [[ -n "$FRONTMATTER" ]]; then
    _val=$(echo "$FRONTMATTER" | grep -E '^compact_on_iteration:' | sed 's/compact_on_iteration:[[:space:]]*//' | tr -d ' ' || true)
    [[ -n "$_val" ]] && COMPACT_ON_ITERATION="$_val"

    _val=$(echo "$FRONTMATTER" | grep -E '^clear_on_iteration:' | sed 's/clear_on_iteration:[[:space:]]*//' | tr -d ' ' || true)
    [[ -n "$_val" ]] && CLEAR_ON_ITERATION="$_val"

    # FF2 mutex: clear_on_iteration supersedes compact_on_iteration (both discard
    # prior transcript; clear is strictly stronger). If both are true in the file
    # (hand-edited), warn and let clear win.
    if [[ "$CLEAR_ON_ITERATION" == "true" ]] && [[ "$COMPACT_ON_ITERATION" == "true" ]]; then
      echo "swarm-loop: clear_on_iteration supersedes compact_on_iteration; disabling compact for this session" >&2
      COMPACT_ON_ITERATION="false"
    fi

    _val=$(echo "$FRONTMATTER" | grep -E '^min_iterations:' | sed 's/min_iterations:[[:space:]]*//' | tr -d ' ' || true)
    [[ -n "$_val" ]] && MIN_ITERATIONS="$_val"

    _val=$(echo "$FRONTMATTER" | grep -E '^max_iterations:' | sed 's/max_iterations:[[:space:]]*//' | tr -d ' ' || true)
    [[ -n "$_val" ]] && MAX_ITERATIONS="$_val"

    _val=$(echo "$FRONTMATTER" | grep -E '^sentinel_timeout:' | sed 's/sentinel_timeout:[[:space:]]*//' | tr -d ' ' || true)
    [[ -n "$_val" ]] && SENTINEL_TIMEOUT="$_val"

    # Section-aware parsing: extract each YAML section block, then grep within it.
    # This avoids ambiguity between identically-named keys in different sections
    # (e.g., classifier.enabled vs notifications.enabled).
    _extract_section() {
      # Extract lines belonging to a top-level section (from "key:" to the next top-level key or EOF)
      echo "$FRONTMATTER" | awk -v section="$1" '
        $0 ~ "^"section":" { found=1; next }
        found && /^[^ ]/ { exit }
        found { print }
      '
    }

    # classifier section
    CLASSIFIER_SECTION=$(_extract_section "classifier")
    _val=$(echo "$CLASSIFIER_SECTION" | grep -E '^\s+enabled:' | sed 's/.*enabled:[[:space:]]*//' | tr -d ' ' || true)
    [[ -n "$_val" ]] && CLASSIFIER_ENABLED="$_val"

    _val=$(echo "$CLASSIFIER_SECTION" | grep -E '^\s+model:' | sed 's/.*model:[[:space:]]*//' | tr -d ' ' || true)
    [[ -n "$_val" ]] && CLASSIFIER_MODEL="$_val"

    _val=$(echo "$CLASSIFIER_SECTION" | grep -E '^\s+effort:' | sed 's/.*effort:[[:space:]]*//' | tr -d ' ' || true)
    [[ -n "$_val" ]] && [[ "$_val" != "null" ]] && CLASSIFIER_EFFORT="$_val"

    # classifier.checks — pre-tool-use and task-completed are unique keys,
    # so we can grep directly from the classifier section
    _val=$(echo "$CLASSIFIER_SECTION" | grep -E 'pre-tool-use:' | sed 's/.*pre-tool-use:[[:space:]]*//' | tr -d ' ' || true)
    [[ -n "$_val" ]] && CLASSIFIER_PRE_TOOL_USE="$_val"

    _val=$(echo "$CLASSIFIER_SECTION" | grep -E 'task-completed:' | sed 's/.*task-completed:[[:space:]]*//' | tr -d ' ' || true)
    [[ -n "$_val" ]] && CLASSIFIER_TASK_COMPLETED="$_val"

    # teammates section
    TEAMMATES_SECTION=$(_extract_section "teammates")
    _val=$(echo "$TEAMMATES_SECTION" | grep -E '^\s+isolation:' | sed 's/.*isolation:[[:space:]]*//' | tr -d ' ' || true)
    [[ -n "$_val" ]] && TEAMMATES_ISOLATION="$_val"

    _val=$(echo "$TEAMMATES_SECTION" | grep -E '^\s+max-count:' | sed 's/.*max-count:[[:space:]]*//' | tr -d ' ' || true)
    [[ -n "$_val" ]] && TEAMMATES_MAX_COUNT="$_val"

    # notifications section
    NOTIFICATIONS_SECTION=$(_extract_section "notifications")
    _val=$(echo "$NOTIFICATIONS_SECTION" | grep -E '^\s+enabled:' | sed 's/.*enabled:[[:space:]]*//' | tr -d ' ' || true)
    [[ -n "$_val" ]] && NOTIFICATIONS_ENABLED="$_val"

    _val=$(echo "$NOTIFICATIONS_SECTION" | grep -E '^\s+channel:' | sed 's/.*channel:[[:space:]]*//' | tr -d ' ' || true)
    [[ -n "$_val" ]] && [[ "$_val" != "null" ]] && NOTIFICATIONS_CHANNEL="$_val"
  fi
fi

# Validate numeric config values (argjson will abort on non-numeric input)
if ! [[ "$SENTINEL_TIMEOUT" =~ ^[0-9]+$ ]]; then
  echo "Error: sentinel_timeout must be a non-negative integer, got '$SENTINEL_TIMEOUT'" >&2
  exit 1
fi
if ! [[ "$TEAMMATES_MAX_COUNT" =~ ^[0-9]+$ ]]; then
  echo "Error: teammates.max-count must be a non-negative integer, got '$TEAMMATES_MAX_COUNT'" >&2
  exit 1
fi
if ! [[ "$MIN_ITERATIONS" =~ ^[0-9]+$ ]]; then
  echo "Error: min_iterations must be a non-negative integer, got '$MIN_ITERATIONS'" >&2
  exit 1
fi
if ! [[ "$MAX_ITERATIONS" =~ ^[0-9]+$ ]]; then
  echo "Error: max_iterations must be a non-negative integer, got '$MAX_ITERATIONS'" >&2
  exit 1
fi
if [[ $MIN_ITERATIONS -gt 0 ]] && [[ $MAX_ITERATIONS -gt 0 ]] && [[ $MIN_ITERATIONS -gt $MAX_ITERATIONS ]]; then
  echo "Error: --min-iterations ($MIN_ITERATIONS) cannot exceed --max-iterations ($MAX_ITERATIONS)" >&2
  exit 1
fi

# Create structured state file (v2 schema — no tasks[], no agent_results[])
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Generate instance ID: first 8 hex chars of sha256(session_id)
# SESSION_ID was resolved earlier (before lockfile acquisition) for duplicate detection.
INSTANCE_ID=$(printf '%s' "$SESSION_ID" | shasum -a 256 2>/dev/null || printf '%s' "$SESSION_ID" | sha256sum 2>/dev/null)
INSTANCE_ID="${INSTANCE_ID:0:8}"
if [[ ! "$INSTANCE_ID" =~ ^[0-9a-f]{8}$ ]]; then
  INSTANCE_ID=$(head -c 4 /dev/urandom | od -A n -t x1 | tr -d ' \n')
fi

INSTANCE_DIR="${CLAUDE_PROJECT_DIR:-$(pwd -P)}/.claude/swarm-loop/${INSTANCE_ID}"
mkdir -p "$INSTANCE_DIR"

# Extend trap to cover instance-specific temp files now that INSTANCE_DIR is known
trap 'rm -f "$LOCKFILE" "${INSTANCE_DIR}/state.json.tmp.$$" ".claude/settings.local.json.tmp.$$"' EXIT

# Clean up stale instance directory for this session if it exists from a crashed previous run
if [[ -d "$INSTANCE_DIR" ]]; then
  rm -f "${INSTANCE_DIR}/deepplan."*
fi

# Derive team_name: use --team-name if provided, otherwise slugify the goal
if [[ -z "$TEAM_NAME" ]]; then
  TEAM_NAME="swarm-$(echo "$GOAL" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/-\{2,\}/-/g; s/^-//; s/-$//' | cut -c1-30)"
fi
# Always append random suffix for uniqueness
TEAM_NAME="${TEAM_NAME}-$(head -c 4 /dev/urandom | od -A n -t x1 | tr -d ' \n')"

# Resolve absolute plugin root path for hook script references.
# ${CLAUDE_PLUGIN_ROOT} is NOT resolved in settings.local.json — must use absolute path.
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [[ -z "$PLUGIN_ROOT" ]]; then
  # Fallback: derive from script location
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

# Validate profile (must happen before state file creation + schema merge)
PROFILE_DIR="${PLUGIN_ROOT}/profiles/${MODE}"
if [[ ! -d "$PROFILE_DIR" ]] || [[ ! -f "$PROFILE_DIR/PROFILE.md" ]]; then
  echo "Error: Unknown mode '${MODE}' — no profile found at ${PROFILE_DIR}" >&2
  echo "   Available profiles: $(ls "${PLUGIN_ROOT}/profiles/" 2>/dev/null | tr '\n' ' ')" >&2
  exit 1
fi

jq -n \
  --arg goal "$GOAL" \
  --arg promise "$COMPLETION_PROMISE" \
  --argjson budget "$SOFT_BUDGET" \
  --argjson min_iterations "$MIN_ITERATIONS" \
  --argjson max_iterations "$MAX_ITERATIONS" \
  --arg verify "$VERIFY_CMD" \
  --arg session "$SESSION_ID" \
  --arg instance_id "$INSTANCE_ID" \
  --arg started "$NOW" \
  --arg now "$NOW" \
  --arg team "$TEAM_NAME" \
  --arg mode "$MODE" \
  --argjson safe_mode_val "$([ "$SAFE_MODE" = "true" ] && echo true || echo false)" \
  --argjson compact_on_iter "$([ "$COMPACT_ON_ITERATION" = "true" ] && echo true || echo false)" \
  --argjson clear_on_iter "$([ "$CLEAR_ON_ITERATION" = "true" ] && echo true || echo false)" \
  --argjson sentinel_timeout_val "$SENTINEL_TIMEOUT" \
  --arg teammates_isolation "$TEAMMATES_ISOLATION" \
  --argjson teammates_max_count "$TEAMMATES_MAX_COUNT" \
  '{
    "version": 2,
    "mode": $mode,
    "goal": $goal,
    "completion_promise": $promise,
    "soft_budget": $budget,
    "min_iterations": $min_iterations,
    "max_iterations": $max_iterations,
    "verify_command": $verify,
    "session_id": $session,
    "instance_id": $instance_id,
    "iteration": 1,
    "phase": "initial",
    "started_at": $started,
    "last_updated": $now,
    "team_name": $team,
    "safe_mode": $safe_mode_val,
    "compact_on_iteration": $compact_on_iter,
    "clear_on_iteration": $clear_on_iter,
    "sentinel_timeout": $sentinel_timeout_val,
    "teammates_isolation": $teammates_isolation,
    "teammates_max_count": $teammates_max_count,
    "permission_failures": [],
    "autonomy_health": "healthy",
    "progress_history": []
  }' > "${INSTANCE_DIR}/state.json.tmp.$$"
mv "${INSTANCE_DIR}/state.json.tmp.$$" "${INSTANCE_DIR}/state.json"

# Merge profile state extensions (if any)
PROFILE_SCHEMA="${PROFILE_DIR}/state-schema.json"
if [[ -f "$PROFILE_SCHEMA" ]] && [[ -s "$PROFILE_SCHEMA" ]]; then
  _schema_content=$(cat "$PROFILE_SCHEMA")
  if [[ "$_schema_content" != "{}" ]]; then
    jq -s '.[0] * .[1]' "${INSTANCE_DIR}/state.json" "$PROFILE_SCHEMA" > "${INSTANCE_DIR}/state.json.tmp.$$"
    if [[ -s "${INSTANCE_DIR}/state.json.tmp.$$" ]]; then
      mv "${INSTANCE_DIR}/state.json.tmp.$$" "${INSTANCE_DIR}/state.json"
    else
      rm -f "${INSTANCE_DIR}/state.json.tmp.$$"
    fi
  fi
fi

# Create narrative log (use printf to avoid shell expansion of user-controlled content)
{
  printf '%s\n' "# Swarm Loop Log" ""
  printf '**Goal:** %s\n' "$GOAL"
  printf '**Completion Promise:** `%s`\n' "$COMPLETION_PROMISE"
  printf '**Started:** %s\n' "$NOW"
  printf '%s\n' "" "---" "" "## Iteration 1 — Initial Assessment" "" "*(Orchestrator will write the first entry here)*" ""
} > "${INSTANCE_DIR}/log.md"

# Initialize progress.jsonl for append-only progress tracking (used by TaskCompleted gate hook)
touch "${INSTANCE_DIR}/progress.jsonl"

# Persist the original prompt into the instance dir for reference / re-runs
printf '%s\n' "$GOAL" > "${INSTANCE_DIR}/prompt.md"

# Build settings.local.json with hook-based safety.
# Replaces the v1 defaultMode: acceptEdits approach.
SETTINGS_LOCAL=".claude/settings.local.json"

# Backup settings.local.json before modifying (only if no backup already exists)
if [[ -f "$SETTINGS_LOCAL" ]] && [[ ! -f "${SETTINGS_LOCAL}.swarm-backup" ]]; then
  cp "$SETTINGS_LOCAL" "${SETTINGS_LOCAL}.swarm-backup"
fi

# Build the hooks object using jq. Each hook is conditionally included.

# PermissionRequest auto-approve hook (safe mode only)
# Allows Edit|Write|Read|Glob|Grep without prompting during autonomous operation.
PERMISSION_REQUEST_HOOK='null'
if [[ "$SAFE_MODE" == "true" ]]; then
  PERMISSION_REQUEST_HOOK=$(jq -n '[{
    "matcher": "Edit|Write|Read|Glob|Grep",
    "hooks": [{
      "type": "command",
      "command": "echo '"'"'{\"hookSpecificOutput\":{\"hookEventName\":\"PermissionRequest\",\"decision\":{\"behavior\":\"allow\"}}}'"'"'"
    }]
  }]')
fi

# Resolve classifier model — used by both PreToolUse and TaskCompleted hooks
# Use model aliases (sonnet, haiku, opus) — Claude Code resolves these internally
# Validate against allowlist to prevent injection via crafted config values
if [[ ! "$CLASSIFIER_MODEL" =~ ^[a-z0-9-]+$ ]]; then
  echo "Error: classifier.model must match ^[a-z0-9-]+$, got '$CLASSIFIER_MODEL'" >&2
  exit 1
fi
CLASSIFIER_MODEL_ID="$CLASSIFIER_MODEL"

# Validate effort against known values
if [[ "$CLASSIFIER_EFFORT" != "auto" ]] && [[ "$CLASSIFIER_EFFORT" != "null" ]]; then
  case "$CLASSIFIER_EFFORT" in
    low|medium|high|max) ;;
    *) echo "Error: classifier.effort must be one of low|medium|high|max|auto, got '$CLASSIFIER_EFFORT'" >&2; exit 1 ;;
  esac
fi

CLASSIFIER_SYSTEM_PROMPT="You are a safety classifier for a swarm loop orchestrator. Your job is to evaluate bash commands and block dangerous ones. A command is DANGEROUS if it: deletes files/directories outside .claude/, force-pushes git branches, drops databases, kills system processes, modifies system files, or exfiltrates data. A command is SAFE if it: reads files, runs tests, installs packages, creates/edits project files, runs build/lint/format tools, queries APIs, or operates on swarm-loop state files under .claude/swarm-loop/ (touch, rm -f, mkdir -p, cat, jq on files under .claude/swarm-loop/). Always ALLOW operations on files under .claude/swarm-loop/ — these are the orchestrator's own state files. Respond with JSON: {\"decision\": \"allow\"} or {\"decision\": \"block\", \"reason\": \"<short reason>\"}. When in doubt, allow. Only block clearly dangerous commands."

# PreToolUse Bash classifier hook (when classifier enabled)
PRE_TOOL_USE_HOOK='null'
if [[ "$SAFE_MODE" == "true" ]] && [[ "$CLASSIFIER_ENABLED" == "true" ]] && [[ "$CLASSIFIER_PRE_TOOL_USE" == "true" ]]; then
  if [[ "$CLASSIFIER_EFFORT" != "auto" ]] && [[ "$CLASSIFIER_EFFORT" != "null" ]]; then
    # Use command hook for explicit effort control (native prompt hooks don't support --effort)
    # Hook input comes via stdin as JSON with tool_input.command — extract and pipe to classifier
    PRE_TOOL_USE_HOOK=$(jq -n \
      --arg model "$CLASSIFIER_MODEL_ID" \
      --arg effort "$CLASSIFIER_EFFORT" \
      --arg system_prompt "$CLASSIFIER_SYSTEM_PROMPT" \
      '[{
        "matcher": "Bash",
        "hooks": [{
          "type": "command",
          "command": ("HOOK_CMD=$(cat | jq -r '\"'\"'.tool_input.command // \"\"'\"'\"'); printf '\"'\"'Evaluate this bash command:\\n%s'\"'\"' \"$HOOK_CMD\" | claude -p --bare --model " + ($model | @sh) + " --effort " + ($effort | @sh) + " --system-prompt " + ($system_prompt | @sh))
        }]
      }]')
  else
    # Use native prompt hook (faster, no CLI dependency)
    PRE_TOOL_USE_HOOK=$(jq -n \
      --arg model "$CLASSIFIER_MODEL_ID" \
      --arg system_prompt "$CLASSIFIER_SYSTEM_PROMPT" \
      '[{
        "matcher": "Bash",
        "hooks": [{
          "type": "prompt",
          "prompt": $system_prompt,
          "model": $model
        }]
      }]')
  fi
fi

# SubagentStart safety injection hook (safe mode only)
# Injects safety context into all teammates automatically.
SUBAGENT_START_HOOK='null'
if [[ "$SAFE_MODE" == "true" ]]; then
  SUBAGENT_START_HOOK=$(jq -n \
    --arg goal "$GOAL" \
    --arg team "$TEAM_NAME" \
    '{ "hookSpecificOutput": { "hookEventName": "SubagentStart", "additionalContext": ("You are a teammate in swarm loop team " + $team + " working on: " + $goal + ". Follow your assigned task, partition file ownership carefully, and send your results to team-lead via SendMessage when done. Do not delete or overwrite files owned by other teammates.") } } as $payload |
    [{
      "hooks": [{
        "type": "command",
        "command": ("printf '"'"'%s'"'"' " + ($payload | tojson | @sh))
      }]
    }]')
fi

# SubagentStop cleanup hook (always, async)
# Fires when any teammate stops — logs in_progress task warnings and cleans up retry counters.
SUBAGENT_STOP_SCRIPT="$PLUGIN_ROOT/hooks/subagent-stop.sh"
SUBAGENT_STOP_HOOK=$(jq -n \
  --arg script "$SUBAGENT_STOP_SCRIPT" \
  '[{
    "hooks": [{
      "type": "command",
      "command": ("bash " + ($script | @sh)),
      "async": true,
      "timeout": 30
    }]
  }]')

# SessionStart(clear|compact) context re-injection hook (always)
# Fires after auto-compaction or manual /clear to restore orchestrator identity.
SESSION_CONTEXT_SCRIPT="$PLUGIN_ROOT/hooks/session-context.sh"
SESSION_START_HOOK=$(jq -n \
  --arg script "$SESSION_CONTEXT_SCRIPT" \
  '[{
    "matcher": "clear|compact",
    "hooks": [{
      "type": "command",
      "command": ("bash " + ($script | @sh))
    }]
  }]')

# PostToolUse heartbeat hook (always, async)
# Updates .claude/swarm-loop.local.heartbeat.json after every tool call. Throttled to 5s.
HEARTBEAT_SCRIPT="$PLUGIN_ROOT/hooks/heartbeat-update.sh"
POST_TOOL_USE_HOOKS=$(jq -n \
  --arg script "$HEARTBEAT_SCRIPT" \
  '[{
    "matcher": ".*",
    "hooks": [{
      "type": "command",
      "command": ("bash " + ($script | @sh)),
      "async": true,
      "timeout": 5
    }]
  }]')

# TaskCompleted notification hook (when notifications enabled, async)
if [[ "$NOTIFICATIONS_ENABLED" == "true" ]] && [[ -n "$NOTIFICATIONS_CHANNEL" ]]; then
  NOTIFY_SCRIPT="$PLUGIN_ROOT/hooks/notify-task-complete.sh"
  TASK_COMPLETED_HOOK=$(jq -n \
    --arg script "$NOTIFY_SCRIPT" \
    '[{
      "hooks": [{
        "type": "command",
        "command": ("bash " + ($script | @sh)),
        "async": true,
        "timeout": 10
      }]
    }]')
else
  TASK_COMPLETED_HOOK='null'
fi

# TaskCompleted verification hook (when classifier.checks.task-completed enabled)
if [[ "$SAFE_MODE" == "true" ]] && [[ "$CLASSIFIER_ENABLED" == "true" ]] && [[ "$CLASSIFIER_TASK_COMPLETED" == "true" ]]; then
  TASK_COMPLETED_VERIFY_HOOK=$(jq -n \
    --arg model "${CLASSIFIER_MODEL_ID:-sonnet}" \
    '[{
      "hooks": [{
        "type": "prompt",
        "prompt": "You are verifying task completion in a swarm loop. Check if the task was genuinely completed. Look at the tool results and outputs. If the task appears complete, respond with {\"decision\": \"allow\"}. If it appears incomplete or failed, respond with {\"decision\": \"block\", \"reason\": \"<brief explanation>\"}.",
        "model": $model
      }]
    }]')
  # Merge with notification hook if both are set
  if [[ "$TASK_COMPLETED_HOOK" != "null" ]]; then
    MERGED=$(echo "$TASK_COMPLETED_VERIFY_HOOK $TASK_COMPLETED_HOOK" | jq -s '.[0] + .[1]' 2>/dev/null)
    if [[ -n "$MERGED" ]]; then
      TASK_COMPLETED_HOOK="$MERGED"
    else
      TASK_COMPLETED_HOOK="$TASK_COMPLETED_VERIFY_HOOK"
    fi
  else
    TASK_COMPLETED_HOOK="$TASK_COMPLETED_VERIFY_HOOK"
  fi
fi

# TaskCompleted gate hook (always — artifact verification + JSONL progress tracking)
GATE_SCRIPT="$PLUGIN_ROOT/hooks/task-completed-gate.sh"
TASK_COMPLETED_GATE=$(jq -n \
  --arg script "$GATE_SCRIPT" \
  --arg instance_dir "$INSTANCE_DIR" \
  --arg mode "$MODE" \
  '[{
    "hooks": [{
      "type": "command",
      "command": ("bash " + ($script | @sh) + " " + ($instance_dir | @sh) + " " + ($mode | @sh)),
      "timeout": 30
    }]
  }]')

# Merge gate into TaskCompleted — gate MUST be first (synchronous, runs before async notify)
if [[ "$TASK_COMPLETED_HOOK" == "null" ]]; then
  TASK_COMPLETED_HOOK="$TASK_COMPLETED_GATE"
else
  TASK_COMPLETED_HOOK=$(echo "$TASK_COMPLETED_GATE $TASK_COMPLETED_HOOK" | jq -s '.[0] + .[1]')
fi

# TaskCreated gate hook (always — max task cap enforcement)
CREATED_GATE_SCRIPT="$PLUGIN_ROOT/hooks/task-created-gate.sh"
TASK_CREATED_HOOK=$(jq -n \
  --arg script "$CREATED_GATE_SCRIPT" \
  --arg instance_dir "$INSTANCE_DIR" \
  --arg mode "$MODE" \
  --argjson max_tasks "$TEAMMATES_MAX_COUNT" \
  '[{
    "hooks": [{
      "type": "command",
      "command": ("bash " + ($script | @sh) + " " + ($instance_dir | @sh) + " " + ($mode | @sh) + " " + ($max_tasks | tostring)),
      "timeout": 30
    }]
  }]')

# TaskCreated scope classifier (deepplan only — LLM-based scope enforcement)
if [[ "$MODE" == "deepplan" ]]; then
  TASK_CREATED_CLASSIFIER=$(jq -n \
    '[{
      "hooks": [{
        "type": "prompt",
        "prompt": "You are a scope enforcement classifier for a deepplan (planning-only) session. An agent is creating a task. Evaluate ONLY whether the task subject describes planning, analysis, exploration, research, or review work (ALLOW) versus implementation, coding, building, or deployment work (BLOCK). Respond with a single JSON object: {\"decision\": \"allow\"} or {\"decision\": \"block\", \"reason\": \"...\"}",
        "model": "haiku"
      }]
    }]')
  TASK_CREATED_HOOK=$(echo "$TASK_CREATED_HOOK $TASK_CREATED_CLASSIFIER" | jq -s '.[0] + .[1]')
fi

# StopFailure observability hook (always, async)
STOP_FAILURE_SCRIPT="$PLUGIN_ROOT/hooks/stop-failure.sh"
STOP_FAILURE_HOOK=$(jq -n \
  --arg script "$STOP_FAILURE_SCRIPT" \
  '[{
    "hooks": [{
      "type": "command",
      "command": ("bash " + ($script | @sh)),
      "async": true,
      "timeout": 15
    }]
  }]')

# PermissionDenied observability hook (always, async)
# Records teammate permission failures in state.json for stuck escalation.
PERMISSION_DENIED_SCRIPT="$PLUGIN_ROOT/hooks/permission-denied.sh"
PERMISSION_DENIED_HOOK=$(jq -n \
  --arg script "$PERMISSION_DENIED_SCRIPT" \
  '[{
    "hooks": [{
      "type": "command",
      "command": ("bash " + ($script | @sh)),
      "async": true,
      "timeout": 15
    }]
  }]')

# Assemble the full settings object
# Build hooks object, omitting null entries. Tag each matcher with _swarm for selective cleanup.
HOOKS_JSON=$(jq -n \
  --argjson perm "$PERMISSION_REQUEST_HOOK" \
  --argjson pre "$PRE_TOOL_USE_HOOK" \
  --argjson subagent "$SUBAGENT_START_HOOK" \
  --argjson session "$SESSION_START_HOOK" \
  --argjson post "$POST_TOOL_USE_HOOKS" \
  --argjson task_completed "$TASK_COMPLETED_HOOK" \
  --argjson task_created "$TASK_CREATED_HOOK" \
  --argjson stop_failure "$STOP_FAILURE_HOOK" \
  --argjson subagent_stop "$SUBAGENT_STOP_HOOK" \
  --argjson perm_denied "$PERMISSION_DENIED_HOOK" \
  '{
    PermissionRequest: $perm,
    PreToolUse: $pre,
    SubagentStart: $subagent,
    SubagentStop: $subagent_stop,
    SessionStart: $session,
    PostToolUse: $post,
    TaskCompleted: $task_completed,
    TaskCreated: $task_created,
    StopFailure: $stop_failure,
    PermissionDenied: $perm_denied
  } | with_entries(select(.value != null)) |
  # Tag every matcher object so fallback cleanup can selectively remove swarm hooks
  map_values([.[] | . + {"_swarm": true}])')

# Base permissions (always include swarm file access)
SWARM_PERMS='["Edit(.claude/swarm-loop/**)", "Write(.claude/swarm-loop/**)", "Read(.claude/swarm-loop/**)"]'

if [[ -f "$SETTINGS_LOCAL" ]]; then
  # Merge permissions and hooks into existing file
  jq \
    --argjson swarm_perms "$SWARM_PERMS" \
    --argjson new_hooks "$HOOKS_JSON" \
    '
      .permissions.allow = (
        (.permissions.allow // []) + $swarm_perms | unique
      ) |
      # Remove defaultMode: acceptEdits if present from a previous v1 setup
      del(.permissions.defaultMode) |
      # Merge hooks: for each event key, merge arrays (or set if absent)
      .hooks = (
        (.hooks // {}) as $existing |
        $new_hooks | to_entries | reduce .[] as $entry (
          $existing;
          .[$entry.key] = ((.[$entry.key] // []) + $entry.value)
        )
      )
    ' "$SETTINGS_LOCAL" > "${SETTINGS_LOCAL}.tmp.$$"
else
  # Create new settings file
  jq -n \
    --argjson swarm_perms "$SWARM_PERMS" \
    --argjson new_hooks "$HOOKS_JSON" \
    '{
      "permissions": {
        "allow": $swarm_perms
      },
      "hooks": $new_hooks
    }' > "${SETTINGS_LOCAL}.tmp.$$"
fi
if [[ -s "${SETTINGS_LOCAL}.tmp.$$" ]]; then
  mv "${SETTINGS_LOCAL}.tmp.$$" "$SETTINGS_LOCAL"
else
  echo "Error: failed to generate settings.local.json (empty output from jq)" >&2
  rm -f "${SETTINGS_LOCAL}.tmp.$$"
  exit 1
fi

# Create project-local verification script if --verify was provided.
# In v2 the generated script is simplified — no tasks[] checks (native task system handles that).
if [[ -n "$VERIFY_CMD" ]]; then
  # Base64 encode the verify command to avoid all quoting issues.
  VERIFY_B64=$(printf '%s' "$VERIFY_CMD" | base64 | tr -d '\n')
  # Write the script with the base64 value embedded directly (no post-write substitution).
  cat > "${INSTANCE_DIR}/verify.sh" <<VERIFY_EOF
#!/bin/bash
# Auto-generated verification script for swarm-loop (v2)
set -euo pipefail

STATE_FILE="\${1:-${INSTANCE_DIR}/state.json}"

# Run custom verification command (base64-encoded at setup time)
VERIFY_CMD=\$(printf '%s' '${VERIFY_B64}' | base64 --decode 2>/dev/null || printf '%s' '${VERIFY_B64}' | base64 -D)
if [[ -z "\$VERIFY_CMD" ]]; then
  echo "Error: failed to decode verification command (no base64 decoder available)" >&2
  exit 1
fi
echo "Running verification: \$VERIFY_CMD"
if ! bash -c "\$VERIFY_CMD"; then
  echo "Verification command failed: \$VERIFY_CMD"
  exit 1
fi

echo "All checks passed"
exit 0
VERIFY_EOF
  chmod +x "${INSTANCE_DIR}/verify.sh"
fi

# Output setup message (use printf for user-controlled content to prevent shell expansion)
printf '%s\n' "Swarm Loop v2.0 activated!" ""
printf 'Goal: %s\n' "$GOAL"
printf 'Completion Promise: %s\n' "$COMPLETION_PROMISE"
printf 'Soft Budget: %s iterations (checkpoint, not a limit)\n' "$SOFT_BUDGET"
if [[ "$MIN_ITERATIONS" -gt 0 ]]; then printf 'Min Iterations: %s (hard floor — promise suppressed until then)\n' "$MIN_ITERATIONS"; fi
if [[ "$MAX_ITERATIONS" -gt 0 ]]; then printf 'Max Iterations: %s (hard ceiling — force-stop after)\n' "$MAX_ITERATIONS"; fi
if [[ -n "$VERIFY_CMD" ]]; then printf 'Verification: %s\n' "$VERIFY_CMD"; fi
if [[ "$SAFE_MODE" == "true" ]]; then echo "Safe Mode: enabled (hook-based: PermissionRequest auto-approve, SubagentStart injection)"; else echo "Safe Mode: disabled"; fi
if [[ "$COMPACT_ON_ITERATION" == "true" ]]; then echo "Compact Mode: enabled (orchestrator will run /compact each iteration)"; fi
if [[ "$CLEAR_ON_ITERATION" == "true" ]]; then echo "Clear Mode: enabled (supervisor will inject /clear via TTY each iteration — requires tmux/kitty/wezterm/screen/zellij/iTerm2/Terminal.app)"; fi
if [[ "$CLASSIFIER_ENABLED" == "true" ]] && [[ "$SAFE_MODE" == "true" ]]; then printf 'Classifier: enabled (%s)\n' "$CLASSIFIER_MODEL"; fi
cat <<'STATIC_EOF'

STATIC_EOF
printf 'State:    %s/state.json\n' "$INSTANCE_DIR"
printf 'Log:      %s/log.md\n' "$INSTANCE_DIR"
printf 'Instance: %s\n' "$INSTANCE_ID"
echo   'Config:   .claude/swarm-loop.local.md (shared, edit with /swarm-settings)'
printf '\n'
printf 'The orchestrator will now follow the %s profile instructions below.\n' "$MODE"
cat <<'STATIC_EOF'

To monitor: /swarm-status
To cancel:  /cancel-swarm
To config:  /swarm-settings

STATIC_EOF

# Output initial orchestrator prompt via profile system
source "${PLUGIN_ROOT}/scripts/profile-lib.sh"
_sanitize_pipe() { printf '%s' "$1" | sed 's/[$`\\!]/\\&/g'; }
GOAL_SAFE=$(_sanitize_pipe "$GOAL")
PROMISE_SAFE=$(_sanitize_pipe "$COMPLETION_PROMISE")
ITERATION=1
NEXT_ITERATION=1
COMPACT_MODE="$COMPACT_ON_ITERATION"
CLEAR_MODE="$CLEAR_ON_ITERATION"
STUCK_MSG="" BUDGET_MSG="" MIN_ITER_MSG="" STUCK_TIMEOUT_MSG=""
WORKTREE_NOTE="" COMPACT_NOTE=""
source "${PROFILE_DIR}/reinject.sh"
build_reinject_prompt
printf '%s\n' "$REINJECT_PROMPT"

# Completion promise requirements
echo ""
echo "═══════════════════════════════════════════════════════════"
printf 'COMPLETION PROMISE: %s\n' "$COMPLETION_PROMISE"
echo "═══════════════════════════════════════════════════════════"
echo ""
printf 'To complete this loop, output EXACTLY: <promise>%s</promise>\n' "$COMPLETION_PROMISE"
echo ""
echo "RULES:"
echo "  The statement MUST be genuinely true"
echo "  Do NOT output false promises to escape the loop"
echo "  If the task is truly impossible, explain why and output the promise"
echo "    only if you can honestly say the goal was met (or proven infeasible)"
if [[ -n "$VERIFY_CMD" ]]; then
  printf '  Verification command must also pass: %s\n' "$VERIFY_CMD"
fi
echo "═══════════════════════════════════════════════════════════"
