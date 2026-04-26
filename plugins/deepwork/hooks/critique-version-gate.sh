#!/bin/bash
# critique-version-gate.sh — TaskCompleted hook: Layer 3 (OPT-IN) of the
# 3-layer halt-pending-verdict defense (M3 Component C, proposals/v3-final.md).
#
# Fires when any TaskCompleted event dispatches (per hooks.md §TaskCompleted,
# matchQuery is not set — the hook must filter inside). Only acts on CRITIC
# verdict tasks whose subject references a version string, and only when the
# guardrail `critique_version_gate: true` is present in state.json.guardrails[].
#
# Input schema (hooks.md §TaskCompleted):
#   {hook_event_name: "TaskCompleted", task_id, task_subject, task_description?,
#    teammate_name?, team_name?}
#
# Exit 2 → blockingError; the critique task completion is blocked. Layer 3
# only activates when the user opts in — see setup-deepwork.sh `--guardrail`
# pattern or the /deepwork-guardrail add flow to enable it for safety-critical
# runs.

set +e
command -v jq >/dev/null 2>&1 || exit 0

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"
_parse_hook_input

TEAM_NAME=$(printf '%s' "$INPUT" | jq -r '.team_name // ""' 2>/dev/null)
TASK_SUBJECT=$(printf '%s' "$INPUT" | jq -r '.task_subject // ""' 2>/dev/null)
TEAMMATE=$(printf '%s' "$INPUT" | jq -r '.teammate_name // ""' 2>/dev/null)

# Resolve instance via team_name (TaskCompleted payload has team_name, not session_id).
[[ -n "$TEAM_NAME" ]] || exit 0
discover_instance_by_team_name "$TEAM_NAME" 2>/dev/null || exit 0

# Opt-in gate: look for `critique_version_gate` in guardrails.
HAS_GUARDRAIL=$(jq -r '.guardrails[]?.rule // empty' "$STATE_FILE" 2>/dev/null | grep -ciE 'critique[_-]version[_-]gate' || echo "0")
HAS_GUARDRAIL=$(printf '%s' "$HAS_GUARDRAIL" | tr -d ' \n')
[[ "$HAS_GUARDRAIL" =~ ^[0-9]+$ ]] || HAS_GUARDRAIL=0
[[ "$HAS_GUARDRAIL" -gt 0 ]] || exit 0

# Only act on critic tasks referencing a version in the subject.
# (CRITIC's critique tasks typically have subjects like "critique.v2.md" or
# "G1 critique v3".)
[[ "$TEAMMATE" == "critic" || "$TASK_SUBJECT" == *critique* || "$TASK_SUBJECT" == *CRITIQUE* ]] || exit 0

TASK_VER=$(printf '%s' "$TASK_SUBJECT" | grep -oE 'v[0-9]+(-final)?' | head -1)
[[ -n "$TASK_VER" ]] || exit 0

SENTINEL="${INSTANCE_DIR}/version-sentinel.json"
[[ -f "$SENTINEL" ]] || exit 0

CUR_VER=$(jq -r '.current_version // ""' "$SENTINEL" 2>/dev/null)
[[ -n "$CUR_VER" ]] || exit 0

TASK_VER_BASE="${TASK_VER%-final}"
CUR_VER_BASE="${CUR_VER%-final}"

if [[ "$TASK_VER_BASE" != "$CUR_VER_BASE" ]]; then
  printf 'TaskCompleted blocked (Layer 3 critique-version-gate):\n' >&2
  printf '  task subject: %s\n' "$TASK_SUBJECT" >&2
  printf '  references:   %s\n' "$TASK_VER" >&2
  printf '  current:      %s (from %s)\n' "$CUR_VER" "$SENTINEL" >&2
  printf 'Re-verdict the current proposal version before completing this task.\n' >&2
  exit 2
fi

exit 0
