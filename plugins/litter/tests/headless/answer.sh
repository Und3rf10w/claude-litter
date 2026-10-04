#!/bin/sh
# Tier 4: the keys that answer the session's waiting AskUserQuestion, for
# drive.exp's keysh: a user who takes the tool's advice. In each question it
# picks the first option whose label matches <regex> (jq, case-insensitive;
# empty for none), else the one labelled "(Recommended)", else the first.
# Each ask is answered once: <mark> keeps the log line of the last ask seen
# and answered, and <mark>.picks gets one {q, a} line per question, the
# label meant, for compare.sh to check against the answer recorded. An ask
# is answered the round after it first shows, so its dialog has been drawn.
# Prints nothing when no ask waits, or this round isn't the one to answer
# it; exits 1 on a missing argument, and under QUIET_MIN (below).
#
#   [QUIET_MIN=<minutes>] sh tests/headless/answer.sh <tool-log.jsonl> <regex> <mark> [<ask mark>]
#
# <ask mark> is asking.sh's: a question the steps declined with esc, before
# it, isn't waiting. QUIET_MIN: with no ask waiting, one answered, and no
# tool called for that many minutes, the session's turn is over: exit 1, so
# the keysh moves on (T4-1 attempt 5: the skill ended without launching,
# and the keysh sat out its 600 s before the steps typed Launch).
#
# What T4-1 taught the rule: the regex is for the interview's Launch and
# repair setting alone (attempt 4: one that matched "Leave as written" over
# the recommended "Add report.sh to G2" answered litter otherwise than
# deepwork). And no option is left out for stopping: litter's interview
# recommends fixing the plan first, and its only other option for G2 was
# "Accept the breakage" (attempt 5). Taking the advice, then typing Launch
# when the skill stops, is the user deepwork's side has, whose run starts
# with its command.
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
if ! sh "$(dirname "$0")/asking.sh" "$log" ${4:+"$4"}; then
  if [ -n "${QUIET_MIN:-}" ] && grep -q '^done ' "$mark" 2>/dev/null && [ -z "$(find "$log" -mmin -"$QUIET_MIN" 2>/dev/null)" ]; then
    exit 1
  fi
  exit 0
fi
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
out=$(sed -n "${n}p" "$log" | jq -c --arg re "$re" '
  .input.questions as $q
  | [$q[] | [.options[].label] as $l
      | ((if $re == "" then null else [range($l | length) | select($l[.] | test($re; "i"))] | first end)
         // ([range($l | length) | select($l[.] | test("\\(recommended\\)"; "i"))] | first) // 0) as $i
      | {q: .question, a: $l[$i], keys: ([range($i) | "down"] + (if .multiSelect then ["enter", "tab"] else ["enter"] end))}] as $p
  | {keys: (([$p[].keys[]]) + (if ($q | length) > 1 or any($q[]; .multiSelect) then ["enter"] else [] end) | join(" ")),
     picks: [$p[] | {q, a}]}' 2>/dev/null) || exit 0
printf '%s\n' "$out" | jq -c '.picks[]' >>"$mark.picks"
printf '%s\n' "$out" | jq -r '.keys'
