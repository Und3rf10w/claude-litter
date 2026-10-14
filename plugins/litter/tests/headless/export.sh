#!/bin/sh
# Tier 4: phase 6's rule export (plan 16.7), live:
#
#   sh tests/headless/export.sh
#
# The repo is lib.sh's, plus two project rules committed at HEAD, so they're
# in force with no acceptance in this checkout's ledger ("accepted
# (committed)"): P-codeword with no paths, and P-notes-marker with paths
# notes/**. Session 1 loads litter. Its session.start sync writes both as
# Claude Code rule files under .claude/rules/litter/ (litter's copies, each
# with a rule.export record), left untracked for you to commit. Sessions 2-4
# load no litter and start no run:
# - 2 follows P-codeword from its start;
# - 3 follows P-notes-marker after it Reads notes/todo.txt;
# - 4 Reads only README, and so never gets P-notes-marker.
#
# Needs a signed-in claude and jq. EXPORT_MODEL sets the sessions' model (--model).

set -u
. "$(dirname "$0")/lib.sh"

h_scratch "export-$(date +%Y%m%d-%H%M%S)"
R=$H_REPO
LD=$R/.claude/litter
OUT=$R/.claude/rules/litter
mkdir -p "$R/.litter/rules" "$R/notes"
cat >|"$R/.litter/rules/P-codeword.md" <<'EOF'
---
id: P-codeword
version: 1
status: accepted
type: rule
applies:
  paths: []
  when: someone asks for this project's codeword
export: true
---

## Rule
Answer with exactly the words periwinkle-42 when anyone asks for this project's codeword.

## Why
The release checklist greps for it.
EOF
cat >|"$R/.litter/rules/P-notes-marker.md" <<'EOF'
---
id: P-notes-marker
version: 1
status: accepted
type: rule
applies:
  paths: [notes/**]
  when: you have read a file under notes/
export: true
---

## Rule
End your reply with the word MARIGOLD-7 on a line of its own.

## Why
The release checklist greps for it.
EOF
printf 'Buy milk. Fix the gate.\n' >|"$R/notes/todo.txt"
h_git -C "$R" add -A
h_git -C "$R" commit -q -m 'two project rules, and notes' || exit 1

model() { if [ -n "${EXPORT_MODEL:-}" ]; then printf '%s\n' --model "$EXPORT_MODEL"; fi; }
# The session's result message: --output-format json answers one object, or (2.1.299) every message in an array.
RESULT='if type == "array" then (map(select(.type == "result")) | .[-1]) else . end'

# Session 1: litter loads, and its session.start sync exports the rules in force.
# shellcheck disable=SC2046
h_claude 'Reply with the single word ready.' $(model)
h_expect 'session 1 ran' jq -e "$RESULT | .is_error == false" "$H_DIR/out.json"
h_expect "P-codeword's rule file is litter's copy, with no paths" sh -c "head -1 '$OUT/P-codeword.md' | grep -qx '## Rule' && grep -q 'Managed by litter (P-codeword v1)\\.' '$OUT/P-codeword.md'"
h_expect "P-notes-marker's has paths: frontmatter" sh -c "[ \"\$(head -3 '$OUT/P-notes-marker.md')\" = \"\$(printf -- '---\\npaths:\\n  - \"notes/**\"')\" ]"
h_expect 'each write is a rule.export record by the mod, with its sha256' sh -c \
  "cat '$LD'/rules-ledger/ledger/*.json | jq -s -e '[.[] | select(.kind == \"rule.export\" and .by.source == \"mod\" and (.body.sha256 | type) == \"string\") | .body.id] | sort == [\"P-codeword\", \"P-notes-marker\"]'"
h_expect 'the exports are left for you to commit' sh -c "h=\$(git -C '$R' status --porcelain -- .claude/rules); [ \"\$h\" = '?? .claude/rules/' ]"

# Sessions 2-4: no litter, no run; Claude Code loads the rule files itself.
ask() {
  (cd "$R" && claude -p "$1" --allowedTools Read --output-format json --max-turns 5 $(model) </dev/null) | jq -r "$RESULT | .result // empty"
}
A2=$(ask "What is this project's codeword? Answer in one line.")
h_expect 'session 2 follows the rule with no paths from its start' sh -c "printf '%s' \"\$1\" | grep -q 'periwinkle-42'" _ "$A2"
A3=$(ask 'Read notes/todo.txt with the Read tool and summarize it in one sentence.')
h_expect 'session 3 follows the paths: rule once it has Read a matching file' sh -c "printf '%s' \"\$1\" | grep -q 'MARIGOLD-7'" _ "$A3"
A4=$(ask 'Read README with the Read tool and summarize it in one sentence.')
h_expect "session 4, which Read no file under notes/, doesn't get it" sh -c "[ -n \"\$1\" ] && ! printf '%s' \"\$1\" | grep -q 'MARIGOLD-7'" _ "$A4"
printf 'session 2: %s\nsession 3: %s\nsession 4: %s\n' "$A2" "$A3" "$A4" >|"$H_DIR/answers.txt"
h_done
