#!/bin/bash
# test-prompt-parse.sh — smoke test for FIX-1 flag parser.
#
# 6 fixtures per proposal v3-final.md FIX-1 smoke-test list. Sources
# prompt-parser.sh directly and asserts on the resulting globals.
#
# Exit 0 on all-pass; exit 1 on any failure with per-fixture diagnostics.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARSER="${SCRIPT_DIR}/prompt-parser.sh"

if [[ ! -f "$PARSER" ]]; then
  echo "FAIL: parser not found at $PARSER" >&2
  exit 1
fi

# shellcheck source=./prompt-parser.sh
source "$PARSER"

PASS=0
FAIL=0

_reset() {
  SOURCE_OF_TRUTH=()
  ANCHORS=()
  GUARDRAILS=()
  BAR_SEEDS=()
  PROMPT_PARTS=()
  SAFE_MODE="true"
  MODE="default"
  TEAM_NAME=""
  PLAN_REF=""
  AUTHORIZED_PUSH="false"
  AUTHORIZED_FORCE_PUSH="false"
  AUTHORIZED_PROD_DEPLOY="false"
  AUTHORIZED_LOCAL_DESTRUCTIVE="false"
  SECRET_SCAN_WAIVED="false"
  CHAOS_MONKEY="auto"
  ALLOW_NO_HOOKS="false"
  SINGLE_WRITER_ENABLED="true"
}

_run() {
  local name="$1" content="$2"
  local tmp
  tmp="$(mktemp -t deepwork-test-XXXXXX.md)"
  printf '%s' "$content" > "$tmp"
  _reset
  parse_prompt_file "$tmp"
  # `parse_prompt_file` removes the tmp on success; defend anyway:
  rm -f "$tmp"
  printf '\n── Fixture: %s ──\n' "$name"
}

_assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    printf '  ✔ %s\n' "$label"
    PASS=$((PASS + 1))
  else
    printf '  ✘ %s\n    expected: %q\n    actual:   %q\n' "$label" "$expected" "$actual" >&2
    FAIL=$((FAIL + 1))
  fi
}

# ─────────────────────────────────────────────────────────────────────
# Fixture 1 — single-line all flags (the E1 repro)
_run "single-line all flags" \
'"My goal text" --source-of-truth docs/a.md --source-of-truth docs/b.md --anchor src/x.ts:10 --anchor src/y.ts:20 --guardrail "no breaking changes" --bar "G1: must compile" --safe-mode false'

_assert_eq "source-of-truth count" "2" "${#SOURCE_OF_TRUTH[@]}"
_assert_eq "source-of-truth[0]"   "docs/a.md" "${SOURCE_OF_TRUTH[0]:-}"
_assert_eq "source-of-truth[1]"   "docs/b.md" "${SOURCE_OF_TRUTH[1]:-}"
_assert_eq "anchors count"         "2" "${#ANCHORS[@]}"
_assert_eq "anchors[0]"           "src/x.ts:10" "${ANCHORS[0]:-}"
_assert_eq "guardrails count"      "1" "${#GUARDRAILS[@]}"
_assert_eq "guardrails[0]"        "no breaking changes" "${GUARDRAILS[0]:-}"
_assert_eq "bar count"             "1" "${#BAR_SEEDS[@]}"
_assert_eq "bar[0]"                "G1: must compile" "${BAR_SEEDS[0]:-}"
_assert_eq "safe-mode"             "false" "$SAFE_MODE"
_assert_eq "goal captured"         '"My goal text"' "${PROMPT_PARTS[0]:-}"

# ─────────────────────────────────────────────────────────────────────
# Fixture 2 — multi-line goal followed by flags on their own lines
_run "multi-line goal" "$(cat <<'EOF'
Review the auth module
for security issues and race conditions.
--source-of-truth src/auth/
--anchor src/auth/login.ts:42
EOF
)"

_assert_eq "source-of-truth[0]"   "src/auth/" "${SOURCE_OF_TRUTH[0]:-}"
_assert_eq "anchors[0]"           "src/auth/login.ts:42" "${ANCHORS[0]:-}"
_assert_eq "goal preserves lines" "Review the auth module
for security issues and race conditions." "${PROMPT_PARTS[0]:-}"

# ─────────────────────────────────────────────────────────────────────
# Fixture 3 — em-dash in value + nested quotes
_run "em-dash + nested quotes" \
'"review" --guardrail "no edits — review only" --guardrail '"'"'he said "stop — now"'"'"''

_assert_eq "em-dash guardrail"    "no edits — review only" "${GUARDRAILS[0]:-}"
_assert_eq "nested-quotes"        'he said "stop — now"' "${GUARDRAILS[1]:-}"

# ─────────────────────────────────────────────────────────────────────
# Fixture 4 — --flag=value form
_run "equals-form" \
'"goal" --mode=default --safe-mode=true --team-name=my-team'

_assert_eq "mode=default"          "default" "$MODE"
_assert_eq "safe-mode=true"        "true" "$SAFE_MODE"
_assert_eq "team-name=my-team"     "my-team" "$TEAM_NAME"

# ─────────────────────────────────────────────────────────────────────
# Fixture 5 — repeated --anchor (≥2 entries)
_run "repeated flags" \
'"g" --anchor a:1 --anchor b:2 --anchor c:3'

_assert_eq "anchors count=3"       "3" "${#ANCHORS[@]}"
_assert_eq "anchors[0]"           "a:1" "${ANCHORS[0]:-}"
_assert_eq "anchors[2]"           "c:3" "${ANCHORS[2]:-}"

# ─────────────────────────────────────────────────────────────────────
# Fixture 6 — adversarial goal with --token that is NOT in allowlist
_run "adversarial --token in goal" \
'"The auth flow should --validate inputs and --sanitize outputs" --anchor src/a:1'

_assert_eq "--validate stays in goal" \
  '"The auth flow should --validate inputs and --sanitize outputs"' \
  "${PROMPT_PARTS[0]:-}"
_assert_eq "anchor still parsed"   "src/a:1" "${ANCHORS[0]:-}"

# ─────────────────────────────────────────────────────────────────────
# PP-* Fixtures — execute-mode flags (W12 #2)
# ─────────────────────────────────────────────────────────────────────

# PP-1 — --plan-ref
_run "PP-1: --plan-ref" '"my goal" --plan-ref /tmp/plan.md'
_assert_eq "plan-ref" "/tmp/plan.md" "${PLAN_REF:-}"

# PP-2 — --authorized-push (boolean flag, no value)
_run "PP-2: --authorized-push" '"my goal" --authorized-push'
_assert_eq "authorized-push" "true" "${AUTHORIZED_PUSH:-}"

# PP-3 — --authorized-force-push
_run "PP-3: --authorized-force-push" '"my goal" --authorized-force-push'
_assert_eq "authorized-force-push" "true" "${AUTHORIZED_FORCE_PUSH:-}"

# PP-4 — --authorized-prod-deploy
_run "PP-4: --authorized-prod-deploy" '"my goal" --authorized-prod-deploy'
_assert_eq "authorized-prod-deploy" "true" "${AUTHORIZED_PROD_DEPLOY:-}"

# PP-5 — --authorized-local-destructive
_run "PP-5: --authorized-local-destructive" '"my goal" --authorized-local-destructive'
_assert_eq "authorized-local-destructive" "true" "${AUTHORIZED_LOCAL_DESTRUCTIVE:-}"

# PP-6 — --secret-scan-waive
_run "PP-6: --secret-scan-waive" '"my goal" --secret-scan-waive'
_assert_eq "secret-scan-waive" "true" "${SECRET_SCAN_WAIVED:-}"

# PP-7 — --chaos-monkey
_run "PP-7: --chaos-monkey" '"my goal" --chaos-monkey'
_assert_eq "chaos-monkey" "true" "${CHAOS_MONKEY:-}"

# PP-8 — --no-chaos-monkey
_run "PP-8: --no-chaos-monkey" '"my goal" --no-chaos-monkey'
_assert_eq "no-chaos-monkey" "false" "${CHAOS_MONKEY:-}"

# PP-9 — --allow-no-hooks
_run "PP-9: --allow-no-hooks" '"my goal" --allow-no-hooks'
_assert_eq "allow-no-hooks" "true" "${ALLOW_NO_HOOKS:-}"

# PP-10 — --enable-single-writer
_run "PP-10: --enable-single-writer" '"my goal" --enable-single-writer'
_assert_eq "enable-single-writer" "true" "${SINGLE_WRITER_ENABLED:-}"

# PP-11 — --disable-single-writer
_run "PP-11: --disable-single-writer" '"my goal" --disable-single-writer'
_assert_eq "disable-single-writer" "false" "${SINGLE_WRITER_ENABLED:-}"

# PP-12 — combined execute flags (single-line)
_run "PP-12: combined execute flags" '"execute goal" --mode execute --plan-ref /tmp/plan.md --authorized-push'
_assert_eq "PP-12: MODE=execute"       "execute"       "${MODE:-}"
_assert_eq "PP-12: PLAN_REF set"       "/tmp/plan.md"  "${PLAN_REF:-}"
_assert_eq "PP-12: AUTHORIZED_PUSH"    "true"          "${AUTHORIZED_PUSH:-}"

# ─────────────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────"
printf "Passed: %d | Failed: %d\n" "$PASS" "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
