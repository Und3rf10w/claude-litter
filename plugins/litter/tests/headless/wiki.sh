#!/bin/sh
# Tier 4: phase 6's wiki (plan section 10), live:
#
#   sh tests/headless/wiki.sh
#
# The repo is lib.sh's. Its litter directory holds three runs and a swarm
# launch, each with a codeword in its outcome:
# - 20261001-parser, an execute run with a summary.md;
# - 20261005-docs, a design run with a summary.md;
# - 20261006-flaky, a fanout run with no summary.md, only its ledger-export/
#   parts, which the wiki reads in its place;
# - swarm alpha's launch 20261007-120000, with its summary.md.
# One headless /litter:wiki session rebuilds WIKI.md through wiki.write. The
# checks want all four codewords in it, the runs linked by their paths, and
# the file written by the mod, never by the model's Write, Edit or Bash.
#
# Needs a signed-in claude and jq. WIKI_MODEL sets the session's model (--model).

set -u
. "$(dirname "$0")/lib.sh"

h_scratch "wiki-$(date +%Y%m%d-%H%M%S)"
R=$H_REPO
LD=$R/.claude/litter

# mkrun <run> <workflow> <goal>: a run folder with its run.json.
mkrun() {
  mkdir -p "$LD/$1" || exit 1
  jq -n --arg run "$1" --arg wf "$2" --arg goal "$3" '{ v: 1, run: $run, workflow: $wf, args: { goal: $goal }, ref: ("litter/" + $run), rules: [] }' >|"$LD/$1/run.json"
}
mkrun 20261001-parser execute 'Rewrite the parser'
printf '# Run 20261001-parser\n\nLanded G1 (the tokenizer) and G2 (the parser). Decision: keep the hand-written parser, not a generated one. Codeword QUOKKA-PARSER.\n' >|"$LD/20261001-parser/summary.md"
mkrun 20261005-docs design 'Choose how to build the docs site'
printf '# Run 20261005-docs\n\nThe design chose a static site generator for the docs. Codeword QUOKKA-DOCS.\n' >|"$LD/20261005-docs/summary.md"
mkrun 20261006-flaky fanout 'Find the flaky tests'
mkdir -p "$LD/20261006-flaky/ledger-export"
{
  jq -nc '{ v: 1, seq: 1, kind: "run.start", run: "20261006-flaky", at: 1, body: { goal: "Find the flaky tests" } }'
  jq -nc '{ v: 1, seq: 2, kind: "task.result", run: "20261006-flaky", at: 2, body: { task: "t1", summary: "Found 3 flaky tests in the retry suite. Codeword QUOKKA-FLAKY." } }'
} >|"$LD/20261006-flaky/ledger-export/0001.jsonl"
mkdir -p "$LD/swarms/alpha/launches/20261007-120000"
printf '# Swarm alpha, launch 20261007-120000\n\nGoal: tidy the docs. Nodes: lead, fixer. It ended with the docs tidied. Codeword QUOKKA-SWARM.\n' >|"$LD/swarms/alpha/launches/20261007-120000/summary.md"

h_claude '/litter:wiki' ${WIKI_MODEL:+--model "$WIKI_MODEL"} --allowedTools mcp__litter__record Read Glob Grep
W=$LD/WIKI.md
h_expect 'WIKI.md is written' test -s "$W"
for word in QUOKKA-PARSER QUOKKA-DOCS QUOKKA-FLAKY QUOKKA-SWARM; do
  h_expect "it holds $word" grep -q "$word" "$W"
done
h_expect 'it links each run by its path, as [label](path)' sh -c "for r in 20261001-parser 20261005-docs 20261006-flaky; do grep -Eq '\\]\\([^)]*'\$r'[^)]*\\)' '$W' || { echo \"no link to \$r\"; exit 1; }; done"
# The mod answers its own tool's calls, so no command hook logs them (2.1.299): the debug file names them.
h_expect 'written through the mod: its record calls, and no Write, Edit or Bash on WIKI.md' sh -c \
  "[ \"\$(grep -c 'tool.call mcp__litter__record .*resolved by a hooks module' '$H_DIR/debug.txt')\" -ge 2 ] && [ \"\$(jq -s '[.[] | select(.ev == \"PreToolUse\" and (.tool == \"Write\" or .tool == \"Edit\" or .tool == \"Bash\") and (.input | tostring | test(\"WIKI\")))] | length' '$H_DIR/tool-log.jsonl')\" = 0 ]"
h_done
