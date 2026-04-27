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
