#!/bin/bash
# status-claim-regex-precheck.sh — Async regex lint for STATUS CLAIM RULE violations.
#
# Fires on TeammateIdle. Emits {"async":true} immediately so it is non-blocking
# (hooks.md:358), then runs violation pattern checks in the background.
#
# For each matched pattern from §5 of the design, checks whether the same turn
# contains a grounding tool use (Read, Grep, or Bash). Ungrounded matches
# increment .status_claim_violations[teammate_name][YYYY-MM-DD] in metrics.json.
#
# Always exits 0 (fail-open). Any error at any stage silently no-ops.

set +e

# Capture stdin before emitting async marker — stdin is consumed once
_INPUT=$(cat 2>/dev/null) || _INPUT=""

printf '%s\n' '{"async":true}'

(
  command -v jq >/dev/null 2>&1 || exit 0

  INPUT="$_INPUT"

  _PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
  # shellcheck source=scripts/instance-lib.sh
  source "${_PLUGIN_ROOT}/scripts/instance-lib.sh" 2>/dev/null || exit 0

  # If INSTANCE_DIR is already set (e.g., test harness), skip discovery
  if [[ -z "${INSTANCE_DIR:-}" ]]; then
    TEAM_NAME=$(printf '%s' "$INPUT" | jq -r '.team_name // ""' 2>/dev/null || echo "")
    [[ -n "$TEAM_NAME" ]] || exit 0
    discover_instance_by_team_name "$TEAM_NAME" 2>/dev/null || exit 0
    [[ -n "${INSTANCE_DIR:-}" ]] || exit 0
  fi

  TEAMMATE=$(printf '%s' "$INPUT" | jq -r '.teammate_name // ""' 2>/dev/null || echo "")
  TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null || echo "")

  [[ -n "$TEAMMATE" ]] || exit 0
  [[ -n "$TRANSCRIPT" ]] || exit 0
  [[ -f "$TRANSCRIPT" ]] || exit 0

  # Extract last assistant turn from JSONL
  LAST_TURN=$(command grep -F '"role"' "$TRANSCRIPT" 2>/dev/null | command grep -F '"assistant"' | tail -1) || exit 0
  [[ -n "$LAST_TURN" ]] || exit 0

  # Validate the turn parses as JSON
  printf '%s' "$LAST_TURN" | jq -e . >/dev/null 2>&1 || exit 0

  # Extract text content from the turn — handle both array and string forms
  TURN_TEXT=$(printf '%s' "$LAST_TURN" | jq -r '
    .message.content
    | if type == "array" then
        map(select(.type == "text") | .text) | join(" ")
      elif type == "string" then
        .
      else
        ""
      end
  ' 2>/dev/null || echo "")

  [[ -n "$TURN_TEXT" ]] || exit 0

  # Check whether the turn contains a grounding tool use (Read, Grep, or Bash)
  HAS_GROUNDING=$(printf '%s' "$LAST_TURN" | jq -r '
    .message.content
    | if type == "array" then
        map(select(.type == "tool_use" and ((.name // .tool_name // "") | test("^(Read|Grep|Bash)$"; ""))))
        | length > 0
      else
        false
      end
  ' 2>/dev/null || echo "false")
  [[ "$HAS_GROUNDING" == "true" ]] && exit 0

  # Run the 10 violation patterns from design §5 (case-insensitive, ERE).
  # Use 'command grep' to bypass any shell function wrappers (e.g., ugrep shim).
  VIOLATION_COUNT=0

  # Pattern 1: task #N is (pending|in?progress|complete|done|blocked)
  printf '%s' "$TURN_TEXT" | command grep -qiE 'task #[0-9]+ is (pending|in.progress|complete|done|blocked)' 2>/dev/null \
    && VIOLATION_COUNT=$((VIOLATION_COUNT + 1))

  # Pattern 2: proposal is at vN
  printf '%s' "$TURN_TEXT" | command grep -qiE 'proposal is at v[0-9]+' 2>/dev/null \
    && VIOLATION_COUNT=$((VIOLATION_COUNT + 1))

  # Pattern 3: (artifact|doc|section) ... is (complete|done|ready|approved|merged)
  printf '%s' "$TURN_TEXT" | command grep -qiE '(artifact|doc|section) .{0,40} is (complete|done|ready|approved|merged)' 2>/dev/null \
    && VIOLATION_COUNT=$((VIOLATION_COUNT + 1))

  # Pattern 4: workstream ... (is|remains) (pending|active|blocked|on hold)
  printf '%s' "$TURN_TEXT" | command grep -qiE 'workstream .{0,30} (is|remains) (pending|active|blocked|on hold)' 2>/dev/null \
    && VIOLATION_COUNT=$((VIOLATION_COUNT + 1))

  # Pattern 5: (still|currently) (pending|in?progress|blocked|open)
  printf '%s' "$TURN_TEXT" | command grep -qiE '(still|currently) (pending|in.progress|blocked|open)' 2>/dev/null \
    && VIOLATION_COUNT=$((VIOLATION_COUNT + 1))

  # Pattern 6: hasn.t (moved|changed|advanced)
  printf '%s' "$TURN_TEXT" | command grep -qiE "hasn.t (moved|changed|advanced)" 2>/dev/null \
    && VIOLATION_COUNT=$((VIOLATION_COUNT + 1))

  # Pattern 7: (no|zero) (progress|changes) (on|since)
  printf '%s' "$TURN_TEXT" | command grep -qiE '(no|zero) (progress|changes) (on|since)' 2>/dev/null \
    && VIOLATION_COUNT=$((VIOLATION_COUNT + 1))

  # Pattern 8: (confirmed|verified|checked)...(is|are)...(complete|done|pending)
  printf '%s' "$TURN_TEXT" | command grep -qiE '(confirmed|verified|checked).{0,30} (is|are) .{0,30}(complete|done|pending)' 2>/dev/null \
    && VIOLATION_COUNT=$((VIOLATION_COUNT + 1))

  # Pattern 9: the (current|latest) (version|phase|state) is
  printf '%s' "$TURN_TEXT" | command grep -qiE 'the (current|latest) (version|phase|state) is' 2>/dev/null \
    && VIOLATION_COUNT=$((VIOLATION_COUNT + 1))

  # Pattern 10: (approved|rejected|merged)...(in|on|at) (phase|vN|stage)
  printf '%s' "$TURN_TEXT" | command grep -qiE '(approved|rejected|merged).{0,20}(in|on|at) (phase|v[0-9]+|stage)' 2>/dev/null \
    && VIOLATION_COUNT=$((VIOLATION_COUNT + 1))

  [[ $VIOLATION_COUNT -gt 0 ]] || exit 0

  TODAY=$(date -u +%Y-%m-%d)
  METRICS_FILE="${INSTANCE_DIR}/metrics.json"

  # Bootstrap metrics.json if absent
  if [[ ! -f "$METRICS_FILE" ]]; then
    printf '%s\n' '{}' > "$METRICS_FILE" 2>/dev/null || exit 0
  fi

  # Validate existing metrics.json is parseable
  jq -e . "$METRICS_FILE" >/dev/null 2>&1 || printf '%s\n' '{}' > "$METRICS_FILE" 2>/dev/null || exit 0

  # Atomic increment: jq + tmp + mv
  TMP_FILE="${METRICS_FILE}.tmp.$$"
  jq --arg teammate "$TEAMMATE" --arg date "$TODAY" --argjson count "$VIOLATION_COUNT" '
    .status_claim_violations //= {}
    | .status_claim_violations[$teammate] //= {}
    | .status_claim_violations[$teammate][$date] = ((.status_claim_violations[$teammate][$date] // 0) + $count)
  ' "$METRICS_FILE" > "$TMP_FILE" 2>/dev/null \
    && mv "$TMP_FILE" "$METRICS_FILE" 2>/dev/null \
    || rm -f "$TMP_FILE" 2>/dev/null

  exit 0
) &>/dev/null &

exit 0
