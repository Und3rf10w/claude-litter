#!/usr/bin/env bash
# run-all-tests.sh — aggregate test runner for all deepwork test suites.
# Runs every test-*.sh in scripts/ and regressions/, plus T-prefixed suites.
# Per-suite pass/fail summary at end; exits non-zero if any suite failed.
#
# Usage:
#   bash plugins/deepwork/scripts/run-all-tests.sh
#
# Output format:
#   PASS <suite-name>   (suite exited 0)
#   FAIL <suite-name>   (suite exited non-zero)

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGRESSIONS_DIR="${SCRIPT_DIR}/regressions"

PASS_SUITES=0
FAIL_SUITES=0
FAILED_NAMES=()

_run_suite() {
  local path="$1"
  local name
  name="$(basename "$path")"
  printf '── %s ──\n' "$name"
  bash "$path" 2>&1
  local rc=$?
  if [[ $rc -eq 0 ]]; then
    printf 'PASS %s\n\n' "$name"
    PASS_SUITES=$((PASS_SUITES + 1))
  else
    printf 'FAIL %s (exit=%d)\n\n' "$name" "$rc"
    FAIL_SUITES=$((FAIL_SUITES + 1))
    FAILED_NAMES+=("$name")
  fi
}

# scripts/ suites (top-level test-*.sh)
for suite in "$SCRIPT_DIR"/test-*.sh; do
  [[ -f "$suite" ]] || continue
  _run_suite "$suite"
done

# regressions/ suites (test-*.sh and T*.sh)
for suite in "$REGRESSIONS_DIR"/test-*.sh "$REGRESSIONS_DIR"/T*.sh; do
  [[ -f "$suite" ]] || continue
  _run_suite "$suite"
done

# ── T-P6-test-tmp-uniqueness ──────────────────────────────────────────────────
# F-P6 (v5-final): test files must not WRITE to bare /tmp/<word>.<ext> paths
# (e.g. `>> /tmp/out.json`, `--output /tmp/out.json`) — concurrent test runs
# collide and orphan files accumulate. Required pattern is mktemp -t
# <prefix>.XXXXXX. This grep scans every test suite for write-creating uses
# of bare /tmp/<word>.<ext> paths. STRING LITERAL uses (--plan-ref /tmp/plan.md
# as parser-test input, ["/tmp/x.ts"] as JSON test data, hook-regex inputs)
# are intentionally NOT flagged — they exercise parsing/regex code paths and
# never touch the filesystem.
printf '── T-P6-test-tmp-uniqueness ──\n'
_TP6_VIOLATIONS=$(
  for f in "$SCRIPT_DIR"/test-*.sh "$REGRESSIONS_DIR"/test-*.sh "$REGRESSIONS_DIR"/T*.sh; do
    [[ -f "$f" ]] || continue
    # Match shell write-redirects and well-known output flags pointing at bare
    # /tmp/<word>.<ext>. Excludes lines beginning with #, lines that contain
    # mktemp on the same line, and the trap rm -f cleanup line (where the
    # /tmp path is being removed, not written).
    grep -nE '(>>?[[:space:]]*|--output[[:space:]]+|--out[[:space:]]+|-o[[:space:]]+|tee[[:space:]]+(-a[[:space:]]+)?)/tmp/[A-Za-z0-9_-]+\.[A-Za-z0-9]+' "$f" \
      | grep -vE '^[^:]*:[[:space:]]*[0-9]+:[[:space:]]*#' \
      | grep -vE 'mktemp|rm[[:space:]]+-f' \
      | sed "s|^|${f}: |"
  done
)
if [[ -n "$_TP6_VIOLATIONS" ]]; then
  printf 'FAIL T-P6-test-tmp-uniqueness — write to bare /tmp/<word>.<ext> path:\n'
  printf '%s\n' "$_TP6_VIOLATIONS"
  FAIL_SUITES=$((FAIL_SUITES + 1))
  FAILED_NAMES+=("T-P6-test-tmp-uniqueness")
else
  printf 'PASS T-P6-test-tmp-uniqueness (no write to bare /tmp/<word>.<ext>)\n'
  PASS_SUITES=$((PASS_SUITES + 1))
fi
printf '\n'

printf '═══════════════════════════════════════\n'
printf 'Suites passed: %d | Suites failed: %d\n' "$PASS_SUITES" "$FAIL_SUITES"
if [[ ${#FAILED_NAMES[@]} -gt 0 ]]; then
  printf 'Failed suites:\n'
  for n in "${FAILED_NAMES[@]}"; do
    printf '  - %s\n' "$n"
  done
fi
printf '═══════════════════════════════════════\n'

[[ $FAIL_SUITES -eq 0 ]]
