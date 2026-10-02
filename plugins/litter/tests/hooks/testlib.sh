# Tier 3: helpers for the hook-script tests. POSIX sh only (BusyBox, dash,
# macOS sh): no bash-isms, no GNU-only flags. Each *.test.sh sources this,
# declares cases with `t`, and ends with `done_testing`.
#
#   t "a litter agent's git push is denied" case_push_denied
#
# A case runs in a subshell inside a fresh scratch folder ($T_DIR), so it can
# cd, export and fail freely. A case fails when it exits non-zero; the
# assertions below exit non-zero with a message.

LITTER_ROOT=${LITTER_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}
T_PASS=0
T_FAIL=0
T_ONLY=${T_ONLY:-}

t() {
  t_name=$1
  shift
  case $t_name in *"$T_ONLY"*) ;; *) return 0 ;; esac
  T_DIR=$(mktemp -d "${TMPDIR:-/tmp}/litter-hooks.XXXXXX") || exit 1
  if (cd "$T_DIR" && set -u && "$@") >|"$T_DIR.log" 2>&1; then
    T_PASS=$((T_PASS + 1))
    printf 'ok   %s\n' "$t_name"
  else
    T_FAIL=$((T_FAIL + 1))
    printf 'FAIL %s\n' "$t_name"
    sed 's/^/     /' "$T_DIR.log"
  fi
  rm -rf "$T_DIR" "$T_DIR.log"
}

done_testing() {
  printf '%s: %d passed, %d failed\n' "$(basename "$0")" "$T_PASS" "$T_FAIL"
  [ "$T_FAIL" -eq 0 ]
}

fail() {
  printf 'assertion failed: %s\n' "$*" >&2
  exit 1
}

# A scratch project: $T_DIR/project with .claude/litter/hooks/ ready, exported
# as CLAUDE_PROJECT_DIR. Prints the hooks folder.
project() {
  mkdir -p "$T_DIR/project/.claude/litter/hooks" || exit 1
  CLAUDE_PROJECT_DIR=$T_DIR/project
  export CLAUDE_PROJECT_DIR
  printf '%s\n' "$T_DIR/project/.claude/litter/hooks"
}

# run_hook <script> [args...] < input
# Runs hooks/<script> as the engine does (exec form), under the shell being
# tested, with CLAUDE_PLUGIN_ROOT set. Leaves stdout, stderr and the exit code
# in $T_DIR/out, err and code.
run_hook() {
  rh_script=$1
  shift
  # A word list on purpose ("busybox sh").
  # shellcheck disable=SC2086
  CLAUDE_PLUGIN_ROOT=$LITTER_ROOT ${SHELL_UNDER_TEST:-sh} "$LITTER_ROOT/hooks/$rh_script" "$@" >|"$T_DIR/out" 2>|"$T_DIR/err"
  printf '%s\n' "$?" >|"$T_DIR/code"
}

# A PATH without jq: a folder of links to every tool on PATH but jq.
path_without_jq() {
  pw_dir=$T_DIR/nojq-bin
  mkdir -p "$pw_dir"
  pw_old_ifs=$IFS
  IFS=:
  for pw_p in $PATH; do
    [ -d "$pw_p" ] || continue
    for pw_f in "$pw_p"/*; do
      pw_n=${pw_f##*/}
      [ "$pw_n" = jq ] && continue
      [ -e "$pw_dir/$pw_n" ] || ln -s "$pw_f" "$pw_dir/$pw_n" 2>/dev/null
    done
  done
  IFS=$pw_old_ifs
  printf '%s\n' "$pw_dir"
}

assert_code() {
  ac_got=$(cat "$T_DIR/code")
  [ "$ac_got" = "$1" ] || fail "exit $ac_got, expected $1; stderr: $(cat "$T_DIR/err")"
}

assert_eq() {
  [ "$1" = "$2" ] || fail "${3:-values differ}: got '$2', expected '$1'"
}

assert_contains() {
  case $2 in *"$1"*) ;; *) fail "${3:-text} doesn't contain '$1': $2" ;; esac
}

assert_not_contains() {
  case $2 in *"$1"*) fail "${3:-text} contains '$1': $2" ;; *) ;; esac
}

assert_stdout_empty() {
  [ ! -s "$T_DIR/out" ] || fail "stdout not empty: $(cat "$T_DIR/out")"
}

assert_stdout_contains() { assert_contains "$1" "$(cat "$T_DIR/out")" stdout; }
assert_stderr_contains() { assert_contains "$1" "$(cat "$T_DIR/err")" stderr; }

assert_file() { [ -f "$1" ] || fail "no file $1"; }
assert_no_file() { [ ! -e "$1" ] || fail "$1 exists"; }
