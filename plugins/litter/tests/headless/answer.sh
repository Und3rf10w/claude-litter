#!/bin/sh
# Tier 4: the keys that answer the session's waiting AskUserQuestion, for
# drive.exp's keysh: a user who wants the run to go ahead and otherwise takes
# the tool's advice. In each question, leaving out the options that stop or
# re-plan (unless all do), it picks the first option whose label matches
# <regex> (jq, case-insensitive; empty for none), else the one labelled
# "(Recommended)", else the first. Each ask is answered once: <mark> keeps
# the log line of the last ask seen and answered, and <mark>.picks gets one
# {q, a} line per question, the label meant, for compare.sh to check against
# the answer recorded. An ask is answered the round after it first shows, so
# its dialog has been drawn. Prints nothing when no ask waits, or this round
# isn't the one to answer it; exits 1 only on a missing argument.
#
#   sh tests/headless/answer.sh <tool-log.jsonl> <regex> <mark> [<ask mark>]
#
# <ask mark> is asking.sh's: a question the steps declined with esc, before
# it, isn't waiting. T4-1 attempt 4: a regex that matched "Leave as written"
# over the recommended "Add report.sh to G2" gave litter's side another
# answer than deepwork's got to the same question, so the regex is for
# Launch and the repair setting alone.
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
out=$(sed -n "${n}p" "$log" | jq -c --arg re "$re" '
  def stops: test("^(stop|halt|cancel|abort|don.?t launch|do not launch|leave it)\\b|fix (the )?plan|edit (the )?plan|re-?plan"; "i");
  .input.questions as $q
  | [$q[] | [.options[].label] as $l
      | ([range($l | length) | select($l[.] | stops | not)] | if length == 0 then [range($l | length)] else . end) as $ok
      | ((if $re == "" then null else [$ok[] | select($l[.] | test($re; "i"))] | first end)
         // ([$ok[] | select($l[.] | test("\\(recommended\\)"; "i"))] | first) // $ok[0]) as $i
      | {q: .question, a: $l[$i], keys: ([range($i) | "down"] + (if .multiSelect then ["enter", "tab"] else ["enter"] end))}] as $p
  | {keys: (([$p[].keys[]]) + (if ($q | length) > 1 or any($q[]; .multiSelect) then ["enter"] else [] end) | join(" ")),
     picks: [$p[] | {q, a}]}' 2>/dev/null) || exit 0
printf '%s\n' "$out" | jq -c '.picks[]' >>"$mark.picks"
printf '%s\n' "$out" | jq -r '.keys'
