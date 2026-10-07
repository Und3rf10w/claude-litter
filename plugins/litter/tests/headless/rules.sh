#!/bin/sh
# Tier 4: phase 3's rules (WP-T4's T4-2), in an interactive session that
# drive.exp types into, since accepting happens only from the rules pane's
# buttons:
#
#   sh tests/headless/rules.sh import   # imported deepwork guardrails: one, a ban narrowed to a/** and accepted, reaches every gate
#
# The repo is lib.sh's plus fixtures/rules-import: parts a/ and b/, each with
# a function and a check in its test.sh, test.sh running both, and a
# two-gate plan.md, G1's Files under a/ and G2's under b/, G1's change one
# that could tempt a write to a/out.txt. .claude/deepwork/ (ignored, as a
# deepwork instance's state is) holds live1/state.json, with guardrails from
# user ("never call curl in a/"), flag ("never write to a/out.txt"),
# orchestrator and scope-boundary, the incidents.jsonl beside it repeating
# the orchestrator one with its incident_ref, and old1/state.archived.json
# with one flag guardrail. The session imports them (/litter:rules import),
# narrows the flag ban to a/** and accepts it in project scope from the pane,
# dismisses the orchestrator one, leaves the rest pending, then runs
# /litter:execute plan.md through its interview and Launch (repair: off, so a
# halt stops). A ban reaches every gate whatever its paths (16.5: they say
# what must not change, not where the work is), so the checks want it in
# args.rules, naming a/** as what it protects, and in G1's and G2's executor
# and critic prompts, and in no gate's own list (args.gates[].rules).
# H_PERSIST=1 keeps the workflow agents' transcripts, whose prompts the
# checks read.
#
# The pane's key sequence isn't known until one manual run shows it: the
# steps marked KEYS below are placeholders for main to fill in from that run.
# Until then those steps do nothing, the waits after them time out, and the
# checks that need the presses fail, naming what's missing.
#
# H_DRY=1 stops once the repo and the steps are made, with no session.
# H_CHECKS=<case folder> skips the repo and the session and runs the checks
# on a folder an earlier run left in $H_OUT. Needs expect and bun. RULES_MODEL
# sets the session's model (--model).

set -u
. "$(dirname "$0")/lib.sh"

mode=${1:-import}
case $mode in import) ;; *) echo "usage: $0 import" >&2; exit 2 ;; esac
command -v bun >/dev/null || { echo "$0: needs bun" >&2; exit 2; }
[ -n "${H_CHECKS:-}" ] || command -v expect >/dev/null || { echo "$0: needs expect" >&2; exit 2; }

# The guardrails' texts, from the fixture itself.
DW=$H_FIX/rules-import/deepwork
guardrail() { jq -r --arg s "$2" '[.guardrails[] | select(.source == $s) | .rule] | first // empty' "$DW/$1"; }
G_USER=$(guardrail live1/state.json user) || exit 1
G_FLAG=$(guardrail live1/state.json flag) || exit 1
G_ORCH=$(guardrail live1/state.json orchestrator) || exit 1
G_SCOPE=$(guardrail live1/state.json scope-boundary) || exit 1
G_OLD=$(guardrail old1/state.archived.json flag) || exit 1
[ -n "$G_USER" ] && [ -n "$G_FLAG" ] && [ -n "$G_ORCH" ] && [ -n "$G_SCOPE" ] && [ -n "$G_OLD" ] || { echo "$0: $DW lacks a guardrail" >&2; exit 2; }

if [ -n "${H_CHECKS:-}" ]; then
  H_DIR=$(cd -P "$H_CHECKS" && pwd -P) || exit 2
  H_CASE=${H_DIR##*/}
  H_REPO=$H_DIR/repo
else
  # A fresh path each run: $.store keeps the rules ledger's head and the ledgers' by their absolute paths.
  h_scratch "rules-$mode-$(date +%Y%m%d-%H%M%S)"
  cp "$LITTER_ROOT/workflows/execute.js" "$H_DIR/litter/workflows/execute.js" || exit 1
  cp -R "$H_FIX/rules-import/." "$H_REPO/" || exit 1
  mv "$H_REPO/deepwork" "$H_REPO/.claude/deepwork" || exit 1
  printf '/.claude/deepwork/\n' >>"$H_REPO/.gitignore"
  h_git -C "$H_REPO" add -A
  h_git -C "$H_REPO" commit -q -m 'parts a and b, their checks and plan.md; deepwork state, ignored' || exit 1
fi
R=$H_REPO
LD=$R/.claude/litter
RL=$LD/rules-ledger/ledger

if [ -z "${H_CHECKS:-}" ]; then
  cat >|"$H_DIR/steps.txt" <<EOF
# The first prompt records the session's mode (watch.sh).
until [ -f $LD/hooks/mode ]
$(h_tool_steps "$H_DIR/debug.txt")
sleep 5
# Step 1: the import. The rules pane opens on the batch: live1 live and old1
# archived, live1's user and flag guardrails checked, the first one picked,
# its description saying "no paths: it reaches every gate, but protects
# nothing by name" (each import is a ban with no paths).
send /litter:rules import
wait 600 ls $RL/*-rule.import.json
sleep 15
#
# KEYS: how the pane takes keys (CC 2.1.288 and 2.1.289). ctrl-x tab gives
# the first pane opened the keyboard, with nothing held (a band above the
# prompt that draws a field would take it first). Tab walks the ring, the
# pane's Button, Input and Select elements in tree order, the first Tab
# landing on the first. The `litter` pane draws its section strip first (phase
# 5b, WP-DA): with Rules shown, the other six sections' Buttons (Home, Runs,
# Swarms, Tasks, Agents, Doctor) take the ring's first six places, so every
# count below is the Rules body's place plus 6. Enter presses the held
# button (space isn't bound); a held field takes typing, and its Enter sets
# it, the field still held; esc gives the keyboard back. The strip's digit
# hotkeys (1–7, while the pane holds the keyboard) never meet these presses,
# which type no digit. The pane holds an element by its place in the
# ring, so a press that changes the tree leaves that place on another
# element: each press below starts again from ctrl-x tab, after a few
# seconds for the last press's redraw. tests/rulespanekeys.test.tsx pins
# every count, from the pane this fixture's import draws: change the two
# together.
#
# Rules (WP-DE): after the strip, its tab strip (the other tab, one Button:
# place 7); the rows are lists drawn as Clients, no Tab stop, beside the
# picked row's detail. The left column's Buttons come first (the batch's
# [Accept selected], 8), then the detail's: [previous] [next] (9, 10), each
# scope but the picked one (an import's is project: user 11, local 12), the
# editor while it's open, then the row's [Accept] [Edit…] [Dismiss] and its
# [Uncheck] or [Check]. Only the picked row's buttons are drawn, so `j`
# ([next]'s hotkey while the pane holds the keyboard) picks the next row
# first; a click on the row would too.
#
# Step 2: narrow the flag ban to a/** and accept it in project scope.
# KEYS: ctrl-x tab into the pane; j picks live1's flag row ("$G_FLAG"), the second; then its [Edit…] (14 Tabs).
key ctrl-x tab
type j
sleep 3
key esc
sleep 2
key ctrl-x tab
key tab tab tab tab tab tab tab tab tab tab tab tab tab tab enter
sleep 3
key esc
sleep 2
# KEYS: in its Paths field (13 Tabs), type a/** and set it (send a/**); then press [Done], two Tabs on.
key ctrl-x tab
key tab tab tab tab tab tab tab tab tab tab tab tab tab
send a/**
sleep 3
key tab tab enter
sleep 3
key esc
sleep 2
# KEYS: press that row's own [Accept], not the batch's [Accept selected] (which would also accept the preselected user guardrail); pick project if it asks the scope.
# (An import is a project proposal already, so it doesn't ask: the file takes the body, [Confirm accept] and [Cancel] above it.) 13 Tabs.
key ctrl-x tab
key tab tab tab tab tab tab tab tab tab tab tab tab tab enter
sleep 5
key esc
sleep 2
# KEYS: the preview names .litter/rules/P-…md with paths: [a/**]; press [Confirm accept], the first after the tab (8 Tabs).
key ctrl-x tab
key tab tab tab tab tab tab tab tab enter
wait 120 ls $RL/*-rule.accept.json
sleep 3
key esc
sleep 2
# Step 3: dismiss the orchestrator proposal; the others stay pending.
# KEYS: the first row is picked again; j picks the orchestrator row ("$G_ORCH"), then its [Dismiss] (15 Tabs).
key ctrl-x tab
type j
sleep 3
key esc
sleep 2
key ctrl-x tab
key tab tab tab tab tab tab tab tab tab tab tab tab tab tab tab enter
wait 120 ls $RL/*-rule.dismiss.json
key esc
sleep 2
# /litter rules shows the ban in force. The checks read tty.txt from the mark on.
until wc -c <$H_DIR/tty.txt >|$H_DIR/rules-mark
send /litter rules
sleep 10
# KEYS: ctrl-x tab into the pane; press the [✓ In force 1] tab.
# (/litter rules opens on the Proposed tab with no batch: the ring starts with the strip's six, then the other tab: 7 Tabs.)
key ctrl-x tab
key tab tab tab tab tab tab tab enter
sleep 10
key esc
sleep 2
# Step 4: the execute run, through the skill's interview and Launch.
send /litter:execute plan.md
# KEYS: answer the interview's settings question(s), each with its recommended option, then choose Launch.
# The skill puts its recommended option first, where an AskUserQuestion's
# highlight starts, and Enter picks it and moves to the next question; after
# the last of several, Enter on the highlighted Submit answers sends them.
# How many questions it asks varies, so Enter every 5 s until run.start has
# made run.json. Enter on an empty prompt sends nothing, mid-turn too.
press 600 5 enter ls $LD/2*/run.json
# A Launch asked in plain text rather than as a question: type it, unless a question is still waiting.
sendsh ls $LD/2*/run.json >/dev/null 2>&1 || sh $H_HERE/asking.sh $H_DIR/tool-log.jsonl || echo Launch
press 300 5 enter ls $LD/2*/run.json
wait 3600 ls $LD/2*/ledger/*-run.end.json
sleep 60
# KEYS: close the skill's closing question about the next step (esc), if the manual run shows one.
# The skill offers the next step with AskUserQuestion: one esc declines it, so /exit isn't typed into it.
wait 240 sh $H_HERE/asking.sh $H_DIR/tool-log.jsonl
press 6 6 esc ! sh $H_HERE/asking.sh $H_DIR/tool-log.jsonl
exit
EOF
fi

[ "${H_DRY:-}" = 1 ] && { echo "$H_CASE: dry run, files in $H_DIR"; exit 0; }

if [ -z "${H_CHECKS:-}" ]; then
  SETTINGS=$(jq -cn '{pluginConfigs: {litter: {options: {verify: ["sh", "test.sh"], repair: "off"}}}}') || exit 1
  echo "$H_CASE: driving the session in $R"
  (
    cd "$R" || exit 1
    # Auto mode, as swarm.sh: the skill's asks are AskUserQuestion calls, which dontAsk refuses (2.1.288).
    # shellcheck disable=SC2086
    H_PERSIST=1 H_DRIVE_MAX=${H_DRIVE_MAX:-5400} expect "$H_HERE/drive.exp" "$H_DIR/steps.txt" "$H_DIR/tty.txt" \
      claude ${RULES_MODEL:+--model "$RULES_MODEL"} --permission-mode auto --settings "$SETTINGS" \
      --allowedTools ToolSearch Workflow Read Glob Grep Write Edit mcp__litter__record 'Bash(git:*)' 'Bash(sh:*)' 'Bash(cat:*)' 'Bash(ls:*)' \
      --plugin-dir "$H_DIR/litter" --plugin-dir "$H_DIR/toollog" --debug-file "$H_DIR/debug.txt" \
      'Reply with the single word ready, and nothing else.' >|"$H_DIR/drive.txt" 2>&1
  )
  rc=$?
  printf '%s: drive exited %s\n' "$H_CASE" "$rc"
  h_tool_down "$rc"
fi

RUN=$(ls "$LD" 2>/dev/null | grep -E '^[0-9]{8}-' | head -n 1)
RD=$LD/$RUN
rl() { cat "$RL"/*-"$1".json 2>/dev/null; }
# An import proposal's seq, by its text.
proposal_of() { rl rule.propose | jq -s -r --arg t "$1" 'map(select(.body.source == "import" and .body.rule == $t) | .seq) | first // empty'; }
BAN=$(rl rule.accept | jq -s -r 'map(.body.id) | first // empty') || BAN=
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
# The terminal log as text: a cursor-forward move as a space; every other
# escape (CSI, OSC, charset, two-byte) and each carriage return dropped.
screen() {
  e=$(printf '\033')
  b=$(printf '\007')
  # A cursor move right (C) or to a column (G) stands for the space it skips: the engine places words so.
  LC_ALL=C sed -e "s#${e}\[[0-9]*[CG]# #g" -e "s#${e}\[[0-9:;<=>?]*[ -/]*[@-~]##g" -e "s#${e}][^${b}${e}]*${b}##g" \
    -e "s#${e}][^${b}${e}]*${e}[\\\\]##g" -e "s#${e}[()][A-Za-z0-9]##g" -e "s#${e}[^][]##g" ${1:+"$1"} | tr -d '\r'
}

# rules/records.ts's recordRuleImport: one batch, its instances (live1 live, old1 archived), every import
# proposal, and the preselection, live1's user and flag ones only (decision 3).
c_import() {
  n=$(rl rule.import | jq -s 'length') || { echo "a rule.import record doesn't parse"; return 1; }
  [ "$n" = 1 ] || { echo "$n rule.import records, not one"; return 1; }
  i=$(rl rule.import | jq -s -c '.[0].body | {from, instances: [.instances[] | {id, archived}]}') || return 1
  [ "$i" = '{"from":"deepwork","instances":[{"id":"live1","archived":false},{"id":"old1","archived":true}]}' ] || { echo "the batch is $i"; return 1; }
  want=$(rl rule.propose | jq -s -c '[.[] | select(.body.source == "import") | {store: "repo", seq}] | sort_by(.seq)') || { echo "a rule.propose record doesn't parse"; return 1; }
  got=$(rl rule.import | jq -s -c '.[0].body.proposals | map({store, seq}) | sort_by(.seq)') || return 1
  [ "$got" = "$want" ] || { echo "the batch's proposals are $got, the import's rule.propose records $want"; return 1; }
  want=$(rl rule.propose | jq -s -c '[.[] | select(.body.source == "import" and .body.import.instance == "live1" and (.body.import.source == "user" or .body.import.source == "flag")) | {store: "repo", seq}] | sort_by(.seq)') || return 1
  got=$(rl rule.import | jq -s -c '.[0].body.preselected | map({store, seq}) | sort_by(.seq)') || return 1
  [ "$got" = "$want" ] && [ "$want" != '[]' ] || { echo "the preselection is $got, not live1's user and flag proposals $want"; return 1; }
}
# One rule.propose per offered guardrail: five, the orchestrator one once (its incident repeats it), each a project ban with no paths.
c_proposals() {
  got=$(rl rule.propose | jq -s -r '[.[] | select(.body.source == "import") | .body.rule] | sort | .[]') || { echo "a rule.propose record doesn't parse"; return 1; }
  want=$(printf '%s\n' "$G_USER" "$G_FLAG" "$G_ORCH" "$G_SCOPE" "$G_OLD" | LC_ALL=C sort)
  [ "$got" = "$want" ] || { echo "the import proposed [$(printf '%s' "$got" | tr '\n' ';')], not [$(printf '%s' "$want" | tr '\n' ';')]"; return 1; }
  bad=$(rl rule.propose | jq -s -r '.[] | select(.body.source == "import") | select(.body.type != "ban" or .body.scope != "project" or .body.paths != []) | .body.rule') || return 1
  [ -z "$bad" ] || { echo "not a project ban with no paths: $bad"; return 1; }
  a=$(rl rule.propose | jq -s -r '[.[] | select(.body.source == "import" and .body.import.archived == true) | .body.rule] | join(";")') || return 1
  [ "$a" = "$G_OLD" ] || { echo "the archived proposals are '$a', not old1's '$G_OLD'"; return 1; }
  r=$(rl rule.propose | jq -s -r --arg t "$G_ORCH" '[.[] | select(.body.source == "import" and .body.rule == $t) | .body.import.incident_ref // "none"] | join(";")') || return 1
  [ "$r" = inc-orch-1 ] || { echo "the orchestrator proposal's incident_ref is '$r'"; return 1; }
}
# store.ts's acceptRule: the one rule.accept, via ui, of the flag proposal, project scope, version 1, and the
# sha256 of the file it wrote (.litter/rules/<id>.md, format.ts's renderRule: "  paths: [a/**]").
c_accept() {
  n=$(rl rule.accept | jq -s 'length') || { echo "a rule.accept record doesn't parse"; return 1; }
  [ "$n" = 1 ] || { echo "$n rule.accept records, not one"; return 1; }
  a=$(rl rule.accept | jq -s -r '.[0].body | "\(.via) \(.scope) \(.version) \(.proposal.store // "none"):\(.proposal.seq // "none") \(.id)"') || return 1
  want="ui project 1 repo:$(proposal_of "$G_FLAG") "
  case $a in "$want"P-*) ;; *) echo "the accept is '$a', not '${want}P-…'"; return 1 ;; esac
  path=$(rl rule.accept | jq -s -r '.[0].body.path') || return 1
  [ "$(cd -P "${path%/*}" 2>/dev/null && pwd -P)/${path##*/}" = "$(cd -P "$R" && pwd -P)/.litter/rules/$BAN.md" ] || { echo "the accept wrote $path, not .litter/rules/$BAN.md"; return 1; }
  s=$(rl rule.accept | jq -s -r '.[0].body.sha256') || return 1
  [ -f "$path" ] && [ "$(sha "$path")" = "$s" ] || { echo "$path's sha256 isn't the accept's $s"; return 1; }
  for l in '  paths: [a/**]' 'type: ban' 'status: accepted' 'version: 1'; do
    grep -qxF -- "$l" "$path" || { echo "$path has no line '$l'"; return 1; }
  done
}
c_dismiss() {
  d=$(rl rule.dismiss | jq -s -r 'map("\(.body.via) \(.body.proposal.store):\(.body.proposal.seq)") | join(";")') || { echo "a rule.dismiss record doesn't parse"; return 1; }
  [ "$d" = "ui repo:$(proposal_of "$G_ORCH")" ] || { echo "the dismisses are '$d', not one of the orchestrator proposal"; return 1; }
}
# AD's loadRules on the scratch repo (fixtures/rules-load.ts): the ban is the one rule in force in its scopes.
c_load() {
  out=$(cd "$LITTER_ROOT/tests/unit" && bun ../headless/fixtures/rules-load.ts "$R" 2>"$H_DIR/rules-load.err") || { echo "rules-load.ts failed: $(cat "$H_DIR/rules-load.err")"; return 1; }
  got=$(printf '%s\n' "$out" | jq -r '[.rules[] | select(.delivered != null and .scope != "user") | "\(.delivered) \(.standing)"] | join(";")') || { echo "rules-load.ts printed '$out'"; return 1; }
  [ -n "$BAN" ] && [ "$got" = "$BAN@1 accepted" ] || { echo "the rules in force are '$got', not ${BAN:-the ban}@1 alone"; return 1; }
}
# /litter rules answers "… N in force" (rules/pane.tsx), and its In force tab draws the ban's row as
# "<its first line>  ✓ in force  project  ban  <id>@1" (WP-DE: the row's line first, then its columns).
c_rules_pane() {
  [ -f "$H_DIR/rules-mark" ] || { echo "the /litter rules step never ran"; return 1; }
  m=$(tr -dc 0-9 <"$H_DIR/rules-mark")
  s=$(tail -c +"$((${m:-0} + 1))" "$H_DIR/tty.txt" | screen)
  # paneview.ts counts user-scope rules too: one of yours under your config dir makes this 2.
  printf '%s\n' "$s" | grep -Eq '(^|[^0-9])1 in force' || { echo "/litter rules didn't answer '1 in force'"; return 1; }
  printf '%s\n' "$s" | LC_ALL=C grep -Eq "in force .*$BAN@1" || { echo "the In force tab never showed ${BAN:-the ban}@1 in force (its KEYS step)"; return 1; }
}
# The batch's headings, and the picked import's description: a ban with no paths reaches every gate.
c_pane_batch() {
  s=$(screen "$H_DIR/tty.txt")
  for w in 'Import from deepwork' live1 old1 'no paths: it reaches every gate'; do
    case $s in *"$w"*) ;; *) echo "the pane never showed '$w'"; return 1 ;; esac
  done
}
c_run() { [ -n "$RUN" ] && [ -f "$RD/run.json" ] || { echo "no run in $LD"; return 1; }; }
# lifecycle.ts's prepare: args.gates[].rules each gate's own (select.ts), args.rules the shared ones, a ban among them
# whatever its paths, its entry "<id>@1 (ban; protects a/**) …"; run.json.rules the versions delivered. A U- rule
# would be one of yours from your config dir, not this test's.
c_selection() {
  [ -n "$BAN" ] || { echo "no rule was accepted"; return 1; }
  s=$(jq -r --arg b "$BAN" '[([.args.gates[] | select(.id == "G1") | (.rules // [])[] | select(contains($b))] | length),
    ([.args.gates[] | select(.id == "G2") | (.rules // [])[] | select(contains($b))] | length), ([(.args.rules // [])[] | select(contains($b))] | length),
    ([(.args.rules // [])[] | select(startswith($b + "@1 (ban; protects a/**)"))] | length)]
    | map(tostring) | join(" ")' "$RD/run.json") ||
    { echo "run.json doesn't parse"; return 1; }
  [ "$s" = '0 0 1 1' ] ||
    { echo "the ban's entries in G1's rules, G2's, args.rules and args.rules naming a/** as protected number '$s', not '0 0 1 1'"; return 1; }
  r=$(jq -c '[.rules[] | select(.id | startswith("U-") | not) | {id, version}]' "$RD/run.json") || { echo "run.json doesn't parse"; return 1; }
  [ "$r" = "[{\"id\":\"$BAN\",\"version\":1}]" ] || { echo "run.json's rules are $r"; return 1; }
}
# Each workflow agent's prompt, one JSON line { file, prompt }: its transcript's user text before its
# first reply, under <config dir>/projects/*/<session>/subagents/workflows/ (H_PERSIST=1 keeps them).
prompts() {
  sid=$(jq -r '.session // empty' "$RD/run.json") || { echo "run.json doesn't parse"; return 1; }
  [ -n "$sid" ] || { echo "run.json names no session"; return 1; }
  : >|"$H_DIR/transcripts.txt"
  for d in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$sid"/subagents/workflows; do
    [ -d "$d" ] && find "$d" -name '*.jsonl' >>"$H_DIR/transcripts.txt"
  done
  [ -s "$H_DIR/transcripts.txt" ] || { echo "no workflow transcripts for session $sid (H_PERSIST=1 keeps them)"; return 1; }
  : >|"$H_DIR/prompts.jsonl"
  while IFS= read -r f; do
    jq -sc --arg f "$f" '{file: $f, prompt: (reduce .[] as $r ({done: false, t: ""}; if .done then . elif $r.type == "assistant" then .done = true
      elif $r.type == "user" then .t += ($r.message.content | if type == "string" then . elif type == "array" then map(.text // "") | join("") else "" end) else . end) | .t)}' "$f" \
      >>"$H_DIR/prompts.jsonl" || { echo "$f doesn't parse"; return 1; }
  done <"$H_DIR/transcripts.txt"
}
# execute.js's prompts: the instruction names the gate ("Implement gate G1, attempt …", "Judge the uncommitted change for gate G1, …"),
# and common() puts args.rules, then the gate's own, in <rules id="<nonce>"> … </rules id="<nonce>">. No G2 prompt means G2 never ran.
c_prompts() {
  [ -n "$BAN" ] || { echo "no rule was accepted"; return 1; }
  prompts || return 1
  nonce=$(jq -r '.args.nonce // empty' "$RD/run.json") || { echo "run.json doesn't parse"; return 1; }
  [ -n "$nonce" ] || { echo "run.json's args have no nonce"; return 1; }
  for who in 'Implement gate G1, attempt' 'Judge the uncommitted change for gate G1, attempt' 'Implement gate G2, attempt' 'Judge the uncommitted change for gate G2, attempt'; do
    r=$(jq -s -r --arg w "$who" --arg o "<rules id=\"$nonce\">" --arg c "</rules id=\"$nonce\">" --arg b "$BAN@1" '[.[] | select(.prompt | contains($w))] as $p
      | if ($p | length) == 0 then "none" else [$p[] | select(.prompt | (split($o)[1] // "") | split($c)[0] | contains($b) | not)] | length | tostring end' "$H_DIR/prompts.jsonl") ||
      { echo "prompts.jsonl doesn't parse"; return 1; }
    [ "$r" != none ] || { echo "no prompt says '$who'"; return 1; }
    [ "$r" = 0 ] || { echo "$r prompt(s) saying '$who' have no $BAN@1 in their <rules> block"; return 1; }
  done
  for t in "$G_USER" "$G_ORCH" "$G_SCOPE" "$G_OLD"; do
    n=$(jq -s --arg t "$t" '[.[] | select(.prompt | contains($t))] | length' "$H_DIR/prompts.jsonl") || { echo "prompts.jsonl doesn't parse"; return 1; }
    [ "$n" = 0 ] || { echo "$n prompt(s) hold '$t', which wasn't accepted"; return 1; }
  done
}
# verdicts.ts's renderVerdict: the latest G1 verdict's "## rules: …" section cites the ban and its version.
c_verdict() {
  [ -n "$BAN" ] || { echo "no rule was accepted"; return 1; }
  f=
  n=0
  for x in "$RD"/verdicts/G1-*.md; do
    [ -f "$x" ] || continue
    k=${x##*-}
    k=${k%.md}
    [ "$k" -gt "$n" ] && { n=$k; f=$x; }
  done
  [ -n "$f" ] || { echo "no verdicts/G1-<n>.md"; return 1; }
  part=$(awk '/^## rules:/ { on = 1; print; next } /^## / { on = 0 } on' "$f")
  case $part in *"$BAN@1"* | *"$BAN version 1"* | *"$BAN (version 1)"* | *"$BAN v1"*) ;; *) echo "${f##*/}'s rules dimension doesn't cite $BAN@1: $(printf '%s' "$part" | tr '\n' ' ' | cut -c1-300)"; return 1 ;; esac
}
c_lock_free() {
  git -C "$R" rev-parse -q --verify refs/litter-active >/dev/null && { echo "refs/litter-active is still held"; return 1; }
  [ ! -f "$LD/hooks/policy.json" ] && return 0
  r=$(jq -r '.run // "none"' "$LD/hooks/policy.json") || { echo "policy.json doesn't parse"; return 1; }
  [ "$r" = none ] || { echo "policy.json still has run $r"; return 1; }
}

h_expect "the import recorded one batch: live1 live, old1 archived, live1's user and flag preselected" c_import
h_expect "one rule.propose per offered guardrail, each a project ban with no paths" c_proposals
h_expect "the pane opened on the batch, its picked entry a ban with no paths" c_pane_batch
h_expect "one rule.accept, via ui, of the flag ban in project scope, its sha256 the file's, paths [a/**]" c_accept
h_expect "one rule.dismiss, of the orchestrator proposal" c_dismiss
h_expect "loadRules shows the ban as the one accepted rule" c_load
h_expect "/litter rules shows the ban in force as accepted" c_rules_pane
h_expect "run.start and the launch made a run" c_run
h_expect "args.rules holds the ban, naming a/** as what it protects, no gate's own rules do, and run.json's rules are the ban@1" c_selection
h_expect "the ban is in G1's and G2's executor and critic <rules> blocks, and no unaccepted guardrail is in any prompt" c_prompts
h_expect "G1's verdict cites the ban and its version in its rules dimension" c_verdict
h_expect "the lock is released" c_lock_free
h_done
