#!/bin/bash
# phase-advance-gate.sh — PreToolUse hook blocking premature phase transitions.
#
# Fires on Edit|Write. Only acts when the target is the session state.json AND
# the edit changes .phase. Runs Checklists A (empirical_unknowns[*].result
# populated + artifacts exist), B (source_of_truth[] superset warning — warn only),
# C (state.json vs log.md team_name/instance_id agreement — covers drift class k),
# and D (version-sentinel currency when transitioning to critique).
#
# CC source references (v2.1.118):
#   - PreToolUse fires before Edit/Write with resolved tool_input (hooks.md §PreToolUse)
#   - Exit 2 → stderr becomes blockingError injected into model context
#   - matchQuery is tool_name; this hook is registered with matcher "Edit|Write"
#     and filters to state.json writes inside the script.
#
# Drift-class coverage (proposals/v3-final.md):
#   (a) state.json write-ownership ambiguity — Checklist A enforces result backfill
#   (k) orchestration-metadata divergence — Checklist C compares state.json vs log.md

set +e
command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"

TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
FILE_PATH=$(_canonical_path "$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo "")")

# Pass-through for non-target tools / non-state.json paths (fast path — runs
# on every Edit/Write so keep it cheap).
[[ "$TOOL_NAME" == "Edit" || "$TOOL_NAME" == "Write" ]] || exit 0
[[ -n "$FILE_PATH" ]] || exit 0
[[ "$(basename "$FILE_PATH")" == "state.json" ]] || exit 0

# Only gate writes to deepwork session state.json (not arbitrary state.json in
# the repo — those aren't ours).
case "$FILE_PATH" in
  */.claude/deepwork/*/state.json) ;;
  *) exit 0 ;;
esac

[[ -f "$FILE_PATH" ]] || exit 0
INSTANCE_DIR="$(dirname "$FILE_PATH")"
STATE_FILE="$FILE_PATH"
LOG_FILE="${INSTANCE_DIR}/log.md"

# Extract proposed new state content. Write replaces whole file; Edit produces
# new_string. We can't easily diff Edit without applying it, so for Edit we read
# the current file and extract the current phase, and we look for a phase
# transition via new_string.
CURRENT_PHASE=$(jq -r '.phase // ""' "$STATE_FILE" 2>/dev/null || echo "")

if [[ "$TOOL_NAME" == "Write" ]]; then
  PROPOSED_CONTENT=$(printf '%s' "$INPUT" | jq -r '.tool_input.content // ""' 2>/dev/null)
  PROPOSED_PHASE=$(printf '%s' "$PROPOSED_CONTENT" | jq -r '.phase // ""' 2>/dev/null || echo "")
else
  # Edit: old_string + new_string. We infer the proposed phase by applying the
  # substitution to the current state content in memory.
  OLD_STRING=$(printf '%s' "$INPUT" | jq -r '.tool_input.old_string // ""' 2>/dev/null)
  NEW_STRING=$(printf '%s' "$INPUT" | jq -r '.tool_input.new_string // ""' 2>/dev/null)
  if [[ -n "$OLD_STRING" && -n "$NEW_STRING" ]]; then
    PROPOSED_CONTENT=$(awk -v old="$OLD_STRING" -v new="$NEW_STRING" '
      BEGIN { RS = "\0"; ORS = "" }
      { sub(old, new); print }
    ' "$STATE_FILE" 2>/dev/null)
    PROPOSED_PHASE=$(printf '%s' "$PROPOSED_CONTENT" | jq -r '.phase // ""' 2>/dev/null || echo "")
  else
    PROPOSED_PHASE="$CURRENT_PHASE"
  fi
fi

# No transition → pass-through.
if [[ -z "$PROPOSED_PHASE" ]] || [[ "$PROPOSED_PHASE" == "$CURRENT_PHASE" ]]; then
  exit 0
fi

# ---- Checklist A: empirical_unknowns[*].result populated + artifact exists ----
# Only blocks transitions into synthesize / critique / deliver / done (forward
# advance). Transitions back (e.g., critique → refining) are always allowed.
case "$PROPOSED_PHASE" in
  synthesize|critique|deliver|done|refining)
    ;;
  *)
    exit 0
    ;;
esac

# Iterate empirical_unknowns[] from current state (proposed content may have
# updated some of them, but the file on disk is the source of truth until the
# write lands).
UNKNOWN_COUNT=$(jq -r '.empirical_unknowns | length' "$STATE_FILE" 2>/dev/null || echo "0")
if [[ "$UNKNOWN_COUNT" =~ ^[0-9]+$ ]] && [[ "$UNKNOWN_COUNT" -gt 0 ]]; then
  for i in $(seq 0 $((UNKNOWN_COUNT - 1))); do
    U_ID=$(jq -r ".empirical_unknowns[$i].id // \"\"" "$STATE_FILE" 2>/dev/null)
    U_RESULT=$(jq -r ".empirical_unknowns[$i].result // \"\"" "$STATE_FILE" 2>/dev/null)
    U_ARTIFACT=$(jq -r ".empirical_unknowns[$i].artifact // \"\"" "$STATE_FILE" 2>/dev/null)

    if [[ -z "$U_RESULT" || "$U_RESULT" == "null" ]]; then
      printf 'Phase advance blocked: empirical_unknowns[%s].result is null.\n' "$U_ID" >&2
      printf 'Write the empirical_results.%s.md artifact, then backfill result via jq+tmp+mv before advancing phase.\n' "$U_ID" >&2
      printf '  current_phase=%s proposed_phase=%s\n' "$CURRENT_PHASE" "$PROPOSED_PHASE" >&2
      exit 2
    fi

    if [[ -n "$U_ARTIFACT" ]] && [[ "$U_ARTIFACT" != "null" ]]; then
      case "$U_ARTIFACT" in
        /*|*..*)
          printf 'Phase advance blocked: empirical_unknowns[%s].artifact path is absolute or contains traversal: %s\n' "$U_ID" "$U_ARTIFACT" >&2
          exit 2
          ;;
      esac
      if [[ ! -f "${INSTANCE_DIR}/${U_ARTIFACT}" ]]; then
        printf 'Phase advance blocked: empirical_unknowns[%s].artifact missing on disk:\n  %s/%s\n' "$U_ID" "$INSTANCE_DIR" "$U_ARTIFACT" >&2
        exit 2
      fi
    fi
  done
fi

# ---- Checklist C: state.json vs log.md metadata invariants (drift class k) ----
# Compare the canonical fields between state.json and log.md after normalizing
# whitespace (log.md may have line-wrapped values from prior bugs).
if [[ -f "$LOG_FILE" ]]; then
  ST_TEAM=$(jq -r '.team_name // ""' "$STATE_FILE" 2>/dev/null | tr -d '\n' | tr -d ' ')
  ST_INST=$(jq -r '.instance_id // ""' "$STATE_FILE" 2>/dev/null | tr -d '\n' | tr -d ' ')

  # log.md **Team:** line — greedy match first occurrence anywhere in file.
  LOG_TEAM=$(grep -m1 -E '^\*\*Team:\*\*' "$LOG_FILE" 2>/dev/null | sed -E 's/^\*\*Team:\*\* *`?([^`]*)`?.*/\1/' | tr -d '\n' | tr -d ' ')
  LOG_INST=$(grep -m1 -E '^\*\*Instance:\*\*' "$LOG_FILE" 2>/dev/null | sed -E 's/^\*\*Instance:\*\* *`?([^`]*)`?.*/\1/' | tr -d '\n' | tr -d ' ')

  if [[ -n "$LOG_TEAM" ]] && [[ -n "$ST_TEAM" ]] && [[ "$ST_TEAM" != "$LOG_TEAM" ]]; then
    printf 'Phase advance blocked (drift class k): state.json and log.md disagree on team_name.\n' >&2
    printf '  state.json: %s\n  log.md:     %s\n' "$ST_TEAM" "$LOG_TEAM" >&2
    printf 'Reconcile before advancing. See proposals/v3-final.md §M1 Checklist C.\n' >&2
    exit 2
  fi

  if [[ -n "$LOG_INST" ]] && [[ -n "$ST_INST" ]] && [[ "$ST_INST" != "$LOG_INST" ]]; then
    printf 'Phase advance blocked (drift class k): state.json and log.md disagree on instance_id.\n' >&2
    printf '  state.json: %s\n  log.md:     %s\n' "$ST_INST" "$LOG_INST" >&2
    exit 2
  fi
fi

# ---- Checklist D: version-sentinel currency (M3 integration) ----
# If we're transitioning TO critique, the sentinel (if present) must reference
# a proposal that exists on disk. Absent sentinel → no check (backward compat).
if [[ "$PROPOSED_PHASE" == "critique" ]]; then
  SENTINEL="${INSTANCE_DIR}/version-sentinel.json"
  if [[ -f "$SENTINEL" ]]; then
    CUR_VER=$(jq -r '.current_version // ""' "$SENTINEL" 2>/dev/null)
    if [[ -n "$CUR_VER" ]]; then
      # Look for proposals/<CUR_VER>.md or proposals/<CUR_VER>-final.md.
      if [[ ! -f "${INSTANCE_DIR}/proposals/${CUR_VER}.md" ]] && [[ ! -f "${INSTANCE_DIR}/proposals/${CUR_VER}-final.md" ]]; then
        printf 'Phase advance blocked: version-sentinel.json says current_version=%s but no matching proposal file exists.\n' "$CUR_VER" >&2
        printf '  Expected one of:\n    %s/proposals/%s.md\n    %s/proposals/%s-final.md\n' "$INSTANCE_DIR" "$CUR_VER" "$INSTANCE_DIR" "$CUR_VER" >&2
        exit 2
      fi
    fi
  fi
fi

# ---- Checklist B: source_of_truth[] superset check (WARN ONLY) ----
# Scan findings.*.md / mechanism.*.md / reframe.*.md / coverage.*.md for cited
# [label](path) references and warn when a cited path isn't in source_of_truth.
# Never blocks — this is a soft prompt for the orchestrator.
if command -v grep >/dev/null 2>&1; then
  SOT_JSON=$(jq -r '.source_of_truth[]? // empty' "$STATE_FILE" 2>/dev/null)
  MISSING=""
  for artifact in "${INSTANCE_DIR}"/findings.*.md "${INSTANCE_DIR}"/mechanism.*.md "${INSTANCE_DIR}"/reframe.*.md "${INSTANCE_DIR}"/coverage.*.md; do
    [[ -f "$artifact" ]] || continue
    # Extract (path) tokens from [label](path) that look like actual paths
    # (contain / or end in .md/.js/.json/.sh).
    CITED=$(grep -oE '\]\([^)]+\)' "$artifact" 2>/dev/null | sed -E 's/^\]\((.*)\)$/\1/' | grep -E '(/|\.(md|js|json|sh|py)$)' || true)
    while IFS= read -r path; do
      [[ -z "$path" ]] && continue
      # Skip URLs and anchored refs (those with #fragment).
      case "$path" in http*|\#*) continue ;; esac
      # Only flag paths that look like repo-relative (not /abs/..., not ../)
      case "$path" in
        /*|*#*) continue ;;
      esac
      if ! printf '%s\n' "$SOT_JSON" | grep -Fqx "$path"; then
        MISSING="${MISSING}${path}"$'\n'
      fi
    done <<< "$CITED"
  done
  if [[ -n "$MISSING" ]]; then
    printf 'NOTE: phase-advance-gate source_of_truth warning (non-blocking):\n' >&2
    printf '  The following paths are cited in artifacts but not in state.json.source_of_truth[]:\n' >&2
    printf '%s' "$MISSING" | sort -u | sed 's/^/    /' >&2
    printf '  Consider adding them via jq+tmp+mv before the next phase advance.\n' >&2
  fi
fi

exit 0
