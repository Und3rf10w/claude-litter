#!/bin/sh
# Tier 4: the keys that answer the session's waiting plan-mode dialog, for
# drive.exp's keysh: EnterPlanMode's, or ExitPlanMode's approval. The engine
# draws these itself, so unlike an AskUserQuestion (answer.sh) their labels
# aren't in the tool log: they're read off the screen, the last run of
# numbered options ("1. Yes, and use auto mode"), the cursor on the first.
# A dialog waits when the tool log has more of the tool's PreToolUse lines
# than PostToolUse and PostToolUseFailure ones. It's answered once, the
# round after it first shows, so its dialog has been drawn: <mark> keeps
# "<tool> <PreToolUse count>" for the one seen, and "<...> answered" once
# answered. The pick is the first option whose label matches <regex> and
# not <never> (extended, case-insensitive; <never> by default: accepting
# edits, bypassing permissions, or clearing the context). Prints nothing
# when no dialog waits or this round isn't the one; exits 1 when one waits
# and no option fits (the steps can't answer it), or on a missing argument.
#
#   sh tests/headless/planpick.sh <tty.txt> <tool-log.jsonl> <mark> <regex> [<never>]

tty=${1:?usage: planpick.sh <tty.txt> <tool-log.jsonl> <mark> <regex> [<never>]}
log=${2:?usage: planpick.sh <tty.txt> <tool-log.jsonl> <mark> <regex> [<never>]}
mark=${3:?usage: planpick.sh <tty.txt> <tool-log.jsonl> <mark> <regex> [<never>]}
want=${4:?usage: planpick.sh <tty.txt> <tool-log.jsonl> <mark> <regex> [<never>]}
never=${5:-accept edits|auto-accept|bypass|clear context}
[ -f "$log" ] || exit 0

# The tool whose dialog waits, with its PreToolUse count: "EnterPlanMode 1".
waiting=$(jq -nRr '[inputs | fromjson? | select(.tool == "EnterPlanMode" or .tool == "ExitPlanMode")]
  | group_by(.tool)[] | .[0].tool as $t
  | (map(select(.ev == "PreToolUse")) | length) as $pre
  | (map(select(.ev == "PostToolUse" or .ev == "PostToolUseFailure")) | length) as $post
  | select($pre > $post) | "\($t) \($pre)"' "$log" 2>/dev/null | head -n 1)
[ -n "$waiting" ] || exit 0
seen=$(cat "$mark" 2>/dev/null)
case $seen in
"$waiting answered") exit 0 ;;
"$waiting") ;;
*)
  printf '%s\n' "$waiting" >|"$mark"
  exit 0
  ;;
esac

# The screen as text (execute.sh's screen()), then its last run of numbered options.
e=$(printf '\033')
b=$(printf '\007')
labels=$(LC_ALL=C sed -e "s#${e}\[[0-9]*[CG]# #g" -e "s#${e}\[[0-9:;<=>?]*[ -/]*[@-~]##g" -e "s#${e}][^${b}${e}]*${b}##g" \
  -e "s#${e}][^${b}${e}]*${e}[\\\\]##g" -e "s#${e}[()][A-Za-z0-9]##g" -e "s#${e}[^][]##g" "$tty" | tr -d '\r' | tail -n 400 | awk '
  {
    l = $0
    gsub(/│/, " ", l)
    sub(/^[ \t]*(❯|›|>)?[ \t]*/, "", l)
    if (match(l, /^[0-9]+\.[ \t]+/)) {
      n = substr(l, 1, index(l, ".") - 1) + 0
      t = substr(l, RLENGTH + 1)
      sub(/[ \t]+$/, "", t)
      if (n == 1) { k = 0 }
      if (n == k + 1) { k = n; opt[n] = t }
    }
  }
  END { for (i = 1; i <= k; i++) print opt[i] }')
i=0
pick=0
while IFS= read -r l; do
  [ -n "$l" ] || continue
  i=$((i + 1))
  printf '%s\n' "$l" | grep -Eiq -- "$never" && continue
  printf '%s\n' "$l" | grep -Eiq -- "$want" && { pick=$i; break; }
done <<EOF
$labels
EOF
[ "$pick" -gt 0 ] || exit 1
printf '%s answered\n' "$waiting" >|"$mark"
keys=
j=1
while [ "$j" -lt "$pick" ]; do keys="$keys down"; j=$((j + 1)); done
echo "${keys# } enter" | sed 's/^ //'
