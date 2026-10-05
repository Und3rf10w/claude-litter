# Tier 3: tests/headless/design-compare.sh, phase 4's tier-4 table, on fake
# sides: each trap's checks, the file lists and fenced code it reads from a
# plan, hand judgments, litter's delivery check, and the verdict's exit code.

. "$(dirname "$0")/testlib.sh"

DC=$LITTER_ROOT/tests/headless/design-compare.sh

# side <name> <meta json>: the side's folder with its meta, and its plan from stdin.
side() {
  mkdir -p "$T_DIR/case/$1/texts" || fail mkdir
  printf '%s\n' "$2" >|"$T_DIR/case/$1/texts/meta.json"
  cat >|"$T_DIR/case/$1/texts/plan.md"
}
# ask <name> <question>: an AskUserQuestion in the side's tool log.
ask() {
  jq -nc --arg q "$2" '{ev: "PreToolUse", tool: "AskUserQuestion", input: {questions: [{question: $q, header: "Sign", options: [{label: "Before"}, {label: "After"}]}]}}' \
    >>"$T_DIR/case/$1/tool-log.jsonl"
}
# bash <name> <command>: a Bash call in the side's tool log.
bash_ran() {
  jq -nc --arg c "$2" '{ev: "PreToolUse", tool: "Bash", input: {command: $c}}' >>"$T_DIR/case/$1/tool-log.jsonl"
}
ran() { printf '{"ran": true, "name": "%s", "ended": "delivered", "delivered": true, "approved": true, "same_bytes": %s, "versions": 2, "rounds": 2}' "$1" "${2:-true}"; }
dw() { printf '{"ran": true, "name": "deepwork", "ended": "halt", "delivered": true, "approved": null, "same_bytes": null, "versions": 3, "rounds": 3}'; }

# The plan that gets every trap right: it reuses cur_sym, keeps out of
# vendor/, settles dash's padding live, writes POSIX sh, changes the report
# alone, and leaves the sign's side to the user.
right_plan() {
  cat <<'EOF'
# Plan: the report in euros

vendor/tabular.sh's col_money hardcodes the dollar sign. lib/locale.sh:5 already has `cur_sym`, the sign for each ISO 4217 code, so the report reuses it.

## G1. The report takes a code

Files: lib/report.sh, report.sh, tests/test_report.sh

```sh
sign=$(cur_sym "${TALLY_CUR:-USD}")
printf '%s%s\n' "$(col_left 20 "$item")" "$(pad 12 "$sign$(amount_fmt "$cents")")"
```

A probe ran printf under dash: dash pads by bytes, not characters, so pad counts characters itself.

## User decisions

- The sign before or after the amount (€12.34 or 12.34 €): your call.
EOF
}
# The plan that gets them wrong: no table, vendor/ in its files, bash-only code, no probe.
wrong_plan() {
  cat <<'EOF'
# Plan

There is no currency table yet, so add one.

**Files:**
- `vendor/tabular.sh`
- `lib/amount.sh`

```bash
if [[ -n $cur ]]; then echo "${cur,,}"; fi
```
EOF
}

# dc: runs it under the shell being tested; out, err, code in $T_DIR.
dc() {
  # shellcheck disable=SC2086
  ${SHELL_UNDER_TEST:-sh} "$DC" "$T_DIR/case" >|"$T_DIR/out" 2>|"$T_DIR/err"
  printf '%s\n' "$?" >|"$T_DIR/code"
}
row() { grep "^$1 *$2 " "$T_DIR/out" || fail "no row $1 $2: $(cat "$T_DIR/out")"; }

case_pass() {
  right_plan | side litter "$(ran litter)"
  bash_ran litter "dash -c 'printf \"[%5s]\" €'"
  wrong_plan | side deepwork "$(dw)"
  printf 'deepwork D5 wrong: it changes lib/amount.sh too\ndeepwork D6 wrong: it never raises the sign\n' >|"$T_DIR/case/hand.txt"
  dc
  assert_code 0
  for d in D1 D2 D3 D4 D5 D6; do assert_contains "yes: a group holds" "$(row "$d" litter)"; done
  for d in D1 D2 D3 D4; do assert_contains "no: no group holds" "$(row "$d" deepwork)"; done
  assert_contains "no: (hand) it changes lib/amount.sh too" "$(row D5 deepwork)"
  assert_stdout_contains "right outcomes: litter 6, deepwork 0"
  assert_stdout_contains "  litter:   lib/report.sh, report.sh, tests/test_report.sh"
  assert_stdout_contains "  deepwork: lib/amount.sh, vendor/tabular.sh"
  assert_stdout_contains "litter's delivery: delivered after an approving verdict"
  assert_stdout_contains "PASS:"
  [ ! -s "$T_DIR/err" ] || fail "stderr: $(cat "$T_DIR/err")"
}

case_worse_on_a_machine_check() {
  right_plan | sed 's#^Files: lib/report.sh#Files: vendor/tabular.sh, lib/report.sh#' | side litter "$(ran litter)"
  bash_ran litter "dash -c 'printf \"[%5s]\" €'"
  right_plan | side deepwork "$(dw)"
  bash_ran deepwork "dash x.sh"
  printf 'litter D5 wrong: vendor/ too\n' >|"$T_DIR/case/hand.txt"
  dc
  assert_code 1
  assert_contains "no: no group holds" "$(row D2 litter)"
  assert_stdout_contains "FAIL: litter's right outcomes are 4, deepwork's 6; D2: litter's plan gets it wrong on a machine check, and deepwork's is right"
}

case_unapproved_delivery_fails() {
  right_plan | side litter '{"ran": true, "delivered": true, "approved": false, "same_bytes": true}'
  bash_ran litter "dash -c true"
  wrong_plan | side deepwork "$(dw)"
  printf 'deepwork D5 wrong: x\ndeepwork D6 wrong: x\n' >|"$T_DIR/case/hand.txt"
  dc
  assert_code 1
  assert_stdout_contains "FAIL: litter delivered without an approving verdict"
  right_plan | side litter "$(ran litter false)"
  dc
  assert_code 1
  assert_stdout_contains "FAIL: litter the plan file it wrote is not the proposal's bytes (false)"
}

# No file list at all: D2 and D5 can't be judged by a check, until hand.txt says.
case_no_file_list_is_undecided() {
  right_plan | grep -v '^Files:' | side litter "$(ran litter)"
  bash_ran litter "dash -c true"
  wrong_plan | side deepwork "$(dw)"
  printf 'deepwork D5 wrong: x\ndeepwork D6 wrong: x\n' >|"$T_DIR/case/hand.txt"
  dc
  assert_code 3
  assert_stdout_contains "UNDECIDED: litter D2, litter D5 need a hand judgment"
  printf 'litter D2 right: no file named\nlitter D5 right: report only\n' >>"$T_DIR/case/hand.txt"
  dc
  assert_code 0
  assert_contains "yes: (hand) no file named" "$(row D2 litter)"
}

case_a_side_that_never_ran() {
  right_plan | side litter "$(ran litter)"
  mkdir -p "$T_DIR/case/deepwork" || fail mkdir
  dc
  assert_code 3
  assert_stdout_contains "INCOMPLETE: deepwork never ran"
}

# files.txt over the plan's lines; bold Files with bullets; fenced Files lines and e.g. left out.
case_file_lists() {
  cat <<'EOF' | side litter "$(ran litter)"
**Files touched:** `README.md`, e.g. the usage line

**Files:**
- `lib/report.sh` (changed)
- tests/test_report.sh

```text
Files: vendor/tabular.sh
```
EOF
  wrong_plan | side deepwork "$(dw)"
  printf 'vendor/tabular.sh\n' >|"$T_DIR/case/deepwork/texts/files.txt"
  dc
  assert_stdout_contains "  litter:   README.md, lib/report.sh, tests/test_report.sh"
  assert_stdout_contains "  deepwork: vendor/tabular.sh"
}

# path:line citations against the fixture; bash-only code in a json block doesn't count; asks and tools.
case_citations_code_asks_tools() {
  cat <<'EOF' | side litter "$(ran litter)"
See lib/locale.sh:5 and lib/locale.sh:99 and nope.sh:1.

```json
{"x": "[[ a ]]"}
```
EOF
  ask litter "Should the sign go before or after the amount?"
  wrong_plan | side deepwork "$(dw)"
  dc
  assert_stdout_contains "path:line citations valid against the fixture (reported, not scored): litter 1/3, deepwork 0/0"
  assert_contains "yes: a group holds" "$(row D4 litter)"
  assert_contains "yes: a group holds" "$(row D6 litter)"
  assert_stdout_contains "  litter:   Should the sign go before or after the amount? Sign Before After"
  # D3's first group needs a dash run in the tools as well as the plan's dash and bytes.
  printf 'dash pads by bytes.\n' >>"$T_DIR/case/litter/texts/plan.md"
  dc
  assert_contains "no: no group holds" "$(row D3 litter)"
  bash_ran litter "printf x | dash -s"
  dc
  assert_contains "yes: a group holds" "$(row D3 litter)"
}

t "a right plan beside a wrong one passes, with hand judgments for the hand traps" case_pass
t "a trap litter gets wrong on a check and deepwork right fails it" case_worse_on_a_machine_check
t "litter delivering without approval, or other bytes than the proposal's, fails" case_unapproved_delivery_fails
t "a plan with no file list leaves D2 and D5 to a hand judgment" case_no_file_list_is_undecided
t "a side that never ran is incomplete" case_a_side_that_never_ran
t "the file lists: Files lines, bullets under one, files.txt; not fenced or e.g." case_file_lists
t "citations, code blocks, asks and tools" case_citations_code_asks_tools
done_testing
