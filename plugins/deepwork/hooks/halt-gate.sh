#!/bin/bash
# halt-gate.sh — Enforces halt_reason population at session halt.
#
# Wired to Stop (fires every turn-end). Gates on phase == "halt" (plan-mode
# top-level .phase OR execute-mode nested .execute.phase) and requires the
# top-level halt_reason field to be a well-formed object:
#   {summary: non-empty string, blockers: array}
#
# Exit conventions (hooks.ts:236, :3328):
#   0 — non-blocking (allows turn-end)
#   2 — blocking (blocks turn-end, stderr becomes system-reminder to orchestrator)
#
# Backward-compat: sessions predating halt_reason (field entirely absent from
# state.json) pass through. setup-deepwork.sh initializes halt_reason=null for
# new sessions so the gate discriminates "new session didn't populate" (null or
# malformed) from "legacy session, no enforcement" (key absent).
#
# Ordering: registered BEFORE approve-archive.sh in the Stop hook chain. Both
# fire on Stop but gate on different phase values (halt vs done), so ordering
# is correctness-preserving today either way — but halt-gate-first avoids
# approve-archive racing a mid-halt state.json rename if future changes ever
# expand overlap. CC runtime chain semantics (whether exit 2 from an earlier
# hook short-circuits later hooks in the same event) are NOT enforced by this
# hook; only the setup-level array-index ordering is guaranteed.
#
# Registration site: scripts/setup-deepwork.sh plan-mode block ONLY. This hook
# must NOT be re-registered inside the execute-mode-only block (a single
# registration with matcher:".*" fires for every Stop event regardless of
# mode). See the ordering comment above STOP_HALT_GATE_HOOK in setup.
#
# Parse-failure pass-through: if state.json is unreadable or malformed, exit 0.
# Consistent with deliver-gate.sh and approve-archive.sh robustness — prevents
# halt-gate from wedging concurrent executor Stop events when another writer
# has an in-flight jq+tmp+mv on state.json.

set +e
command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
discover_instance "$SESSION_ID" 2>/dev/null || exit 0

STATE_CONTENT=$(cat "$STATE_FILE" 2>/dev/null) || exit 0
printf '%s' "$STATE_CONTENT" | jq -e . >/dev/null 2>&1 || exit 0

PHASE_TOP=$(printf '%s' "$STATE_CONTENT" | jq -r '.phase // ""' 2>/dev/null)
PHASE_EXEC=$(printf '%s' "$STATE_CONTENT" | jq -r '.execute.phase // ""' 2>/dev/null)
if [[ "$PHASE_TOP" != "halt" && "$PHASE_EXEC" != "halt" ]]; then
  exit 0
fi

HAS_KEY=$(printf '%s' "$STATE_CONTENT" | jq -r 'has("halt_reason")' 2>/dev/null)
if [[ "$HAS_KEY" != "true" ]]; then
  exit 0
fi

VALIDATION=$(printf '%s' "$STATE_CONTENT" | jq -r '
  .halt_reason as $hr
  | if $hr == null then "NULL"
    elif ($hr | type) != "object" then "NOT_OBJECT"
    elif ($hr.summary // null) == null then "MISSING_SUMMARY"
    elif ($hr.summary | type) != "string" then "BAD_SUMMARY_TYPE"
    elif ($hr.summary | length) == 0 then "EMPTY_SUMMARY"
    elif ($hr.blockers // null) == null then "MISSING_BLOCKERS"
    elif ($hr.blockers | type) != "array" then "BAD_BLOCKERS_TYPE"
    else "OK"
    end
' 2>/dev/null)

[[ -z "$VALIDATION" ]] && exit 0   # jq execution failure → parse-failure pass-through

if [[ "$VALIDATION" == "OK" ]]; then
  exit 0
fi

CURRENT_VALUE=$(printf '%s' "$STATE_CONTENT" | jq -c '.halt_reason // null' 2>/dev/null)

cat >&2 <<EOF
halt-gate: phase=halt requires structured halt_reason before turn-end.

Set it in ${STATE_FILE} via atomic jq+tmp+mv, e.g.:

  jq '.halt_reason = {
    summary: "<one-line explanation>",
    blockers: ["<open question or blocker>", ...]
  }' "\$STATE_FILE" > "\$STATE_FILE.tmp" && mv "\$STATE_FILE.tmp" "\$STATE_FILE"

Shape rules:
  - summary: non-empty string describing why the session is halting
  - blockers: array (use [] for normal completion; enumerate open items otherwise)

Examples:
  Normal completion: {summary: "Plan approved; v3-final.md delivered", blockers: []}
  User cancel:       {summary: "User cancelled at phase=explore", blockers: []}
  Mid-flight abort:  {summary: "Halted on open design questions", blockers: ["OD3: DB lib?", "OD4: API shape?"]}

Validation failure: ${VALIDATION}
Current halt_reason: ${CURRENT_VALUE}
EOF

exit 2
