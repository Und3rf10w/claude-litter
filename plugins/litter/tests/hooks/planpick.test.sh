# Tier 3: tests/headless/planpick.sh, the tier-4 steps' answer to a
# plan-mode dialog, on a fake screen and tool log: which option it picks,
# once, the round after the dialog shows. Nothing goes to stderr, which
# drive.exp reads as a failure.

. "$(dirname "$0")/testlib.sh"

PP=$LITTER_ROOT/tests/headless/planpick.sh

# ev <tool> <event>: a tool-log line.
ev() { printf '{"ev":"%s","tool":"%s","agent_id":null}\n' "$2" "$1" >>"$T_DIR/log"; }
# The approval dialog as drawn, under a plan whose own numbered list comes first.
dialog() {
  esc=$(printf '\033')
  {
    printf '%s[2J Here is the plan:\r\n 1. Problem\r\n 2. Design\r\n' "$esc"
    printf ' Would you like to proceed?\r\n'
    printf ' %s[1m❯ 1. Yes, clear context (31%% used) and use auto mode%s[0m\r\n' "$esc" "$esc"
    printf '   2. Yes, and use auto mode\r\n'
    printf '   3. Yes, and auto-accept edits\r\n'
    printf '   4. Yes, manually approve edits\r\n'
    printf '   5. No, keep planning\r\n'
  } >>"$T_DIR/tty"
}
# pp <regex> [<never>]: runs it under the shell being tested; out, err, code in $T_DIR.
pp() {
  # shellcheck disable=SC2086
  ${SHELL_UNDER_TEST:-sh} "$PP" "$T_DIR/tty" "$T_DIR/log" "$T_DIR/mark" "$@" >|"$T_DIR/out" 2>|"$T_DIR/err"
  printf '%s\n' "$?" >|"$T_DIR/code"
  [ ! -s "$T_DIR/err" ] || fail "stderr: $(cat "$T_DIR/err")"
}

case_once_the_round_after() {
  : >|"$T_DIR/tty"
  ev Read PreToolUse
  pp '^yes'
  assert_code 0
  assert_stdout_empty
  ev ExitPlanMode PreToolUse
  dialog
  pp '^yes'
  assert_code 0
  assert_stdout_empty
  # The second round answers: the first Yes that doesn't clear the context or accept edits.
  pp '^yes'
  assert_code 0
  assert_eq 'down enter' "$(cat "$T_DIR/out")" keys
  pp '^yes'
  assert_stdout_empty
  # Answered: a PostToolUse, then a second call, a new dialog.
  ev ExitPlanMode PostToolUse
  pp '^yes'
  assert_stdout_empty
  ev ExitPlanMode PreToolUse
  pp '^yes'
  assert_stdout_empty
  pp 'manually'
  assert_eq 'down down down enter' "$(cat "$T_DIR/out")" keys
}

case_nothing_fits() {
  : >|"$T_DIR/tty"
  ev ExitPlanMode PreToolUse
  dialog
  pp '^no, refine'
  pp '^no, refine'
  assert_code 1
  assert_stdout_empty
  # never can be narrowed: the first option itself.
  pp '^yes' 'auto-accept'
  assert_code 0
  assert_eq 'enter' "$(cat "$T_DIR/out")" keys
}

case_no_log() {
  : >|"$T_DIR/tty"
  pp '^yes'
  assert_code 0
  assert_stdout_empty
}

# As 2.1.289 draws it (design.sh basic, 2026-10-04): no newlines, each row
# reached with a cursor move and the words spaced with cursor moves too.
case_rows_by_cursor() {
  esc=$(printf '\033')
  : >|"$T_DIR/tty"
  ev ExitPlanMode PreToolUse
  printf '%s[2J%s[3;1H1.%s[1CPlan%s[4;1HWould%s[1Cyou%s[1Clike%s[1Cto%s[1Cproceed?' "$esc" "$esc" "$esc" "$esc" "$esc" "$esc" "$esc" "$esc" >>"$T_DIR/tty"
  printf '%s[6;3H%s[1m❯%s[1C1.%s[1CYes,%s[1Cand%s[1Cuse%s[1Cauto%s[1Cmode%s[0m' "$esc" "$esc" "$esc" "$esc" "$esc" "$esc" "$esc" "$esc" "$esc" >>"$T_DIR/tty"
  printf '%s[1B%s[5G2.%s[1CYes,%s[1Cmanually%s[1Capprove%s[1Cedits' "$esc" "$esc" "$esc" "$esc" "$esc" "$esc" >>"$T_DIR/tty"
  printf '%s[1B%s[5G3.%s[1CTell%s[1CClaude%s[1Cwhat%s[1Cto%s[1Cchange' "$esc" "$esc" "$esc" "$esc" "$esc" "$esc" "$esc" >>"$T_DIR/tty"
  pp '^yes'
  pp 'manually'
  assert_code 0
  assert_eq 'down enter' "$(cat "$T_DIR/out")" keys
  ev ExitPlanMode PostToolUse
  ev ExitPlanMode PreToolUse
  pp '^yes'
  pp '^yes'
  assert_eq 'enter' "$(cat "$T_DIR/out")" keys
}

t "it answers a waiting dialog once, the round after it shows, with the first fitting option" case_once_the_round_after
t "no fitting option exits 1; never can be set" case_nothing_fits
t "no tool log: nothing waits" case_no_log
t "a dialog drawn with cursor moves, not newlines, is read row by row" case_rows_by_cursor
done_testing
