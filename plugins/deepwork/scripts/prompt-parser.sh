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
# Why splitting at all? When SKILL.md's quoted heredoc delivers $ARGUMENTS as
# a single line with the goal and flags concatenated, a line-oriented parser
# would miss every flag. The preprocessor inserts `\n` before each known flag
# occurrence so the case-branch loop in parse_prompt_file sees one flag per
# line. Pure-bash implementation — no fork to perl/sed/awk.

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
# into one-flag-per-line form, in-place. Pure-bash — no perl/sed/awk fork.
#
# Algorithm: pad input with leading/trailing space so flags at start/end
# are detectable, then iterate bash regex matches. Each match is whitespace
# followed by a known --flag and a trailing whitespace/equals; we replace
# the leading whitespace with a newline. Flags appearing inside arbitrary
# text without leading whitespace are not split (matches prior perl behavior).
_preprocess_prompt_file() {
  local file="$1"
  local content
  content=$(<"$file") || return 1
  content="${content//$'\r'/}"

  # Pad so flags at start/end of input are matched; the padding is stripped
  # at the end. Trailing space also serves as a sentinel so the last flag's
  # ([[:space:]=]) match succeeds even when the original input ended on a flag.
  content=" ${content} "

  local flag_alt='source-of-truth|anchor|guardrail|bar|safe-mode|mode|team-name|prompt-file|plan-ref'
  flag_alt+='|authorized-push|authorized-force-push|authorized-prod-deploy'
  flag_alt+='|authorized-local-destructive|secret-scan-waive|chaos-monkey|no-chaos-monkey'
  flag_alt+='|allow-no-hooks|enable-single-writer|disable-single-writer'

  # Whitespace + --flag + (whitespace or =). Bash regex is POSIX ERE.
  local pattern='[[:space:]]+(--('"$flag_alt"'))([[:space:]=])'

  local result=""
  local match flag trail before
  while [[ "$content" =~ $pattern ]]; do
    match="${BASH_REMATCH[0]}"
    flag="${BASH_REMATCH[1]}"
    trail="${BASH_REMATCH[3]}"
    before="${content%%"$match"*}"
    result+="${before}"$'\n'"${flag}"
    # Put the trailing char back at the start of content so that adjacent
    # flags (e.g. `--chaos-monkey --allow-no-hooks`) still have a leading
    # whitespace for the next match.
    content="${trail}${content#*"$match"}"
  done
  result+="$content"

  # Strip the leading newline (from the first pad-space match) and the
  # leading/trailing pad whitespace. Trail accumulation may leave multiple
  # trailing whitespace chars; strip all of them.
  result="${result#$'\n'}"
  result="${result# }"
  while [[ "$result" == *[[:space:]] ]]; do
    result="${result%[[:space:]]}"
  done

  printf '%s' "$result" > "${file}.tmp" && mv "${file}.tmp" "$file" || { rm -f "${file}.tmp"; return 1; }
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

  _preprocess_prompt_file "$file" || return 1

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
