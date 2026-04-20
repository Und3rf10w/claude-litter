#!/bin/bash

# Deepwork Setup Script v0.1
# Creates instance directory, state file, dynamic hooks, and prints the orchestrator's
# initial prompt. Forked from swarm-loop's setup-swarm-loop.sh with iteration machinery
# stripped. Deepwork does not iterate — it runs a single SCOPE → DELIVER phase pipeline
# with REFINE cycles on critic-HOLDING.

set -euo pipefail

# Parse arguments
PROMPT_PARTS=()
MODE="default"
PROMPT_FILE=""
TEAM_NAME=""
SAFE_MODE="true"
SOURCE_OF_TRUTH=()
ANCHORS=()
GUARDRAILS=()
BAR_SEEDS=()

while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help)
      cat << 'HELP_EOF'
Deepwork — Research/design convergence via a 5-archetype oppositional team

USAGE:
  /deepwork [GOAL...] [OPTIONS]

ARGUMENTS:
  GOAL...    The goal/research question (can be multiple words)

OPTIONS:
  --source-of-truth <path>       Path to an authoritative doc/bundle/spec. Repeatable.
                                 Every teammate prompt renders these as {{SOURCE_OF_TRUTH}}.
  --anchor <file:line>           File-path-with-line-number starting point. Repeatable.
                                 Every role prompt renders these as {{ANCHORS}}.
  --guardrail '<rule>'           Hard-safety constraint (e.g. "no signals to hosting process").
                                 Repeatable. Teammate prompts render as {{HARD_GUARDRAILS}}.
  --bar '<criterion>'            Pre-seed a bar criterion. Repeatable. Orchestrator augments
                                 in SCOPE to reach the 6-criteria minimum with ≥1 categorical_ban.
  --safe-mode true|false         Enable autonomous hooks (default: true). Safe mode wires
                                 PermissionRequest auto-approve for the team coordination
                                 tools (Edit/Write/Read/Agent/TaskCreate/TaskUpdate/...).
  --mode <name>                  Profile (default: default). Currently only "default" exists.
  --team-name <name>             Base team name (random 8-hex suffix appended for uniqueness).
                                 Default: derived from goal text.
  --prompt-file <path>           Read goal/flags from a file instead of positional args.
                                 Flags in the file are extracted by a perl preprocessor;
                                 multiline goal body after flags becomes the goal text.
  -h, --help                     Show this help

DESCRIPTION:
  Spawns a 5-archetype oppositional team (FALSIFIER / COVERAGE / MECHANISM / REFRAMER / CRITIC)
  to converge on a research/design question. CRITIC is the invariant veto-holder; the other
  four are dynamically named by the orchestrator per-problem. The team runs a phase pipeline:

    SCOPE → EXPLORE → SYNTHESIZE → CRITIQUE → (REFINE → CRITIQUE)* → DELIVER → HALT

  Delivery is via ExitPlanMode. The team NEVER crosses into implementation — the deliverable
  is the approved plan document. User proceeds from there.

  See references/when-not-to-use.md if you're unsure deepwork is the right tool.

EXAMPLES:
  /deepwork "Design a feature flag system for project X" \
    --source-of-truth ./docs/architecture.md \
    --anchor src/config.ts:45 \
    --guardrail "no breaking changes to public API"

  /deepwork "Audit the auth middleware for vulns" \
    --source-of-truth ./src/auth/ \
    --bar "CVE-checked against OWASP top 10 (categorical ban)"

HELP_EOF
      exit 0
      ;;
    --source-of-truth)
      SOURCE_OF_TRUTH+=("$2")
      shift 2
      ;;
    --anchor)
      ANCHORS+=("$2")
      shift 2
      ;;
    --guardrail)
      GUARDRAILS+=("$2")
      shift 2
      ;;
    --bar)
      BAR_SEEDS+=("$2")
      shift 2
      ;;
    --safe-mode)
      SAFE_MODE="$2"
      shift 2
      ;;
    --mode)
      MODE="$2"
      shift 2
      ;;
    --team-name)
      TEAM_NAME="$2"
      shift 2
      ;;
    --prompt-file)
      PROMPT_FILE="$2"
      shift 2
      ;;
    *)
      PROMPT_PARTS+=("$1")
      shift
      ;;
  esac
done

# ── Prompt-file parsing (shared helper) ──────────
# Helpers live in scripts/prompt-parser.sh so they can be unit-tested.
# We derive PLUGIN_ROOT here (same logic as later in the script) just to source.
_PLUGIN_ROOT_EARLY="${CLAUDE_PLUGIN_ROOT:-}"
if [[ -z "$_PLUGIN_ROOT_EARLY" ]]; then
  _PLUGIN_ROOT_EARLY="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
# shellcheck source=./prompt-parser.sh
source "${_PLUGIN_ROOT_EARLY}/scripts/prompt-parser.sh"

if [[ -n "$PROMPT_FILE" ]] && [[ -f "$PROMPT_FILE" ]]; then
  parse_prompt_file "$PROMPT_FILE"
fi

GOAL="${PROMPT_PARTS[*]:-}"
if [[ -z "$GOAL" ]]; then
  echo "Error: goal is required. Usage: /deepwork <goal> [options]" >&2
  echo "       or via --prompt-file <path> containing goal body + flag lines" >&2
  exit 1
fi

# Validate safe-mode value
if [[ "$SAFE_MODE" != "true" ]] && [[ "$SAFE_MODE" != "false" ]]; then
  echo "Error: --safe-mode must be 'true' or 'false', got '$SAFE_MODE'" >&2
  exit 1
fi

# Ensure .claude/ exists in CWD (project root)
mkdir -p .claude

# Resolve SESSION_ID
SESSION_ID="${CLAUDE_CODE_SESSION_ID:-}"
if [[ -z "$SESSION_ID" ]]; then
  SESSION_ID="deepwork-$(head -c 8 /dev/urandom | od -A n -t x1 | tr -d ' \n')-$(date +%s)"
fi

# Atomic lockfile (TOCTOU-safe)
LOCKFILE=".claude/deepwork.local.lock"
if ! (set -o noclobber; echo $$ > "$LOCKFILE") 2>/dev/null; then
  LOCK_PID=$(cat "$LOCKFILE" 2>/dev/null)
  if [[ -n "$LOCK_PID" ]] && ! kill -0 "$LOCK_PID" 2>/dev/null; then
    rm -f "$LOCKFILE"
    if ! (set -o noclobber; echo $$ > "$LOCKFILE") 2>/dev/null; then
      echo "Error: Failed to reclaim stale lockfile" >&2
      exit 1
    fi
  else
    for _sf in .claude/deepwork/*/state.json; do
      [[ -f "$_sf" ]] || continue
      _existing_session=$(jq -r '.session_id // ""' "$_sf" 2>/dev/null)
      if [[ "$_existing_session" == "$SESSION_ID" ]]; then
        EXISTING_GOAL=$(jq -r '.goal // "unknown"' "$_sf" 2>/dev/null)
        EXISTING_PHASE=$(jq -r '.phase // "?"' "$_sf" 2>/dev/null)
        echo "Error: A deepwork session is already active for this Claude session!" >&2
        echo "" >&2
        echo "   Goal: $EXISTING_GOAL" >&2
        echo "   Phase: $EXISTING_PHASE" >&2
        echo "" >&2
        echo "   To stop it first:   /deepwork-cancel" >&2
        echo "   To check status:    /deepwork-status" >&2
        exit 1
      fi
    done
    echo "Error: Another deepwork session is being set up concurrently" >&2
    exit 1
  fi
fi
trap 'rm -f "$LOCKFILE" ".claude/settings.local.json.tmp.$$"' EXIT

# Check for already-active instance (lockfile was stale from a crashed setup)
for _sf in .claude/deepwork/*/state.json; do
  [[ -f "$_sf" ]] || continue
  _existing_session=$(jq -r '.session_id // ""' "$_sf" 2>/dev/null)
  if [[ "$_existing_session" == "$SESSION_ID" ]]; then
    EXISTING_GOAL=$(jq -r '.goal // "unknown"' "$_sf" 2>/dev/null)
    EXISTING_PHASE=$(jq -r '.phase // "?"' "$_sf" 2>/dev/null)
    echo "Error: A deepwork session is already active for this Claude session!" >&2
    echo "   Goal: $EXISTING_GOAL" >&2
    echo "   Phase: $EXISTING_PHASE" >&2
    echo "   /deepwork-cancel to stop it; /deepwork-status for detail" >&2
    exit 1
  fi
done

# Compute instance ID
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
INSTANCE_ID=$(printf '%s' "$SESSION_ID" | shasum -a 256 2>/dev/null || printf '%s' "$SESSION_ID" | sha256sum 2>/dev/null)
INSTANCE_ID="${INSTANCE_ID:0:8}"
if [[ ! "$INSTANCE_ID" =~ ^[0-9a-f]{8}$ ]]; then
  INSTANCE_ID=$(head -c 4 /dev/urandom | od -A n -t x1 | tr -d ' \n')
fi

INSTANCE_DIR="${CLAUDE_PROJECT_DIR:-$(pwd -P)}/.claude/deepwork/${INSTANCE_ID}"
mkdir -p "$INSTANCE_DIR"
mkdir -p "${INSTANCE_DIR}/proposals"

trap '
  _rc=$?
  rm -f "$LOCKFILE" "${INSTANCE_DIR}/state.json.tmp.$$" ".claude/settings.local.json.tmp.$$"
  # On non-zero exit, restore settings.local.json from backup so a failed setup
  # does not leave half-wired hooks behind.
  if [ $_rc -ne 0 ] && [ -f ".claude/settings.local.json.deepwork-backup" ]; then
    mv ".claude/settings.local.json.deepwork-backup" ".claude/settings.local.json" 2>/dev/null || true
  fi
' EXIT

# Derive team_name
if [[ -z "$TEAM_NAME" ]]; then
  TEAM_NAME="deepwork-$(printf '%s' "$GOAL" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/-\{2,\}/-/g; s/^-//; s/-$//' | cut -c1-30)"
fi
TEAM_NAME="${TEAM_NAME}-$(head -c 4 /dev/urandom | od -A n -t x1 | tr -d ' \n')"

# Resolve absolute plugin root (needed for hook script absolute paths in settings.local.json)
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [[ -z "$PLUGIN_ROOT" ]]; then
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

# Validate profile
PROFILE_DIR="${PLUGIN_ROOT}/profiles/${MODE}"
if [[ ! -d "$PROFILE_DIR" ]] || [[ ! -f "$PROFILE_DIR/PROFILE.md" ]]; then
  echo "Error: Unknown mode '${MODE}' — no profile at ${PROFILE_DIR}" >&2
  echo "   Available: $(ls "${PLUGIN_ROOT}/profiles/" 2>/dev/null | tr '\n' ' ')" >&2
  exit 1
fi

# Build seeded arrays for state.json using jq
SOURCE_OF_TRUTH_JSON=$(printf '%s\n' "${SOURCE_OF_TRUTH[@]:-}" | jq -R . | jq -s 'map(select(. != ""))')
ANCHORS_JSON=$(printf '%s\n' "${ANCHORS[@]:-}" | jq -R . | jq -s 'map(select(. != ""))')

# Guardrails array with metadata
if [[ ${#GUARDRAILS[@]} -gt 0 ]]; then
  GUARDRAILS_JSON=$(
    for g in "${GUARDRAILS[@]}"; do
      jq -n --arg rule "$g" --arg ts "$NOW" \
        '{rule: $rule, source: "flag", timestamp: $ts}'
    done | jq -s '.'
  )
else
  GUARDRAILS_JSON='[]'
fi

# Bar seeds — each with auto-assigned ID G1, G2, ...
if [[ ${#BAR_SEEDS[@]} -gt 0 ]]; then
  _i=0
  BAR_JSON=$(
    for b in "${BAR_SEEDS[@]}"; do
      _i=$((_i+1))
      jq -n --arg criterion "$b" --arg id "G${_i}" \
        '{id: $id, criterion: $criterion, evidence_required: "to be populated by orchestrator", verdict: null, categorical_ban: false}'
    done | jq -s '.'
  )
else
  BAR_JSON='[]'
fi

# Write state.json — base fields; profile schema merged after
jq -n \
  --arg goal "$GOAL" \
  --arg session "$SESSION_ID" \
  --arg instance_id "$INSTANCE_ID" \
  --arg started "$NOW" \
  --arg now "$NOW" \
  --arg team "$TEAM_NAME" \
  --arg mode "$MODE" \
  --argjson safe_mode_val "$([ "$SAFE_MODE" = "true" ] && echo true || echo false)" \
  --argjson sot "$SOURCE_OF_TRUTH_JSON" \
  --argjson anchors "$ANCHORS_JSON" \
  --argjson guardrails "$GUARDRAILS_JSON" \
  --argjson bar "$BAR_JSON" \
  '{
    "version": 1,
    "mode": $mode,
    "goal": $goal,
    "session_id": $session,
    "instance_id": $instance_id,
    "started_at": $started,
    "last_updated": $now,
    "team_name": $team,
    "safe_mode": $safe_mode_val,
    "phase": "scope",
    "source_of_truth": $sot,
    "anchors": $anchors,
    "guardrails": $guardrails,
    "bar": $bar,
    "empirical_unknowns": [],
    "role_definitions": [],
    "user_feedback": null,
    "hook_warnings": []
  }' > "${INSTANCE_DIR}/state.json.tmp.$$"
mv "${INSTANCE_DIR}/state.json.tmp.$$" "${INSTANCE_DIR}/state.json"

# Merge profile state-schema.json extensions (if any beyond what we set)
PROFILE_SCHEMA="${PROFILE_DIR}/state-schema.json"
if [[ -f "$PROFILE_SCHEMA" ]] && [[ -s "$PROFILE_SCHEMA" ]]; then
  _schema_content=$(cat "$PROFILE_SCHEMA")
  if [[ "$_schema_content" != "{}" ]]; then
    # Merge: existing state.json (has user-seeded arrays) takes priority over schema defaults
    jq -s '.[1] * .[0]' "${INSTANCE_DIR}/state.json" "$PROFILE_SCHEMA" \
      > "${INSTANCE_DIR}/state.json.tmp.$$"
    if [[ -s "${INSTANCE_DIR}/state.json.tmp.$$" ]]; then
      mv "${INSTANCE_DIR}/state.json.tmp.$$" "${INSTANCE_DIR}/state.json"
    else
      rm -f "${INSTANCE_DIR}/state.json.tmp.$$"
    fi
  fi
fi

# Narrative log
{
  printf '%s\n' "# Deepwork Log" ""
  printf '**Goal:** %s\n' "$GOAL"
  printf '**Team:** `%s`\n' "$TEAM_NAME"
  printf '**Started:** %s\n' "$NOW"
  printf '**Instance:** %s\n' "$INSTANCE_ID"
  printf '%s\n' "" "---" "" "## SCOPE Phase" "" "*(Orchestrator will populate role_definitions, bar, empirical_unknowns, and spawn the team.)*" ""
} > "${INSTANCE_DIR}/log.md"

# Persist original prompt for reference
printf '%s\n' "$GOAL" > "${INSTANCE_DIR}/prompt.md"

# ---- Settings.local.json hook wiring ----
SETTINGS_LOCAL=".claude/settings.local.json"

if [[ -f "$SETTINGS_LOCAL" ]] && [[ ! -f "${SETTINGS_LOCAL}.deepwork-backup" ]]; then
  cp "$SETTINGS_LOCAL" "${SETTINGS_LOCAL}.deepwork-backup"
fi

# PermissionRequest auto-approve (safe-mode only)
PERMISSION_REQUEST_HOOK='null'
if [[ "$SAFE_MODE" == "true" ]]; then
  PERMISSION_REQUEST_HOOK=$(jq -n '[{
    "matcher": "Edit|Write|Read|Glob|Grep|Agent|TaskCreate|TaskUpdate|TaskList|TaskGet|SendMessage|TeamCreate",
    "hooks": [{
      "type": "command",
      "command": "echo '"'"'{\"hookSpecificOutput\":{\"hookEventName\":\"PermissionRequest\",\"decision\":{\"behavior\":\"allow\"}}}'"'"'"
    }]
  }]')
fi

# SubagentStop — feed into incident-detector
SUBAGENT_STOP_SCRIPT="$PLUGIN_ROOT/hooks/incident-detector.sh"
SUBAGENT_STOP_HOOK=$(jq -n --arg script "$SUBAGENT_STOP_SCRIPT" \
  '[{"matcher": ".*", "hooks": [{"type": "command", "command": ("bash " + ($script | @sh) + " --event SubagentStop")}]}]')

# SessionStart(clear|compact) context re-injection
SESSION_CONTEXT_SCRIPT="$PLUGIN_ROOT/hooks/session-context.sh"
SESSION_START_HOOK=$(jq -n --arg script "$SESSION_CONTEXT_SCRIPT" \
  '[{"matcher": "clear|compact", "hooks": [{"type": "command", "command": ("bash " + ($script | @sh))}]}]')

# TaskCompleted — artifact-existence check + cross-check count enforcement
TASK_COMPLETED_SCRIPT="$PLUGIN_ROOT/hooks/task-completed-gate.sh"
TASK_COMPLETED_HOOK=$(jq -n --arg script "$TASK_COMPLETED_SCRIPT" \
  '[{"matcher": ".*", "hooks": [{"type": "command", "command": ("bash " + ($script | @sh))}]}]')

# PermissionDenied — incident signal
PERMISSION_DENIED_SCRIPT="$PLUGIN_ROOT/hooks/incident-detector.sh"
PERMISSION_DENIED_HOOK=$(jq -n --arg script "$PERMISSION_DENIED_SCRIPT" \
  '[{"matcher": ".*", "hooks": [{"type": "command", "command": ("bash " + ($script | @sh) + " --event PermissionDenied")}]}]')

# PreToolUse:ExitPlanMode — deliver-gate lints the plan for principle 9 + 8
DELIVER_GATE_SCRIPT="$PLUGIN_ROOT/hooks/deliver-gate.sh"
DELIVER_GATE_HOOK=$(jq -n --arg script "$DELIVER_GATE_SCRIPT" \
  '[{"matcher": "ExitPlanMode", "hooks": [{"type": "command", "command": ("bash " + ($script | @sh))}]}]')

# Merge hooks into settings.local.json. Tag with _deepwork:true for selective teardown.
CURRENT_SETTINGS='{}'
if [[ -f "$SETTINGS_LOCAL" ]]; then
  CURRENT_SETTINGS=$(jq '.' "$SETTINGS_LOCAL" 2>/dev/null || echo '{}')
fi

jq -n \
  --argjson current "$CURRENT_SETTINGS" \
  --argjson permission_request "$PERMISSION_REQUEST_HOOK" \
  --argjson subagent_stop "$SUBAGENT_STOP_HOOK" \
  --argjson session_start "$SESSION_START_HOOK" \
  --argjson task_completed "$TASK_COMPLETED_HOOK" \
  --argjson permission_denied "$PERMISSION_DENIED_HOOK" \
  --argjson deliver_gate "$DELIVER_GATE_HOOK" \
  '
  def attach_dw(arr; tag):
    if arr == null then null
    else (arr | map(. + {_deepwork: tag}))
    end;

  def add_hook_event(current; event; new):
    if new == null then current
    else
      current[event] = (current[event] // []) + new
      | current
    end;

  ($current // {}) as $c
  | ($c.hooks // {}) as $h
  | ($h
      | add_hook_event(.; "PermissionRequest"; attach_dw($permission_request; true))
      | add_hook_event(.; "SubagentStop"; attach_dw($subagent_stop; true))
      | add_hook_event(.; "SessionStart"; attach_dw($session_start; true))
      | add_hook_event(.; "TaskCompleted"; attach_dw($task_completed; true))
      | add_hook_event(.; "PermissionDenied"; attach_dw($permission_denied; true))
      | add_hook_event(.; "PreToolUse"; attach_dw($deliver_gate; true))
    ) as $new_hooks
  | $c + {"hooks": $new_hooks}
  ' > "${SETTINGS_LOCAL}.tmp.$$"

if [[ -s "${SETTINGS_LOCAL}.tmp.$$" ]]; then
  mv "${SETTINGS_LOCAL}.tmp.$$" "$SETTINGS_LOCAL"
else
  rm -f "${SETTINGS_LOCAL}.tmp.$$"
  echo "Warning: failed to write hooks into $SETTINGS_LOCAL (proceeding without dynamic hooks)" >&2
fi

# ---- Print user-visible setup banner to stderr ----
printf '%s\n' "" \
  "Deepwork session started." \
  "  Goal:     $GOAL" \
  "  Team:     $TEAM_NAME" \
  "  Instance: $INSTANCE_ID" \
  "  Mode:     $MODE" \
  "  Safe:     $SAFE_MODE" \
  "" \
  "  Status:   /deepwork-status" \
  "  Cancel:   /deepwork-cancel" \
  "  Guardrail add: /deepwork-guardrail add \"<rule>\"" \
  "  Bar add:       /deepwork-bar add \"<criterion>\"" \
  "" >&2

# ---- Render and print orchestrator prompt to stdout ----
# shellcheck source=./profile-lib.sh
source "${PLUGIN_ROOT}/scripts/profile-lib.sh"

# Build render placeholders from state.json
HARD_GUARDRAILS=$(render_guardrails "${INSTANCE_DIR}/state.json")
SOURCE_OF_TRUTH=$(render_source_of_truth "${INSTANCE_DIR}/state.json")
ANCHORS=$(render_anchors "${INSTANCE_DIR}/state.json")
WRITTEN_BAR=$(render_bar "${INSTANCE_DIR}/state.json")
ROLE_DEFINITIONS=$(render_role_definitions "${INSTANCE_DIR}/state.json")
TEAM_ROSTER=$(render_team_roster "${INSTANCE_DIR}/state.json")
PHASE="scope"

# Sanitize goal (defense-in-depth; the SKILL.md quoted heredoc already neutralized $/backtick)
GOAL_SAFE=$(printf '%s' "$GOAL" | sed 's/[$`\\!]/\\&/g')
GOAL_ORIG="$GOAL"
GOAL="$GOAL_SAFE"

# Render PROFILE.md
TMPL=$(cat "${PROFILE_DIR}/PROFILE.md")
RENDERED=$(substitute_profile_template "$TMPL")

# Print the rendered orchestrator prompt
printf '%s\n' "$RENDERED"

printf '\n\n---\n\n'
printf '# Appendix A — Tool Reference (read this before any team operation)\n\n'
cat "${PLUGIN_ROOT}/references/tool-reference.md"

printf '\n\n---\n\n'
printf '# Appendix B — Archetype Taxonomy (how to compose the team)\n\n'
cat "${PLUGIN_ROOT}/references/archetype-taxonomy.md"

printf '\n\n---\n\n'
printf '# Appendix C — Written Bar Template (what to populate in SCOPE)\n\n'
cat "${PLUGIN_ROOT}/references/written-bar-template.md"

# Remaining references (critic-stance, reframer-stance, ask-guidance, versioning-protocol,
# when-not-to-use, failure-modes) are loaded on demand via Read during the orchestrator's
# phase pipeline. Per principle: progressive disclosure keeps the initial prompt lean.

exit 0
