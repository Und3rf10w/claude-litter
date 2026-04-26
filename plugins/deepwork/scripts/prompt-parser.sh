#!/bin/bash
# prompt-parser.sh — shared flag/goal parser for --prompt-file inputs.
#
# Sourced by setup-deepwork.sh and test-prompt-parse.sh. Do NOT add
# `set -euo pipefail` here; this file is sourced, not executed directly.
#
# CONTRACT for callers:
#   - Caller must declare these as arrays BEFORE calling parse_prompt_file:
#       SOURCE_OF_TRUTH=()  ANCHORS=()  GUARDRAILS=()  BAR_SEEDS=()
#       PROMPT_PARTS=()
#   - Caller must declare these as scalars with defaults (or empty):
#       SAFE_MODE  MODE  TEAM_NAME
#   - parse_prompt_file mutates these globals. The prompt file is consumed
#     (removed on success).
#
# Why perl -0777 slurp-mode regex? SKILL.md's quoted heredoc delivers $ARGUMENTS
# as a single line with the goal and flags concatenated. A line-oriented parser
# would miss everything. The slurp regex injects `\n` before every known flag
# occurrence, normalizing single-line input to one-flag-per-line before the
# case-branch parser runs. Pattern from setup-swarm-loop.sh:170-229.

# Strip surrounding single/double quotes with whitespace trim.
_strip_quotes() {
  local val="$1"
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  if [[ "$val" =~ ^\'(.*)\'$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  elif [[ "$val" =~ ^\"(.*)\"$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  else
    printf '%s' "$val"
  fi
}

# Split concatenated `goal --flag value --flag value` single-line input
# into one-flag-per-line form, in-place.
#
# Two flag classes:
#   value_re  — flags that require a value (=val or space val)
#   bool_re   — boolean flags with no value (presence sets the flag)
_preprocess_prompt_file() {
  local file="$1"
  perl -0777 -pe '
    s/\r//g;
    my $value_re = "source-of-truth|anchor|guardrail|bar|safe-mode|mode|team-name|prompt-file|plan-ref";
    my $bool_re  = "authorized-push|authorized-force-push|authorized-prod-deploy|authorized-local-destructive|secret-scan-waive|chaos-monkey|no-chaos-monkey|allow-no-hooks|enable-single-writer|disable-single-writer";
    # value flags: split before --flag=val or --flag val
    s/[^\S\n]+(--(?:$value_re)(?:=\s*(?:'"'"'[^'"'"']*'"'"'|"[^"]*"|\S+)|\s+(?:'"'"'[^'"'"']*'"'"'|"[^"]*"|\S+)))/\n$1/gx;
    # boolean flags: split before --flag (no value follows, or next token starts with --)
    s/[^\S\n]+(--(?:$bool_re))(?=[[:space:]]|$)/\n$1/gx;
  ' "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
}

# parse_prompt_file <path> — reads flags and goal body, mutates globals.
# Populates: SOURCE_OF_TRUTH, ANCHORS, GUARDRAILS, BAR_SEEDS (arrays)
#            SAFE_MODE, MODE, TEAM_NAME, PLAN_REF (scalars — overwritten only if flag present)
#            AUTHORIZED_PUSH, AUTHORIZED_FORCE_PUSH, AUTHORIZED_PROD_DEPLOY,
#            AUTHORIZED_LOCAL_DESTRUCTIVE, SECRET_SCAN_WAIVED, CHAOS_MONKEY,
#            ALLOW_NO_HOOKS, SINGLE_WRITER_ENABLED (scalars — set on flag presence)
#            PROMPT_PARTS — goal body lines joined with \n (if any non-flag lines found)
# Removes the prompt file on success.
parse_prompt_file() {
  local file="$1"
  [[ -f "$file" ]] || return 1

  _preprocess_prompt_file "$file"

  local _goal_lines=()
  local _line
  while IFS= read -r _line || [[ -n "$_line" ]]; do
    _line="${_line//$'\r'/}"
    case "$_line" in
      --source-of-truth\ *)            SOURCE_OF_TRUTH+=("$(_strip_quotes "${_line#--source-of-truth }")") ;;
      --source-of-truth=*)             SOURCE_OF_TRUTH+=("$(_strip_quotes "${_line#--source-of-truth=}")") ;;
      --anchor\ *)                     ANCHORS+=("$(_strip_quotes "${_line#--anchor }")") ;;
      --anchor=*)                      ANCHORS+=("$(_strip_quotes "${_line#--anchor=}")") ;;
      --guardrail\ *)                  GUARDRAILS+=("$(_strip_quotes "${_line#--guardrail }")") ;;
      --guardrail=*)                   GUARDRAILS+=("$(_strip_quotes "${_line#--guardrail=}")") ;;
      --bar\ *)                        BAR_SEEDS+=("$(_strip_quotes "${_line#--bar }")") ;;
      --bar=*)                         BAR_SEEDS+=("$(_strip_quotes "${_line#--bar=}")") ;;
      --safe-mode\ *)                  SAFE_MODE="$(_strip_quotes "${_line#--safe-mode }")" ;;
      --safe-mode=*)                   SAFE_MODE="$(_strip_quotes "${_line#--safe-mode=}")" ;;
      --mode\ *)                       MODE="$(_strip_quotes "${_line#--mode }")" ;;
      --mode=*)                        MODE="$(_strip_quotes "${_line#--mode=}")" ;;
      --team-name\ *)                  TEAM_NAME="$(_strip_quotes "${_line#--team-name }")" ;;
      --team-name=*)                   TEAM_NAME="$(_strip_quotes "${_line#--team-name=}")" ;;
      --plan-ref\ *)                   PLAN_REF="$(_strip_quotes "${_line#--plan-ref }")" ;;
      --plan-ref=*)                    PLAN_REF="$(_strip_quotes "${_line#--plan-ref=}")" ;;
      --authorized-push)               AUTHORIZED_PUSH="true" ;;
      --authorized-push=*)             AUTHORIZED_PUSH="$(_strip_quotes "${_line#--authorized-push=}")" ;;
      --authorized-force-push)         AUTHORIZED_FORCE_PUSH="true" ;;
      --authorized-force-push=*)       AUTHORIZED_FORCE_PUSH="$(_strip_quotes "${_line#--authorized-force-push=}")" ;;
      --authorized-prod-deploy)        AUTHORIZED_PROD_DEPLOY="true" ;;
      --authorized-prod-deploy=*)      AUTHORIZED_PROD_DEPLOY="$(_strip_quotes "${_line#--authorized-prod-deploy=}")" ;;
      --authorized-local-destructive)  AUTHORIZED_LOCAL_DESTRUCTIVE="true" ;;
      --authorized-local-destructive=*) AUTHORIZED_LOCAL_DESTRUCTIVE="$(_strip_quotes "${_line#--authorized-local-destructive=}")" ;;
      --secret-scan-waive)             SECRET_SCAN_WAIVED="true" ;;
      --secret-scan-waive=*)           SECRET_SCAN_WAIVED="$(_strip_quotes "${_line#--secret-scan-waive=}")" ;;
      --chaos-monkey)                  CHAOS_MONKEY="true" ;;
      --no-chaos-monkey)               CHAOS_MONKEY="false" ;;
      --allow-no-hooks)                ALLOW_NO_HOOKS="true" ;;
      --enable-single-writer)          SINGLE_WRITER_ENABLED="true" ;;
      --disable-single-writer)         SINGLE_WRITER_ENABLED="false" ;;
      --*)                             ;;  # skip unknown flags (forward-compat)
      *)                               [[ -n "$_line" ]] && _goal_lines+=("$_line") ;;
    esac
  done < "$file"
  rm -f "$file"

  if [[ ${#_goal_lines[@]} -gt 0 ]]; then
    local _goal_body
    _goal_body="$(printf '%s\n' "${_goal_lines[@]}")"
    _goal_body="${_goal_body%$'\n'}"
    PROMPT_PARTS=("$_goal_body")
  fi
  return 0
}
