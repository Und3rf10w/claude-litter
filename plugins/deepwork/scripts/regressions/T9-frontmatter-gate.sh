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
cat > "$INSTANCE_DIR/state.json" <<EOF
{
  "session_id": "$SESSION_ID",
  "phase": "explore",
  "team_name": "test-team",
  "frontmatter_schema_version": "1"
}
EOF

export CLAUDE_CODE_SESSION_ID="$SESSION_ID"

_run_gate() {
  local tool_name="$1" file_path="$2" content="$3"
  local payload
  payload=$(jq -cn \
    --arg sid "$SESSION_ID" \
    --arg tn "$tool_name" \
    --arg fp "$file_path" \
    --arg c  "$content" \
    '{session_id: $sid, tool_name: $tn, tool_input: {file_path: $fp, content: $c}}')
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
    '{session_id: $sid, tool_name: "Edit", tool_input: {file_path: $fp, new_string: $ns}}')
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
cat > "$INSTANCE_DIR/state.json" <<EOF
{
  "session_id": "$SESSION_ID",
  "phase": "explore",
  "team_name": "test-team"
}
EOF
_assert_exit "T9-i: pre-fix session fail-open" "0" "$(_run_gate "Write" "$TARGET_MD" "$CONTENT_NO_ATYPE")"

# Restore schema version for remaining tests
cat > "$INSTANCE_DIR/state.json" <<EOF
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

# ── (k) ADV: non-.md file in instance dir → not matched, allowed ──
echo ""
echo "── T9-k (ADV): Write to .json file in instance dir → not matched, allowed ──"
STATE_WRITE="${INSTANCE_DIR}/state.json"
_assert_exit "T9-k: Write to .json in instance dir" "0" "$(_run_gate "Write" "$STATE_WRITE" '{"phase":"explore"}')"

# ── Summary ──
echo ""
echo "─────────────────────────────────────"
printf "Passed: %d | Failed: %d\n" "$PASS" "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
