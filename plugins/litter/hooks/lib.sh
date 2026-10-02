# lib.sh: what the command hooks share (plan section 10). Sourced, never run.
#
# POSIX sh only, so it runs under BusyBox sh, dash and macOS sh: no bash-isms,
# no GNU-only flags. The hooks run jq, POSIX tools and readlink, nothing else:
# no value from a hook's input, a model or the repo becomes a command, and
# input values reach jq on stdin or through --arg (plan section 9, "Mod
# safety"). Names start with lt_ or LT_, so a script's own can't clash.
#
# The paths below mirror hooks/layout.ts, its hooks/ part (plan section 9,
# "Mod-to-hook state"). Keep the two identical:
#   <hooks>/active  policy.json  worktree.json  agents/<id>.json  out/<id>.json
#   <hooks>/bind/<id>  mode  wt/<name>  spool/<session_id>.jsonl  spool/blobs/<name>.json
#   $CLAUDE_PROJECT_DIR/.claude/litter/hooks/pointer
# and, for worktree.sh, the run's setup log and its writers' branches
# (lt_wt_marker, lt_setup_log, lt_writer_branch below):
#   <runDir>/verify/setup-<name>/0001.log  litter/<run>-w<n>
#
# How a script fails (plan section 9, "Fail closed"): its work runs in a
# subshell (lt_run), so set -u or a failed step ends only that subshell, and
# lt_finish turns no decision into exit 2 for a litter agent's PreToolUse call
# and exit 0 for anyone else's. Only PreToolUse denies. The other events never
# exit 2: on SubagentStop it would keep the agent running, on UserPromptSubmit
# it would drop the prompt. They report a failure on stderr with exit 1
# (lt_note), and the guard refuses whatever that left unbound.

LT_PREFIX='litter guard:'
LT_NOJQ='litter: jq not found; install it, or stop the run'
LT_NL='
'
LT_MAX_IN=8388608   # bytes; a bigger input is cut, doesn't parse, and so denies a litter agent
LT_READ_SECS=3      # the read never waits longer (deepwork 2.0.1: a bare cat can hang a session)
LT_LINE_MAX=4000    # bytes; a spool line stays under 4 KiB, so one >> writes it whole
LT_IN=
LT_CUT=

# hooks/ from $CLAUDE_PROJECT_DIR, following the mod's pointer when the session
# started in a linked worktree. Sets LT_DIR, or LT_DIR_ERR and fails. Builtins
# only, since this runs before every tool call.
lt_locate() {
  LT_DIR=
  LT_DIR_ERR=
  case ${CLAUDE_PROJECT_DIR:-} in
    /*) ;;
    *) LT_DIR_ERR='CLAUDE_PROJECT_DIR is not an absolute path'; return 1 ;;
  esac
  LT_DIR=${CLAUDE_PROJECT_DIR%/}/.claude/litter/hooks
  [ -e "$LT_DIR/pointer" ] || return 0
  lt_ptr=
  if [ -r "$LT_DIR/pointer" ]; then
    IFS= read -r lt_ptr <"$LT_DIR/pointer" 2>/dev/null
  fi
  case $lt_ptr in
    /*) ;;
    *) LT_DIR_ERR="$LT_DIR/pointer doesn't hold an absolute path"; return 1 ;;
  esac
  lt_ptr=${lt_ptr%/}
  # layout.ts has the pointer name hooks/, the plan's section 9 litterDir: take either.
  case $lt_ptr in
    */hooks) LT_DIR=$lt_ptr ;;
    *) LT_DIR=$lt_ptr/hooks ;;
  esac
  [ -d "$LT_DIR" ] || { LT_DIR_ERR="the pointer names $LT_DIR, which isn't a folder"; return 1; }
}

# The fast path, then the one read. With nothing active a hook costs one sh and
# one stat, and never reads its input or starts jq. When hooks/ can't be found,
# nobody can say whether a run is active, so the script goes on and refuses
# litter agents (LT_DIR_ERR).
lt_begin() {
  if lt_locate; then
    [ -f "$LT_DIR/active" ] || exit 0
  fi
  lt_read_input
}

# The one bounded read of the hook's input: at most LT_MAX_IN bytes, for at
# most LT_READ_SECS seconds. An async list reads /dev/null unless told
# otherwise, hence fd 3. A cut input doesn't parse, which denies. A read cut
# by the clock may have kept nothing, so the watchdog appends a line no
# compact JSON holds, and LT_CUT makes lt_raw_litter treat the unknown caller
# as a litter agent: refused, not passed.
lt_read_input() {
  LT_IN=$(
    exec 3<&0
    head -c "$LT_MAX_IN" <&3 2>/dev/null &
    lt_r=$!
    (
      sleep "$LT_READ_SECS" 4>&- &
      lt_s=$!
      trap 'kill "$lt_s" 2>/dev/null; exit 0' TERM
      wait "$lt_s"
      # The mark before the kill: the moment head is gone, this is killed.
      printf '\n%s\n' 'litter: the read timed out' >&4
      kill "$lt_r" 2>/dev/null
    ) </dev/null 4>&1 >/dev/null 2>&1 &
    lt_w=$!
    wait "$lt_r" 2>/dev/null
    kill "$lt_w" 2>/dev/null
  )
  LT_CUT=
  case $LT_IN in *"${LT_NL}litter: the read timed out"*) LT_CUT=1 ;; esac
}

# A litter agent, recognised without jq (plan section 9, "jq missing"). The
# engine's input is compact JSON, and a nested string's quotes are escaped, so
# this matches the caller's own agent_type. A read cut by the clock counts too.
lt_raw_litter() {
  [ -z "$LT_CUT" ] || return 0
  case $LT_IN in *'"agent_type":"litter:'*) return 0 ;; esac
  return 1
}

lt_have_jq() { command -v jq >/dev/null 2>&1; }

# An id that's safe as a file name: agent, session and tool_use ids.
lt_id_ok() {
  case $1 in '' | *[!A-Za-z0-9_-]*) return 1 ;; esac
  [ "${#1}" -le 128 ]
}

lt_mkdir() { [ -d "$1" ] || mkdir -p -- "$1" 2>/dev/null; }

# layout.ts's wtMarkerPath, setupLogPart and writerBranch.
lt_wt_marker() { printf '%s\n' "$LT_DIR/wt/$1"; }
lt_setup_log() { printf '%s\n' "${1%/}/verify/setup-$2/0001.log"; }
lt_writer_branch() { printf '%s\n' "litter/$1-w$2"; }

# The resolved path of a target that may not exist yet (plan section 9,
# "Guard"): a final link is followed with readlink, up to 40 links, and the
# nearest folder that exists is resolved with cd -P and pwd -P, which follows
# every link and folds . and .. physically, as the kernel will. The missing
# part is appended; none of it can be a link, and an empty, . or .. part is
# refused. Fails for anything it can't place.
lt_realpath() {
  lt_p=$1
  lt_links=0
  while :; do
    case $lt_p in /*) ;; *) return 1 ;; esac
    lt_name=${lt_p##*/}
    lt_dir=${lt_p%/*}
    [ -n "$lt_dir" ] || lt_dir=/
    case $lt_name in '' | . | ..) return 1 ;; esac
    [ -L "$lt_p" ] || break
    lt_links=$((lt_links + 1))
    [ "$lt_links" -le 40 ] || return 1
    lt_to=$(readlink "$lt_p") || return 1
    case $lt_to in
      '') return 1 ;;
      /*) lt_p=$lt_to ;;
      *) lt_p=${lt_dir%/}/$lt_to ;;
    esac
  done
  lt_tail=$lt_name
  while [ ! -d "$lt_dir" ]; do
    # Something that isn't a folder, or a dangling link, on the way.
    if [ -e "$lt_dir" ] || [ -L "$lt_dir" ]; then return 1; fi
    lt_part=${lt_dir##*/}
    case $lt_part in '' | . | ..) return 1 ;; esac
    lt_tail=$lt_part/$lt_tail
    lt_dir=${lt_dir%/*}
    [ -n "$lt_dir" ] || lt_dir=/
  done
  lt_real=$(cd -P "$lt_dir" 2>/dev/null && pwd -P) || return 1
  case $lt_real in /*) ;; *) return 1 ;; esac
  printf '%s\n' "${lt_real%/}/$lt_tail"
}

# A folder's resolved path, with no trailing slash.
lt_realdir() {
  lt_real=$(cd -P "$1" 2>/dev/null && pwd -P) || return 1
  case $lt_real in /*) printf '%s\n' "${lt_real%/}" ;; *) return 1 ;; esac
}

# Writes <text> and a newline to <path> through a temp file beside it and mv,
# so a reader sees the old file or the new one, never half of one.
lt_write() {
  lt_tmp=$1.tmp.$$
  if printf '%s\n' "$2" >"$lt_tmp" 2>/dev/null && mv -f -- "$lt_tmp" "$1" 2>/dev/null; then
    return 0
  fi
  rm -f -- "$lt_tmp" 2>/dev/null
  return 1
}

# Appends one spool line, a compact JSON object, for <session_id>. A line of
# 4 KiB or more goes whole to spool/blobs/<name>.json, and the line appended
# instead names it in `file` (a bare name under spool/blobs/), keeping ev and
# the ids (hookfiles.ts, SpoolLine).
lt_spool() {
  lt_sid=$1
  lt_line=$2
  lt_id_ok "$lt_sid" || return 1
  lt_mkdir "$LT_DIR/spool" || return 1
  lt_bytes=$(printf '%s' "$lt_line" | wc -c) || return 1
  if [ $((lt_bytes)) -ge "$LT_LINE_MAX" ]; then
    lt_mkdir "$LT_DIR/spool/blobs" || return 1
    LT_SEQ=$((${LT_SEQ:-0} + 1))
    lt_blob=$(date +%s)-$$-$LT_SEQ.json
    lt_write "$LT_DIR/spool/blobs/$lt_blob" "$lt_line" || return 1
    lt_line=$(printf '%s' "$lt_line" | jq -c --arg f "$lt_blob" \
      'with_entries(select(.key == "v" or .key == "ev" or .key == "ts" or .key == "session_id" or .key == "agent_id" or .key == "agent_type" or .key == "tool" or .key == "tool_use_id")) + {file: $f}') || return 1
  fi
  printf '%s\n' "$lt_line" >>"$LT_DIR/spool/$lt_sid.jsonl"
}

# PreToolUse, the deny decision, its reason shown to the agent (exit 0).
lt_deny() {
  if lt_have_jq && jq -cn --arg r "$1" \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'; then
    exit 0
  fi
  lt_block "$1"
}

# PreToolUse, exit 2 with the reason on stderr: blocks without needing jq.
lt_block() {
  printf '%s\n' "$1" >&2
  exit 2
}

# Every other event: a failure on stderr, exit 1, never blocking.
lt_note() {
  printf 'litter: %s\n' "$1" >&2
  exit 1
}

# Runs a script's work, "$@", in a subshell. The work prints `step <what>` and
# `who litter|other` lines as it goes, then its decision, one value per line:
# a verb, then the text, the session id and the spool lines it needs. Leaves
# LT_STEP, LT_WHO and LT_L1..LT_L5, the decision's lines (all empty when the
# work failed or decided nothing).
lt_run() {
  lt_res=$("$@")
  lt_rc=$?
  LT_STEP=start
  LT_WHO=
  lt_rest=$lt_res
  lt_out=
  while [ -n "$lt_rest" ]; do
    lt_take
    case $lt_t in
      'step '*) LT_STEP=${lt_t#step } ;;
      'who '*) LT_WHO=${lt_t#who } ;;
      *) lt_out=$lt_t$LT_NL$lt_rest; break ;;
    esac
  done
  [ "$lt_rc" -eq 0 ] || lt_out=
  lt_rest=$lt_out
  lt_take; LT_L1=$lt_t
  lt_take; LT_L2=$lt_t
  lt_take; LT_L3=$lt_t
  lt_take; LT_L4=$lt_t
  lt_take; LT_L5=$lt_t
}

lt_take() {
  lt_t=${lt_rest%%"$LT_NL"*}
  case $lt_rest in
    *"$LT_NL"*) lt_rest=${lt_rest#*"$LT_NL"} ;;
    *) lt_rest= ;;
  esac
}

# Acts on a PreToolUse decision from lt_run:
#   pass                                  exit 0, nothing printed
#   deny|block, reason, sid, spool lines  the lines spooled, then the deny (block: exit 2)
#   spool, -, sid, line                   the line spooled (else refused), exit 0
#   fill, hook output, sid, line          the line spooled (else refused), the output printed
# With no decision, a litter agent's call is refused naming the step, and
# anyone else's passes.
lt_finish() {
  case $LT_L1 in
    pass) exit 0 ;;
    deny | block)
      [ -z "$LT_L4" ] || lt_spool "$LT_L3" "$LT_L4" || :
      [ -z "$LT_L5" ] || lt_spool "$LT_L3" "$LT_L5" || :
      [ "$LT_L1" = block ] || lt_deny "$LT_L2"
      lt_block "$LT_L2"
      ;;
    spool | fill)
      lt_spool "$LT_L3" "$LT_L4" || lt_block "litter guard failed: spooling the result; refusing (retry once)"
      [ "$LT_L1" = spool ] || printf '%s\n' "$LT_L2"
      exit 0
      ;;
  esac
  if [ "$LT_WHO" = litter ] || { [ -z "$LT_WHO" ] && lt_raw_litter; }; then
    [ -z "$LT_CUT" ] || lt_block "litter guard failed: the hook input did not arrive within $LT_READ_SECS s; refusing"
    lt_block "litter guard failed: $LT_STEP; refusing"
  fi
  exit 0
}

# The work's answer when it can't go on: no hooks folder, or no jq. A litter
# agent's call is refused, anyone else's passes.
lt_cant() {
  if lt_raw_litter; then
    printf 'who litter\nblock\n%s\n' "$1"
  else
    printf 'who other\npass\n'
  fi
}

# How jq gets a shared file: `--rawfile <name> <path>` when it exists, else
# `--arg <name> ""`, so the program tells a missing file from a bad one, and a
# file that can't be read fails the jq call. Sets LT_FF (the flag) and LT_FV.
lt_file() {
  if [ -f "$1" ]; then
    LT_FF=--rawfile
    LT_FV=$1
  else
    LT_FF=--arg
    LT_FV=
  fi
}

# jq definitions every script's program starts with. No single quotes inside:
# they live in a single-quoted sh string, so messages avoid contractions.
LT_JQ_DEFS='
def str: if type == "string" then . else "" end;
def line: str | gsub("[\\r\\n\\t]"; " ");
def okid: str | test("^[A-Za-z0-9_-]{1,128}$");
def sid($in): if $in.session_id | okid then $in.session_id else "" end;
def readj($t): if $t == "" then null else (try ($t | fromjson) catch "unparsable") end;
def ok1: type == "object" and .v == 1;
def why($t; $j): if $t == "" then "missing" elif $j == "unparsable" then "it does not parse"
  elif ($j | type) != "object" then "not a JSON object" else "not version 1" end;
def ts: now | floor;
def orNull: if . == "" then null else . end;
def denyline($in; $r): {v: 1, ev: "deny", ts: ts, session_id: ($in.session_id | str),
  agent_id: ($in.agent_id | str | orNull), agent_type: ($in.agent_type | str | orNull),
  tool: ($in.tool_name | str), tool_use_id: ($in.tool_use_id | str), reason: $r} | tojson;
def out($in; $m; $extra): ($GP + " " + ($m | line)) as $r
  | (["deny", $r, sid($in)] + [$extra[] | tojson] + [denyline($in; $r)]) | join("\n");
def deny($in; $m): out($in; $m; []);
'
