#!/bin/sh
# Tier 4: exits 0 while the session's AskUserQuestion waits for an answer,
# read from fixtures/toollog's log: more PreToolUse lines for it than
# PostToolUse and PostToolUseFailure ones. For drive.exp's waits and presses:
#
#   sh tests/headless/asking.sh <tool-log.jsonl> [<mark>]
#
# A question declined with esc logs neither, so it would count as waiting
# for good: after declining one, write the log's line count to <mark>
# (wc -l), and only the lines after it count. Only the main thread asks:
# subagents and workflow agents never get the tool.
log=${1:-}
[ -n "$log" ] && [ -f "$log" ] || exit 1
n=0
[ -n "${2:-}" ] && [ -f "$2" ] && n=$(tr -dc 0-9 <"$2")
tail -n +"$((${n:-0} + 1))" "$log" | jq -nRe '[inputs | fromjson? | select(.tool == "AskUserQuestion") | .ev]
  | (map(select(. == "PreToolUse")) | length) > (map(select(. == "PostToolUse" or . == "PostToolUseFailure")) | length)' >/dev/null 2>&1
