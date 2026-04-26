#!/bin/bash
# bash-gate.sh — PreToolUse(Bash) combined classifier: G2 reversibility ladder + G7 secret-scan
# + G8 CI-bypass prevention + rollback-plan gate for prod deployments.
#
# G2 (reversibility ladder, plan §5.2): Commands are classified into reversibility tiers:
#   - reversible-local (reads, tests, status): auto-allow
#   - reversible-sandbox (/tmp ops, git stash): auto-allow
#   - irreversible-local (rm -rf non-tmp, git reset --hard, SQL destructive): deny unless
#     state.execute.authorized_local_destructive:true (set at setup time)
#   - irreversible-remote (git push non-force, npm publish, docker push): deny unless
#     state.execute.authorized_push:true AND critic approval present AND CI attestation exists
#   - irreversible-prod (kubectl apply, terraform apply, helm upgrade): deny unless
#     state.execute.authorized_prod_deploy:true AND rollback.<change_id>.md exists with
#     "## Tested procedure" section
#
# G7 (secret-scan, plan §5.3): On git commit commands, run `git diff --cached` and check
# staged content for secrets (AWS keys, OAuth tokens, JWTs, SSH private keys, API key patterns).
# Skip if state.execute.secret_scan_waived:true. Paths matching **/fixtures/** or **/testdata/**
# or listed in .gitsecretignore are exempt from per-line scanning.
#
# G8 (CI-bypass, plan §5.4): Categorically deny git push --force, git push -f,
# git push --no-verify, git commit --no-verify, git -c core.hooksPath=*, SKIP=* git commit.
# Force-push only overridable by state.execute.authorized_force_push:true (setup time).
# --no-verify variants have NO override.
#
# Setup-time flag enforcement: authorized_* flags only honored if they were set before
# phase left "setup". Checked against state.execute.setup_flags_snapshot (written at
# setup-end by setup-execute.sh). If a flag is true in state but absent from snapshot, deny.
#
# Blocking form: hookSpecificOutput.permissionDecision:"deny" per cli_formatted_2.1.116.js:632082
# (decision:"block" deprecated for PreToolUse). Exit 2 used for fatal parse errors only.
# CC source: :265521 (permissionDecision enum), :632082 (deprecated decision:block for PreToolUse),
# :564690 (exit 2 → blockingError), :472423-472440 (ask degrades to deny in non-interactive mode —
# never use ask; always use deny + state flag).
#
# Fail-open: if no active execute instance, exit 0 immediately.

set +e

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
discover_instance "$SESSION_ID" 2>/dev/null || exit 0

# Only active execute instances apply these gates
EXEC_PHASE=$(jq -r '.execute.phase // ""' "$STATE_FILE" 2>/dev/null || echo "")
[[ -n "$EXEC_PHASE" ]] || exit 0

COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
[[ -n "$COMMAND" ]] || exit 0

# --- Helper: emit deny JSON and exit 0 ---
_deny() {
  local reason="$1"
  jq -n \
    --arg reason "$reason" \
    '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": $reason}}'
  exit 0
}

# Drift block: if plan_drift_detected is true, ALL bash commands are blocked
DRIFT=$(jq -r '.execute.plan_drift_detected // false' "$STATE_FILE" 2>/dev/null || echo "false")
if [[ "$DRIFT" == "true" ]]; then
  _deny "DRIFT BLOCKED — run /deepwork-execute-amend before proceeding."
fi

# --- Read execute state flags ---
STATE_JSON=$(jq '.' "$STATE_FILE" 2>/dev/null || echo "{}")
EXEC_JSON=$(printf '%s' "$STATE_JSON" | jq '.execute // {}' 2>/dev/null || echo "{}")

AUTH_FORCE_PUSH=$(printf '%s' "$EXEC_JSON" | jq -r '.authorized_force_push // false' 2>/dev/null || echo "false")
AUTH_PUSH=$(printf '%s' "$EXEC_JSON" | jq -r '.authorized_push // false' 2>/dev/null || echo "false")
AUTH_PROD=$(printf '%s' "$EXEC_JSON" | jq -r '.authorized_prod_deploy // false' 2>/dev/null || echo "false")
AUTH_LOCAL_DEST=$(printf '%s' "$EXEC_JSON" | jq -r '.authorized_local_destructive // false' 2>/dev/null || echo "false")
SECRET_SCAN_WAIVED=$(printf '%s' "$EXEC_JSON" | jq -r '.secret_scan_waived // false' 2>/dev/null || echo "false")

# --- Setup-time flag enforcement ---
# authorized_* flags are only honored if present in setup_flags_snapshot (written at setup-end).
# If flag is true in current state but absent from snapshot, deny — the flag was set after setup.
SNAPSHOT_JSON=$(printf '%s' "$EXEC_JSON" | jq '.setup_flags_snapshot // {}' 2>/dev/null || echo "{}")
_flag_authorized() {
  local flag_name="$1"
  local current_val="$2"
  if [[ "$current_val" != "true" ]]; then
    echo "false"
    return
  fi
  local snapshot_val
  snapshot_val=$(printf '%s' "$SNAPSHOT_JSON" | jq -r --arg k "$flag_name" '.[$k] // false' 2>/dev/null || echo "false")
  if [[ "$snapshot_val" == "true" ]]; then
    echo "true"
  else
    echo "false"
  fi
}

AUTH_FORCE_PUSH_VALID=$(_flag_authorized "authorized_force_push" "$AUTH_FORCE_PUSH")
AUTH_PUSH_VALID=$(_flag_authorized "authorized_push" "$AUTH_PUSH")
AUTH_PROD_VALID=$(_flag_authorized "authorized_prod_deploy" "$AUTH_PROD")
AUTH_LOCAL_DEST_VALID=$(_flag_authorized "authorized_local_destructive" "$AUTH_LOCAL_DEST")
SECRET_SCAN_WAIVED_VALID=$(_flag_authorized "secret_scan_waived" "$SECRET_SCAN_WAIVED")

# --- G8: CI-bypass prevention (categorical checks first — no override for --no-verify) ---
# Categorically deny --no-verify variants regardless of any flag
if printf '%s' "$COMMAND" | grep -qE '(git[[:space:]]+push[[:space:]]+.*--no-verify|git[[:space:]]+commit[[:space:]]+.*--no-verify)'; then
  _deny "CI-bypass blocked (G8): '--no-verify' is categorically prohibited in execute mode. This bypass cannot be overridden. Use standard git hooks to ensure CI integrity."
fi

# git -c core.hooksPath=* override
if printf '%s' "$COMMAND" | grep -qE 'git[[:space:]]+-c[[:space:]]+core\.hooksPath='; then
  _deny "CI-bypass blocked (G8): 'git -c core.hooksPath=...' overrides the git hooks path and is prohibited in execute mode. Remove the -c flag."
fi

# SKIP=* git commit env-var hook skip
if printf '%s' "$COMMAND" | grep -qE '^[[:space:]]*SKIP=[^[:space:]].*git[[:space:]]+commit'; then
  _deny "CI-bypass blocked (G8): 'SKIP=... git commit' bypasses commit hooks via environment variable. This is prohibited in execute mode."
fi

# Force-push: overridable by setup-time authorized_force_push
if printf '%s' "$COMMAND" | grep -qE 'git[[:space:]]+push[[:space:]]+.*(--force|-f)(\b|[[:space:]])'; then
  if [[ "$AUTH_FORCE_PUSH_VALID" == "true" ]]; then
    : # allow — authorized at setup time
  else
    _deny "CI-bypass blocked (G8): 'git push --force' / 'git push -f' rewrites shared history and is not authorized. Set state.execute.authorized_force_push:true at setup time to enable."
  fi
fi

# --- G7: Secret-scan (only on git commit commands) ---
if printf '%s' "$COMMAND" | grep -qE 'git[[:space:]]+(commit|diff[[:space:]]+--cached)'; then
  if [[ "$SECRET_SCAN_WAIVED_VALID" != "true" ]]; then
    # Run git diff --cached to capture staged content
    PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PROJECT_ROOT}"
    STAGED_DIFF=$(git -C "$PROJECT_DIR" diff --cached 2>/dev/null || echo "")
    if [[ -n "$STAGED_DIFF" ]]; then
      # Read .gitsecretignore patterns (one path pattern per line)
      GITIGNORE_PATTERNS=()
      if [[ -f "${PROJECT_DIR}/.gitsecretignore" ]]; then
        while IFS= read -r _pat; do
          [[ -n "$_pat" ]] && [[ "$_pat" != '#'* ]] && GITIGNORE_PATTERNS+=("$_pat")
        done < "${PROJECT_DIR}/.gitsecretignore"
      fi

      # Filter diff to only lines not from fixtures/testdata paths and not in .gitsecretignore
      # diff +++ header lines look like: +++ b/path/to/file.ts
      FILTERED_DIFF=""
      CURRENT_FILE=""
      SKIP_FILE=false
      while IFS= read -r _line; do
        if printf '%s' "$_line" | grep -qE '^\+\+\+ b/'; then
          CURRENT_FILE=$(printf '%s' "$_line" | sed 's|^+++ b/||')
          SKIP_FILE=false
          # Check fixtures/testdata exemptions
          if printf '%s' "$CURRENT_FILE" | grep -qE '(fixtures|testdata)/'; then
            SKIP_FILE=true
          fi
          # Check .gitsecretignore patterns
          if [[ "$SKIP_FILE" != "true" ]]; then
            for _pat in "${GITIGNORE_PATTERNS[@]:-}"; do
              if [[ "$CURRENT_FILE" == $_pat ]]; then
                SKIP_FILE=true
                break
              fi
            done
          fi
        fi
        if [[ "$SKIP_FILE" != "true" ]]; then
          FILTERED_DIFF="${FILTERED_DIFF}${_line}"$'\n'
        fi
      done <<< "$STAGED_DIFF"

      if [[ -n "$FILTERED_DIFF" ]]; then
        # AWS Access Key ID: AKIA + 16 uppercase alphanumerics
        if printf '%s' "$FILTERED_DIFF" | grep -qE 'AKIA[0-9A-Z]{16}'; then
          _deny "Secret scan blocked (G7): AWS Access Key ID pattern (AKIA...) detected in staged diff. Remove secrets before committing. Set state.execute.secret_scan_waived:true at setup time to override."
        fi

        # GitHub OAuth token: ghp_ prefix + 36+ alphanumerics
        if printf '%s' "$FILTERED_DIFF" | grep -qE 'ghp_[A-Za-z0-9]{36,}'; then
          _deny "Secret scan blocked (G7): GitHub OAuth token (ghp_...) detected in staged diff. Remove secrets before committing."
        fi

        # JWT: three base64url segments separated by dots
        if printf '%s' "$FILTERED_DIFF" | grep -qE 'eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'; then
          _deny "Secret scan blocked (G7): JWT token pattern detected in staged diff. Remove tokens before committing."
        fi

        # SSH/PEM private key header
        if printf '%s' "$FILTERED_DIFF" | grep -qE '-----BEGIN [A-Z ]*PRIVATE KEY-----'; then
          _deny "Secret scan blocked (G7): SSH/PEM private key header detected in staged diff. Remove private keys before committing."
        fi

        # Google OAuth2 token: ya29. prefix
        if printf '%s' "$FILTERED_DIFF" | grep -qE 'ya29\.[0-9A-Za-z_-]{64,}'; then
          _deny "Secret scan blocked (G7): Google OAuth2 token (ya29...) detected in staged diff. Remove tokens before committing."
        fi

        # Generic API key/token/secret pattern: key=value with 24+ char value
        if printf '%s' "$FILTERED_DIFF" | grep -qiE '(api[_-]?key|api[_-]?token|access[_-]?token|secret[_-]?key)[[:space:]]*[:=][[:space:]]*['"'"'"]?[A-Za-z0-9_\-]{24,}'; then
          _deny "Secret scan blocked (G7): Generic API key/token pattern detected in staged diff. Verify no secrets are being committed."
        fi
      fi
    fi
  fi
fi

# --- G2: Reversibility ladder ---

# irreversible-prod: kubectl apply, terraform apply, helm upgrade/install
if printf '%s' "$COMMAND" | grep -qE '(kubectl[[:space:]]+apply|terraform[[:space:]]+apply|helm[[:space:]]+(upgrade|install))'; then
  if [[ "$AUTH_PROD_VALID" != "true" ]]; then
    _deny "Irreversible-prod blocked (G2): production deployment commands (kubectl apply, terraform apply, helm upgrade/install) require state.execute.authorized_prod_deploy:true set at setup time."
  fi
  # Also require rollback plan with tested procedure
  CHANGE_ID=$(jq -r '.change_id // ""' "${INSTANCE_DIR}/pending-change.json" 2>/dev/null || echo "")
  if [[ -n "$CHANGE_ID" ]]; then
    ROLLBACK_FILE="${INSTANCE_DIR}/rollback.${CHANGE_ID}.md"
    if [[ ! -f "$ROLLBACK_FILE" ]]; then
      _deny "Irreversible-prod blocked (G2): rollback.${CHANGE_ID}.md not found at ${INSTANCE_DIR}. Create a rollback plan with a '## Tested procedure' section before deploying."
    fi
    if ! grep -q "## Tested procedure" "$ROLLBACK_FILE" 2>/dev/null; then
      _deny "Irreversible-prod blocked (G2): rollback.${CHANGE_ID}.md is missing '## Tested procedure' section. Document and test the rollback procedure before deploying."
    fi
  else
    _deny "Irreversible-prod blocked (G2): no change_id in pending-change.json — cannot verify rollback plan exists. Set up a change entry before deploying."
  fi
fi

# irreversible-remote: git push (force-push already denied above), npm publish, docker push
if printf '%s' "$COMMAND" | grep -qE '(git[[:space:]]+push|npm[[:space:]]+publish|docker[[:space:]]+push)'; then
  if [[ "$AUTH_PUSH_VALID" != "true" ]]; then
    _deny "Irreversible-remote blocked (G2): push/publish operations require state.execute.authorized_push:true set at setup time, CRITIC approval in critique.v*.md, and a green CI attestation in state.execute.env_attestations[]."
  fi
  # Check CRITIC approval: look for "APPROVED" marker in any critique.v*.md file
  CRITIC_APPROVED=false
  for _cf in "${INSTANCE_DIR}/critique.v"*.md; do
    [[ -f "$_cf" ]] || continue
    if grep -q "APPROVED" "$_cf" 2>/dev/null; then
      CRITIC_APPROVED=true
      break
    fi
  done
  if [[ "$CRITIC_APPROVED" != "true" ]]; then
    _deny "Irreversible-remote blocked (G2): no CRITIC approval found in critique.v*.md files at ${INSTANCE_DIR}. A critic review with 'APPROVED' marker is required before pushing."
  fi
  # Check green CI attestation
  CURRENT_COMMIT=$(git -C "${CLAUDE_PROJECT_DIR:-$PROJECT_ROOT}" rev-parse HEAD 2>/dev/null || echo "")
  if [[ -n "$CURRENT_COMMIT" ]]; then
    CI_ATTESTED=$(printf '%s' "$EXEC_JSON" | jq -r --arg sha "$CURRENT_COMMIT" '
      .env_attestations // [] |
      map(select(.commit_sha == $sha and .ci_green == true)) |
      length
    ' 2>/dev/null || echo "0")
    if [[ "$CI_ATTESTED" == "0" ]]; then
      _deny "Irreversible-remote blocked (G2): no green CI attestation found in state.execute.env_attestations[] for current commit ${CURRENT_COMMIT}. Add a CI attestation entry before pushing."
    fi
  fi
fi

# irreversible-local: rm -rf non-tmp, git reset --hard, SQL destructive
if printf '%s' "$COMMAND" | grep -qE 'rm[[:space:]]+-[a-zA-Z]*r[a-zA-Z]*f'; then
  # Allow if target is /tmp or similar sandbox paths
  if ! printf '%s' "$COMMAND" | grep -qE 'rm[[:space:]]+-[a-zA-Z]*r[a-zA-Z]*f[[:space:]]+(|.*[[:space:]])/tmp/'; then
    if [[ "$AUTH_LOCAL_DEST_VALID" != "true" ]]; then
      _deny "Irreversible-local blocked (G2): recursive delete outside /tmp requires state.execute.authorized_local_destructive:true set at setup time. Verify the target path before proceeding."
    fi
  fi
fi

if printf '%s' "$COMMAND" | grep -qE 'git[[:space:]]+reset[[:space:]]+--hard'; then
  if [[ "$AUTH_LOCAL_DEST_VALID" != "true" ]]; then
    _deny "Irreversible-local blocked (G2): 'git reset --hard' discards uncommitted work and requires state.execute.authorized_local_destructive:true set at setup time."
  fi
fi

# SQL destructive patterns (DROP TABLE, TRUNCATE, DELETE without WHERE)
if printf '%s' "$COMMAND" | grep -qiE '(DROP[[:space:]]+TABLE|TRUNCATE[[:space:]]+TABLE|DELETE[[:space:]]+FROM[[:space:]]+[a-zA-Z_]+[[:space:]]*;)'; then
  if [[ "$AUTH_LOCAL_DEST_VALID" != "true" ]]; then
    _deny "Irreversible-local blocked (G2): destructive SQL command detected (DROP TABLE / TRUNCATE / DELETE without WHERE). Requires state.execute.authorized_local_destructive:true set at setup time."
  fi
fi

exit 0
