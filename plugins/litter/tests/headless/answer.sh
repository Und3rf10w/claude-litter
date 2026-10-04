#!/bin/sh
# Tier 4: the keys that answer the session's waiting AskUserQuestion, for
# drive.exp's presssh. In each question it picks the first option whose label
# matches <regex> (jq, case-insensitive), else the first option, which the
# skills make the recommended one. Each ask is answered once: <mark> keeps the
# log line of the last ask seen and answered. An ask is answered the round
# after it first shows, so its dialog has been drawn. Prints nothing when no
# ask waits, or this round isn't the one to answer it; exits 1 only on a
# missing argument.
#
#   sh tests/headless/answer.sh <tool-log.jsonl> <regex> <mark> [<ask mark>]
#
# <ask mark> is asking.sh's: a question the steps declined with esc, before
# it, isn't waiting.
#
# Keys, as CC 2.1.289 reads them:
# - a single-select question: Down to the option, then Enter, which picks it
#   and moves to the next question;
# - a multiSelect question: Enter toggles the option and Tab moves on;
# - then Enter on "Submit answers", unless the ask is one single-select
#   question, which its Enter already sent.
log=${1:-}
re=${2:-}
mark=${3:-}
[ -n "$log" ] && [ -n "$mark" ] || exit 1
# No log yet: the session hasn't called a tool, so nothing is asked.
[ -f "$log" ] || exit 0
sh "$(dirname "$0")/asking.sh" "$log" ${4:+"$4"} || exit 0
n=$(jq -nRr 'inputs | (fromjson? // {}) | select(.tool == "AskUserQuestion" and .ev == "PreToolUse") | input_line_number' "$log" 2>/dev/null | tail -n 1)
[ -n "$n" ] || exit 0
case $(cat "$mark" 2>/dev/null) in
"done $n") exit 0 ;;
"seen $n") ;;
*)
  echo "seen $n" >|"$mark"
  exit 0
  ;;
esac
echo "done $n" >|"$mark"
sed -n "${n}p" "$log" | jq -r --arg re "$re" '.input.questions as $q
  | [$q[] | ([.options[].label | test($re; "i")] | index(true) // 0) as $i
      | [range($i) | "down"] + (if .multiSelect then ["enter", "tab"] else ["enter"] end)]
  | add + (if ($q | length) > 1 or any($q[]; .multiSelect) then ["enter"] else [] end)
  | join(" ")' 2>/dev/null
