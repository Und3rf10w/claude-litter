#!/bin/bash

# Leanswarm completion profile for swarm-loop.
# Sourced by stop-hook.sh before the completion check.
#
# Inputs (env vars set by stop-hook.sh):
#   LAST_OUTPUT          — last assistant message text
#   COMPLETION_PROMISE   — normalized promise string (whitespace-collapsed)
#   STATE_FILE           — path to instance state.json
#   LOG_FILE             — path to instance log.md
#   STATE_JSON           — cached contents of STATE_FILE
#   ITERATION            — current iteration number (numeric)
#
# Outputs (set by this function):
#   COMPLETION_DETECTED      — "true" if promise matched and verification passed (or no verify script)
#                              "false" otherwise
#   COMPLETION_BLOCK_REASON  — non-empty plain string (human-readable reason) if verification failed.
#                              Do NOT set this to a JSON object — stop-hook.sh wraps it in the hook decision.

check_completion() {
  COMPLETION_DETECTED="false"
  COMPLETION_BLOCK_REASON=""

  # No promise configured — nothing to check
  if [[ -z "$COMPLETION_PROMISE" ]] || [[ "$COMPLETION_PROMISE" == "null" ]]; then
    return
  fi

  # Extract <promise>...</promise> from last output, normalize whitespace
  PROMISE_TEXT=$(echo "$LAST_OUTPUT" | perl -0777 -ne 'if (/<promise>(.*?)<\/promise>/s) { my $t = $1; $t =~ s/^\s+|\s+$//g; $t =~ s/\s+/ /g; print $t; }' 2>/dev/null || echo "")

  # Promise not present in output — not complete yet
  if [[ -z "$PROMISE_TEXT" ]] || [[ "$PROMISE_TEXT" != "$COMPLETION_PROMISE" ]]; then
    return
  fi

  # Promise matched — run verification
  # Check instance-local verify script first, then plugin default
  _plugin_root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

  if [[ -n "${INSTANCE_DIR:-}" ]] && [[ -x "${INSTANCE_DIR}/verify.sh" ]]; then
    VERIFY_SCRIPT="${INSTANCE_DIR}/verify.sh"
  else
    VERIFY_SCRIPT="${_plugin_root}/scripts/verify-completion.sh"
  fi

  if [[ -x "$VERIFY_SCRIPT" ]]; then
    set +e
    VERIFY_RESULT=$("$VERIFY_SCRIPT" "$STATE_FILE" 2>&1)
    VERIFY_EXIT=$?
    set -e

    if [[ $VERIFY_EXIT -ne 0 ]]; then
      # Verification failed — increment iteration, update state, log, and signal block
      NEXT_ITERATION=$((ITERATION + 1))
      TEMP_FILE="${STATE_FILE}.tmp.$$"
      jq --argjson iter "$NEXT_ITERATION" \
         --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
         '.iteration = $iter | .phase = "verification_failed" | .last_updated = $now' "$STATE_FILE" > "$TEMP_FILE"
      if [[ -s "$TEMP_FILE" ]]; then
        mv "$TEMP_FILE" "$STATE_FILE"
      else
        rm -f "$TEMP_FILE"
      fi

      # Log the verification failure
      echo "" >> "$LOG_FILE"
      echo "### Iteration $ITERATION — Verification Failed" >> "$LOG_FILE"
      echo "" >> "$LOG_FILE"
      echo "Promise was output but verification failed:" >> "$LOG_FILE"
      echo '```' >> "$LOG_FILE"
      echo "$VERIFY_RESULT" >> "$LOG_FILE"
      echo '```' >> "$LOG_FILE"
      echo "" >> "$LOG_FILE"

      COMPLETION_BLOCK_REASON="⚠️ VERIFICATION FAILED — Your completion promise was detected but verification did not pass. Fix the issues and try again.

Verification output:
${VERIFY_RESULT}

Re-read ${INSTANCE_DIR}/state.json and ${INSTANCE_DIR}/log.md for full context. Continue working on the goal.

When the goal is fully achieved, output exactly: <promise>${COMPLETION_PROMISE}</promise>"
      return
    fi
  else
    echo "WARNING: Verification script not found at $VERIFY_SCRIPT — skipping verification" >&2
  fi

  # Promise matched and verification passed (or no verify script)
  COMPLETION_DETECTED="true"
}
