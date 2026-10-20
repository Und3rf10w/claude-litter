#!/bin/sh
# Tier 4: phase 4's table (docs/litter-design/SCOPE.md section 3): litter's
# design beside deepwork DESIGN on fixtures/design-compare, each side's
# delivered plan scored against the traps in its ground/expect.json.
# design.sh compare runs it once both sides have run; it reads only their
# files, so it can be run again at any time:
#
#   sh tests/headless/design-compare.sh <case folder>    # its litter/ and deepwork/
#
# Each side folder holds:
#   texts/plan.md     the plan it delivered (empty when it delivered none)
#   texts/files.txt   optional: the paths on its file lists, one a line
#                     (litter's: its gates' files); when it's missing they
#                     are read from the plan's "Files:" lines and the
#                     bullets under one
#   texts/meta.json   {ran, name, ended, delivered, approved, same_bytes,
#                     versions, rounds}: approved, the verdict the delivery
#                     followed; same_bytes, the plan ExitPlanMode put up
#                     for review against the proposal it came from
#                     (litter's; null for none)
#   tool-log.jsonl    the toollog fixture's: asks (AskUserQuestion's
#                     questions and options) and tools (every agent's Bash
#                     commands)
# The code a trap reads is the plan's fenced blocks but json, yaml and
# markdown ones. plan and asks are matched whole; files, code and tools a
# line at a time (jq's ^ is the text's start).
#
# A trap is undecided when one of its undecided checks holds (no file list
# to judge); otherwise right when every check of one of its groups holds,
# and else its else: wrong, or hand. A line "<side> <trap> right|wrong <why>" in the case folder's
# hand.txt settles a trap either way; the table marks it "(hand)".
#
# Passes (exit 0) when litter's right outcomes are at least deepwork's, no
# trap litter's plan gets wrong on a machine check is right in deepwork's,
# and litter delivered only after an approving verdict, the plan file it
# wrote the same bytes as the proposal. Exit 1 when it fails; 3 while a
# trap needs a hand judgment or a side never ran; 2 on bad input.
# Reported, not scored: the share of valid path:line citations (against the
# fixture), versions and rounds, the questions asked, wall time and tokens.

set -u
here=$(cd "$(dirname "$0")" && pwd)
FIX=$here/fixtures/design-compare
EXPECT=$FIX/ground/expect.json
[ $# -eq 1 ] || { echo "usage: $0 <case folder>" >&2; exit 2; }
L=$1/litter D=$1/deepwork HAND=${COMPARE_HAND:-$1/hand.txt}
for s in "$L" "$D"; do [ -d "$s" ] || { echo "$0: no $s" >&2; exit 2; }; done
jq -e '.traps | length > 0' "$EXPECT" >/dev/null || exit 2

# files_of <plan>: the paths on its "Files:" lines, on the bullets under one
# with nothing after its colon, and in a "Files touched" (or changed, or to
# change) section up to the next heading (deepwork's form, compare run 1).
files_of() {
  awk '
  function emit(s,   n, i, t, a) {
    gsub(/[][`*(),;]/, " ", s)
    n = split(s, a, /[ \t]+/)
    for (i = 1; i <= n; i++) {
      t = a[i]
      sub(/:[0-9][0-9-]*$/, "", t)
      sub(/[.:]$/, "", t)
      # A path with an extension of two characters or more (not e.g.), or a folder.
      if (t ~ "^(\\./)?[A-Za-z0-9_][A-Za-z0-9_./-]*\\.[A-Za-z0-9][A-Za-z0-9]+$" || t ~ "^(\\./)?[A-Za-z0-9_][A-Za-z0-9_.-]*/$") print t
    }
  }
  /^[ \t]*(```|~~~)/ { fence = !fence; next }
  fence { next }
  /^[ \t]*#/ {
    l = tolower($0)
    insect = l ~ /^[ \t]*#+[ \t]+((changed|touched) )?files( touched| changed| to (change|edit|touch))?[ \t]*$/
    next
  }
  # A sentence there that names what is not touched ("Nothing under vendor/") lists nothing.
  insect {
    n = split($0, part, "[.!?][ \t]+|[*][*]")
    for (j = 1; j <= n; j++) if (tolower(part[j]) !~ "(^|[^a-z])(nothing|none|not|never|no|unchanged|untouched)([^a-z]|$)") emit(part[j])
    next
  }
  inlist && /^[ \t]*[-*+][ \t]/ { emit($0); seen = 1; next }
  inlist && /^[ \t]*$/ { if (seen) inlist = 0; next }
  { inlist = 0 }
  {
    l = tolower($0)
    if (l ~ /^[ \t]*([-*+][ \t]+)?(\*\*|__)?((changed|touched) )?files( touched| changed| to (change|edit|touch))?(\*\*|__)?[ \t]*(\([^)]*\))?[ \t]*:/) {
      rest = $0
      sub(/^[^:]*:/, "", rest)
      t = rest
      gsub(/[ \t*_]/, "", t)
      if (t == "") { inlist = 1; seen = 0 } else emit(rest)
    }
  }' "$1" | LC_ALL=C sort -u
}
# code_of <plan>: its fenced blocks, but json, yaml and markdown ones.
code_of() {
  awk '
  /^[ \t]*(```|~~~)/ {
    if (!fence) {
      fence = 1
      info = $0
      sub(/^[ \t]*(```|~~~)[ \t]*/, "", info)
      skip = (tolower(info) ~ /^(json|jsonc|yaml|yml|markdown|md)([ \t]|$)/)
      next
    }
    fence = 0
    next
  }
  fence && !skip { print }' "$1"
}

# side <folder> <name>: one JSON object, the side's texts and what's reported.
side() {
  sd=$1
  sp=$sd/texts/plan.md
  [ -f "$sd/texts/meta.json" ] && sm=$(jq -c . "$sd/texts/meta.json") || sm='{"ran": false}'
  sl=$sd/tool-log.jsonl
  sa='""' st='[]'
  if [ -f "$sl" ]; then
    # A torn line from concurrent hooks is skipped, not fatal.
    sa=$(jq -nRc '[inputs | fromjson? | select(.tool == "AskUserQuestion" and .ev == "PreToolUse") | .input.questions[]?
      | [.question, .header, (.options[]? | .label, .description)] | map(select(. != null)) | join("\n")] | join("\n")' "$sl") || return 1
    st=$(jq -nRc '[inputs | fromjson? | select(.tool == "Bash" and .ev == "PreToolUse") | .input.command // empty | split("\n")[]]' "$sl") || return 1
  fi
  if [ -f "$sp" ]; then
    if [ -f "$sd/texts/files.txt" ]; then sf=$(jq -Rsc 'split("\n") | map(select(. != ""))' "$sd/texts/files.txt"); else sf=$(files_of "$sp" | jq -Rsc 'split("\n") | map(select(. != ""))'); fi || return 1
    sc=$(code_of "$sp" | jq -Rsc 'split("\n")') || return 1
    # Each path:line citation, valid when the fixture has the file and the line.
    cites=$(jq -Rsr '[match("(?<p>[A-Za-z0-9_][A-Za-z0-9_./-]*\\.[A-Za-z0-9]{2,}):(?<l>[0-9]+)"; "g") | [.captures[].string] | "\(.[0] | ltrimstr("./")) \(.[1])"] | unique | .[]' "$sp") || return 1
    cn=0 cv=0
    while read -r cp cl; do
      [ -n "$cp" ] || continue
      cn=$((cn + 1))
      [ -f "$FIX/repo/$cp" ] && [ "$cl" -ge 1 ] && [ "$cl" -le "$(wc -l <"$FIX/repo/$cp" | tr -d ' ')" ] && cv=$((cv + 1))
    done <<EOF
$cites
EOF
    jq -nc --rawfile plan "$sp" --argjson files "$sf" --argjson code "$sc" --argjson asks "$sa" --argjson tools "$st" \
      --argjson meta "$sm" --argjson cn "$cn" --argjson cv "$cv" \
      '{plan: $plan, files: $files, code: $code, asks: $asks, tools: $tools, meta: $meta, cites: {n: $cn, valid: $cv}}'
  else
    jq -nc --argjson asks "$sa" --argjson tools "$st" --argjson meta "$sm" \
      '{plan: "", files: [], code: [], asks: $asks, tools: $tools, meta: $meta, cites: {n: 0, valid: 0}}'
  fi
}
tokens() {
  find "$1/transcripts" -name '*.jsonl' 2>/dev/null | while IFS= read -r f; do
    jq -cR 'fromjson? | select(.type == "assistant" and .message.usage != null) | {id: .message.id, u: .message.usage}' "$f"
  done | jq -s -r 'if length == 0 then "no transcripts kept" else (map(select(.id == null)) + (map(select(.id != null)) | unique_by(.id))) | map(.u)
    | "in \(map(.input_tokens // 0) | add), cache write \(map(.cache_creation_input_tokens // 0) | add), cache read \(map(.cache_read_input_tokens // 0) | add), out \(map(.output_tokens // 0) | add)" end' ||
    echo 'tokens unreadable'
}
wall() {
  [ -f "$1/start" ] && [ -f "$1/end" ] || { echo 'no wall time'; return; }
  w=$(($(cat "$1/end") - $(cat "$1/start")))
  printf '%dh%02dm%02ds\n' $((w / 3600)) $((w % 3600 / 60)) $((w % 60))
}

ls_=$(side "$L") || { echo "$0: litter's side can't be read" >&2; exit 2; }
ds_=$(side "$D") || { echo "$0: deepwork's side can't be read" >&2; exit 2; }
hand='[]'
if [ -f "$HAND" ]; then
  hand=$(jq -Rsc 'split("\n") | map(capture("^\\s*(?<side>litter|deepwork)\\s+(?<trap>D[0-9]+)\\s+(?<v>right|wrong)\\b[\\s:]*(?<why>.*)$")?)' "$HAND") || exit 2
fi

table=$(jq -nr --slurpfile e "$EXPECT" --argjson ls "$ls_" --argjson ds "$ds_" --argjson hand "$hand" --arg hf "$HAND" \
  --arg lw "$(wall "$L")" --arg dw "$(wall "$D")" --arg lt "$(tokens "$L")" --arg dt "$(tokens "$D")" '
  def pad($n): tostring | if length < $n then . + ([range($n - length)] | map(" ") | add) else . end;
  def lines($t): if ($t | type) == "array" then $t else [$t] end;
  def holds($s):
    . as $c | lines($s[$c.in]) as $xs
    | if $c.empty == true then ($xs | map(select(. != "")) | length) == 0
      elif $c.match != null then any($xs[]; test($c.match; "i"))
      elif $c.no != null then all($xs[]; test($c.no; "i") | not)
      elif $c.only != null then all($xs[]; test($c.only; "i"))
      else error("a check with no test: \($c)") end;
  def judge($side; $s; $t):
    ([$hand[] | select(.side == $side and .trap == $t.id)] | last) as $h
    | (if any($t.undecided[]; holds($s)) then {r: "?", why: "undecided by the checks", m: "?"}
       elif any($t.groups[]; all(.[]; holds($s))) then {r: "yes", why: "a group holds", m: "yes"}
       elif $t.else == "wrong" then {r: "no", why: "no group holds", m: "no"}
       else {r: "?", why: "no group holds: judge it by hand", m: "?"} end) as $j
    | (if $h != null then {r: (if $h.v == "right" then "yes" else "no" end), why: "(hand) \($h.why)", m: $j.m} else $j end)
    | . + {side: $side, trap: $t.id, tests: $t.tests};
  def deliv($s): $s.meta as $m
    | if ($m.delivered // false) | not then {ok: true, why: "delivered nothing"}
      elif $m.approved != true then {ok: false, why: "delivered without an approving verdict"}
      elif $m.same_bytes != true then {ok: false, why: "the plan it put up for review is not the proposal'"'"'s bytes (\($m.same_bytes))"}
      else {ok: true, why: "delivered after an approving verdict, the proposal'"'"'s bytes"} end;
  def about($n; $s; $w; $tk): $s.meta as $m
    | "  \($n | pad(10))\($m.name // "no run"), \($m.ended // "never ended"); versions \($m.versions // "?"), rounds \($m.rounds // "?"); wall \($w); tokens \($tk)";
  $e[0].traps as $traps
  | [$traps[] as $t | judge("litter"; $ls; $t), judge("deepwork"; $ds; $t)] as $rows
  | ($rows | map(select(.side == "litter" and .r == "yes")) | length) as $lr
  | ($rows | map(select(.side == "deepwork" and .r == "yes")) | length) as $dr
  | [$traps[] | .id as $id
      | select(any($rows[]; .side == "litter" and .trap == $id and .m == "no" and .r == "no")
          and any($rows[]; .side == "deepwork" and .trap == $id and .r == "yes"))
      | "\($id): litter'"'"'s plan gets it wrong on a machine check, and deepwork'"'"'s is right"] as $worse
  | deliv($ls) as $ld
  | [$rows[] | select(.r == "?") | "\(.side) \(.trap)"] as $open
  | "Phase 4: litter'"'"'s design beside deepwork DESIGN",
    about("litter:"; $ls; $lw; $lt),
    about("deepwork:"; $ds; $dw; $dt),
    "",
    "\("trap" | pad(6))\("side" | pad(10))\("tests" | pad(18))right",
    ($rows[] | "\(.trap | pad(6))\(.side | pad(10))\(.tests | pad(18))\(.r): \(.why)"),
    "",
    "litter'"'"'s delivery: \($ld.why)",
    "file lists (the checks'"'"' files):",
    "  litter:   \($ls.files | if length == 0 then "none" else join(", ") end)",
    "  deepwork: \($ds.files | if length == 0 then "none" else join(", ") end)",
    "path:line citations valid against the fixture (reported, not scored): litter \($ls.cites.valid)/\($ls.cites.n), deepwork \($ds.cites.valid)/\($ds.cites.n)",
    "questions asked (reported, not scored):",
    "  litter:   \($ls.asks | if . == "" then "none" else gsub("\\s+"; " ") | .[0:300] end)",
    "  deepwork: \($ds.asks | if . == "" then "none" else gsub("\\s+"; " ") | .[0:300] end)",
    "right outcomes: litter \($lr), deepwork \($dr)",
    (if (($ls.meta.ran // false) and ($ds.meta.ran // false)) | not then
       "INCOMPLETE: \([(if $ls.meta.ran // false then empty else "litter never ran" end), (if $ds.meta.ran // false then empty else "deepwork never ran" end)] | join(" and ")): run that side again"
     elif ($open | length) > 0 then "UNDECIDED: \($open | join(", ")) need a hand judgment: a line \"<side> <trap> right|wrong <why>\" in \($hf)"
     elif $lr >= $dr and ($worse | length) == 0 and $ld.ok then "PASS: litter'"'"'s right outcomes are at least deepwork'"'"'s, no trap its plan gets wrong is right in deepwork'"'"'s, and it delivered only what was approved"
     else "FAIL: " + ([(if $lr < $dr then "litter'"'"'s right outcomes are \($lr), deepwork'"'"'s \($dr)" else empty end), $worse[],
       (if $ld.ok then empty else "litter " + $ld.why end)] | join("; ")) end)') ||
  { echo "$0: the table couldn't be built" >&2; exit 2; }
printf '%s\n' "$table"
case $(printf '%s\n' "$table" | tail -n 1) in PASS:*) exit 0 ;; UNDECIDED:* | INCOMPLETE:*) exit 3 ;; *) exit 1 ;; esac
