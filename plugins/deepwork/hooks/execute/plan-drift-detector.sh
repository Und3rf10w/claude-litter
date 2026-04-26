#!/bin/bash
# plan-drift-detector.sh — FileChanged(<plan_ref>) advisory plan mutation detector.
#
# Fires when the plan file referenced in state.execute.plan_ref is modified on disk.
# The matcher is registered dynamically at execute-mode setup time using the absolute
# path stored in state.execute.plan_ref (matched against FileChanged.file_path).
#
# On any mutation, computes sha256 of the current plan file content and compares
# against state.execute.plan_hash. On mismatch, sets state.execute.plan_drift_detected=true
# via state-transition.sh merge (W6 single-writer).
#
# Advisory only — FileChanged hooks cannot block operations. The drift flag is checked
# by EXECUTOR during the next write/verify cycle (plan-citation-gate reads state and
# the model is expected to surface the drift warning). This partially mitigates GAP-4
# (multi-agent plan-hash coherence) for the single-EXECUTOR V0 case by detecting
# external mutations (e.g., user edits the plan file while EXECUTOR is running).
#
# CC source: cli_formatted_2.1.116.js:265956 (FileChanged event literal),
# :269399-269416 (matcher → watch path via chokidar glob), :269417 (awaitWriteFinish debounce).
# Fail-open on any error.

set +e

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
discover_instance "$SESSION_ID" 2>/dev/null || exit 0

# Only active execute instances
EXEC_PHASE=$(jq -r '.execute.phase // ""' "$STATE_FILE" 2>/dev/null || echo "")
[[ -n "$EXEC_PHASE" ]] || exit 0

PLAN_REF=$(jq -r '.execute.plan_ref // ""' "$STATE_FILE" 2>/dev/null || echo "")
PLAN_HASH=$(jq -r '.execute.plan_hash // ""' "$STATE_FILE" 2>/dev/null || echo "")

[[ -n "$PLAN_REF" ]] || exit 0
[[ -n "$PLAN_HASH" ]] || exit 0
[[ -f "$PLAN_REF" ]] || exit 0

# Compute current sha256 of the plan file
if command -v sha256sum >/dev/null 2>&1; then
  CURRENT_HASH=$(sha256sum "$PLAN_REF" 2>/dev/null | awk '{print $1}' || echo "")
elif command -v shasum >/dev/null 2>&1; then
  CURRENT_HASH=$(shasum -a 256 "$PLAN_REF" 2>/dev/null | awk '{print $1}' || echo "")
else
  exit 0
fi

[[ -n "$CURRENT_HASH" ]] || exit 0

# If hashes match, no drift
[[ "$CURRENT_HASH" == "$PLAN_HASH" ]] && exit 0

# Hash mismatch — set plan_drift_detected=true via state-transition.sh
_NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
STATE_FILE="$STATE_FILE" bash "${_PLUGIN_ROOT}/scripts/state-transition.sh" merge \
  "{\"execute\":{\"plan_drift_detected\":true,\"plan_drift_detected_at\":\"${_NOW}\",\"plan_hash_at_drift\":\"${CURRENT_HASH}\"}}" \
  2>/dev/null || true

exit 0
