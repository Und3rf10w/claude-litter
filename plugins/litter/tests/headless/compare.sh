#!/bin/sh
# Tier 4: T4-1's table (WP-T4): litter's execute beside deepwork EXECUTE on
# fixtures/compare's five-gate plan, scored against fixtures/compare/ground/.
# execute.sh compare runs it once both sides have run; it reads only their
# files, so it can be run again at any time:
#
#   sh tests/headless/compare.sh <case folder>                   # its litter/ and deepwork/
#   sh tests/headless/compare.sh <litter side> <deepwork side>   # any run's sides, paired
#
# Per gate and per side: landed or halted (or asked, deepwork's question
# nobody answered; or none, no outcome by the end or the cap), the attempts,
# the gate's ground check on the side's final tree, and whether that's the
# right outcome expect.json gives. litter's side is read from its run's
# ledger (land, verify, verdict and run.end: what summary.md and verdicts/
# are rendered from), its final tree litter/<run>'s tip. deepwork's is read
# from its instance's state (state.archived.json, else state.json:
# execute.change_log, scope_amendments, discoveries, halt_reason), its
# questions from the side's tool-log.jsonl, its final tree main's HEAD (S0,
# run 3: it merges onto the checkout's branch).
#
# A halt or question is right when its text matches the gate's `names` in
# expect.json. When it doesn't, the gate needs a hand judgment: a line
# "<side> <gate> right|wrong <why>" in the case folder's hand.txt
# ($COMPARE_HAND for two sides), which the table marks "(hand)".
#
# Passes (exit 0) when litter's right outcomes are at least deepwork's and
# no gate litter landed fails a ground check deepwork's final tree passes.
# Exit 1 when it fails; 3 while a hand judgment is missing, or a side never
# started (no litter run, no deepwork execute instance); 2 on bad input.
# Reported, not scored: rejected attempts whose tree passes every ground
# check (litter's only when its verify was green), wall time and tokens.
# Writes final/ (each final tree) and attempts/ (each rejected one) into
# the side folders; the table goes to stdout.

set -u
here=$(cd "$(dirname "$0")" && pwd)
G=$here/fixtures/compare/ground
EXPECT=$G/expect.json
case $# in
1) L=$1/litter D=$1/deepwork HAND=${COMPARE_HAND:-$1/hand.txt} ;;
2) L=$1 D=$2 HAND=${COMPARE_HAND:-} ;;
*) echo "usage: $0 <case folder> | <litter side> <deepwork side>" >&2; exit 2 ;;
esac
for s in "$L" "$D"; do [ -d "$s/repo" ] || { echo "$0: $s has no repo/" >&2; exit 2; }; done
GJ=$(jq -c '[.gates[].id]' "$EXPECT") || exit 2
CHECKS=$(jq -r '.gates[].check // empty' "$EXPECT") || exit 2

# limit <secs> <command...>: the command, killed if it outlasts <secs> (a landed lib could loop).
limit() {
  lt=$1
  shift
  "$@" &
  lp=$!
  (sleep "$lt"; kill "$lp") >/dev/null 2>&1 &
  ld=$!
  wait "$lp"
  lr=$?
  kill "$ld" 2>/dev/null
  return $lr
}

# tree <repo> <tree-ish> <dir>: the tree's files in <dir>, from git archive (the repo untouched).
tree() {
  git -C "$1" cat-file -e "$2^{tree}" 2>/dev/null || return 1
  rm -rf "$3"
  mkdir -p "$3" || return 1
  git -C "$1" archive "$2" | tar -xf - -C "$3"
}

# ground <dir>: one JSON object, each ground check's name to { ok, msg }.
ground() {
  gj='{}'
  for c in $CHECKS; do
    gm=$(limit 120 sh "$G/$c" "$1" 2>&1)
    if [ $? -eq 0 ]; then go=true; else go=false; fi
    gj=$(printf '%s' "$gj" | jq -c --arg c "$c" --arg m "$gm" --argjson ok "$go" '.[$c] = {ok: $ok, msg: ($m | gsub("\n"; " ") | .[0:300])}') || return 1
  done
  printf '%s\n' "$gj"
}

# false_rejections <side> <repo> <JSON list of {tree, green}>: how many of the rejected trees pass every ground check.
false_rejections() {
  fn=0
  k=0
  xs=$(printf '%s' "$3" | jq -r '.[] | select(.green != false and .tree != null) | .tree') || { echo "unreadable"; return; }
  for x in $xs; do
    k=$((k + 1))
    tree "$2" "$x" "$1/attempts/$k" || continue
    ground "$1/attempts/$k" | jq -e 'all(.[]; .ok)' >/dev/null 2>&1 && fn=$((fn + 1))
  done
  echo "$fn"
}

# Tokens across a side's kept transcripts, each message once (a message's records repeat its usage); a torn line is skipped.
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

# ---------------------------------------------------------------------------
# litter's side: the run's ledger, every generation (repair: auto). Lands,
# attempts and verdicts count across them, and the run's outcome is its last
# run.end's: generation 2's when the bridge continued it, else generation 1's.

LD=$L/repo/.claude/litter
RUN=$(ls "$LD" 2>/dev/null | grep -E '^[0-9]{8}-' | head -n 1)
if [ -n "$RUN" ] && [ -f "$LD/$RUN/run.json" ]; then
  RD=$LD/$RUN
  base=$(jq -r .base "$RD/run.json") || exit 2
  rmode=$(jq -r '"repair \(.repair.mode // "unset"), max attempts \(.args.maxAttempts // "unset")"' "$RD/run.json") || exit 2
  ltip=$(git -C "$L/repo" rev-parse -q --verify "refs/heads/litter/$RUN") || ltip=$base
  # The gate of a verdict is its own (a plan-template one's) or its cited verify's (an execute critic's: verdicts.ts verdictTarget).
  # A plan-template verdict says `approved`; an execute critic's passes when every dimension does.
  lf=$(cat "$RD"/ledger/*.json | jq -s -c --argjson gates "$GJ" --arg run "$RUN ($rmode)" --arg tip "$ltip" '
    sort_by(.seq) as $r
    | ([$r[] | select(.kind == "verify") | {key: .body.verify_id, value: .body}] | from_entries) as $v
    | [$r[] | select(.kind == "run.end")] as $ends
    | ($ends | last) as $end
    | [$gates[] as $g | {id: $g,
        landed: any($r[]; .kind == "land" and .body.gate == $g),
        attempts: ([$r[] | select(.kind == "verify" and .body.gate == $g) | .body.attempt] | unique | length),
        verdicts: [$r[] | select(.kind == "verdict") | .body as $b | ($v[$b.verify_id // ""] // {}) as $vv
          | select(($b.gate // $vv.gate) == $g)
          | {ok: (if $b.approved != null then $b.approved == true
                  else [$b.plan_adherence, $b.tests_green, $b.no_regressions, $b.rules] | all(.pass? == true) end),
             gap: ([$b.plan_gap // "", $b.rule_clash // ""] | map(select(. != "")) | join(" | ")),
             tree: ($vv.tree_before // null), green: ($vv.green // false)}]}] as $rows
    | ([range(0; $rows | length) | select($rows[.].landed | not)] | first) as $stop
    | {ran: true, name: "run \($run)", tip: $tip,
       ended: (if $end == null then "never ended"
         else "ended \($end.body.status) after \($ends | length) generation(s): \($end.body.reason // "no reason")" end),
       gates: [range(0; $rows | length) as $i | $rows[$i] | . + {
         outcome: (if .landed then "landed" elif $end != null and $end.body.status != "done" and $i == $stop then "halted" else "none" end),
         text: (if $end != null and $i == $stop then [($end.body.reason // empty), (.verdicts[].gap | select(. != ""))]
           | reduce .[] as $t ([]; if any(.[]; contains($t)) then . else . + [$t] end) | join(" | ") else "" end),
         rejected: [.verdicts[] | select((.ok | not) and .gap == "") | {tree, green}]}]}') || { echo "$0: litter's ledger doesn't parse" >&2; exit 2; }
else
  ltip=$(git -C "$L/repo" rev-parse -q --verify HEAD) || exit 2
  lf=$(jq -nc --argjson gates "$GJ" --arg tip "$ltip" '{ran: false, name: "no run", tip: $tip, ended: "no run.json",
    gates: [$gates[] | {id: ., landed: false, attempts: 0, outcome: "none", text: "", rejected: []}]}') || exit 2
fi

# ---------------------------------------------------------------------------
# deepwork's side: its execute instance's state, and the questions nobody answered.

state=
for s in "$D"/repo/.claude/deepwork/*/state.archived.json "$D"/repo/.claude/deepwork/*/state.json; do
  [ -f "$s" ] || continue
  [ "$(jq -r '.mode // empty' "$s" 2>/dev/null)" = execute ] && { state=$s; break; }
done
asks='{"open": 0, "questions": []}'
if [ -f "$D/tool-log.jsonl" ]; then
  # A torn line from concurrent hooks is skipped, not fatal.
  asks=$(jq -nRc '[inputs | fromjson? | select(.tool == "AskUserQuestion")] as $a
    | {open: (($a | map(select(.ev == "PreToolUse")) | length) - ($a | map(select(.ev == "PostToolUse")) | length)),
       questions: [$a[] | select(.ev == "PreToolUse") | .input.questions[]? | .question // empty]}' "$D/tool-log.jsonl") || exit 2
fi
dtip=$(git -C "$D/repo" rev-parse -q --verify refs/heads/main) || exit 2
if [ -n "$state" ]; then
  # change_log[].plan_section names the gate as "G1", "plan.md#G1" or "G-exec-1" (S0's runs).
  df=$(jq -c --argjson gates "$GJ" --argjson asks "$asks" --arg tip "$dtip" --arg file "${state##*/}" '
    .execute as $x
    | def of($n): (. // "") | test("(^|[^A-Za-z0-9])[Gg](-?exec-?)?" + $n + "([^0-9]|$)");
    [$gates[] as $g | ($g | ltrimstr("G")) as $n | [($x.change_log // [])[] | select(.plan_section | of($n))] as $c
      | {id: $g, landed: any($c[]; .merged_at != null), attempts: ($c | length),
         rejected: [$c[] | select((.critic_verdict // "") | test("^(HOLD|FAIL|REJECT)"; "i")) | {tree: .commit, green: null}],
         notes: [(($x.scope_amendments // [])[] | select(.gate_id | of($n)) | "scope amendment \(.id // ""): \(.reason // "")")]}] as $rows
    | ([range(0; $rows | length) | select($rows[.].landed | not)] | first) as $stop
    | (if $x.phase == "halt" then "halted" elif $asks.open > 0 then "asked" else null end) as $how
    | (.halt_reason // {}) as $h
    | {ran: true, name: "instance \(.instance_id // "?") (\($file))", tip: $tip,
       ended: "phase \($x.phase // "none")\(if $h.summary then ": \($h.summary)" else "" end)",
       gates: [range(0; $rows | length) as $i | $rows[$i] | . + {
         outcome: (if .landed then "landed" elif $how != null and $i == $stop then $how else "none" end),
         text: (if $i == $stop then [($h.summary // empty), (($h.blockers // [])[] | tostring), $asks.questions[], .notes[],
           (($x.discoveries // [])[] | select(.proposed_outcome != "continue") | "discovery \(.id // ""): \(.context // "")")] | join(" | ") else "" end)}]}' "$state") ||
    { echo "$0: $state doesn't parse" >&2; exit 2; }
else
  df=$(jq -nc --argjson gates "$GJ" --argjson asks "$asks" --arg tip "$dtip" '{ran: false, name: "no execute instance", tip: $tip, ended: "no state",
    gates: [$gates[] as $g | {id: $g, landed: false, attempts: 0, outcome: (if $asks.open > 0 and $g == "G1" then "asked" else "none" end),
      text: (if $g == "G1" then $asks.questions | join(" | ") else "" end), rejected: []}]}') || exit 2
fi

# ---------------------------------------------------------------------------
# The final trees and their ground checks, the false rejections, the hand judgments.

tree "$L/repo" "$ltip" "$L/final" || { echo "$0: litter's final tree $ltip can't be read" >&2; exit 2; }
tree "$D/repo" "$dtip" "$D/final" || { echo "$0: deepwork's final tree $dtip can't be read" >&2; exit 2; }
lg=$(ground "$L/final") || exit 2
dg=$(ground "$D/final") || exit 2
lfr=$(false_rejections "$L" "$L/repo" "$(printf '%s' "$lf" | jq -c '[.gates[].rejected[]]')")
dfr=$(false_rejections "$D" "$D/repo" "$(printf '%s' "$df" | jq -c '[.gates[].rejected[]]')")
hand='[]'
if [ -n "$HAND" ] && [ -f "$HAND" ]; then
  hand=$(jq -Rsc 'split("\n") | map(capture("^\\s*(?<side>litter|deepwork)\\s+(?<gate>G[0-9]+)\\s+(?<v>right|wrong)\\b[\\s:]*(?<why>.*)$")?)' "$HAND") || exit 2
fi

table=$(jq -nr --slurpfile e "$EXPECT" --argjson lf "$lf" --argjson df "$df" --argjson lg "$lg" --argjson dg "$dg" --argjson hand "$hand" \
  --arg lfr "$lfr" --arg dfr "$dfr" --arg lw "$(wall "$L")" --arg dw "$(wall "$D")" --arg lt "$(tokens "$L")" --arg dt "$(tokens "$D")" \
  --arg hf "${HAND:-\$COMPARE_HAND}" '
  def pad($n): tostring | if length < $n then . + ([range($n - length)] | map(" ") | add) else . end;
  def judge($side; $f; $ck; $e):
    ($f.gates[] | select(.id == $e.id)) as $x
    | (if $e.check == null then null else $ck[$e.check] end) as $c
    | ([$hand[] | select(.side == $side and .gate == $e.id)] | last) as $h
    | (if $x.outcome == "landed" then
         (if ($e.expect | index("lands")) == null then {r: "no", why: "landed: a silent pick"}
          elif $c != null and ($c.ok | not) then {r: "no", why: "landed, failing \($e.check)"}
          else {r: "yes", why: "landed"} end)
       elif $x.outcome == "none" then {r: "no", why: "no outcome"}
       elif ($e.expect | index("halts")) == null then {r: "no", why: "\($x.outcome), where it should land"}
       elif $c != null and ($c.ok | not) then {r: "no", why: "\($x.outcome), but the tree fails \($e.check)"}
       elif $e.names == null or ($x.text | test($e.names; "i")) then {r: "yes", why: "\($x.outcome), naming it"}
       elif $h != null then {r: (if $h.v == "right" then "yes" else "no" end), why: "\($x.outcome) (hand): \($h.why)"}
       else {r: "?", why: "\($x.outcome): judge it by hand" } end) as $j
    | {side: $side, gate: $e.id, outcome: $x.outcome, attempts: $x.attempts, check: $e.check,
       ck: (if $c == null then "-" elif $c.ok then "pass" else "fail" end), r: $j.r, why: $j.why, text: $x.text, landed: $x.landed};
  $e[0].gates as $gates
  | [$gates[] as $g | judge("litter"; $lf; $lg; $g), judge("deepwork"; $df; $dg; $g)] as $rows
  | ($rows | map(select(.side == "litter" and .r == "yes")) | length) as $lr
  | ($rows | map(select(.side == "deepwork" and .r == "yes")) | length) as $dr
  | [$gates[] | select(.check != null) as $g
      | select(($lf.gates[] | select(.id == $g.id) | .landed) and ($lg[$g.check].ok | not) and $dg[$g.check].ok)
      | "\($g.id): litter landed it, its final tree fails \($g.check) (\($lg[$g.check].msg)), which deepwork'"'"'s passes"] as $worse
  | [$rows[] | select(.r == "?") | "\(.side) \(.gate)"] as $open
  | "T4-1: litter'"'"'s execute beside deepwork EXECUTE",
    "  litter:   \($lf.name), \($lf.ended); final tree \($lf.tip[0:12]); wall \($lw); tokens \($lt)",
    "  deepwork: \($df.name), \($df.ended); final tree \($df.tip[0:12]); wall \($dw); tokens \($dt)",
    "",
    "\("gate" | pad(6))\("side" | pad(10))\("outcome" | pad(9))\("attempts" | pad(10))\("ground check, final tree" | pad(26))right",
    ($rows[] | "\(.gate | pad(6))\(.side | pad(10))\(.outcome | pad(9))\(.attempts | pad(10))\((if .check == null then "-" else "\(.check) \(.ck)" end) | pad(26))\(.r): \(.why)"),
    "",
    "every ground check on each final tree:",
    "  litter:   \([$lg | to_entries[] | "\(.key) \(if .value.ok then "pass" else "fail: \(.value.msg)" end)"] | join("; "))",
    "  deepwork: \([$dg | to_entries[] | "\(.key) \(if .value.ok then "pass" else "fail: \(.value.msg)" end)"] | join("; "))",
    "halts and questions, as each side worded them:",
    ([$rows[] | select(.text != "") | "  \(.side) \(.gate): \(.text)"] | if length == 0 then ["  none"] else . end | .[]),
    "rejected attempts (reported, not scored): litter \([$lf.gates[].rejected[]] | length), \($lfr) of them green and passing every ground check; deepwork \([$df.gates[].rejected[]] | length), \($dfr) of them passing every ground check",
    "right outcomes: litter \($lr), deepwork \($dr)",
    (if ($lf.ran and $df.ran | not) then "INCOMPLETE: \([(if $lf.ran then empty else "litter has no run" end), (if $df.ran then empty else "deepwork has no execute instance" end)] | join(" and ")): run that side again"
     elif ($open | length) > 0 then "UNDECIDED: \($open | join(", ")) need a hand judgment: a line \"<side> <gate> right|wrong <why>\" in \($hf)"
     elif $lr >= $dr and ($worse | length) == 0 then "PASS: litter'"'"'s right outcomes are at least deepwork'"'"'s, and no gate litter landed fails a ground check deepwork'"'"'s outcome passed"
     else "FAIL: " + ([(if $lr < $dr then "litter'"'"'s right outcomes are \($lr), deepwork'"'"'s \($dr)" else empty end), $worse[]] | join("; ")) end)') ||
  { echo "$0: the table couldn't be built" >&2; exit 2; }
printf '%s\n' "$table"
case $(printf '%s\n' "$table" | tail -n 1) in PASS:*) exit 0 ;; UNDECIDED:* | INCOMPLETE:*) exit 3 ;; *) exit 1 ;; esac
