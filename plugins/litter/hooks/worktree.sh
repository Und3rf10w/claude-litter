#!/bin/sh
# worktree.sh: WorktreeCreate, every worktree the engine asks for (plan
# section 9, "Run worktrees"; section 10, "Command hooks"). Once a
# WorktreeCreate command hook is configured, the engine hands it every
# creation and fails one it doesn't answer (zan, :480468-480500), so there is
# no fast path and no pass-through:
#  - a litter name, `<runId>-<n>` for a run id policy.json lists, gets its
#    run's worktree at the launch commit, on litter/<run>-w<n>, with the run's
#    setup or linkDirs, each step spooled for the mod and kept in wt/<name>;
#  - every other name is made as the engine would (vAe, :431085), with the
#    engine's post-create step (TAe, :431546), which it skips for a
#    hook-made worktree.
# The worktree's absolute, resolved path is the only line on stdout (xF takes
# the last line a successful hook printed). For a litter name it can't
# settle, the script exits 1 with the reason on stderr and prints nothing
# ("Fails closed"); a real failure for any other name does the same, since
# there is no fallback.

set -u
case $0 in */*) lt_here=${0%/*} ;; *) lt_here=. ;; esac
# stdout carries the path alone: everything else goes to stderr, the path to fd 3.
exec 3>&1 1>&2

wt_die() {
  printf 'litter: worktree.sh: %s\n' "$1" >&2
  exit 1
}
wt_note() { printf 'litter: worktree.sh: %s\n' "$1" >&2; }

[ -r "$lt_here/lib.sh" ] || wt_die "can't load lib.sh beside it, so no worktree can be made; refusing"
. "$lt_here/lib.sh"

# Every git call names its repository with -C; one named by the environment would win.
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE GIT_PREFIX 2>/dev/null || :

WT_LAUNCH_WAIT=15 # seconds a wf_ name is polled for while a launch is in progress
WT_GRACE=5        # seconds between a timed-out setup's TERM and its KILL
WT_PENDING=0      # 1 while this request holds an intent with no create yet
WT_READD=0        # 1 while a replay re-adds a recorded worktree that was gone
WT_IGNORED='[]'

# git with the repository's hooks and fsmonitor off, as the engine runs its
# own (yn, :55600), and in English, since its messages become reasons.
wt_git() { LC_ALL=C git -c core.hooksPath=/dev/null -c core.fsmonitor= "$@"; }

# A command's output on one line, for a reason.
wt_one() { printf '%s' "$1" | tr '\n' ' ' | sed 's/ *$//'; }

wt_exists() { [ -e "$1" ] || [ -L "$1" ]; }

# ---------------------------------------------------------------------------
# The input and the name

WT_JQ_INPUT='
def s: if type == "string" then . else "" end;
[(.name | s), (.cwd | s), (.session_id | s)]
| if any(.[]; test("[\\x00-\\x1f]")) then "bad" else "ok\n" + join("\n") end
'

# Sets WT_NAME, WT_CWD and WT_SID. Without jq, sed reads each from the
# compact input, and only a value with no escapes in it (section 9, "jq
# missing").
wt_input() {
  [ -z "$LT_CUT" ] || wt_die "the hook input did not arrive within $LT_READ_SECS s; refusing"
  [ -n "$LT_IN" ] || wt_die "the hook input is empty; refusing"
  if lt_have_jq; then
    wi_out=$(printf '%s' "$LT_IN" | jq -r "$WT_JQ_INPUT") || wt_die "the hook input does not parse; refusing"
    lt_rest=$wi_out
    lt_take
    [ "$lt_t" = ok ] || wt_die "the hook input has control characters in name, cwd or session_id; refusing"
    lt_take; WT_NAME=$lt_t
    lt_take; WT_CWD=$lt_t
    lt_take; WT_SID=$lt_t
  else
    WT_NAME=$(printf '%s\n' "$LT_IN" | sed -n 's/.*"name":"\([^"\\]*\)".*/\1/p' | head -n 1)
    WT_CWD=$(printf '%s\n' "$LT_IN" | sed -n 's/.*"cwd":"\([^"\\]*\)".*/\1/p' | head -n 1)
    WT_SID=$(printf '%s\n' "$LT_IN" | sed -n 's/.*"session_id":"\([^"\\]*\)".*/\1/p' | head -n 1)
  fi
}

# The engine's own name rules (gFe, :430467): at most 64 characters, "/"-
# separated segments of letters, digits, dots, underscores and dashes, none
# of them ".", ".." or .git.
wt_name_ok() {
  [ -n "$1" ] && [ "${#1}" -le 64 ] || return 1
  case $1 in /* | */ | *//*) return 1 ;; esac
  wn_rest=$1
  while :; do
    wn_seg=${wn_rest%%/*}
    case $wn_seg in '' | . | .. | *[!A-Za-z0-9._-]*) return 1 ;; esac
    case $wn_seg in
      [.][Gg][Ii][Tt]*) case ${wn_seg#[.][Gg][Ii][Tt]} in *[!.]*) ;; *) return 1 ;; esac ;;
    esac
    case $wn_rest in */*) wn_rest=${wn_rest#*/} ;; *) return 0 ;; esac
  done
}

# The run id of a name shaped like a workflow agent's (`<runId>-<n>`, :954614),
# or a failure. The id is everything before the last -<digits>, so an id with
# dashes of its own is kept whole, and must fit the tool's ^wf_[a-z0-9-]{6,}$.
wt_runid_of() {
  case $1 in wf_*-*) ;; *) return 1 ;; esac
  case ${1##*-} in '' | *[!0-9]*) return 1 ;; esac
  wr_id=${1%-*}
  case ${wr_id#wf_} in '' | *[!a-z0-9-]*) return 1 ;; esac
  [ "${#wr_id}" -ge 9 ] || return 1
  printf '%s\n' "$wr_id"
}

# ---------------------------------------------------------------------------
# Is it litter's?

# policy.json (raw, on stdin) and $name: `other`, `wait` (a launch is on its
# way), `refuse` and the reason, or `litter` and the run's fields, one per
# line, the setup argv and linkDirs last, then `end`.
WT_JQ_DECIDE='
def abs: type == "string" and startswith("/") and (test("[\\x00-\\x1f]") | not);
def dotfree: split("/") | .[1:] | all(. != "" and . != "." and . != "..");
def word: type == "string" and (test("[\\x00\\n\\r]") | not);
def reldir: word and (rtrimstr("/") | (startswith("/") | not) and (split("/") | all(. != "" and . != "." and . != "..")));
. as $text
| readj($text) as $p
| ($name | capture("^(?<id>.+)-(?<n>[0-9]+)$")) as $m
| if ($p | ok1 | not) then
    "refuse\npolicy.json is unreadable (\(why($text; $p))), so litter cannot tell whether \($name) is one of its run worktrees; refusing it"
  elif ($p.run | type) != "object" then "other"
  elif ([($p.run.runIds // [])[] | str] | index([$m.id])) == null then
    (if $p.run.launching == true then "wait" else "other" end)
  else $p.run as $r
  | ($r.linkDirs // []) as $links
  | if ($m.id | test("^wf_[a-z0-9-]{6,}$") | not) then
      "refuse\npolicy.json lists the run id \($m.id), which does not fit ^wf_[a-z0-9-]{6,}$, so \($name) cannot be placed; refusing it"
    elif $r.stopping == true then "refuse\nrun \($r.run | str) is stopping, so it makes no more worktrees; refusing \($name)"
    elif ($r.run | str | test("^[0-9]{8}-[a-z0-9][a-z0-9-]{0,62}$") | not) or ($r.workflow | str | test("^[a-z]+$") | not) then
      "refuse\npolicy.json names no usable run or workflow (\($r.run | tojson), \($r.workflow | tojson)); refusing \($name)"
    elif ($r.base | str | test("^([0-9a-f]{40}|[0-9a-f]{64})$") | not) then
      "refuse\npolicy.json gives run \($r.run) no usable base (\($r.base | tojson)); refusing \($name)"
    elif ($r.worktreeRoot | abs | not) or ($r.worktreeRoot | rtrimstr("/") | dotfree | not) then
      "refuse\npolicy.json gives run \($r.run) no worktreeRoot (an absolute, resolved folder), so litter cannot place \($name); refusing it until the mod rewrites policy.json"
    elif ($r.setupTimeoutSec | type) != "number" or ($r.setupTimeoutSec | floor) != $r.setupTimeoutSec
        or $r.setupTimeoutSec < 1 or $r.setupTimeoutSec > 600 then
      "refuse\npolicy.json gives run \($r.run) no setupTimeoutSec (whole seconds, 1 to 600), so a setup in \($name) could not be bounded; refusing it"
    elif ($r.checkout | abs | not) or ($r.runDir | abs | not) then
      "refuse\npolicy.json gives run \($r.run) no absolute checkout or runDir; refusing \($name)"
    elif ($m.n | test("^(0|[1-9][0-9]{0,8})$") | not) then
      "refuse\n\($name) does not end in an agent index the engine makes; refusing it"
    elif $r.setup != null and (($r.setup | type) != "array" or ($r.setup | length) == 0 or (all($r.setup[]; word) | not) or $r.setup[0] == "") then
      "refuse\npolicy.json gives run \($r.run) a setup that is not a list of words; refusing \($name)"
    elif ($links | type) != "array" or (all($links[]; reldir) | not) then
      "refuse\npolicy.json gives run \($r.run) a linkDirs entry that is not a relative folder with no empty, . or .. parts; refusing \($name)"
    else
      (["litter", $r.run, $r.workflow, ($r.runDir | rtrimstr("/")), ($r.checkout | rtrimstr("/")), $r.base,
        ($r.worktreeRoot | rtrimstr("/")), ($r.setupTimeoutSec | tostring), $m.n, ($r.workflow == "design" | tostring),
        (($r.setup // []) | length | tostring), ($links | length | tostring)]
       + ($r.setup // []) + [$links[] | rtrimstr("/")] + ["end"]) | join("\n")
    end
  end
'

# Sets the run's fields from WT_JQ_DECIDE's `litter` answer.
wt_fields() {
  lt_rest=$1
  lt_take
  lt_take; WT_RUN=$lt_t
  lt_take; WT_WORKFLOW=$lt_t
  lt_take; WT_RUNDIR=$lt_t
  lt_take; WT_CO=$lt_t
  lt_take; WT_BASE=$lt_t
  lt_take; WT_ROOT=$lt_t
  lt_take; WT_TIMEOUT=$lt_t
  lt_take; WT_N=$lt_t
  lt_take; WT_DISP=$lt_t
  lt_take; WT_SETUP_N=$lt_t
  lt_take; WT_LINKS_N=$lt_t
  WT_SETUP=
  wf_i=0
  while [ "$wf_i" -lt "$WT_SETUP_N" ]; do
    lt_take
    if [ "$wf_i" -eq 0 ]; then WT_SETUP=$lt_t; else WT_SETUP=$WT_SETUP$LT_NL$lt_t; fi
    wf_i=$((wf_i + 1))
  done
  WT_LINKS=
  wf_i=0
  while [ "$wf_i" -lt "$WT_LINKS_N" ]; do
    lt_take
    if [ "$wf_i" -eq 0 ]; then WT_LINKS=$lt_t; else WT_LINKS=$WT_LINKS$LT_NL$lt_t; fi
    wf_i=$((wf_i + 1))
  done
  lt_take
  [ "$lt_t" = end ] || wt_die "policy.json's run fields didn't read back whole; refusing $WT_NAME"
}

# Sets WT_KIND: litter (with the run's fields) or other. A wf_ name whose run
# id isn't listed while policy.json shows `launching` is polled for once a
# second, at most WT_LAUNCH_WAIT s: the first agent can ask before the
# Workflow call has returned its run id (section 9, "Which names are litter's").
wt_decide() {
  wd_i=0
  while :; do
    if [ ! -f "$LT_DIR/active" ]; then
      WT_KIND=other
      return 0
    fi
    wd_pol=
    if wt_exists "$LT_DIR/policy.json"; then
      wd_pol=$(cat "$LT_DIR/policy.json") ||
        wt_die "policy.json is unreadable, so litter cannot tell whether $WT_NAME is one of its run worktrees; refusing it"
    fi
    wd_out=$(printf '%s' "$wd_pol" | jq -rRs --arg name "$WT_NAME" "$LT_JQ_DEFS$WT_JQ_DECIDE") ||
      wt_die "jq failed on policy.json, so litter cannot tell whether $WT_NAME is one of its run worktrees; refusing it"
    case $wd_out in
      other) WT_KIND=other; return 0 ;;
      wait)
        if [ "$wd_i" -ge "$WT_LAUNCH_WAIT" ]; then
          WT_KIND=other
          return 0
        fi
        wd_i=$((wd_i + 1))
        sleep 1
        ;;
      "litter$LT_NL"*) WT_KIND=litter; wt_fields "$wd_out"; return 0 ;;
      "refuse$LT_NL"*) wt_die "${wd_out#refuse"$LT_NL"}" ;;
      *) wt_die "no decision came back for $WT_NAME; refusing it" ;;
    esac
  done
}

# Without jq: a policy.json that names the run id refuses the name, since it
# can't be settled; one that doesn't makes it the engine's way.
wt_decide_nojq() {
  wd_i=0
  while :; do
    if [ ! -f "$LT_DIR/active" ]; then
      WT_KIND=other
      return 0
    fi
    [ -r "$LT_DIR/policy.json" ] ||
      wt_die "jq not found and policy.json unreadable, so litter cannot tell whether $WT_NAME is one of its run worktrees; refusing it (install jq, or stop the run)"
    if grep -F -q -e "\"$WT_RUNID\"" "$LT_DIR/policy.json"; then
      wt_die "jq not found, so litter cannot settle $WT_NAME, a worktree of its run; refusing it (install jq, or stop the run)"
    fi
    if [ "$wd_i" -lt "$WT_LAUNCH_WAIT" ] &&
      grep -E -q -e '"launching"[[:space:]]*:[[:space:]]*true' "$LT_DIR/policy.json"; then
      wd_i=$((wd_i + 1))
      sleep 1
      continue
    fi
    WT_KIND=other
    return 0
  done
}

# ---------------------------------------------------------------------------
# A litter name: the records and the marker

WT_JQ_LINE='
{v: 1, ev: "worktree", ts: (now | floor), session_id: $sid, step: $step, run: $run, name: $name, path: $path,
 branch: $branch, base: $base, disposable: ($disp == "true")}
+ (if $step == "create" then {ignored: .}
   elif $step == "setup_failed" then {exit_code: (if $ec == "" then null else ($ec | tonumber) end), timed_out: ($to == "true"), log: $log}
   else {} end)
'

WT_JQ_MARKER='
{v: 1, step: $step, run: $run, name: $name, path: $path, branch: $branch, base: $base, disposable: ($disp == "true")}
'

WT_JQ_MARK='
readj(.) as $m
| if $m == null then "none"
  elif ($m | ok1 | not) then "bad\nwt/\($name) is unreadable (\(why(.; $m)))"
  elif (["intent", "create", "setup_failed"] | index([$m.step | str])) == null then
    "bad\nwt/\($name) records no step litter knows (\($m.step | tojson))"
  elif [$m.run, $m.name, $m.path, $m.branch, $m.base] != [$run, $name, $path, $branch, $base] or $m.disposable != ($disp == "true") then
    "bad\nwt/\($name) records another worktree (run \($m.run | tojson), path \($m.path | tojson), branch \($m.branch | tojson), base \($m.base | tojson))"
  else $m.step end
'

# wt_spool <step> [exit_code timed_out]: one `worktree` line (hookfiles.ts,
# SpoolLine), the ignored paths read from WT_IGNORED for a create.
wt_spool() {
  ws_line=$(printf '%s' "$WT_IGNORED" | jq -c --arg sid "$WT_SID" --arg step "$1" --arg run "$WT_RUN" \
    --arg name "$WT_NAME" --arg path "$WT_PATH" --arg branch "$WT_BRANCH" --arg base "$WT_BASE" \
    --arg disp "$WT_DISP" --arg ec "${2:-}" --arg to "${3:-false}" --arg log "$WT_LOG" "$WT_JQ_LINE") || return 1
  lt_spool "$WT_SID" "$ws_line"
}

# wt_mark <step>: wt/<name>, replaced whole (hookfiles.ts, WtMarker).
wt_mark() {
  wm_json=$(jq -cn --arg step "$1" --arg run "$WT_RUN" --arg name "$WT_NAME" --arg path "$WT_PATH" \
    --arg branch "$WT_BRANCH" --arg base "$WT_BASE" --arg disp "$WT_DISP" "$WT_JQ_MARKER") || return 1
  lt_mkdir "$LT_DIR/wt" && lt_write "$(lt_wt_marker "$WT_NAME")" "$wm_json"
}

# The marker's step for this name (none, intent, create or setup_failed).
wt_marker_step() {
  wk_file=$(lt_wt_marker "$WT_NAME")
  wk_text=
  if wt_exists "$wk_file"; then
    wk_text=$(cat "$wk_file") || wt_die "wt/$WT_NAME can't be read, so litter cannot tell how far an earlier request got; refusing it"
  fi
  wk_out=$(printf '%s' "$wk_text" | jq -rRs --arg run "$WT_RUN" --arg name "$WT_NAME" --arg path "$WT_PATH" \
    --arg branch "$WT_BRANCH" --arg base "$WT_BASE" --arg disp "$WT_DISP" "$LT_JQ_DEFS$WT_JQ_MARK") ||
    wt_die "jq failed on wt/$WT_NAME; refusing it"
  case $wk_out in
    "bad$LT_NL"*) wt_die "${wk_out#bad"$LT_NL"}; refusing it" ;;
  esac
  printf '%s\n' "$wk_out"
}

# wt_refuse <reason> [exit_code timed_out]: ends the request. One that holds
# an open intent records it as worktree.setup_failed, with the setup's log or,
# for any other failure, the reason as the log, and leaves the marker there,
# so the next request for the name retries by the unfinished rules. A replay
# that re-added a gone worktree takes it away again, so the next one re-adds
# it and reruns the setup.
wt_refuse() {
  if [ "$WT_PENDING" = 1 ]; then
    if [ "$#" -lt 3 ]; then
      lt_mkdir "${WT_LOG%/*}" && printf '%s\n' "$1" >"$WT_LOG" 2>/dev/null
    fi
    wt_spool setup_failed "${2:-}" "${3:-false}" || wt_note "couldn't spool the setup_failed of $WT_NAME"
    wt_mark setup_failed || wt_note "couldn't write wt/$WT_NAME"
  elif [ "$WT_READD" = 1 ]; then
    wt_git -C "$WT_CO" worktree remove --force --force -- "$WT_PATH" >/dev/null 2>&1 ||
      wt_note "couldn't take away the re-added $WT_PATH"
  fi
  wt_die "$1"
}

# ---------------------------------------------------------------------------
# A litter name: git

WT_JQ_LIST='
split("\u0000")
| reduce .[] as $f ({cur: null, all: []};
    if $f == "" then (if .cur != null then .all += [.cur] | .cur = null else . end)
    else ($f | index(" ")) as $i
    | (if $i == null then [$f, true] else [$f[:$i], $f[$i + 1:]] end) as $kv
    | if $kv[0] == "worktree" then (if .cur != null then .all += [.cur] else . end) | .cur = {worktree: $kv[1]}
      elif .cur != null then .cur[$kv[0]] = $kv[1]
      else . end
    end)
| .all + (if .cur != null then [.cur] else [] end)
| (map(select(.worktree == $path)) | .[0]) as $at
| (map(select(.branch == ("refs/heads/" + $branch) and .worktree != $path)) | .[0]) as $other
| def s: if type == "string" then gsub("[\\x00-\\x1f]"; "?") else "" end;
  [ (if $at == null then "none" else "at" end),
    ($at.branch | s),
    ($at.HEAD | s),
    (if $at.locked == null then "" elif $at.locked == true then "locked" else "locked " + ($at.locked | s) end),
    (if $at.prunable != null then "prunable" else "" end),
    ($other.worktree | s) ] | join("\n")
'

# What git knows of this name's worktree and branch: WT_AT (at or none),
# WT_AT_BRANCH, WT_AT_HEAD, WT_AT_LOCKED, WT_AT_GONE (its folder is missing),
# WT_OTHER (another worktree holding the branch) and WT_BSHA (the branch tip,
# empty without one).
wt_facts() {
  wf_tmp=$LT_DIR/wt/.list-$$
  lt_mkdir "$LT_DIR/wt" || wt_refuse "can't make $LT_DIR/wt"
  if ! wt_git -C "$WT_CO" worktree list --porcelain -z >"$wf_tmp" 2>/dev/null; then
    rm -f -- "$wf_tmp"
    wt_refuse "git worktree list failed in $WT_CO"
  fi
  wf_out=$(jq -rRs --arg path "$WT_PATH" --arg branch "$WT_BRANCH" "$WT_JQ_LIST" <"$wf_tmp")
  wf_rc=$?
  rm -f -- "$wf_tmp"
  [ "$wf_rc" -eq 0 ] || wt_refuse "jq failed on git worktree list"
  lt_rest=$wf_out
  lt_take; WT_AT=$lt_t
  lt_take; WT_AT_BRANCH=$lt_t
  lt_take; WT_AT_HEAD=$lt_t
  lt_take; WT_AT_LOCKED=$lt_t
  lt_take; WT_AT_GONE=$lt_t
  lt_take; WT_OTHER=$lt_t
  [ -d "$WT_PATH" ] || [ "$WT_AT" = none ] || WT_AT_GONE=prunable
  WT_BSHA=$(wt_git -C "$WT_CO" rev-parse -q --verify "refs/heads/$WT_BRANCH^{commit}" 2>/dev/null) || WT_BSHA=
}

# The branch, which isn't at base: why it can't be reused.
wt_branch_why() {
  if wt_git -C "$WT_CO" merge-base --is-ancestor "$WT_BASE" "$WT_BSHA" 2>/dev/null; then
    printf '%s\n' "$WT_BRANCH has commits past base $WT_BASE, so it may hold someone's work; refusing to reuse it for $WT_NAME"
  else
    printf '%s\n' "$WT_BRANCH is at $WT_BSHA, which doesn't descend from base $WT_BASE; refusing to reuse it for $WT_NAME"
  fi
}

# A first request's add: -b fails when the branch exists, so it never takes one over.
wt_add_new() {
  wa_out=$(wt_git -C "$WT_CO" worktree add -b "$WT_BRANCH" -- "$WT_PATH" "$WT_BASE" 2>&1) ||
    wt_refuse "git worktree add -b $WT_BRANCH $WT_PATH failed: $(wt_one "$wa_out")"
}

# The add of a branch that exists: never -b again.
wt_add_branch() {
  wa_out=$(wt_git -C "$WT_CO" worktree add -- "$WT_PATH" "$WT_BRANCH" 2>&1) ||
    wt_refuse "git worktree add $WT_PATH $WT_BRANCH failed: $(wt_one "$wa_out")"
}

# Clears the registration at the path (the add will make it again). Only for
# a worktree nobody was handed, or whose folder is gone: --force twice also
# takes git's own `initializing` lock off an add that was cut off.
wt_remove() {
  wa_out=$(wt_git -C "$WT_CO" worktree remove --force --force -- "$WT_PATH" 2>&1) ||
    wt_refuse "git worktree remove $WT_PATH failed: $(wt_one "$wa_out")"
}

# ---------------------------------------------------------------------------
# A litter name: the dependency setup (section 7, fanout.js step 3)

# The approved setup argv, exactly, in the worktree's root, with its output in
# the setup log, under a watchdog of WT_TIMEOUT s built from sleep and kill.
# The argv comes from policy.json's JSON array as separate words, never
# through a shell string (section 9, "Mod safety").
wt_setup() {
  [ "$WT_SETUP_N" -gt 0 ] || return 0
  lt_mkdir "${WT_LOG%/*}" || wt_refuse "can't make the setup log folder ${WT_LOG%/*}"
  set --
  while IFS= read -r ws_w; do
    set -- ${1+"$@"} "$ws_w"
  done <<EOF
$WT_SETUP
EOF
  [ "$#" -eq "$WT_SETUP_N" ] || wt_refuse "the setup argv read back as $# words, not $WT_SETUP_N"
  # Neither child keeps the hook's stdout (fd 3) or stderr: the engine reads
  # them to the end.
  (cd -- "$WT_PATH" && exec "$@") </dev/null >"$WT_LOG" 2>&1 3>&- &
  ws_pid=$!
  (
    ws_s=
    ws_fired=0
    trap 'kill "$ws_s" 2>/dev/null; exit "$ws_fired"' TERM
    sleep "$WT_TIMEOUT" &
    ws_s=$!
    wait "$ws_s"
    ws_fired=3
    kill -TERM "$ws_pid" 2>/dev/null
    sleep "$WT_GRACE" &
    ws_s=$!
    wait "$ws_s"
    kill -KILL "$ws_pid" 2>/dev/null
    exit 3
  ) </dev/null >/dev/null 2>&1 3>&- &
  ws_wd=$!
  wait "$ws_pid"
  ws_rc=$?
  kill "$ws_wd" 2>/dev/null
  wait "$ws_wd"
  ws_wrc=$?
  if [ "$ws_wrc" -eq 3 ]; then
    wt_refuse "the setup ($1) timed out after $WT_TIMEOUT s in $WT_PATH; its log is $WT_LOG" "" true
  fi
  [ "$ws_rc" -eq 0 ] || wt_refuse "the setup ($1) exited $ws_rc in $WT_PATH; its log is $WT_LOG" "$ws_rc" false
}

# Whether a path's nearest existing folder lies inside a resolved root: a
# folder on the way that is a committed link out of the worktree, or not a
# folder at all, fails it (the engine's SAe, :430490, without its final-link
# test, which the callers make themselves).
wt_parent_inside() {
  wp_d=${1%/*}
  while :; do
    if [ -d "$wp_d" ]; then
      wp_r=$(lt_realdir "$wp_d") || return 1
      case $wp_r in "$2" | "$2"/*) return 0 ;; *) return 1 ;; esac
    fi
    wt_exists "$wp_d" && return 1
    case $wp_d in */*) wp_d=${wp_d%/*} ;; *) return 1 ;; esac
    [ -n "$wp_d" ] || return 1
  done
}

# The engine's SAe: true when <dest> escapes <root> through a link, or is one.
wt_escapes() {
  wt_parent_inside "$1" "$2" || return 0
  [ -L "$1" ]
}

# linkDirs: each a folder in the checkout, ignored as a link in the worktree
# (a `node_modules/` pattern matches folders only, so a link named
# node_modules would otherwise go into the snapshot), linked by its absolute
# checkout path. A link that already points there is left alone.
wt_links() {
  [ "$WT_LINKS_N" -gt 0 ] || return 0
  while IFS= read -r wl_e; do
    wl_src=$WT_CO/$wl_e
    wl_dst=$WT_PATH/$wl_e
    [ -d "$wl_src" ] || wt_refuse "linkDirs: $wl_e isn't a folder in the checkout $WT_CO"
    wt_git -C "$WT_PATH" check-ignore -q -- "$wl_e" 2>/dev/null
    case $? in
      0) ;;
      1) wt_refuse "linkDirs: $wl_e isn't ignored as a link in $WT_PATH (a pattern like $wl_e/ matches folders only); ignore $wl_e without the trailing slash" ;;
      *) wt_refuse "linkDirs: git check-ignore failed for $wl_e in $WT_PATH" ;;
    esac
    wt_parent_inside "$wl_dst" "$WT_PATH" || wt_refuse "linkDirs: $wl_dst would land outside $WT_PATH through a link"
    if [ -L "$wl_dst" ]; then
      [ "$(readlink "$wl_dst")" != "$wl_src" ] || continue
      rm -f -- "$wl_dst" || wt_refuse "linkDirs: couldn't replace the link $wl_dst"
    elif [ -e "$wl_dst" ]; then
      wt_refuse "linkDirs: $wl_dst already exists in the worktree and isn't a link"
    fi
    mkdir -p -- "${wl_dst%/*}" && ln -s -- "$wl_src" "$wl_dst" || wt_refuse "linkDirs: couldn't link $wl_dst to $wl_src"
  done <<EOF
$WT_LINKS
EOF
}

WT_JQ_IGNORED='
split("\u0000")
| reduce .[] as $e ({skip: false, out: []};
    if .skip then .skip = false
    elif ($e | startswith("!! ")) then .out += [$e[3:]]
    elif ($e | test("^(R|C|.R|.C)")) then .skip = true
    else . end)
| .out
'

# The ignored paths the setup left, as git status lists them (folders
# collapsed), into WT_IGNORED: cleanup removes no worktree holding one more.
wt_ignored() {
  wi_tmp=$LT_DIR/wt/.status-$$
  if ! wt_git -C "$WT_PATH" status --porcelain -z --ignored >"$wi_tmp" 2>/dev/null; then
    rm -f -- "$wi_tmp"
    return 1
  fi
  WT_IGNORED=$(jq -cRs "$WT_JQ_IGNORED" <"$wi_tmp")
  wi_rc=$?
  rm -f -- "$wi_tmp"
  return "$wi_rc"
}

# ---------------------------------------------------------------------------
# The post-create step's hooks path, for every worktree (section 9: it runs
# for litter's too, so a writer's commits run your repository's hooks)

# A path folded lexically, as path.resolve folds it: no symlink is followed.
wt_norm() {
  wn_out=
  wn_ifs=$IFS
  IFS=/
  set -f
  for wn_p in $1; do
    case $wn_p in
      '' | .) ;;
      ..) wn_out=${wn_out%/*} ;;
      *) wn_out=$wn_out/$wn_p ;;
    esac
  done
  set +f
  IFS=$wn_ifs
  printf '%s\n' "${wn_out:-/}"
}

# wt_hookspath <worktree> <repository root>: a relative core.hooksPath in the
# repository's config is set to its absolute path from the root (TAe,
# :431550-431566). A failure is reported, as the engine logs it.
wt_hookspath() {
  wh_cd=$(wt_git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || {
    wt_note "core.hooksPath: couldn't find the common git folder of $1, so it was left as it is"
    return 0
  }
  wh_hp=$(git config --file "$wh_cd/config" --get core.hooksPath 2>/dev/null) || return 0
  case $wh_hp in '' | /*) return 0 ;; *"$LT_NL"*) wt_note "core.hooksPath has a newline in it; left as it is"; return 0 ;; esac
  wh_abs=$(wt_norm "$2/$wh_hp")
  wt_git -C "$1" config core.hooksPath "$wh_abs" >/dev/null 2>&1 ||
    wt_note "core.hooksPath: couldn't set it to $wh_abs"
}

# ---------------------------------------------------------------------------
# A litter name: the two paths (section 9, "Run worktrees")

wt_litter() {
  WT_PATH=$WT_ROOT/$WT_NAME
  WT_BRANCH=$(lt_writer_branch "$WT_RUN" "$WT_N")
  WT_LOG=$(lt_setup_log "$WT_RUNDIR" "$WT_NAME")
  lt_id_ok "$WT_SID" || wt_die "the hook input carries no usable session_id, so the records for $WT_NAME can't be spooled; refusing it"
  WT_CANON=$(wt_canon_of "$WT_CO") || wt_die "the run checkout $WT_CO isn't in a git repository; refusing $WT_NAME"
  wl_step=$(wt_marker_step) || exit 1
  case $wl_step in
    none) wt_first ;;
    intent | setup_failed) wt_unfinished ;;
    create) wt_replay ;;
    *) wt_die "wt/$WT_NAME gave no step; refusing it" ;;
  esac
}

# The first request: the intent before git touches anything.
wt_first() {
  wt_spool intent || wt_die "couldn't spool the intent for $WT_NAME, so git didn't run; refusing it"
  wt_mark intent || wt_die "couldn't write wt/$WT_NAME after its intent, so git didn't run; refusing it"
  WT_PENDING=1
  wt_exists "$WT_PATH" && wt_refuse "$WT_PATH exists already, and isn't a worktree litter made for $WT_NAME"
  wt_add_new
  wt_finish
}

# An intent with no create (a crash, a stop or a failed setup between the
# intent and the create): finished without -b. Nothing in the worktree was
# handed to an agent yet, so nothing there is anyone's work.
wt_unfinished() {
  WT_PENDING=1
  wt_facts
  if [ "$WT_AT" = at ]; then
    [ "$WT_AT_BRANCH" = "refs/heads/$WT_BRANCH" ] ||
      wt_refuse "$WT_PATH is a worktree on ${WT_AT_BRANCH:-a detached HEAD}, not on $WT_BRANCH"
    [ "$WT_BSHA" = "$WT_BASE" ] || wt_refuse "$(wt_branch_why)"
    if [ -n "$WT_AT_GONE" ]; then
      wt_remove
      wt_add_branch
    else
      wu_head=$(wt_git -C "$WT_PATH" rev-parse --verify HEAD 2>/dev/null) || wu_head=
      [ "$wu_head" = "$WT_BASE" ] || wt_refuse "$WT_PATH has HEAD at ${wu_head:-nothing}, not at base $WT_BASE"
      wu_st=$(wt_git -C "$WT_PATH" status --porcelain 2>&1) || wt_refuse "git status failed in $WT_PATH: $(wt_one "$wu_st")"
      if [ -n "$wu_st" ] || [ -n "$WT_AT_LOCKED" ]; then
        # A checkout cut off part way leaves files missing, and git's lock on.
        wt_remove
        wt_add_branch
      fi
    fi
  elif [ -n "$WT_BSHA" ]; then
    [ -z "$WT_OTHER" ] || wt_refuse "$WT_BRANCH is checked out at $WT_OTHER; refusing to make $WT_NAME"
    [ "$WT_BSHA" = "$WT_BASE" ] || wt_refuse "$(wt_branch_why)"
    wt_exists "$WT_PATH" && wt_refuse "$WT_PATH exists, but isn't the worktree for $WT_BRANCH"
    wt_add_branch
  else
    wt_exists "$WT_PATH" && wt_refuse "$WT_PATH exists, but isn't the worktree for $WT_BRANCH"
    wt_add_new
  fi
  wt_finish
}

# The steps after the add, for a first or unfinished request: HEAD at base,
# the hooks path, the setup or links, then the create, and only then the path.
wt_finish() {
  wn_real=$(lt_realdir "$WT_PATH") || wt_refuse "can't resolve $WT_PATH after adding it"
  [ "$wn_real" = "$WT_PATH" ] || wt_refuse "$WT_PATH resolves to $wn_real, so it isn't where litter placed it"
  wn_head=$(wt_git -C "$WT_PATH" rev-parse --verify HEAD 2>/dev/null) || wn_head=
  [ "$wn_head" = "$WT_BASE" ] || wt_refuse "$WT_PATH has HEAD at ${wn_head:-nothing}, not at base $WT_BASE"
  wt_hookspath "$WT_PATH" "$WT_CANON"
  wt_setup
  wt_links
  wt_ignored || wt_refuse "git status --ignored failed in $WT_PATH"
  wt_spool create || wt_refuse "couldn't spool the create of $WT_NAME"
  WT_PENDING=0
  wt_mark create || wt_die "couldn't write wt/$WT_NAME after its create; refusing it"
  printf '%s\n' "$WT_PATH" >&3
  exit 0
}

# A replay (a create recorded): a restarted or resumed call asks for the same
# name, so the recorded worktree is reused with whatever the interrupted agent
# left, once its ancestry and state check out.
wt_replay() {
  wt_facts
  if [ "$WT_AT" = at ] && [ -z "$WT_AT_GONE" ]; then
    [ "$WT_AT_BRANCH" = "refs/heads/$WT_BRANCH" ] ||
      wt_die "$WT_PATH is a worktree on ${WT_AT_BRANCH:-a detached HEAD}, not on the recorded $WT_BRANCH; refusing $WT_NAME"
    if [ "$WT_AT_LOCKED" = "locked initializing" ]; then
      # git's own lock: a re-add below was cut off before its checkout ended.
      wt_remove
      wt_readd
    fi
    wt_ancestry "$WT_AT_HEAD"
    wr_u=$(wt_git -C "$WT_PATH" ls-files -u 2>&1) || wt_die "git ls-files failed in $WT_PATH: $(wt_one "$wr_u")"
    [ -z "$wr_u" ] || wt_die "$WT_PATH has unmerged paths; refusing to hand it out again as $WT_NAME"
    wr_gd=$(wt_git -C "$WT_PATH" rev-parse --absolute-git-dir 2>/dev/null) || wt_die "can't find the git folder of $WT_PATH"
    for wr_f in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply; do
      wt_exists "$wr_gd/$wr_f" && wt_die "a merge, rebase, cherry-pick or revert is in progress in $WT_PATH ($wr_f); refusing to hand it out again as $WT_NAME"
    done
    wr_real=$(lt_realdir "$WT_PATH") || wt_die "can't resolve $WT_PATH"
    [ "$wr_real" = "$WT_PATH" ] || wt_die "$WT_PATH resolves to $wr_real, so it isn't where litter placed it; refusing $WT_NAME"
    printf '%s\n' "$WT_PATH" >&3
    exit 0
  fi
  if [ "$WT_AT" = at ]; then
    # Registered, but its folder is gone.
    wt_remove
  elif wt_exists "$WT_PATH"; then
    wt_die "$WT_PATH exists but isn't the recorded worktree for $WT_BRANCH; refusing $WT_NAME"
  fi
  [ -n "$WT_BSHA" ] || wt_die "the recorded worktree $WT_PATH and its branch $WT_BRANCH are both gone; refusing $WT_NAME"
  [ -z "$WT_OTHER" ] || wt_die "$WT_BRANCH is checked out at $WT_OTHER; refusing $WT_NAME"
  wt_ancestry "$WT_BSHA"
  wt_readd
}

# base is an ancestor of <head>, and the branch's fork point is still base.
wt_ancestry() {
  wt_git -C "$WT_CO" merge-base --is-ancestor "$WT_BASE" "$1" 2>/dev/null ||
    wt_die "base $WT_BASE isn't an ancestor of $WT_BRANCH ($1); refusing to hand out $WT_PATH as $WT_NAME"
  wa_mb=$(wt_git -C "$WT_CO" merge-base "$WT_BRANCH" "$WT_BASE" 2>/dev/null) || wa_mb=
  [ "$wa_mb" = "$WT_BASE" ] ||
    wt_die "$WT_BRANCH forks from ${wa_mb:-nothing}, not from base $WT_BASE; refusing to hand out $WT_PATH as $WT_NAME"
}

# A recorded worktree that was gone, added again from its branch, without -b,
# and set up again. Its create stands, so nothing more is spooled.
wt_readd() {
  WT_READD=1
  wt_add_branch
  wd_real=$(lt_realdir "$WT_PATH") || wt_refuse "can't resolve $WT_PATH after adding it again"
  [ "$wd_real" = "$WT_PATH" ] || wt_refuse "$WT_PATH resolves to $wd_real, so it isn't where litter placed it"
  wt_hookspath "$WT_PATH" "$WT_CANON"
  wt_setup
  wt_links
  printf '%s\n' "$WT_PATH" >&3
  exit 0
}

# ---------------------------------------------------------------------------
# Any other name: made as the engine would (vAe, :431085; TAe, :431546)

# The canonical repository root of a folder, as the engine's bs (:60519):
# its top level, or for a linked worktree the primary checkout, or the
# repository folder of a bare one.
wt_canon_of() {
  wc_top=$(wt_git -C "$1" rev-parse --show-toplevel 2>/dev/null) || return 1
  [ -n "$wc_top" ] || return 1
  if [ -f "$wc_top/.git" ]; then
    wc_gd=$(wt_git -C "$wc_top" rev-parse --absolute-git-dir 2>/dev/null) || wc_gd=
    wc_cd=$(wt_git -C "$wc_top" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || wc_cd=
    if [ -n "$wc_gd" ] && [ -n "$wc_cd" ] && [ "$wc_gd" != "$wc_cd" ]; then
      case $wc_cd in
        */.git) wc_top=${wc_cd%/.git} ;;
        *) wt_exists "$wc_cd/.git" || wc_top=$wc_cd ;;
      esac
    fi
  fi
  printf '%s\n' "$wc_top"
}

WT_JQ_WTPOL='
readj(.) as $w
| if ($w | ok1) and ($w.baseRef == "fresh" or $w.baseRef == "head") and ($w.symlinkDirectories | type) == "array" then
    (["ok", $w.baseRef] + [$w.symlinkDirectories[] | select(type == "string" and . != "" and (test("[\\x00-\\x1f]") | not))]) | join("\n")
  elif ($w | ok1) then "bad\nit has no baseRef of fresh or head, or no symlinkDirectories list"
  else "bad\n" + why(.; $w) end
'

# Your merged worktree settings, from worktree.json: WT_BASEREF and
# WT_SYMLINKS. Without the file or jq, the engine's defaults (the fresh base,
# no links), and the skip is named.
wt_settings() {
  WT_BASEREF=fresh
  WT_SYMLINKS=
  if [ -n "$LT_DIR_ERR" ]; then
    wt_note "can't find litter's hooks folder ($LT_DIR_ERR), so worktree.json isn't read: $WT_NAME gets the fresh base and no symlinkDirectories"
    return 0
  fi
  if ! lt_have_jq; then
    wt_note "jq not found, so worktree.json isn't read: $WT_NAME gets the fresh base and no symlinkDirectories"
    return 0
  fi
  if ! wt_exists "$LT_DIR/worktree.json"; then
    wt_note "no worktree.json (the litter mod writes it at session start), so $WT_NAME gets the fresh base and no symlinkDirectories"
    return 0
  fi
  wp_out=$(jq -rRs "$LT_JQ_DEFS$WT_JQ_WTPOL" <"$LT_DIR/worktree.json" 2>/dev/null) || wp_out="bad${LT_NL}it can't be read"
  case $wp_out in
    "ok$LT_NL"*)
      lt_rest=${wp_out#ok"$LT_NL"}
      lt_take
      WT_BASEREF=$lt_t
      WT_SYMLINKS=$lt_rest
      ;;
    *) wt_note "worktree.json is unusable (${wp_out#bad"$LT_NL"}), so $WT_NAME gets the fresh base and no symlinkDirectories" ;;
  esac
}

# The engine's default branch (_T, :60656, and $7r, :61688): origin/HEAD's
# target when that ref resolves, else main or master if origin has it, else main.
wt_default_branch() {
  if wd_ref=$(wt_git -C "$1" symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null); then
    case $wd_ref in
      refs/remotes/origin/?*)
        wd_b=${wd_ref#refs/remotes/origin/}
        if wt_git -C "$1" rev-parse -q --verify "refs/remotes/origin/$wd_b^{commit}" >/dev/null 2>&1; then
          printf '%s\n' "$wd_b"
          return 0
        fi
        ;;
    esac
  fi
  for wd_b in main master; do
    if wt_git -C "$1" rev-parse -q --verify "refs/remotes/origin/$wd_b^{commit}" >/dev/null 2>&1; then
      printf '%s\n' "$wd_b"
      return 0
    fi
  done
  printf 'main\n'
}

# Whether you own a repository root, its .git and its .claude (lstat for the
# last two), as the engine's Xns (:46762) checks before it keeps local
# settings at the canonical root.
wt_owned() {
  wo_uid=$(id -u) || return 1
  [ -n "$(find "$1" -prune -user "$wo_uid" 2>/dev/null)" ] || return 1
  [ -n "$(find "$1/.git" -prune -user "$wo_uid" 2>/dev/null)" ] || return 1
  if wt_exists "$1/.claude"; then
    [ -n "$(find "$1/.claude" -prune -user "$wo_uid" 2>/dev/null)" ] || return 1
  fi
}

# The settings.local.json copy (eJn, :431516). Skipped when your local
# settings resolve to the canonical root (the root isn't your home, and you
# own it), since a copy there would bring back permissions you revoked; for a
# symlinked source; and for a destination a committed link takes outside.
wt_settings_copy() {
  wc_root=$(lt_realdir "$1") || return 0
  wc_home=$(lt_realdir "${HOME:-/nonexistent}") || wc_home=
  if [ "$wc_root" != "$2" ] && [ "$wc_root" != "$wc_home" ] && wt_owned "$wc_root"; then
    return 0
  fi
  wc_src=$1/.claude/settings.local.json
  if [ -L "$wc_src" ]; then
    wt_note "settings.local.json: $wc_src is a symlink, so it isn't copied"
    return 0
  fi
  [ -f "$wc_src" ] || return 0
  wc_dst=$2/.claude/settings.local.json
  if wt_escapes "$wc_dst" "$2"; then
    wt_note "settings.local.json: $wc_dst escapes the worktree through a committed link, so it isn't copied"
    return 0
  fi
  if mkdir -p -- "$2/.claude" && cp -p -- "$wc_src" "$wc_dst.tmp.$$" && mv -f -- "$wc_dst.tmp.$$" "$wc_dst"; then
    return 0
  fi
  rm -f -- "$wc_dst.tmp.$$" 2>/dev/null
  wt_note "settings.local.json: couldn't copy it into $2"
}

# symlinkDirectories (GQn, :430512): absolute and .. entries are skipped, and
# so are a source missing from the root and a destination a link takes out of
# the worktree; one that exists already is left, as the engine leaves it.
wt_symlinks() {
  [ -n "$WT_SYMLINKS" ] || return 0
  while IFS= read -r wy_g; do
    case $wy_g in /*) wt_note "symlinkDirectories: $wy_g is absolute; skipped"; continue ;; esac
    wy_bad=
    wy_ifs=$IFS
    IFS='/\'
    set -f
    for wy_seg in $wy_g; do
      case $wy_seg in ..*) case ${wy_seg#..} in *[!.\ ]*) ;; *) wy_bad=1 ;; esac ;; esac
    done
    set +f
    IFS=$wy_ifs
    if [ -n "$wy_bad" ]; then
      wt_note "symlinkDirectories: $wy_g has a .. part; skipped"
      continue
    fi
    wy_src=$(wt_norm "$1/$wy_g")
    wy_dst=$(wt_norm "$2/$wy_g")
    if wt_escapes "$wy_dst" "$2"; then
      wt_note "symlinkDirectories: $wy_dst escapes the worktree through a committed link; skipped"
      continue
    fi
    if ! wt_exists "$wy_src"; then
      wt_note "symlinkDirectories: $wy_g isn't in $1; skipped"
      continue
    fi
    wt_exists "$wy_dst" && continue
    ln -s -- "$wy_src" "$wy_dst" 2>/dev/null || :
  done <<EOF
$WT_SYMLINKS
EOF
}

# Whether the .worktreeinclude patterns could reach inside an ignored folder
# (ZQn's prefix tests, :431384): a pattern that starts with the folder, one
# whose part before its first glob character the folder starts with, or a
# **/ pattern whose first part names one of the folder's parts.
wt_include_reaches() {
  wr_dir=$1
  wr_low=$(printf '%s' "${wr_dir%/}" | tr '[:upper:]' '[:lower:]')
  while IFS= read -r wr_p; do
    wr_k=${wr_p#/}
    case $wr_k in "$wr_dir"*) return 0 ;; esac
    wr_pre=${wr_k%%[*?[]*}
    if [ -n "$wr_pre" ] && [ "$wr_pre" != "$wr_k" ]; then
      case $wr_dir in "$wr_pre"*) return 0 ;; esac
    fi
    wr_v=$wr_k
    while :; do
      case $wr_v in '**/'*) wr_v=${wr_v#'**/'} ;; *) break ;; esac
    done
    [ "$wr_v" != "$wr_k" ] || continue
    wr_te=${wr_v%%/*}
    wr_tp=${wr_te%%[*?[]*}
    wr_e=$(printf '%s' "$wr_tp" | tr -d '\\' | tr '[:upper:]' '[:lower:]')
    [ -n "$wr_e" ] || continue
    if [ "$wr_tp" = "$wr_te" ]; then
      case /$wr_low/ in */"$wr_e"/*) return 0 ;; esac
    else
      case /$wr_low in */"$wr_e"*) return 0 ;; esac
    fi
  done <<EOF
$WT_INC_PATS
EOF
  return 1
}

# Which ignored folders the patterns match as folders, through git's own
# matcher: an empty scratch repository whose one exclude source is the file.
wt_include_dirs() {
  wd_tmp=${TMPDIR:-/tmp}
  wd_tmp=${wd_tmp%/}/litter-worktreeinclude.$$
  rm -rf -- "$wd_tmp" 2>/dev/null
  mkdir -p -- "$wd_tmp" && wt_git -c init.defaultBranch=main init -q --template= -- "$wd_tmp" >/dev/null 2>&1 || {
    rm -rf -- "$wd_tmp" 2>/dev/null
    return 0
  }
  wd_names=
  while IFS= read -r wd_d; do
    [ -n "$wd_d" ] || continue
    mkdir -p -- "$wd_tmp/$wd_d" 2>/dev/null || continue
    wd_names=$wd_names${wd_d%/}$LT_NL
  done <<EOF
$1
EOF
  if [ -n "$wd_names" ]; then
    printf '%s' "$wd_names" | wt_git -C "$wd_tmp" -c core.excludesFile="$2" -c core.quotePath=false check-ignore --stdin 2>/dev/null
  fi
  rm -rf -- "$wd_tmp" 2>/dev/null
  return 0
}

# The .worktreeinclude copy (ZQn, :431384): files git ignores that the
# file's patterns (gitignore rules) match, copied from the root; a symlinked
# source and a destination a link takes outside the worktree are skipped. A
# name git has to quote is skipped, as the engine can't copy one either.
wt_include() {
  wi_root=$1
  wi_wt=$2
  wi_file=$wi_root/.worktreeinclude
  [ -f "$wi_file" ] || return 0
  WT_INC_PATS=$(sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e '/^$/d' -e '/^#/d' "$wi_file" 2>/dev/null) || return 0
  [ -n "$WT_INC_PATS" ] || return 0
  wi_all=$(wt_git -C "$wi_root" -c core.quotePath=false ls-files --others --ignored --exclude-standard --directory 2>/dev/null) || return 0
  [ -n "$wi_all" ] || return 0
  set --
  wi_dirs=
  while IFS= read -r wi_e; do
    case $wi_e in
      '' | '"'*) ;;
      */) if wt_include_reaches "$wi_e"; then set -- ${1+"$@"} "$wi_e"; else wi_dirs=$wi_dirs$wi_e$LT_NL; fi ;;
      *) set -- ${1+"$@"} "$wi_e" ;;
    esac
  done <<EOF
$wi_all
EOF
  if [ -n "$wi_dirs" ]; then
    wi_match=$(wt_include_dirs "$wi_dirs" "$wi_file")
    while IFS= read -r wi_e; do
      [ -n "$wi_e" ] && set -- ${1+"$@"} "$wi_e/"
    done <<EOF
$wi_match
EOF
  fi
  [ "$#" -gt 0 ] || return 0
  wi_files=$(wt_git -C "$wi_root" -c core.quotePath=false --literal-pathspecs ls-files --others --ignored \
    --exclude-from="$wi_file" -- "$@" 2>/dev/null) || return 0
  while IFS= read -r wi_f; do
    case $wi_f in '' | '"'*) continue ;; esac
    wi_src=$wi_root/$wi_f
    wi_dst=$wi_wt/$wi_f
    if [ -L "$wi_src" ]; then
      wt_note ".worktreeinclude: $wi_f is a symlink, so it isn't copied"
      continue
    fi
    if wt_escapes "$wi_dst" "$wi_wt"; then
      wt_note ".worktreeinclude: $wi_dst escapes the worktree through a committed link, so it isn't copied"
      continue
    fi
    mkdir -p -- "${wi_dst%/*}" && cp -p -- "$wi_src" "$wi_dst" || wt_note ".worktreeinclude: couldn't copy $wi_f"
  done <<EOF
$wi_files
EOF
}

wt_engine() {
  case $WT_CWD in /*) ;; *) wt_die "the hook input's cwd ($WT_CWD) isn't an absolute path, so $WT_NAME has no repository; refusing" ;; esac
  we_root=$(wt_canon_of "$WT_CWD") ||
    wt_die "$WT_CWD isn't in a git repository, so there's nowhere to make $WT_NAME"
  we_slug=$(printf '%s' "$WT_NAME" | tr '/' '+')
  we_path=$we_root/.claude/worktrees/$we_slug
  we_branch=worktree-$we_slug
  for we_l in "$we_root/.claude" "$we_root/.claude/worktrees" "$we_path"; do
    [ ! -L "$we_l" ] || wt_die "$we_l is a symlink, which could take the worktree outside the repository; remove it and retry"
  done
  # An existing worktree of this repository at the path is resumed as it is.
  if [ -f "$we_path/.git" ] && [ ! -L "$we_path/.git" ]; then
    we_line=$(head -n 1 "$we_path/.git" 2>/dev/null) || we_line=
    case $we_line in
      gitdir:*)
        if wt_git -C "$we_path" rev-parse -q --verify HEAD >/dev/null 2>&1; then
          we_gd=$(wt_git -C "$we_path" rev-parse --absolute-git-dir 2>/dev/null) || we_gd=
          we_cd=$(wt_git -C "$we_root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || we_cd=
          we_a=$(lt_realdir "${we_gd%/*}" 2>/dev/null) || we_a=
          we_b=$(lt_realdir "$we_cd/worktrees" 2>/dev/null) || we_b=
          [ -n "$we_a" ] && [ "$we_a" = "$we_b" ] ||
            wt_die "the worktree folder $we_path belongs to a different repository; remove it or choose another name"
          we_real=$(lt_realdir "$we_path") || wt_die "can't resolve $we_path"
          printf '%s\n' "$we_real" >&3
          exit 0
        fi
        ;;
    esac
  fi
  wt_settings
  if [ "$WT_BASEREF" = head ]; then
    we_base=$(wt_git -C "$WT_CWD" rev-parse --verify HEAD 2>/dev/null) || wt_die "can't resolve HEAD in $WT_CWD"
  else
    # origin/<default branch> as the local ref has it, else HEAD. The engine
    # fetches first when FETCH_HEAD is over a day old; a hook can't risk a
    # network wait, so there's no fetch here.
    we_db=$(wt_default_branch "$we_root")
    case $we_db in -*) we_db=HEAD ;; esac
    we_base=$(wt_git -C "$we_root" rev-parse -q --verify "refs/remotes/origin/$we_db^{commit}" 2>/dev/null) ||
      we_base=$(wt_git -C "$we_root" rev-parse --verify HEAD 2>/dev/null) || wt_die "can't resolve a base for $WT_NAME in $we_root"
  fi
  mkdir -p -- "$we_root/.claude/worktrees" || wt_die "can't make $we_root/.claude/worktrees"
  # As the engine's own add: --no-track -B, with the repository's hooks as they are.
  we_out=$(LC_ALL=C git -C "$we_root" worktree add --no-track -B "$we_branch" -- "$we_path" "$we_base" 2>&1) ||
    wt_die "git worktree add $we_path failed: $(wt_one "$we_out")"
  we_real=$(lt_realdir "$we_path") || wt_die "can't resolve $we_path after adding it"
  we_rr=$(lt_realdir "$we_root") || wt_die "can't resolve $we_root"
  [ "$we_real" = "$we_rr/.claude/worktrees/$we_slug" ] ||
    wt_die "$we_path resolved to $we_real, which isn't the expected worktree location $we_rr/.claude/worktrees/$we_slug"
  # The post-create step (TAe), which the engine skips for a hook-made worktree.
  wt_settings_copy "$we_root" "$we_real"
  wt_hookspath "$we_real" "$we_root"
  wt_symlinks "$we_root" "$we_real"
  wt_include "$we_root" "$we_real"
  printf '%s\n' "$we_real" >&3
  exit 0
}

# ---------------------------------------------------------------------------

lt_locate || :
lt_read_input
wt_input
wt_name_ok "$WT_NAME" ||
  wt_die "the worktree name '$WT_NAME' isn't one the engine makes (at most 64 characters, /-separated parts of letters, digits, ., _ and -); refusing"
WT_KIND=other
if WT_RUNID=$(wt_runid_of "$WT_NAME"); then
  if [ -n "$LT_DIR_ERR" ]; then
    wt_die "can't find litter's hooks folder ($LT_DIR_ERR), so litter cannot tell whether $WT_NAME is one of its run worktrees; refusing it"
  elif lt_have_jq; then
    wt_decide
  else
    wt_decide_nojq
  fi
fi
case $WT_KIND in
  litter) wt_litter ;;
  *) wt_engine ;;
esac
wt_die "no worktree was made for $WT_NAME"
