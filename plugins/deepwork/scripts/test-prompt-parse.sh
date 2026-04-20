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
echo ""
echo "─────────────────────────────────────"
printf "Passed: %d | Failed: %d\n" "$PASS" "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
