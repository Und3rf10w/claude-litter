#!/usr/bin/env bash
# T9-frontmatter-gate.sh — adversarial tests for hooks/frontmatter-gate.sh (G-exec-2)
#
# Designed to fail if the gate implementation is subtly wrong. Run before and after
# G-exec-2 implementation to confirm coverage.
#
# Exit 0 = all cases behaved as expected
# Exit 1 = one or more cases failed

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
GATE="${PLUGIN_ROOT}/hooks/frontmatter-gate.sh"

if [[ ! -f "$GATE" ]]; then
  printf 'SKIP: frontmatter-gate.sh not found at %s\n' "$GATE" >&2
  exit 0
fi

PASS=0
FAIL=0

_assert_exit() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    printf 'pass: %s (exit=%s)\n' "$name" "$actual"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s — expected exit %s, got %s\n' "$name" "$expected" "$actual" >&2
    FAIL=$((FAIL + 1))
  fi
}

# ── Fixture setup ──
SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

export CLAUDE_PROJECT_DIR="$SANDBOX"
INSTANCE_ID="ab12cd34"
INSTANCE_DIR="$SANDBOX/.claude/deepwork/$INSTANCE_ID"
mkdir -p "$INSTANCE_DIR"

SESSION_ID="test-session-$(date +%s)"

# state.json with frontmatter_schema_version=1 (enforcement enabled)
STATE_FILE="$INSTANCE_DIR/state.json" \
  bash "${PLUGIN_ROOT}/scripts/state-transition.sh" init - <<EOF
{
  "session_id": "$SESSION_ID",
  "phase": "explore",
  "team_name": "test-team",
  "frontmatter_schema_version": "1"
}
EOF

_run_gate() {
  local tool_name="$1" file_path="$2" content="$3"
  local payload
  payload=$(jq -cn \
    --arg sid "$SESSION_ID" \
    --arg tn "$tool_name" \
    --arg fp "$file_path" \
    --arg c  "$content" \
    '{session_id: $sid, hook_event_name: "PreToolUse", tool_name: $tn, tool_input: {file_path: $fp, content: $c}}')
  printf '%s' "$payload" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$GATE" >/dev/null 2>&1
  echo $?
}

_run_gate_edit() {
  local file_path="$1" new_string="$2"
  local payload
  payload=$(jq -cn \
    --arg sid "$SESSION_ID" \
    --arg fp  "$file_path" \
    --arg ns  "$new_string" \
    '{session_id: $sid, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {file_path: $fp, new_string: $ns}}')
  printf '%s' "$payload" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$GATE" >/dev/null 2>&1
  echo $?
}

TARGET_MD="${INSTANCE_DIR}/findings.test-agent.md"
LOG_MD="${INSTANCE_DIR}/log.md"

# ── (a) Write missing artifact_type → blocked exit 2 ──
echo ""
echo "── T9-a: Write with missing artifact_type → blocked (exit 2) ──"
CONTENT_NO_ATYPE=$(cat <<'EOF'
---
author: test-agent
instance: ab12cd34
task_id: "1"
bar_id: G1
sources: []
---

Body without artifact_type.
EOF
)
_assert_exit "T9-a: Write missing artifact_type" "2" "$(_run_gate "Write" "$TARGET_MD" "$CONTENT_NO_ATYPE")"

# ── (b) Write with all required fields → allowed exit 0 ──
echo ""
echo "── T9-b: Write with all required fields → allowed (exit 0) ──"
CONTENT_VALID=$(cat <<'EOF'
---
artifact_type: findings
author: test-agent
instance: ab12cd34
task_id: "1"
bar_id: G1
sources: []
---

Valid artifact body.
EOF
)
_assert_exit "T9-b: Write with all required fields" "0" "$(_run_gate "Write" "$TARGET_MD" "$CONTENT_VALID")"

# ── (c) Write with wrong instance field → blocked ──
# The plan requires that instance value matches INSTANCE_ID (ab12cd34).
# A wrong value (deadbeef) must be blocked.
echo ""
echo "── T9-c: Write with wrong instance value → blocked (exit 2) ──"
CONTENT_WRONG_INSTANCE=$(cat <<'EOF'
---
artifact_type: findings
author: test-agent
instance: deadbeef
task_id: "1"
bar_id: G1
sources: []
---

Wrong instance ID.
EOF
)
_assert_exit "T9-c: Write with wrong instance value" "2" "$(_run_gate "Write" "$TARGET_MD" "$CONTENT_WRONG_INSTANCE")"

# ── (d) Partial Edit on existing-frontmatter file without frontmatter in new_string → allowed (fail-open) ──
# Setup: file already exists with valid frontmatter on disk
echo ""
echo "── T9-d: Partial Edit on existing-frontmatter file → allowed (fail-open) ──"
printf '%s\n' "$CONTENT_VALID" > "$TARGET_MD"
PARTIAL_PATCH="Additional insight appended by Edit."
_assert_exit "T9-d: Partial Edit fail-open" "0" "$(_run_gate_edit "$TARGET_MD" "$PARTIAL_PATCH")"

# ── (e) Write to log.md → allowed (carve-out) ──
echo ""
echo "── T9-e: Write to log.md → allowed (carve-out; no frontmatter required) ──"
_assert_exit "T9-e: Write to log.md allowed" "0" "$(_run_gate "Write" "$LOG_MD" "## [2026-01-01] Session started")"

# ── (f) Write to a file outside instance dir → not matched, allowed ──
echo ""
echo "── T9-f: Write outside instance dir → not matched, allowed (exit 0) ──"
OUTSIDE_FILE="$SANDBOX/some-other-dir/notes.md"
mkdir -p "$(dirname "$OUTSIDE_FILE")"
_assert_exit "T9-f: Write outside instance dir" "0" "$(_run_gate "Write" "$OUTSIDE_FILE" "No frontmatter here.")"

# ── (g) ADV: Write with task_ids (plural) instead of task_id → should be allowed ──
# The plan schema allows task_ids as an alternative to task_id. A gate that only
# checks task_id (not task_ids) would falsely block valid multi-task artifacts.
echo ""
echo "── T9-g (ADV): Write with task_ids (plural) → should be allowed (plan schema allows plural) ──"
CONTENT_TASK_IDS=$(cat <<'EOF'
---
artifact_type: findings
author: test-agent
instance: ab12cd34
task_ids: ["1","2"]
bar_id: G1
sources: []
---

Multi-task artifact body.
EOF
)
_assert_exit "T9-g: task_ids plural accepted" "0" "$(_run_gate "Write" "$TARGET_MD" "$CONTENT_TASK_IDS")"

# ── (h) ADV: Write with bar_ids (plural) instead of bar_id → should be allowed ──
echo ""
echo "── T9-h (ADV): Write with bar_ids (plural) → should be allowed ──"
CONTENT_BAR_IDS=$(cat <<'EOF'
---
artifact_type: findings
author: test-agent
instance: ab12cd34
task_id: "1"
bar_ids: [G1, G2]
sources: []
---

Multi-gate artifact body.
EOF
)
_assert_exit "T9-h: bar_ids plural accepted" "0" "$(_run_gate "Write" "$TARGET_MD" "$CONTENT_BAR_IDS")"

# ── (i) ADV: pre-fix session (no schema_version) → gate should warn-only, exit 0 ──
echo ""
echo "── T9-i (ADV): pre-fix session (no frontmatter_schema_version) → warn-only, exit 0 ──"
rm -f "$INSTANCE_DIR/state.json"
STATE_FILE="$INSTANCE_DIR/state.json" \
  bash "${PLUGIN_ROOT}/scripts/state-transition.sh" init - <<EOF
{
  "session_id": "$SESSION_ID",
  "phase": "explore",
  "team_name": "test-team"
}
EOF
_assert_exit "T9-i: pre-fix session fail-open" "0" "$(_run_gate "Write" "$TARGET_MD" "$CONTENT_NO_ATYPE")"

# Restore schema version for remaining tests
rm -f "$INSTANCE_DIR/state.json"
STATE_FILE="$INSTANCE_DIR/state.json" \
  bash "${PLUGIN_ROOT}/scripts/state-transition.sh" init - <<EOF
{
  "session_id": "$SESSION_ID",
  "phase": "explore",
  "team_name": "test-team",
  "frontmatter_schema_version": "1"
}
EOF

# ── (j) ADV: Write to prompt.md → allowed (other carve-out) ──
echo ""
echo "── T9-j (ADV): Write to prompt.md → allowed (exempt like log.md) ──"
PROMPT_MD="${INSTANCE_DIR}/prompt.md"
_assert_exit "T9-j: Write to prompt.md allowed" "0" "$(_run_gate "Write" "$PROMPT_MD" "# Initial prompt")"

# ── (k) Single-writer gate: direct Write to state.json → blocked (exit 2) ──
echo ""
echo "── T9-k (single-writer): direct Write to state.json without sentinel → blocked ──"
STATE_WRITE="${INSTANCE_DIR}/state.json"
_assert_exit "T9-k: Write to state.json blocked by single-writer gate" "2" "$(_run_gate "Write" "$STATE_WRITE" '{"phase":"explore"}')"

# ── (T9-sw-h) Single-writer gate: Write WITH sentinel → allowed ──
echo ""
echo "── T9-sw-h: Write to state.json WITH _DW_STATE_TRANSITION_WRITER=1 → allowed ──"
_run_gate_with_sentinel() {
  local tool_name="$1" file_path="$2" content="$3"
  local payload
  payload=$(jq -cn \
    --arg sid "$SESSION_ID" \
    --arg tn  "$tool_name" \
    --arg fp  "$file_path" \
    --arg ct  "$content" \
    '{session_id: $sid, hook_event_name: "PreToolUse", tool_name: $tn, tool_input: {file_path: $fp, content: $ct}}')
  printf '%s' "$payload" \
    | _DW_STATE_TRANSITION_WRITER=1 \
      CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
      bash "$GATE" 2>/dev/null
  printf '%s' "$?"
}
_assert_exit "T9-sw-h: Write to state.json with sentinel allowed" "0" "$(_run_gate_with_sentinel "Write" "$STATE_WRITE" '{"phase":"explore"}')"

# ── (T9-sw-i) Single-writer gate: Write without sentinel → blocked ──
echo ""
echo "── T9-sw-i: Write to state.json WITHOUT sentinel → blocked (exit 2) ──"
_assert_exit "T9-sw-i: Write to state.json without sentinel blocked" "2" "$(_run_gate "Write" "$STATE_WRITE" '{"phase":"explore"}')"

# ── (T9-ot-a) override-tokens.json single-writer gate: direct Write → blocked ──
echo ""
echo "── T9-ot-a: direct Write to override-tokens.json → blocked (exit 2) ──"
OT_FILE="${INSTANCE_DIR}/override-tokens.json"
_assert_exit "T9-ot-a: Write to override-tokens.json blocked" "2" \
  "$(_run_gate "Write" "$OT_FILE" '{"tokens":[]}')"

# ── (T9-ot-b) override-tokens.json single-writer gate: Write WITH sentinel → allowed ──
echo ""
echo "── T9-ot-b: Write to override-tokens.json WITH _DW_STATE_TRANSITION_WRITER=1 → allowed ──"
_assert_exit "T9-ot-b: Write to override-tokens.json with sentinel allowed" "0" \
  "$(_run_gate_with_sentinel "Write" "$OT_FILE" '{"tokens":[]}')"

# ── (T9-ot-c) override-tokens.json gate: Edit without sentinel → blocked ──
echo ""
echo "── T9-ot-c: Edit to override-tokens.json without sentinel → blocked (exit 2) ──"
_assert_exit "T9-ot-c: Edit to override-tokens.json without sentinel blocked" "2" \
  "$(_run_gate_edit "$OT_FILE" '{"tokens":[]}')"

# ── W15 FG-a: prefix match — sibling-dir substring match must NOT pass ──
# A path like /some/parent-ab12cd34-extra/file.md matches the old substring
# check but should NOT match the new prefix check.
echo ""
echo "── FG-a (W15): sibling dir with instance-ID substring — NOT matched ──"
SIBLING_DIR="$SANDBOX/.claude/deepwork/sibling-${INSTANCE_ID}-suffix"
mkdir -p "$SIBLING_DIR"
SIBLING_FILE="$SIBLING_DIR/findings.md"
# This must exit 0 (not in scope) rather than trying to validate frontmatter
_assert_exit "FG-a: sibling dir not matched by prefix check" "0" \
  "$(_run_gate "Write" "$SIBLING_FILE" "no frontmatter here")"

# ── W15 FG-b: body-text fields do NOT satisfy frontmatter requirement ──
# A file where artifact_type, author etc. appear in the document body (after
# the closing ---) must still be rejected if the frontmatter block is absent/empty.
echo ""
echo "── FG-b (W15): required fields only in body, not in frontmatter → blocked ──"
CONTENT_FIELDS_IN_BODY=$(cat <<'EOF'
no frontmatter here

artifact_type: findings
author: test-agent
instance: ab12cd34
task_id: "1"
bar_id: G1
sources: []
EOF
)
_assert_exit "FG-b: body-only fields rejected (no frontmatter block)" "2" \
  "$(_run_gate "Write" "$TARGET_MD" "$CONTENT_FIELDS_IN_BODY")"

# ── W15 FG-c: Edit that removes artifact_type is blocked ──
# File on disk has valid frontmatter. Edit replaces artifact_type line with empty.
echo ""
echo "── FG-c (W15): Edit that removes artifact_type → blocked (exit 2) ──"
printf '%s\n' "$CONTENT_VALID" > "$TARGET_MD"
_run_gate_edit_full() {
  local file_path="$1" old_string="$2" new_string="$3"
  local payload
  payload=$(jq -cn \
    --arg sid "$SESSION_ID" \
    --arg fp  "$file_path" \
    --arg os  "$old_string" \
    --arg ns  "$new_string" \
    '{session_id: $sid, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {file_path: $fp, old_string: $os, new_string: $ns}}')
  printf '%s' "$payload" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$GATE" >/dev/null 2>&1
  echo $?
}
_assert_exit "FG-c: Edit removing artifact_type blocked" "2" \
  "$(_run_gate_edit_full "$TARGET_MD" "artifact_type: findings" "")"

# ── W15 FG-d: Edit that preserves artifact_type passes ──
echo ""
echo "── FG-d (W15): Edit that preserves artifact_type → allowed (exit 0) ──"
_assert_exit "FG-d: Edit preserving artifact_type passes" "0" \
  "$(_run_gate_edit_full "$TARGET_MD" "Valid artifact body." "Updated artifact body.")"

# ── Summary ──
echo ""
echo "─────────────────────────────────────"
printf "Passed: %d | Failed: %d\n" "$PASS" "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
