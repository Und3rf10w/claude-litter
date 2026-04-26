#!/usr/bin/env bash
# test-hook-graph.sh — correctness regression test for scripts/hook-graph.sh
#
# --check mode guards against drift from the committed snapshot but does NOT
# validate generator correctness: if the parser misses a state read the wrong
# output gets committed and --check keeps passing.  These assertions verify
# the real output against known-correct values.
#
# Previously-broken parse cases (fixed during development):
#   frontmatter-gate.sh  — reads were empty; now: .frontmatter_schema_version
#   session-context.sh   — echo|jq pattern missed; now: .goal .mode .phase .team_name
#   retest-dispatch.sh   — markers missed; now: test-results.jsonl
#
# Exit 0 = all pass
# Exit 1 = one or more failures

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
GENERATOR="${PLUGIN_ROOT}/scripts/hook-graph.sh"

if [[ ! -f "$GENERATOR" ]]; then
  printf 'SKIP: hook-graph.sh not found at %s\n' "$GENERATOR" >&2
  exit 0
fi

PASS=0
FAIL=0

_pass() {
  printf 'pass: %s\n' "$1"
  PASS=$((PASS + 1))
}

_fail() {
  printf 'FAIL: %s\n' "$1" >&2
  if [[ -n "${2:-}" ]]; then
    printf '  detail: %s\n' "$2" >&2
  fi
  FAIL=$((FAIL + 1))
}

_assert_contains() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    _pass "$name"
  else
    _fail "$name" "expected to find: $needle"
  fi
}

_assert_not_contains() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    _fail "$name" "found unexpected string: $needle"
  else
    _pass "$name"
  fi
}

# ── Generate output once ──
OUTPUT=$(bash "$GENERATOR" 2>/dev/null)

# Extract JSON block (between ```json and closing ```)
JSON_BLOCK=$(printf '%s' "$OUTPUT" | awk '/^```json$/{ found=1; next } found && /^```$/{ exit } found{ print }')

# Extract Mermaid block
MERMAID_BLOCK=$(printf '%s' "$OUTPUT" | awk '/^```mermaid$/{ found=1; next } found && /^```$/{ exit } found{ print }')

echo ""
echo "── Assertion 1: halt-gate.sh listed with correct state reads ──"
# halt-gate.sh must read .phase, .execute.phase, .halt_reason
HALT_BLOCK=$(printf '%s' "$JSON_BLOCK" | awk '/"halt-gate\.sh"/{found=1} found && /^\s+"source_refs"/{print; exit} found{print}')
_assert_contains "1a: halt-gate.sh in JSON" '"halt-gate.sh"' "$JSON_BLOCK"
_assert_contains "1b: halt-gate reads .phase" '".phase"' "$HALT_BLOCK"
_assert_contains "1c: halt-gate reads .execute.phase" '".execute.phase"' "$HALT_BLOCK"
_assert_contains "1d: halt-gate reads .halt_reason" '".halt_reason"' "$HALT_BLOCK"

echo ""
echo "── Assertion 2: task-completed-gate.sh writes.markers contains .gate-blocked- ──"
TCG_BLOCK=$(printf '%s' "$JSON_BLOCK" | awk '/"task-completed-gate\.sh"/{found=1} found && /^\s+"source_refs"/{print; exit} found{print}')
# Extract only writes section
TCG_WRITES=$(printf '%s' "$TCG_BLOCK" | awk '/"writes"/{found=1} found{print}')
_assert_contains "2: task-completed-gate writes .gate-blocked-" '".gate-blocked-"' "$TCG_WRITES"

echo ""
echo "── Assertion 3: frontmatter-gate.sh has NON-EMPTY reads (previously-broken case) ──"
FMG_BLOCK=$(printf '%s' "$JSON_BLOCK" | awk '/"frontmatter-gate\.sh"/{found=1} found && /^\s+"source_refs"/{print; exit} found{print}')
FMG_STATE_READS=$(printf '%s' "$FMG_BLOCK" | awk '/"state"/{found=1; next} found && /\]/{exit} found{print}')
# Check the state reads array has at least one non-empty entry
if printf '%s' "$FMG_STATE_READS" | grep -qE '"\.[a-zA-Z]'; then
  _pass "3a: frontmatter-gate has non-empty state reads"
else
  _fail "3a: frontmatter-gate has non-empty state reads" "state reads array appears empty — bug may have regressed"
fi
_assert_contains "3b: frontmatter-gate reads .frontmatter_schema_version" '".frontmatter_schema_version"' "$FMG_STATE_READS"

echo ""
echo "── Assertion 4: session-context.sh reads .team_name .goal .mode .phase (previously-broken case) ──"
SC_BLOCK=$(printf '%s' "$JSON_BLOCK" | awk '/"session-context\.sh"/{found=1} found && /^\s+"source_refs"/{print; exit} found{print}')
SC_READS=$(printf '%s' "$SC_BLOCK" | awk '/"state"/{found=1; next} found && /\]/{exit} found{print}')
_assert_contains "4a: session-context reads .team_name" '".team_name"' "$SC_READS"
_assert_contains "4b: session-context reads .goal" '".goal"' "$SC_READS"
_assert_contains "4c: session-context reads .mode" '".mode"' "$SC_READS"
_assert_contains "4d: session-context reads .phase" '".phase"' "$SC_READS"

echo ""
echo "── Assertion 5: retest-dispatch.sh writes.markers contains test-results.jsonl (previously-broken case) ──"
RD_BLOCK=$(printf '%s' "$JSON_BLOCK" | awk '/"retest-dispatch\.sh"/{found=1} found && /^\s+"source_refs"/{print; exit} found{print}')
RD_WRITES=$(printf '%s' "$RD_BLOCK" | awk '/"writes"/{found=1} found{print}')
_assert_contains "5: retest-dispatch writes test-results.jsonl" '"test-results.jsonl"' "$RD_WRITES"

echo ""
echo "── Assertion 6: blocklist — no hook has .tool_input or .tool_result in state reads ──"
if printf '%s' "$JSON_BLOCK" | grep -qE '"\.(tool_input|tool_result)'; then
  # Find offending lines for the error message
  VIOLATIONS=$(printf '%s' "$JSON_BLOCK" | grep -E '"\.(tool_input|tool_result)' | head -3)
  _fail "6: no tool_input/tool_result in state reads" "$VIOLATIONS"
else
  _pass "6: blocklist enforced — no tool_input/tool_result in state reads"
fi

echo ""
echo "── Assertion 7: node/edge count sanity ──"
# Count hook nodes in Mermaid (lines inside Hooks_Design or Hooks_Execute subgraphs)
HOOK_NODE_COUNT=$(printf '%s' "$MERMAID_BLOCK" | awk '
  /subgraph Hooks_Design/ { in_hooks=1 }
  /subgraph Hooks_Execute/ { in_hooks=1 }
  in_hooks && /^  end/ { in_hooks=0 }
  in_hooks && /\["/ { count++ }
  END { print count+0 }
')
if [[ "$HOOK_NODE_COUNT" -ge 20 ]]; then
  _pass "7a: Mermaid has >= 20 hook nodes (actual: $HOOK_NODE_COUNT)"
else
  _fail "7a: Mermaid has >= 20 hook nodes" "actual: $HOOK_NODE_COUNT"
fi

# Count top-level keys in hooks JSON object
JSON_HOOK_COUNT=$(printf '%s' "$JSON_BLOCK" | grep -cE '^\s+"[a-z][a-z0-9_-]*\.sh":' || true)
if [[ "$JSON_HOOK_COUNT" -ge 20 ]]; then
  _pass "7b: adjacency JSON has >= 20 hooks (actual: $JSON_HOOK_COUNT)"
else
  _fail "7b: adjacency JSON has >= 20 hooks" "actual: $JSON_HOOK_COUNT"
fi

echo ""
echo "── Assertion 8: determinism — two runs produce byte-identical output ──"
TMP1=$(mktemp "${TMPDIR:-/tmp}/hook-graph-test-XXXXXX")
TMP2=$(mktemp "${TMPDIR:-/tmp}/hook-graph-test-XXXXXX")
bash "$GENERATOR" > "$TMP1" 2>/dev/null
bash "$GENERATOR" > "$TMP2" 2>/dev/null
if diff -q "$TMP1" "$TMP2" >/dev/null 2>&1; then
  _pass "8: generator output is byte-identical on two runs"
else
  _fail "8: generator output is byte-identical on two runs" "diff found between run1 and run2"
fi
rm -f "$TMP1" "$TMP2"

echo ""
echo "── Assertion 9: --check passes on unchanged repo ──"
bash "$GENERATOR" --check >/dev/null 2>&1
RC_CHECK=$?
if [[ "$RC_CHECK" -eq 0 ]]; then
  _pass "9: --check exits 0 on unchanged repo"
else
  _fail "9: --check exits 0 on unchanged repo" "exit code: $RC_CHECK (snapshot may be stale; run: bash plugins/deepwork/scripts/hook-graph.sh > plugins/deepwork/references/hook-architecture.md)"
fi

echo ""
echo "── Assertion 10: --check detects drift (self-reverting) ──"
# Temporarily corrupt the snapshot by appending a line, then verify --check exits 2.
# Restoring the original snapshot is guaranteed via a subshell trap.
SNAPSHOT_FILE="${PLUGIN_ROOT}/references/hook-architecture.md"
if [[ ! -f "$SNAPSHOT_FILE" ]]; then
  _fail "10: --check detects drift" "snapshot file not found: $SNAPSHOT_FILE"
else
  SNAPSHOT_BACKUP=$(mktemp "${TMPDIR:-/tmp}/hook-arch-backup-XXXXXX")
  cp "$SNAPSHOT_FILE" "$SNAPSHOT_BACKUP"

  # Corrupt snapshot so generator output will differ
  printf '\n<!-- regression-test-drift-probe -->\n' >> "$SNAPSHOT_FILE"

  bash "$GENERATOR" --check >/dev/null 2>&1
  RC_DRIFT=$?

  # Revert always, even if assertion fails
  cp "$SNAPSHOT_BACKUP" "$SNAPSHOT_FILE"
  rm -f "$SNAPSHOT_BACKUP"

  if [[ "$RC_DRIFT" -eq 2 ]]; then
    _pass "10: --check exits 2 on drift (snapshot reverted)"
  else
    _fail "10: --check exits 2 on drift" "exit code: $RC_DRIFT (expected 2)"
  fi
fi

# ── Summary ──
echo ""
echo "─────────────────────────────────────"
printf "Passed: %d | Failed: %d\n" "$PASS" "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
