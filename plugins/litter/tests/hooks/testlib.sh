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
T_SKIP=0
T_ONLY=${T_ONLY:-}
# The real date, found before any case puts one of its own on PATH (t_clock):
# as `command -v` answers (run_hook compares that), and as a path, since a
# shell whose date is a builtin answers with the bare name.
T_DATE_FOUND=$(command -v date)
T_DATE=$T_DATE_FOUND
case $T_DATE in /*) ;; *) T_DATE=/bin/date ;; esac

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

# t_fake_sleep: t, for a case that puts a fake sleep first on PATH. A shell
# under test that runs sleep as a builtin (Ubuntu's BusyBox ash does) never
# runs the fake, so there the case is skipped, and the line says why. It
# runs under sh and dash.
t_fake_sleep() {
  case $1 in *"$T_ONLY"*) ;; *) return 0 ;; esac
  # shellcheck disable=SC2086
  case $(${SHELL_UNDER_TEST:-sh} -c 'type sleep' 2>/dev/null) in
  *builtin*)
    T_SKIP=$((T_SKIP + 1))
    printf 'skip %s: %s runs sleep as a builtin, so the fake sleep on PATH never runs\n' "$1" "${SHELL_UNDER_TEST:-sh}"
    return 0
    ;;
  esac
  t "$@"
}

done_testing() {
  if [ "$T_SKIP" -gt 0 ]; then
    printf '%s: %d passed, %d failed, %d skipped\n' "$(basename "$0")" "$T_PASS" "$T_FAIL" "$T_SKIP"
  else
    printf '%s: %d passed, %d failed\n' "$(basename "$0")" "$T_PASS" "$T_FAIL"
  fi
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
# in $T_DIR/out, err and code. guard.sh runs on the case's stopped clock, when
# it has one (t_clock) and hasn't put a date of its own first on PATH.
run_hook() {
  rh_script=$1
  shift
  rh_path=$PATH
  if [ "$rh_script" = guard.sh ] && [ -x "$T_DIR/clock/date" ] && [ "$(command -v date)" = "$T_DATE_FOUND" ]; then
    rh_path=$T_DIR/clock:$PATH
  fi
  # A word list on purpose ("busybox sh").
  # shellcheck disable=SC2086
  PATH=$rh_path CLAUDE_PLUGIN_ROOT=$LITTER_ROOT ${SHELL_UNDER_TEST:-sh} "$LITTER_ROOT/hooks/$rh_script" "$@" >|"$T_DIR/out" 2>|"$T_DIR/err"
  printf '%s\n' "$?" >|"$T_DIR/code"
}

# t_clock <epoch>: stops the guard's clock at <epoch> for the rest of the case
# (run_hook): its `date +%s` prints <epoch>, any other date is the real one.
# guard.sh ages a swarm's owner.checkedAt against that clock (over 10 s old,
# it runs git to check the ownership ref). In a session the mod's 10 s beat
# keeps the check fresh; a case has no beat, and on a loaded machine a case
# can run past 10 s, so a check its fixture wrote fresh would go stale midway
# (the scratch project has no such ref, and the guard then denies).
t_clock() {
  mkdir -p "$T_DIR/clock" || fail "clock"
  printf '#!/bin/sh\ncase $* in +%%s) echo %s ;; *) exec %s "$@" ;; esac\n' "$1" "'$T_DATE'" >|"$T_DIR/clock/date" ||
    fail "clock"
  chmod +x "$T_DIR/clock/date" || fail "clock"
}

# A PATH without jq: a folder of links to every tool on PATH but jq. One ln
# per PATH folder, in PATH order: a name linked already is kept, as the
# shell's lookup keeps the first.
path_without_jq() {
  pw_dir=$T_DIR/nojq-bin
  mkdir -p "$pw_dir"
  pw_old_ifs=$IFS
  IFS=:
  set -f
  for pw_p in $PATH; do
    [ -d "$pw_p" ] || continue
    set +f
    ln -s "$pw_p"/* "$pw_dir"/ 2>/dev/null
    set -f
  done
  set +f
  IFS=$pw_old_ifs
  rm -f "$pw_dir/jq"
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

# A PreToolUse call that passed: exit 0, nothing printed.
assert_pass() {
  assert_code 0
  assert_stdout_empty
}

# A PreToolUse call that was refused, either way a command hook can: a deny
# decision on stdout (exit 0) or exit 2. [text] must be in the reason.
assert_deny() {
  ad_code=$(cat "$T_DIR/code")
  case $ad_code in
    0)
      ad_out=$(cat "$T_DIR/out")
      assert_contains '"permissionDecision":"deny"' "$ad_out" "deny decision"
      [ -z "${1:-}" ] || assert_contains "$1" "$ad_out" "deny reason"
      ;;
    2) [ -z "${1:-}" ] || assert_stderr_contains "$1" ;;
    *) fail "exit $ad_code is neither a deny decision nor exit 2; stderr: $(cat "$T_DIR/err")" ;;
  esac
}

# What every litter agent's call is denied with when the script itself fails.
assert_blocked() {
  assert_code 2
  [ -z "${1:-}" ] || assert_stderr_contains "$1"
}

# Fixtures, after `project`: the hooks folder, a policy for an active run, a
# binding, and hook inputs. Each writes what the mod or identity.sh would.
hooks_dir() { printf '%s\n' "$T_DIR/project/.claude/litter/hooks"; }

# The guard's view of each role, as roles.ts has it (ROLE_POLICIES).
T_ROLES='{
  "falsifier": {"write": "none", "bash": "ro", "isolated": false},
  "coverage": {"write": "none", "bash": "ro", "isolated": false},
  "mechanism": {"write": "none", "bash": "ro", "isolated": false},
  "reframer": {"write": "none", "bash": "ro", "isolated": false},
  "prober": {"write": "own-worktree", "bash": "rw", "isolated": true},
  "author": {"write": "none", "bash": "ro", "isolated": false},
  "design-critic": {"write": "none", "bash": "ro", "isolated": false},
  "gate-critic": {"write": "none", "bash": "ro", "isolated": false},
  "executor": {"write": "checkout", "bash": "rw", "isolated": false},
  "adversary": {"write": "none", "bash": "ro", "isolated": false},
  "relay": {"write": "none", "bash": "ro", "isolated": false},
  "planner": {"write": "none", "bash": "ro", "isolated": false},
  "verifier": {"write": "none", "bash": "ro", "isolated": false},
  "researcher": {"write": "none", "bash": "ro", "isolated": false}
}'

# The scratch project's real path, as the mod's resolve would give it.
real_project() { (cd -P "$T_DIR/project" && pwd -P); }

# policy [jq filter]: policy.json for an active execute run whose checkout is
# the scratch project, then `active`. The filter edits it first, e.g.
# '.run.stopping = true'.
policy() {
  pl_hooks=$(hooks_dir)
  pl_co=$(real_project)
  jq -n --arg co "$pl_co" --arg ld "$pl_co/.claude/litter" --argjson roles "$T_ROLES" '
    {v: 1, session: "s1", litterDir: $ld,
     run: {run: "20261002-test", workflow: "execute", runDir: ($ld + "/20261002-test"), checkout: $co, base: "0000000",
           runIds: ["wf_abc123-456"], launching: false, stopping: false, inflight: null, isolationLost: false,
           roots: {checkout: $co, litterDir: $ld, litterCopies: [], ruleDirs: [], worktrees: []},
           setup: null, linkDirs: []},
     roles: $roles, swarm: null}' | jq "${1:-.}" >|"$pl_hooks/policy.json" || fail "policy fixture"
  : >|"$pl_hooks/active"
}

# bind <agent_id> <agent_type> [cwd]: the binding identity.sh writes at SubagentStart.
bind() {
  bd_hooks=$(hooks_dir)
  mkdir -p "$bd_hooks/bind"
  jq -n --arg id "$1" --arg ty "$2" --arg cwd "${3:-$T_DIR/project}" \
    '{v: 1, agent_id: $id, agent_type: $ty, cwd: $cwd, session_id: "s1", transcript_path: "/tmp/t.jsonl"}' \
    >|"$bd_hooks/bind/$1" || fail "bind fixture"
}

# call <agent_type> <tool> <tool_input JSON> [jq filter]: a PreToolUse input,
# from agent a1 of that type, or from the main thread for `-`. The keys come
# in the engine's order, the base fields (agent_id among them) before
# hook_event_name, which lib.sh's lt_raw_agent_id relies on.
call() {
  jq -cn --arg ty "$1" --arg tool "$2" --argjson ti "$3" --arg cwd "$T_DIR/project" '
    {session_id: "s1", transcript_path: "/tmp/t.jsonl", cwd: $cwd, permission_mode: "auto"}
    + (if $ty == "-" then {} else {agent_id: "a1", agent_type: $ty} end)
    + {hook_event_name: "PreToolUse", tool_name: $tool, tool_input: $ti, tool_use_id: "toolu_1"}' | jq -c "${4:-.}"
}

# bash_call <agent_type> <command>: a Bash call's input.
bash_call() {
  call "$1" Bash "$(jq -cn --arg c "$2" '{command: $c}')"
}

# write_call <agent_type> <path> [tool]: a Write (or Edit, NotebookEdit) call's input.
write_call() {
  case ${3:-Write} in
    NotebookEdit) wc_ti=$(jq -cn --arg p "$2" '{notebook_path: $p, new_source: "x"}') ;;
    Edit) wc_ti=$(jq -cn --arg p "$2" '{file_path: $p, old_string: "a", new_string: "b"}') ;;
    *) wc_ti=$(jq -cn --arg p "$2" '{file_path: $p, content: "x"}') ;;
  esac
  call "$1" "${3:-Write}" "$wc_ti"
}

# The spool lines written for session s1, one per line.
spool_lines() { cat "$(hooks_dir)/spool/s1.jsonl" 2>/dev/null; }

# Every git run in a case ignores your global and system config and has a
# fixed identity, as tier 2's HERMETIC_GIT_ENV, scripts under test included.
git_env() {
  GIT_CONFIG_GLOBAL=/dev/null
  GIT_CONFIG_NOSYSTEM=1
  GIT_AUTHOR_NAME=litter-test
  GIT_AUTHOR_EMAIL=test@litter.invalid
  GIT_COMMITTER_NAME=litter-test
  GIT_COMMITTER_EMAIL=test@litter.invalid
  export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
}

# repo: the scratch project (see `project`) as a git repository with two
# commits, whose origin/main (and origin/HEAD) is the first, so it is behind
# HEAD. Sets REPO_OLD (the first) and REPO_BASE (HEAD). .claude/ and deps/
# are ignored.
repo() {
  git_env
  project >/dev/null
  rp_dir=$T_DIR/project
  git -C "$rp_dir" init -q -b main || fail "git init"
  printf '.claude/\ndeps/\n' >|"$rp_dir/.gitignore"
  printf 'one\n' >|"$rp_dir/a.txt"
  git -C "$rp_dir" add .gitignore a.txt && git -C "$rp_dir" commit -qm one || fail "first commit"
  REPO_OLD=$(git -C "$rp_dir" rev-parse HEAD)
  printf 'two\n' >>"$rp_dir/a.txt"
  mkdir -p "$rp_dir/src"
  printf 'x = 1\n' >|"$rp_dir/src/x.py"
  git -C "$rp_dir" add -A && git -C "$rp_dir" commit -qm two || fail "second commit"
  REPO_BASE=$(git -C "$rp_dir" rev-parse HEAD)
  git -C "$rp_dir" update-ref refs/remotes/origin/main "$REPO_OLD" || fail "origin/main"
  git -C "$rp_dir" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main || fail "origin/HEAD"
}

# fanout_policy [jq filter]: policy.json for an active fanout run on the
# scratch repository, at REPO_BASE, its worktrees under the project's
# .claude/worktrees (resolved, as the mod writes it), and the fanout
# executor's role. The filter edits it last.
fanout_policy() {
  fp_co=$(real_project)
  policy ".run.workflow = \"fanout\" | .run.base = \"${REPO_BASE:-0000000000000000000000000000000000000000}\"
    | .run.worktreeRoot = \"$fp_co/.claude/worktrees\" | .run.setupTimeoutSec = 30
    | .roles.executor = {write: \"own-worktree\", bash: \"rw\", isolated: true} | ${1:-.}"
}

# wt_in <name> [cwd]: a WorktreeCreate input from session s1.
wt_in() {
  jq -cn --arg n "$1" --arg cwd "${2:-$T_DIR/project}" \
    '{session_id: "s1", transcript_path: "/tmp/t.jsonl", cwd: $cwd, hook_event_name: "WorktreeCreate", name: $n}'
}

# --- swarms (plan 15.4, "The guard for nodes") -------------------------------

# swarm_policy [jq filter]: policy.json with swarm `s` live and no run, as
# swarm/guard.ts's writeSwarmPolicy writes it, then `active`. Its owner check
# is fresh (checkedAt now), and the guard's clock stops at that now (t_clock),
# so however long the case runs the guard runs no git; the filter edits it
# last, e.g. '.swarm.swarms.s.state = "stopping"'. A test that sets a stale
# check uses `swarm_ref` for the ref and oid.
swarm_policy() {
  sp_hooks=$(hooks_dir)
  sp_co=$(real_project)
  sp_now=$(date +%s)
  jq -n --arg co "$sp_co" --arg ld "$sp_co/.claude/litter" --argjson roles "$T_ROLES" --argjson now "$sp_now" \
    --arg oid "${SWARM_OID:-0123456789abcdef0123456789abcdef01234567}" '
    {v: 1, session: "s1", litterDir: $ld, run: null, roles: $roles,
     swarm: {swarms: {s: {launch: "20261003-120000", state: "live", commonDir: ($co + "/.git"),
       owner: {ref: "refs/litter-swarm/s", oid: $oid, generation: 1, session: "s1", checkedAt: $now},
       nodeTypes: ["litter:sw-s-lead", "litter:sw-s-fixer", "litter:sw-s-reviewer"]}}}}' |
    jq "${1:-.}" >|"$sp_hooks/policy.json" || fail "swarm policy fixture"
  : >|"$sp_hooks/active"
  t_clock "$sp_now"
}

# swarm_ref: the scratch repository (see `repo`) gets refs/litter-swarm/s at
# a blob, as Launch takes it; sets SWARM_OID.
swarm_ref() {
  SWARM_OID=$(printf '{"swarm":"s"}\n' | git -C "$T_DIR/project" hash-object -w --stdin) || fail "owner blob"
  git -C "$T_DIR/project" update-ref refs/litter-swarm/s "$SWARM_OID" || fail "owner ref"
}

# node_policy <agent_id> [jq filter]: agents/<agent_id>.json for an admitted
# orchestrator `lead` of swarm s, working in the scratch project with no
# limits set, as nodePolicyFor renders it. The filter edits the node, e.g.
# '.kind = "worker" | .parent = "a0"'.
node_policy() {
  nd_hooks=$(hooks_dir)
  nd_co=$(real_project)
  mkdir -p "$nd_hooks/agents"
  jq -n --arg co "$nd_co" '
    {swarm: "s", launch: "20261003-120000", node: "lead", n: 1, kind: "orchestrator", of: null,
     type: "litter:sw-s-lead", parent: null, generation: 1, dir: $co, paths: null,
     protect: [($co + "/.claude/litter"), ($co + "/.litter"), ($co + "/.litter.local"),
               ($co + "/.claude/rules/litter"), ($co + "/.claude/rules/litter-local")],
     branch: null, authority: {}, toolsDeny: [], bashDeny: [], spawns: [], spawnOther: true,
     admitted: true, stopped: null, bind: false}' | jq "${2:-.}" | jq '{v: 1, node: .}' >|"$nd_hooks/agents/$1.json" ||
    fail "node fixture"
}

# A swarm live, with orchestrator a1 bound: swarm_setup [node filter] [policy filter].
swarm_setup() {
  project >/dev/null
  swarm_policy "${2:-.}"
  node_policy a1 "${1:-.}"
}

# A PreToolUse input from agent <id> of <agent_type>: as_agent <id> <call…>.
as_agent() {
  aa_id=$1
  shift
  "$@" | jq -c --arg id "$aa_id" '.agent_id = $id'
}

# stop_input <id> <agent_type> [jq filter]: a SubagentStop input for that
# agent. background_tasks lists the agent itself, as the engine's does.
stop_input() {
  jq -cn --arg id "$1" --arg ty "$2" '
    {session_id: "s1", transcript_path: "/p/s1.jsonl", cwd: "/p", permission_mode: "auto", agent_id: $id,
     agent_type: $ty, hook_event_name: "SubagentStop", stop_hook_active: false,
     agent_transcript_path: "/p/s1/subagents/a.jsonl", last_assistant_message: "done",
     background_tasks: [{id: $id, type: "subagent", status: "running", description: "d", agent_type: $ty}],
     session_crons: []}' | jq -c "${3:-.}"
}

# A folder holding a fake <tool> that runs <body>, for PATH=…:$PATH.
fake_tool() {
  ft_dir=$T_DIR/fake-$1
  mkdir -p "$ft_dir"
  printf '#!/bin/sh\n%s\n' "$2" >|"$ft_dir/$1"
  chmod +x "$ft_dir/$1"
  printf '%s\n' "$ft_dir"
}
