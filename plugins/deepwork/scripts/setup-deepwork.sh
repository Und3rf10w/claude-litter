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
# Execute-mode-specific flags (only meaningful when --mode execute)
PLAN_REF=""
AUTHORIZED_FORCE_PUSH="false"
AUTHORIZED_PUSH="false"
AUTHORIZED_PROD_DEPLOY="false"
AUTHORIZED_LOCAL_DESTRUCTIVE="false"
SECRET_SCAN_WAIVED="false"
CHAOS_MONKEY="auto"  # auto | true | false
ALLOW_NO_HOOKS="false"
SINGLE_WRITER_ENABLED="true"

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
  --mode <name>                  Profile (default: "default"). Also available: "execute"
                                 (implementation mode — requires --plan-ref).
  --team-name <name>             Base team name (random 8-hex suffix appended for uniqueness).
                                 Default: derived from goal text.
  --prompt-file <path>           Read goal/flags from a file instead of positional args.
                                 Flags in the file are extracted by a perl preprocessor;
                                 multiline goal body after flags becomes the goal text.

EXECUTE-MODE OPTIONS (only meaningful with --mode execute):
  --plan-ref <path>              Absolute path to the APPROVED plan document. Required for
                                 execute mode. Setup computes sha256 and stores as plan_hash
                                 for drift detection.
  --authorized-force-push        Grant setup-time authorization for `git push --force`.
  --authorized-push              Grant setup-time authorization for `git push`, `npm publish`,
                                 `docker push` (also requires CRITIC APPROVED + green CI).
  --authorized-prod-deploy       Grant setup-time authorization for `kubectl apply`,
                                 `terraform apply`, `helm upgrade` (also requires rollback plan).
  --authorized-local-destructive Grant setup-time authorization for `rm -rf` non-tmp,
                                 `git reset --hard`, local DB destructive migrations.
  --secret-scan-waive            Disable G7 secret-scan (not recommended; setup-time only).
  --chaos-monkey                 Explicitly spawn chaos-monkey archetype (fault injection).
                                 Default: auto-enabled for distributed/infra goals.
  --no-chaos-monkey              Explicitly disable chaos-monkey spawn.
  --allow-no-hooks               Allow setup to proceed even if hook injection fails (debugging
                                 only; enforcement will be absent without hooks).

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
    --plan-ref)
      PLAN_REF="$2"
      shift 2
      ;;
    --authorized-force-push)
      AUTHORIZED_FORCE_PUSH="true"
      shift
      ;;
    --authorized-push)
      AUTHORIZED_PUSH="true"
      shift
      ;;
    --authorized-prod-deploy)
      AUTHORIZED_PROD_DEPLOY="true"
      shift
      ;;
    --authorized-local-destructive)
      AUTHORIZED_LOCAL_DESTRUCTIVE="true"
      shift
      ;;
    --secret-scan-waive)
      SECRET_SCAN_WAIVED="true"
      shift
      ;;
    --chaos-monkey)
      CHAOS_MONKEY="true"
      shift
      ;;
    --no-chaos-monkey)
      CHAOS_MONKEY="false"
      shift
      ;;
    --allow-no-hooks)
      ALLOW_NO_HOOKS="true"
      shift
      ;;
    --enable-single-writer)
      SINGLE_WRITER_ENABLED="true"
      shift
      ;;
    --disable-single-writer)
      SINGLE_WRITER_ENABLED="false"
      shift
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
        echo "   To stop it first:   /deepwork-teardown" >&2
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
    echo "   /deepwork-teardown to stop it; /deepwork-status for detail" >&2
    exit 1
  fi
done

# Compute a collision-safe random 8-hex instance ID.
# Retry up to 8 times if the directory already exists (2^32 space; collisions
# are astronomically rare but a retry loop costs nothing).
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
_DW_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd -P)}/.claude/deepwork"
INSTANCE_ID=""
for _attempt in 1 2 3 4 5 6 7 8; do
  _cand=$(head -c 4 /dev/urandom | od -A n -t x1 | tr -d ' \n' | head -c 8)
  if [[ ! "$_cand" =~ ^[0-9a-f]{8}$ ]]; then
    continue
  fi
  if [[ ! -d "${_DW_ROOT}/${_cand}" ]]; then
    INSTANCE_ID="$_cand"
    break
  fi
done
if [[ -z "$INSTANCE_ID" ]]; then
  INSTANCE_ID=$(date +%s | head -c 8 | od -A n -t x1 | tr -d ' \n' | head -c 8)
fi

INSTANCE_DIR="${CLAUDE_PROJECT_DIR:-$(pwd -P)}/.claude/deepwork/${INSTANCE_ID}"
mkdir -p "$INSTANCE_DIR"
mkdir -p "${INSTANCE_DIR}/proposals"

trap '
  _rc=$?
  rm -f "$LOCKFILE" "${INSTANCE_DIR}/state.json.tmp.$$" ".claude/settings.local.json.tmp.$$"
  # On non-zero exit, remove only the hook blocks inserted by this instance.
  # Backup is last-resort manual recovery only (not automatic primary path).
  if [ $_rc -ne 0 ] && [ -f ".claude/settings.local.json" ] && command -v jq >/dev/null 2>&1; then
    _iid="$INSTANCE_ID"
    if [ -n "$_iid" ]; then
      _tmp_rollback=".claude/settings.local.json.rollback.$$"
      jq --arg iid "$_iid" "
        if .hooks then
          .hooks |= with_entries(.value = [.value[]? | select(._deepwork_instance != \$iid)] | select(.value | length > 0))
          | if (.hooks | length) == 0 then del(.hooks) else . end
        else . end
      " ".claude/settings.local.json" > "$_tmp_rollback" 2>/dev/null
      if [ -s "$_tmp_rollback" ]; then
        mv "$_tmp_rollback" ".claude/settings.local.json" 2>/dev/null || true
      else
        rm -f "$_tmp_rollback" 2>/dev/null || true
      fi
    fi
  fi
' EXIT

# Derive team_name
if [[ -z "$TEAM_NAME" ]]; then
  # Normalize whitespace (including newlines) before `cut` — multi-line goals
  # produced line-wise truncated team_name via `cut -c1-30`, leaking newlines
  # into on-disk team_name while jq --arg further in the pipeline escaped them.
  # Drift class (k) in proposals/v3-final.md.
  TEAM_NAME="deepwork-$(printf '%s' "$GOAL" | tr '[:upper:]' '[:lower:]' | tr '\n' ' ' | sed 's/[^a-z0-9]/-/g; s/-\{2,\}/-/g; s/^-//; s/-$//' | cut -c1-30)"
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

# Execute-mode validation: --plan-ref REQUIRED; compute plan_hash
PLAN_HASH=""
if [[ "$MODE" == "execute" ]]; then
  if [[ -z "$PLAN_REF" ]]; then
    echo "Error: --mode execute requires --plan-ref <path>" >&2
    echo "  Pass the absolute path to the APPROVED plan document produced by plan-mode." >&2
    exit 1
  fi
  if [[ ! -f "$PLAN_REF" ]]; then
    echo "Error: --plan-ref '$PLAN_REF' does not exist or is not a file." >&2
    exit 1
  fi
  # Canonicalize to absolute path
  PLAN_REF="$(cd "$(dirname "$PLAN_REF")" && pwd)/$(basename "$PLAN_REF")"
  # Compute sha256 (prefer sha256sum, fall back to shasum -a 256)
  if command -v sha256sum >/dev/null 2>&1; then
    PLAN_HASH=$(sha256sum "$PLAN_REF" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    PLAN_HASH=$(shasum -a 256 "$PLAN_REF" | awk '{print $1}')
  else
    echo "Error: neither sha256sum nor shasum found; cannot compute plan_hash." >&2
    exit 1
  fi
  if [[ -z "$PLAN_HASH" ]]; then
    echo "Error: failed to compute plan_hash for '$PLAN_REF'." >&2
    exit 1
  fi
  echo "execute mode: plan_ref=$PLAN_REF plan_hash=$PLAN_HASH" >&2
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

# Bootstrap path — the ONLY place state.json is written outside state-transition.sh.
# After bootstrap, state-transition.sh's _ensure_event_log seeds events.jsonl with a
# bootstrap event that projects from this initial state, anchoring the hash chain.
# All subsequent mutations MUST go through state-transition.sh; direct writes are
# blocked by frontmatter-gate.sh (event_head check) and state-bash-gate.sh (sentinel).
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
  --argjson single_writer_val "$([ "$SINGLE_WRITER_ENABLED" = "true" ] && echo true || echo false)" \
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
    "single_writer_enabled": $single_writer_val,
    "phase": "scope",
    "source_of_truth": $sot,
    "anchors": $anchors,
    "guardrails": $guardrails,
    "bar": $bar,
    "empirical_unknowns": [],
    "role_definitions": [],
    "user_feedback": null,
    "hook_warnings": [],
    "frontmatter_schema_version": "1"
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

# Execute-mode: populate CLI-driven fields + setup_flags_snapshot
# Runs after schema merge so CLI values win over schema defaults (plan §5.2 last paragraph:
# authorized_* flags are setup-time only; snapshot captures them here so bash-gate.sh can
# refuse runtime mutations).
if [[ "$MODE" == "execute" ]]; then
  # Auto-detect chaos-monkey spawn if user didn't override
  if [[ "$CHAOS_MONKEY" == "auto" ]]; then
    # Heuristic: goal mentions services/networks/databases/queues/distributed/deploy/k8s/infra
    if printf '%s' "$GOAL" | grep -qiE 'service|network|database|queue|distributed|deploy|kubectl|terraform|helm|infrastructure|microservice|cluster'; then
      CHAOS_MONKEY="true"
    else
      CHAOS_MONKEY="false"
    fi
  fi

  jq \
    --arg plan_ref "$PLAN_REF" \
    --arg plan_hash "$PLAN_HASH" \
    --argjson auth_fp "$([ "$AUTHORIZED_FORCE_PUSH" = "true" ] && echo true || echo false)" \
    --argjson auth_push "$([ "$AUTHORIZED_PUSH" = "true" ] && echo true || echo false)" \
    --argjson auth_prod "$([ "$AUTHORIZED_PROD_DEPLOY" = "true" ] && echo true || echo false)" \
    --argjson auth_local "$([ "$AUTHORIZED_LOCAL_DESTRUCTIVE" = "true" ] && echo true || echo false)" \
    --argjson scan_waive "$([ "$SECRET_SCAN_WAIVED" = "true" ] && echo true || echo false)" \
    --argjson chaos "$([ "$CHAOS_MONKEY" = "true" ] && echo true || echo false)" \
    '.execute.plan_ref = $plan_ref
     | .execute.plan_hash = $plan_hash
     | .execute.authorized_force_push = $auth_fp
     | .execute.authorized_push = $auth_push
     | .execute.authorized_prod_deploy = $auth_prod
     | .execute.authorized_local_destructive = $auth_local
     | .execute.secret_scan_waived = $scan_waive
     | .execute.chaos_monkey_enabled = $chaos
     | .execute.setup_flags_snapshot = {
         "authorized_force_push": $auth_fp,
         "authorized_push": $auth_push,
         "authorized_prod_deploy": $auth_prod,
         "authorized_local_destructive": $auth_local,
         "secret_scan_waived": $scan_waive
       }' \
    "${INSTANCE_DIR}/state.json" > "${INSTANCE_DIR}/state.json.tmp.$$"
  if [[ -s "${INSTANCE_DIR}/state.json.tmp.$$" ]]; then
    mv "${INSTANCE_DIR}/state.json.tmp.$$" "${INSTANCE_DIR}/state.json"
  else
    rm -f "${INSTANCE_DIR}/state.json.tmp.$$"
    echo "Warning: failed to populate execute-mode state fields" >&2
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

# Backup kept as last-resort manual recovery only — transactional rollback (trap above)
# removes only this instance's injected blocks on failure without touching the backup.
if [[ -f "$SETTINGS_LOCAL" ]] && [[ ! -f "${SETTINGS_LOCAL}.deepwork-backup" ]]; then
  cp "$SETTINGS_LOCAL" "${SETTINGS_LOCAL}.deepwork-backup"
fi

# Drive registration from the manifest. Filters by mode: entries with modes containing
# the current mode ("design"/"execute") or "both" are registered. Execute is a superset
# of design — all "design"/"both" hooks also register in execute sessions, matching the
# previous two-block behaviour.
#
# Special cases handled inline:
#   safe_mode_only: PermissionRequest hook only registered when SAFE_MODE=true.
#   command_override: use literal command string instead of "bash <script> [args]".
#   args: appended to the "bash <script>" command string.
#   __plan_ref__: matcher sentinel replaced with $PLAN_REF at registration time.
#   timeout: forwarded into the hook entry when present.
MANIFEST="${PLUGIN_ROOT}/scripts/hook-manifest.json"
CURRENT_SETTINGS='{}'
if [[ -f "$SETTINGS_LOCAL" ]]; then
  CURRENT_SETTINGS=$(jq '.' "$SETTINGS_LOCAL" 2>/dev/null || echo '{}')
fi

_SETUP_PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$(pwd -P)}"

jq -n \
  --argjson current "$CURRENT_SETTINGS" \
  --argjson manifest "$(jq '.' "$MANIFEST")" \
  --arg plugin_root "$PLUGIN_ROOT" \
  --arg mode "$MODE" \
  --argjson safe_mode "$([ "$SAFE_MODE" = "true" ] && echo true || echo false)" \
  --arg plan_ref "$PLAN_REF" \
  --arg instance_id "$INSTANCE_ID" \
  --arg project_root "$_SETUP_PROJECT_ROOT" \
  '
  def build_hook_entry(entry):
    if (entry | has("command_override")) then
      {"type": "command", "command": entry.command_override}
      | if (entry | has("timeout")) then . + {"timeout": entry.timeout} else . end
      | if (entry | has("async")) then . + {"async": entry.async} else . end
    else
      (("bash " + ($plugin_root + "/" + entry.script | @sh))
        + (if (entry | has("args")) then " " + entry.args else "" end)) as $cmd
      | {"type": "command", "command": $cmd}
      | if (entry | has("timeout")) then . + {"timeout": entry.timeout} else . end
      | if (entry | has("async")) then . + {"async": entry.async} else . end
    end;

  def active_for_mode(entry):
    ($mode == "execute" and (entry.modes | map(. == "execute" or . == "design" or . == "both") | any))
    or ($mode != "execute" and (entry.modes | map(. == "design" or . == "both") | any));

  def should_register(entry):
    active_for_mode(entry)
    and (if (entry | has("safe_mode_only")) then $safe_mode else true end);

  def effective_matcher(entry):
    if entry.matcher == "__plan_ref__" then $plan_ref
    elif entry.matcher == "__src_glob__" then ($project_root + "/src/**")
    else entry.matcher
    end;

  ($current // {}) as $c
  | ($c.hooks // {}) as $h
  | reduce ($manifest.hooks[] | select(should_register(.))) as $entry (
      $h;
      . as $hooks
      | effective_matcher($entry) as $m
      | $entry.event as $ev
      | {"matcher": $m, "hooks": [build_hook_entry($entry)], "_deepwork": true, "_deepwork_instance": $instance_id} as $block
      | ($hooks[$ev] // [] | . + [$block]) as $merged
      | $hooks | .[$ev] = $merged
    )
  | . as $new_hooks
  | $c + {"hooks": $new_hooks}
  ' > "${SETTINGS_LOCAL}.tmp.$$"

if [[ -s "${SETTINGS_LOCAL}.tmp.$$" ]]; then
  mv "${SETTINGS_LOCAL}.tmp.$$" "$SETTINGS_LOCAL"
  # Record successful injection into state for health-check visibility
  _HOOK_BLOCK_COUNT=$(jq '[.hooks[][]? | select(._deepwork_instance == $iid)] | length' \
    --arg iid "$INSTANCE_ID" "$SETTINGS_LOCAL" 2>/dev/null || echo "0")
  jq \
    --arg ts "$NOW" \
    --argjson count "${_HOOK_BLOCK_COUNT:-0}" \
    '.hooks_inject_status = {"timestamp": $ts, "block_count": $count}' \
    "${INSTANCE_DIR}/state.json" > "${INSTANCE_DIR}/state.json.tmp.$$"
  if [[ -s "${INSTANCE_DIR}/state.json.tmp.$$" ]]; then
    mv "${INSTANCE_DIR}/state.json.tmp.$$" "${INSTANCE_DIR}/state.json"
  else
    rm -f "${INSTANCE_DIR}/state.json.tmp.$$"
  fi
else
  rm -f "${SETTINGS_LOCAL}.tmp.$$"
  if [[ "$ALLOW_NO_HOOKS" != "true" ]]; then
    rm -rf "${INSTANCE_DIR}"
    echo "Hook injection failed; programmatic enforcement is absent. Re-run with --allow-no-hooks to override (debugging only)." >&2
    exit 1
  fi
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
  "  End:      /deepwork-teardown" \
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
# Execute-mode placeholders (PLAN_REF and PLAN_HASH already set by flag parsing above)
TEST_MANIFEST_SUMMARY=$(render_test_manifest_summary "${INSTANCE_DIR}/state.json")
CHANGE_LOG_SUMMARY=$(render_change_log_summary "${INSTANCE_DIR}/state.json")
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
