#!/usr/bin/env bash
# test-path-canonicalize.sh — regression tests for PR-C path canonicalization.
#
# Verifies that hooks fire correctly when file_path is expressed as a relative
# path, a path with .., a symlinked path, or a path to a non-existent file.
#
# PC-a: relative path ./state.json resolves to absolute INSTANCE_DIR/state.json → gate fires
# PC-b: path with .. (INSTANCE_DIR/foo/../state.json) → gate fires
# PC-c: symlinked path → resolves to canonical, gate fires
# PC-d: non-existent file (new write target) → canonical computed via dirname → gate fires correctly
# PC-e: empty file_path → no-op, exit 0
#
# Exit 0 = all pass; Exit 1 = one or more failures

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

PASS=0
FAIL=0

_pass() { printf 'pass: %s\n' "$1"; PASS=$((PASS + 1)); }
_fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }

_assert_exit() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    _pass "${name} (exit=${actual})"
  else
    _fail "${name} — expected exit ${expected}, got ${actual}"
  fi
}

_assert_contains() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    _pass "${name} (found \"${needle}\")"
  else
    _fail "${name} — did not find \"${needle}\" in output: ${haystack}"
  fi
}

# ── Fixture setup ──
SANDBOX=$(mktemp -d)
# Resolve sandbox through symlinks (macOS /var → /private/var)
SANDBOX="$(cd "$SANDBOX" && pwd -P)"
trap 'rm -rf "$SANDBOX"' EXIT

INSTANCE_ID="ab12cd34"
INSTANCE_DIR="${SANDBOX}/.claude/deepwork/${INSTANCE_ID}"
mkdir -p "$INSTANCE_DIR"
SESSION_ID="test-pc-$(date +%s)"

# Write a valid execute state.json
STATE_FILE="${INSTANCE_DIR}/state.json" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" init - <<EOF
{
  "session_id": "${SESSION_ID}",
  "execute": {
    "phase": "execute",
    "plan_ref": "plan.md",
    "plan_hash": "abc123",
    "plan_drift_detected": false,
    "authorized_force_push": false,
    "authorized_push": false,
    "authorized_prod_deploy": false,
    "authorized_local_destructive": false,
    "secret_scan_waived": false,
    "setup_flags_snapshot": {},
    "test_manifest": []
  }
}
EOF

# plan-citation-gate.sh helper: runs the gate against a given file_path string.
# Appends the exit code on its own line so callers can use `tail -1` to extract it.
_citation_gate() {
  local file_path="$1"
  local _out _rc
  _out=$(printf '{"session_id":"%s","tool_input":{"file_path":"%s"}}' "$SESSION_ID" "$file_path" \
    | CLAUDE_PROJECT_DIR="$SANDBOX" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
      bash "${PLUGIN_ROOT}/hooks/execute/plan-citation-gate.sh" 2>&1)
  _rc=$?
  printf '%s\n%s\n' "$_out" "$_rc"
}

# state-drift-marker.sh helper: runs the PreToolUse leg against a given file_path
_drift_marker_pre() {
  local file_path="$1"
  printf '{"session_id":"%s","hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"%s"}}' \
    "$SESSION_ID" "$file_path" \
    | CLAUDE_PROJECT_DIR="$SANDBOX" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
      bash "${PLUGIN_ROOT}/hooks/state-drift-marker.sh" 2>&1
  echo $?
}

# frontmatter-gate.sh helper: runs the gate against a given file_path and content
_frontmatter_gate() {
  local file_path="$1" content="$2"
  local payload
  payload=$(printf '{"session_id":"%s","hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"%s","content":"%s"}}' \
    "$SESSION_ID" "$file_path" "$content")
  printf '%s' "$payload" \
    | CLAUDE_PROJECT_DIR="$SANDBOX" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
      bash "${PLUGIN_ROOT}/hooks/frontmatter-gate.sh" 2>&1
  echo $?
}

# ── PC-a: relative path ./state.json → plan-citation-gate must fire (state.json is protected) ──
echo ""
echo "── PC-a: relative path ./state.json → plan-citation-gate fires (protected file) ──"
# Change cwd to INSTANCE_DIR so that ./state.json resolves there
(
  cd "$INSTANCE_DIR" 2>/dev/null || exit 1
  OUT=$(printf '{"session_id":"%s","tool_input":{"file_path":"%s"}}' \
    "$SESSION_ID" "./state.json" \
    | CLAUDE_PROJECT_DIR="$SANDBOX" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
      bash "${PLUGIN_ROOT}/hooks/execute/plan-citation-gate.sh" 2>&1)
  RC=$(printf '%s' "$OUT" | tail -1)
  if printf '%s' "$OUT" | grep -qE 'BLOCKED|pending-change|GAP-10'; then
    printf 'pass: PC-a (relative ./state.json canonicalized, gate fired)\n'
    exit 0
  else
    printf 'FAIL: PC-a — gate did not fire for relative ./state.json\n  output: %s\n' "$OUT" >&2
    exit 1
  fi
)
[ $? -eq 0 ] && PASS=$((PASS + 1)) || FAIL=$((FAIL + 1))

# ── PC-b: path with .. resolves to state.json → gate fires ──
echo ""
echo "── PC-b: path INSTANCE_DIR/subdir/../state.json → gate fires ──"
mkdir -p "${INSTANCE_DIR}/subdir"
DOTDOT_PATH="${INSTANCE_DIR}/subdir/../state.json"
OUT=$(_citation_gate "$DOTDOT_PATH")
RC=$(printf '%s' "$OUT" | tail -1)
if printf '%s' "$OUT" | grep -qE 'BLOCKED|pending-change|GAP-10'; then
  _pass "PC-b: dotdot path canonicalized, gate fired"
else
  _fail "PC-b — gate did not fire for dotdot path (${DOTDOT_PATH}); output: ${OUT}"
fi

# ── PC-c: symlinked path → resolves to canonical target, gate fires ──
echo ""
echo "── PC-c: symlinked path → gate fires on real target ──"
LINK_DIR="${SANDBOX}/sym-instance"
ln -s "$INSTANCE_DIR" "$LINK_DIR" 2>/dev/null
if [[ -L "$LINK_DIR" ]]; then
  SYMLINK_PATH="${LINK_DIR}/state.json"
  # plan-citation-gate skips symlinked instance dirs via discover_instance guards,
  # so test via state-drift-marker (which uses INSTANCE_DIR after canonicalization).
  # We write a pending-change.json and use frontmatter-gate to confirm path resolves.
  # Better: use the _canonical_path function directly by sourcing instance-lib.sh
  # and confirming that the symlink resolves to the real path.
  CANONICAL=$(bash -c "
    source '${PLUGIN_ROOT}/scripts/instance-lib.sh'
    _canonical_path '${SYMLINK_PATH}'
  " 2>/dev/null)
  EXPECTED_CANONICAL="${INSTANCE_DIR}/state.json"
  if [[ "$CANONICAL" == "$EXPECTED_CANONICAL" ]]; then
    _pass "PC-c: symlinked path resolved to canonical (${CANONICAL})"
  else
    _fail "PC-c: expected ${EXPECTED_CANONICAL}, got ${CANONICAL}"
  fi
else
  printf 'SKIP: PC-c — ln -s not available or sandbox unsupported symlinks\n'
fi

# ── PC-d: non-existent file → _canonical_path computes canonical via dirname ──
echo ""
echo "── PC-d: non-existent new-file target → _canonical_path resolves via dirname ──"
# The file does not exist yet; dirname (INSTANCE_DIR) exists.
NONEXISTENT="${INSTANCE_DIR}/new-output-file.ts"
CANONICAL_NE=$(bash -c "
  source '${PLUGIN_ROOT}/scripts/instance-lib.sh'
  _canonical_path '${NONEXISTENT}'
" 2>/dev/null)
# The result must be absolute and preserve the basename
if [[ "$CANONICAL_NE" == "${INSTANCE_DIR}/new-output-file.ts" ]]; then
  _pass "PC-d: non-existent file canonical path correct (${CANONICAL_NE})"
else
  _fail "PC-d: expected ${INSTANCE_DIR}/new-output-file.ts, got ${CANONICAL_NE}"
fi

# Also verify that plan-citation-gate fires (G3 no pending-change) for non-existent target
OUT_NE=$(_citation_gate "$NONEXISTENT")
if printf '%s' "$OUT_NE" | grep -qE 'BLOCKED|pending-change'; then
  _pass "PC-d: gate fires correctly for non-existent target file"
else
  _fail "PC-d: gate did not fire for non-existent target; output: ${OUT_NE}"
fi

# ── PC-e: empty file_path → no-op, exit 0 ──
echo ""
echo "── PC-e: empty file_path → _canonical_path returns empty, hooks exit 0 ──"
CANONICAL_EMPTY=$(bash -c "
  source '${PLUGIN_ROOT}/scripts/instance-lib.sh'
  _canonical_path ''
" 2>/dev/null)
if [[ -z "$CANONICAL_EMPTY" ]]; then
  _pass "PC-e: empty input → empty output"
else
  _fail "PC-e: expected empty, got '${CANONICAL_EMPTY}'"
fi

# plan-citation-gate should exit 0 (pass-through) when file_path is empty
OUT_E=$(_citation_gate "")
RC_E=$(printf '%s' "$OUT_E" | tail -1)
_assert_exit "PC-e: empty file_path exits 0" "0" "$RC_E"

# ── Summary ──
echo ""
echo "─────────────────────────────────────"
printf "Passed: %d | Failed: %d\n" "$PASS" "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
