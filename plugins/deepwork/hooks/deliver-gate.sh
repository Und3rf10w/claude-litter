#!/bin/bash
# deliver-gate.sh — PreToolUse:ExitPlanMode gate mechanizing principles 8 + 9.
#
# Principle 9 (default-off residual risk): delivered plan MUST contain a
#   "Residual unknowns" section — items that could not be verified ship default-off.
# Principle 8 (named versioning forces honest deltas): if the highest
#   proposals/v<N>.md with N≥2 has null delta_from_prior front-matter, that's
#   a version-bump without stated delta — reject.
#
# Wired by setup-deepwork.sh on PreToolUse with matcher for ExitPlanMode.
# Payload field assumption: .tool_input.plan contains the plan text. If the
# Claude Code harness emits the field under a different name the gate
# fails-open (exits 0) rather than blocking legitimate deliveries — this is
# intentional for v1.0. v1.1 will add a harness-version smoke test.
#
# Exit 2 = block ExitPlanMode (stderr shown to orchestrator)
# Exit 0 = allow

set +e

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)

TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
# Only fire for ExitPlanMode; other PreToolUse fires pass through.
[[ "$TOOL_NAME" == "ExitPlanMode" ]] || exit 0

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")

# Scope to active deepwork instance only; skip if none.
discover_instance "$SESSION_ID" 2>/dev/null || exit 0

PLAN_TEXT=$(printf '%s' "$INPUT" | jq -r '.tool_input.plan // ""' 2>/dev/null || echo "")

# If the plan field is absent, fail-open. Principle 9 doesn't apply if there
# is nothing to gate — better to let the delivery through than to misfire on
# a payload shape change.
if [[ -z "$PLAN_TEXT" ]]; then
  exit 0
fi

# Gate 1: Residual unknowns section (principle 9)
if ! printf '%s' "$PLAN_TEXT" | grep -qiE '^#{1,4}[[:space:]]+Residual unknowns'; then
  printf 'BLOCKED: ExitPlanMode plan is missing a "Residual unknowns" section.\n' >&2
  printf 'Principle 9 (default-off for unverified mechanisms): the delivered plan must list\n' >&2
  printf 'items that could not be empirically verified in-session so they ship opt-in.\n' >&2
  printf 'Add a "## Residual unknowns" section and re-try ExitPlanMode.\n' >&2
  exit 2
fi

# Gate 2: delta_from_prior populated on v≥2 proposals (principle 8)
if [[ -d "${INSTANCE_DIR}/proposals" ]]; then
  # Find highest v<N> proposal file, strip prefix/suffix, take max N
  LATEST_V=$(ls "${INSTANCE_DIR}/proposals/"v*.md 2>/dev/null \
    | sed -nE 's|.*/v([0-9]+)(-.*)?\.md$|\1|p' \
    | sort -n \
    | tail -1)

  if [[ -n "$LATEST_V" ]] && [[ "$LATEST_V" =~ ^[0-9]+$ ]] && [[ "$LATEST_V" -ge 2 ]]; then
    # Find the actual file path for v<LATEST_V>*.md
    LATEST_FILE=$(ls "${INSTANCE_DIR}/proposals/"v"${LATEST_V}"*.md 2>/dev/null | head -1)
    if [[ -f "$LATEST_FILE" ]]; then
      # Back-compat: proposal predates frontmatter schema; skip delta check
      # and record the fall-open in state.json.hook_warnings[] so the pre-fix
      # delivery is audit-visible (plan Part C).
      FRONT_MATTER_CHECK=$(sed -n '/^---$/,/^---$/p' "$LATEST_FILE" 2>/dev/null)
      if [[ -z "$FRONT_MATTER_CHECK" ]]; then
        if [[ -f "$STATE_FILE" ]]; then
          _NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
          _write_state_atomic "$STATE_FILE" --arg ts "$_NOW" --arg v "$LATEST_V" \
            '.hook_warnings += [{event: "deliver-gate",
                                 timestamp: $ts,
                                 note: ("pre-fix proposal delivered; frontmatter presence not enforced (proposals/v" + $v + "*.md)")}]'
        fi
        exit 0
      fi
      # Extract front-matter delta_from_prior. Accept any non-empty non-null value.
      FRONT_MATTER=$(sed -n '/^---$/,/^---$/p' "$LATEST_FILE" 2>/dev/null)
      DELTA_LINE=$(printf '%s' "$FRONT_MATTER" | grep -E '^delta_from_prior:' | head -1)
      DELTA_VALUE=${DELTA_LINE#delta_from_prior:}
      # Trim whitespace
      DELTA_VALUE="${DELTA_VALUE#"${DELTA_VALUE%%[![:space:]]*}"}"
      DELTA_VALUE="${DELTA_VALUE%"${DELTA_VALUE##*[![:space:]]}"}"
      # For block-scalar form `delta_from_prior: |`, DELTA_VALUE == "|". Check for content on following lines.
      if [[ "$DELTA_VALUE" == "|" ]] || [[ "$DELTA_VALUE" == ">" ]]; then
        # Block-scalar — check whether the following indented lines have content
        BLOCK_CONTENT=$(awk '/^delta_from_prior:[[:space:]]*[|>]/{flag=1;next} flag && /^[[:space:]]+[^[:space:]]/{print;flag=2} flag==2 && /^[^[:space:]]/{flag=0} flag==2' "$LATEST_FILE" 2>/dev/null)
        if [[ -z "$BLOCK_CONTENT" ]]; then
          printf 'BLOCKED: proposals/v%s*.md has empty delta_from_prior block.\n' "$LATEST_V" >&2
          printf 'Principle 8 (named versioning forces honest deltas): bump the version AND populate delta_from_prior.\n' >&2
          exit 2
        fi
      elif [[ -z "$DELTA_VALUE" ]] || [[ "$DELTA_VALUE" == "null" ]] || [[ "$DELTA_VALUE" == "~" ]] || [[ "$DELTA_VALUE" == '""' ]] || [[ "$DELTA_VALUE" == "''" ]]; then
        printf 'BLOCKED: proposals/v%s*.md has null/empty delta_from_prior.\n' "$LATEST_V" >&2
        printf 'Principle 8 (named versioning forces honest deltas): bump the version AND populate delta_from_prior.\n' >&2
        exit 2
      fi
    fi
  fi
fi

exit 0
