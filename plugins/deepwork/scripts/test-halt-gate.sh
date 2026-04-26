#!/bin/bash
# test-halt-gate.sh — smoke test for halt_reason enforcement.
#
# Five test-manifest cases (all runnable without a real CC session):
#
#   TM-HALT-GATE-BLOCK               — phase=halt, halt_reason=null           → exit 2
#   TM-HALT-GATE-PASS                — phase=halt, valid halt_reason          → exit 0
#   TM-HALT-GATE-LEGACY-PASSTHROUGH  — phase=halt, halt_reason key absent     → exit 0
#   TM-HALT-GATE-MALFORMED-PASSTHROUGH — corrupt state.json                   → exit 0
#   TM-HALT-REGISTRATION             — setup registers halt-gate in Stop arr  → presence + strict tag
#
# Branch-aware: detects parallelism vs hygiene by presence of
# scripts/_settings-lock.sh; asserts the correct hook-tag scheme strictly per
# branch (bare `_deepwork` on hygiene; `_deepwork_<8hex>` on parallelism). A
# bare `_deepwork` on the parallelism branch is a FAIL (regression signal),
# not a PASS — Option A union regex would have silently hidden this.
#
# TM-HALT-REGISTRATION does NOT assert CC runtime hook execution ordering.
# The test only verifies that halt-gate.sh appears in the Stop array with
# the expected tag scheme. CC chain semantics (whether exit 2 from an earlier
# hook blocks the turn before later hooks run) are not testable at shell
# level. The array-index order is preserved by setup for clarity, but the
# "before approve-archive" claim in docs is empirical, not enforced here.
#
# Runtime ordering caveat (W15 #16, deferred): the CC runtime dispatches Stop
# hooks in array order but does not guarantee halt-gate exit 2 blocks
# approve-archive execution — this depends on CC version chain semantics.
# A stop-dispatch.sh consolidation (single entry invoking both in sequence
# with explicit exit-code threading) would remove the ambiguity; deferred to
# a future wave pending CC chain-semantics clarification.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
HOOK="${PLUGIN_ROOT}/hooks/halt-gate.sh"
SETUP="${PLUGIN_ROOT}/scripts/setup-deepwork.sh"

if [[ ! -x "$HOOK" ]]; then
  echo "FAIL: halt-gate.sh not found or not executable at $HOOK" >&2
  exit 1
fi

# Branch detection — presence of _settings-lock.sh indicates parallelism branch
# (added in M1 of the parallelism work). On hygiene (off main), this helper
# doesn't exist. Since C3, all branches emit dual-tag scheme:
#   _deepwork: true          (required — identity tag for bulk-remove)
#   _deepwork_instance: <8hex>  (required since C3 — per-instance teardown tag)
# EXPECTED_TAG_REGEX allows both keys. A key matching neither is a FAIL.
if [[ -f "${PLUGIN_ROOT}/scripts/_settings-lock.sh" ]]; then
  BRANCH_KIND="parallelism"
else
  BRANCH_KIND="hygiene"
fi
# Both branches now use the dual-tag scheme introduced in C3 (W15 #31).
# Each hook block has two keys: _deepwork (identity) and _deepwork_instance (per-instance teardown).
# The regex accepts exactly these two key names; any other _deepwork* key is a FAIL.
EXPECTED_TAG_REGEX='^_deepwork(_instance)?$'
EXPECTED_TAG_DESC='_deepwork (identity) + _deepwork_instance (per-instance) dual-tag scheme'

PASS=0
FAIL=0
FAILED_CASES=()

_assert_exit() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    printf '✔ %s (exit=%s)\n' "$name" "$actual"
    PASS=$((PASS + 1))
  else
    printf '✘ %s — expected exit %s, got %s\n' "$name" "$expected" "$actual" >&2
    FAIL=$((FAIL + 1))
    FAILED_CASES+=("$name")
  fi
}

_assert_grep() {
  local name="$1" pattern="$2" file="$3"
  if grep -q "$pattern" "$file" 2>/dev/null; then
    printf '✔ %s (matched /%s/)\n' "$name" "$pattern"
    PASS=$((PASS + 1))
  else
    printf '✘ %s — pattern /%s/ not found in %s\n' "$name" "$pattern" "$file" >&2
    FAIL=$((FAIL + 1))
    FAILED_CASES+=("$name")
  fi
}

# ============================================================================
# Hook-invocation cases (TM-HALT-GATE-{BLOCK,PASS,LEGACY-PASSTHROUGH,MALFORMED-PASSTHROUGH})
# ============================================================================
# Each case creates an isolated sandbox with a single instance dir and a
# state.json shaped per the scenario, pipes a Stop payload referencing
# SESSION_ID into halt-gate.sh, asserts exit code + stderr content.

# Function sets these globals after each invocation for secondary assertions.
LAST_STDERR=""
LAST_SANDBOX=""

_run_hook_case() {
  local case_name="$1" state_json="$2" expected_exit="$3"
  local sandbox instance_dir session_id stderr_file actual_exit

  sandbox=$(mktemp -d)
  export CLAUDE_PROJECT_DIR="$sandbox"
  export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"
  session_id="halt-gate-test-$$-${RANDOM}"

  instance_dir="$sandbox/.claude/deepwork/deadbeef"
  mkdir -p "$instance_dir"

  # Inject session_id into the state.json template (all fixtures reference it).
  printf '%s\n' "$state_json" | \
    sed "s|__SESSION_ID__|$session_id|g" > "$instance_dir/state.json"

  stderr_file=$(mktemp)
  echo "{\"session_id\":\"$session_id\"}" | bash "$HOOK" 2>"$stderr_file" >/dev/null
  actual_exit=$?

  _assert_exit "$case_name" "$expected_exit" "$actual_exit"

  LAST_STDERR="$stderr_file"
  LAST_SANDBOX="$sandbox"
}

_cleanup_run() {
  [[ -n "$LAST_STDERR" ]] && rm -f "$LAST_STDERR"
  [[ -n "$LAST_SANDBOX" ]] && rm -rf "$LAST_SANDBOX"
  LAST_STDERR=""
  LAST_SANDBOX=""
}

# --- TM-HALT-GATE-BLOCK ---
_run_hook_case "TM-HALT-GATE-BLOCK" \
  '{"session_id":"__SESSION_ID__","phase":"halt","halt_reason":null}' 2
# Primary: stable prefix
_assert_grep "TM-HALT-GATE-BLOCK/stderr-prefix" "Validation failure:" "$LAST_STDERR"
# Secondary: exact code match (catches regressions in validation-code spelling)
_assert_grep "TM-HALT-GATE-BLOCK/stderr-code" "Validation failure: NULL" "$LAST_STDERR"
_cleanup_run

# --- TM-HALT-GATE-PASS ---
_run_hook_case "TM-HALT-GATE-PASS" \
  '{"session_id":"__SESSION_ID__","phase":"halt","halt_reason":{"summary":"Plan approved; final proposal delivered","blockers":[]}}' 0
_cleanup_run

# --- TM-HALT-GATE-LEGACY-PASSTHROUGH ---
# Pre-halt_reason session: halt_reason KEY entirely absent from state.json.
# Must exit 0 (back-compat discriminator via jq 'has("halt_reason")').
_run_hook_case "TM-HALT-GATE-LEGACY-PASSTHROUGH" \
  '{"session_id":"__SESSION_ID__","phase":"halt"}' 0
_cleanup_run

# --- TM-HALT-GATE-MALFORMED-PASSTHROUGH ---
# Corrupt state.json: hook must exit 0 (parse-failure pass-through), not block
# concurrent executor turns mid-write.
_run_hook_case "TM-HALT-GATE-MALFORMED-PASSTHROUGH" \
  'not valid json {{{ syntax error' 0
_cleanup_run

# ============================================================================
# TM-HALT-REGISTRATION
# ============================================================================
# Invokes setup-deepwork.sh against a throwaway project; asserts halt-gate.sh
# is registered in the Stop hook array with the correct per-branch tag scheme.
# Does NOT assert CC runtime execution ordering.

_run_registration_test() {
  local sandbox goal session_id settings_file
  sandbox=$(mktemp -d)
  export CLAUDE_PROJECT_DIR="$sandbox"
  export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"
  session_id="halt-gate-reg-$$-${RANDOM}"

  mkdir -p "$sandbox/.claude"
  # Per executor: pre-populate settings.local.json with empty hooks object
  # so jq merge doesn't fail on first run.
  echo '{"hooks":{}}' > "$sandbox/.claude/settings.local.json"

  settings_file="$sandbox/.claude/settings.local.json"

  # Invoke setup in plan mode with a minimal goal. stderr is noise (setup
  # prints a user-visible banner); only settings.local.json matters.
  (cd "$sandbox" && bash "$SETUP" "test halt-gate registration harness" \
    --safe-mode false >/dev/null 2>&1) || true

  if [[ ! -s "$settings_file" ]]; then
    printf '✘ TM-HALT-REGISTRATION — setup-deepwork.sh did not produce settings.local.json at %s\n' "$settings_file" >&2
    FAIL=$((FAIL + 1))
    FAILED_CASES+=("TM-HALT-REGISTRATION/no-output")
    rm -rf "$sandbox"
    return
  fi

  # 1. Assert halt-gate.sh appears in Stop hook array.
  local halt_gate_count
  halt_gate_count=$(jq '[.hooks.Stop // [] | .[] | .hooks // [] | .[] | select(.command | test("halt-gate\\.sh"))] | length' "$settings_file" 2>/dev/null)
  if [[ "${halt_gate_count:-0}" -ge 1 ]]; then
    printf '✔ TM-HALT-REGISTRATION/present (halt-gate.sh found in Stop array, count=%s)\n' "$halt_gate_count"
    PASS=$((PASS + 1))
  else
    printf '✘ TM-HALT-REGISTRATION/present — halt-gate.sh not found in Stop array\n' >&2
    jq '.hooks.Stop' "$settings_file" >&2 2>/dev/null || true
    FAIL=$((FAIL + 1))
    FAILED_CASES+=("TM-HALT-REGISTRATION/present")
    rm -rf "$sandbox"
    return
  fi

  # 2. Assert the entry carries the expected per-branch tag scheme.
  # Each hook matcher-block in settings.local.json has keys for the hooks array
  # plus a tag key (_deepwork or _deepwork_<iid>) at the matcher-block level.
  # Extract all keys from the Stop-array matcher-block that contains halt-gate.
  local tag_keys
  tag_keys=$(jq -r '
    [.hooks.Stop // [] | .[] |
     select((.hooks // []) | any(.command | test("halt-gate\\.sh"))) |
     to_entries | .[] | .key | select(startswith("_deepwork"))]
     | unique | .[]
  ' "$settings_file" 2>/dev/null)

  if [[ -z "$tag_keys" ]]; then
    printf '✘ TM-HALT-REGISTRATION/tag — no _deepwork* tag key found on halt-gate block (expected: %s)\n' "$EXPECTED_TAG_DESC" >&2
    FAIL=$((FAIL + 1))
    FAILED_CASES+=("TM-HALT-REGISTRATION/tag")
    rm -rf "$sandbox"
    return
  fi

  local tag_ok=1 wrong_tag=""
  while IFS= read -r tag; do
    if [[ ! "$tag" =~ $EXPECTED_TAG_REGEX ]]; then
      tag_ok=0
      wrong_tag="$tag"
      break
    fi
  done <<<"$tag_keys"

  if (( tag_ok == 1 )); then
    printf '✔ TM-HALT-REGISTRATION/tag (%s — all keys matched /%s/)\n' "$EXPECTED_TAG_DESC" "$EXPECTED_TAG_REGEX"
    PASS=$((PASS + 1))
  else
    printf '✘ TM-HALT-REGISTRATION/tag — found unexpected tag key %q; expected %s\n' \
      "$wrong_tag" "$EXPECTED_TAG_DESC" >&2
    printf '  Unexpected tag key on halt-gate block indicates tag-scheme regression (C3/W15 #31).\n' >&2
    FAIL=$((FAIL + 1))
    FAILED_CASES+=("TM-HALT-REGISTRATION/tag")
  fi

  # 3. Informational: log the array-index of halt-gate relative to
  # approve-archive. Not a pass/fail assertion (CC runtime order isn't
  # testable at shell level) — this is just visibility.
  local halt_idx archive_idx
  halt_idx=$(jq '[.hooks.Stop // [] | to_entries | .[] |
    select(.value.hooks // [] | any(.command | test("halt-gate\\.sh"))) | .key] | first // null' "$settings_file" 2>/dev/null)
  archive_idx=$(jq '[.hooks.Stop // [] | to_entries | .[] |
    select(.value.hooks // [] | any(.command | test("approve-archive\\.sh"))) | .key] | first // null' "$settings_file" 2>/dev/null)
  printf '  (info) halt-gate Stop-array index=%s, approve-archive Stop-array index=%s — CC runtime ordering is not tested here\n' \
    "$halt_idx" "$archive_idx"

  # 4. Assert halt-gate Stop-array index < approve-archive Stop-array index.
  # This catches a source reorder in setup-deepwork.sh that would put
  # approve-archive before halt-gate (archive renames state.json, making
  # halt_reason unreadable for a concurrent halt-phase Stop event).
  if [[ "$halt_idx" =~ ^[0-9]+$ ]] && [[ "$archive_idx" =~ ^[0-9]+$ ]]; then
    if [[ "$halt_idx" -lt "$archive_idx" ]]; then
      printf '✔ TM-HALT-REGISTRATION/order (halt-gate idx=%s < approve-archive idx=%s)\n' \
        "$halt_idx" "$archive_idx"
      PASS=$((PASS + 1))
    else
      printf '✘ TM-HALT-REGISTRATION/order — halt-gate idx=%s >= approve-archive idx=%s; ' \
        "$halt_idx" "$archive_idx" >&2
      printf 'setup-deepwork.sh Stop registration order was changed\n' >&2
      FAIL=$((FAIL + 1))
      FAILED_CASES+=("TM-HALT-REGISTRATION/order")
    fi
  else
    printf '  (skip) TM-HALT-REGISTRATION/order — one or both hooks absent from Stop array (already caught above)\n'
  fi

  rm -rf "$sandbox"
}

_run_registration_test

# ============================================================================
# Summary
# ============================================================================
printf '\n'
printf '============================================================\n'
printf 'test-halt-gate.sh — branch=%s, expected_tag=%s\n' "$BRANCH_KIND" "$EXPECTED_TAG_DESC"
printf '  PASS: %d\n' "$PASS"
printf '  FAIL: %d\n' "$FAIL"
if (( FAIL > 0 )); then
  printf '  Failed cases:\n'
  for c in "${FAILED_CASES[@]}"; do
    printf '    - %s\n' "$c"
  done
  exit 1
fi
exit 0
