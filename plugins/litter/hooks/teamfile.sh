#!/bin/sh
# teamfile.sh: writes one of the engine's task or inbox files under the
# engine's own lock (phase 5; COMMON decisions 4 and 5). hooks/team/store.ts
# runs it; $.fs has no mkdir, rename or remove, and $.fs.write takes no lock.
# Owner: WP-CE.
#
#   sh teamfile.sh task-update <file> [--stale-before <CCYYMMDDhhmm.SS>]  < patch
#   sh teamfile.sh inbox-append <file> [--stale-before <CCYYMMDDhhmm.SS>] < entry
#
# The change is JSON on stdin: a patch of `subject`, `description`, `status`
# and `owner` (null removes the key), or one inbox entry. The lock is
# proper-lockfile's, as 2.1.289 takes it: the directory `<file>.lock`, made
# with mkdir (a task's beside the file's real path, an inbox's beside the path
# as given, its `lockfilePath`). It's retried for up to 5 s. A lock no newer
# than --stale-before (the mod passes its now less 10 s, UTC, in `touch -t`
# form, since its age can't be read portably here) is stale, and is broken the
# way proper-lockfile breaks one: rmdir, then one more mkdir. The new text
# goes to a temporary file in the same folder that no `*.json` glob matches,
# then `mv` over the file.
#
# Prints one JSON line, {"ok":true} or {"ok":false,"error":"..."}, and exits
# 0; it exits 2 only for a usage error. A file that isn't JSON, or isn't a
# task or an inbox, is refused and left as it was. POSIX sh plus jq.

usage() {
  printf 'usage: sh teamfile.sh task-update|inbox-append <absolute .json file> [--stale-before <CCYYMMDDhhmm.SS>]\n' >&2
  exit 2
}

[ $# -eq 2 ] || [ $# -eq 4 ] || usage
mode=$1
file=$2
case $mode in task-update | inbox-append) ;; *) usage ;; esac
case $file in /*.json) ;; *) usage ;; esac
cutoff=
if [ $# -eq 4 ]; then
  [ "$3" = --stale-before ] || usage
  cutoff=$4
  case $cutoff in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].[0-9][0-9]) ;;
    *) usage ;;
  esac
fi

lock=
locked=
tmp=
ref=
cleanup() {
  [ -z "$tmp" ] || rm -f "$tmp"
  [ -z "$ref" ] || rm -f "$ref"
  [ -z "$locked" ] || rmdir "$lock" 2>/dev/null
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# answer ok | answer <why>: the one line, then exit 0 (the trap cleans up).
answer() {
  if [ "$1" = ok ]; then
    printf '{"ok":true}\n'
  else
    jq -cn --arg e "$1" '{ok: false, error: $e}' 2>/dev/null || printf '{"ok":false,"error":"teamfile.sh failed"}\n'
  fi
  exit 0
}

if ! command -v jq >/dev/null 2>&1; then
  printf '{"ok":false,"error":"jq is not on PATH, so nothing was written"}\n'
  exit 0
fi
input=$(cat) || answer "the change on stdin couldn't be read"

dir=${file%/*}
base=${file##*/}
stem=${base%.json}
case $mode in
  task-update)
    case $stem in '' | *[!0-9]*) answer "$base isn't a task file's name (<id>.json)" ;; esac
    what="task #$stem"
    # The patch: only the four fields the pane edits, each of the engine's type.
    printf '%s' "$input" | jq -e '
      type == "object" and length > 0
      and ((keys - ["subject", "description", "status", "owner"]) | length) == 0
      and ((has("subject") | not) or (.subject | type) == "string")
      and ((has("description") | not) or (.description | type) == "string")
      and ((has("status") | not) or .status == "pending" or .status == "in_progress" or .status == "completed")
      and ((has("owner") | not) or .owner == null or ((.owner | type) == "string" and .owner != ""))' >/dev/null 2>&1 ||
      answer 'the patch must set subject, description, status (pending, in_progress, completed) or owner (a name, or null), and nothing else'
    [ -d "$dir" ] || answer "the task list folder $dir isn't there"
    ;;
  inbox-append)
    case $base in .*) answer "$base isn't an inbox file's name" ;; esac
    [ -n "$stem" ] || answer "$base isn't an inbox file's name"
    what='the inbox'
    printf '%s' "$input" | jq -e '
      type == "object"
      and ((keys - ["from", "text", "timestamp", "summary", "color", "type", "read"]) | length) == 0
      and (.from | type) == "string" and (.text | type) == "string" and (.timestamp | type) == "string"
      and ((has("summary") | not) or (.summary | type) == "string")
      and ((has("color") | not) or (.color | type) == "string")
      and ((has("type") | not) or (.type | type) == "string")
      and ((has("read") | not) or (.read | type) == "boolean")' >/dev/null 2>&1 ||
      answer 'the entry must have from, text and timestamp (strings), and only summary, color, type or read besides'
    if [ ! -d "$dir" ]; then
      # The engine makes a team's inboxes/ folder at its first message; the team's folder must be there.
      [ "${dir##*/}" = inboxes ] && [ -d "${dir%/*}" ] || answer "the team folder ${dir%/*} isn't there"
      mkdir "$dir" 2>/dev/null || [ -d "$dir" ] || answer "the inbox folder $dir couldn't be made"
    fi
    ;;
esac
[ ! -h "$file" ] || answer "$file is a symbolic link, so it was left alone"
if [ "$mode" = task-update ]; then
  [ -f "$file" ] || answer "$what isn't there ($file)"
  # proper-lockfile resolves the file's real path and locks beside it.
  real=$(cd -P "$dir" 2>/dev/null && pwd -P) || answer "the folder $dir couldn't be resolved"
  lock=$real/$base.lock
else
  lock=$file.lock
fi

# stale: whether the lock is no newer than the cutoff (UTC), by find -newer.
stale() {
  ref=${TMPDIR:-/tmp}/teamfile-ref.$$
  TZ=UTC0 touch -t "$cutoff" "$ref" 2>/dev/null || return 1
  st_old=$(find "$lock" -prune ! -newer "$ref" -print 2>/dev/null)
  rm -f "$ref"
  ref=
  [ -n "$st_old" ]
}

tenths=0
while :; do
  if mkdir "$lock" 2>/dev/null; then
    locked=1
    break
  fi
  if [ ! -d "$lock" ]; then
    # Released in between, or it can't be made at all.
    if mkdir "$lock" 2>/dev/null; then
      locked=1
      break
    fi
    [ -d "$lock" ] || answer "the lock $lock couldn't be made"
  fi
  if [ -n "$cutoff" ] && stale; then
    rmdir "$lock" 2>/dev/null
    if mkdir "$lock" 2>/dev/null; then
      locked=1
      break
    fi
  fi
  [ "$tenths" -lt 50 ] || answer "$what is locked by another writer ($lock): nothing was written; try again"
  if sleep 0.1 2>/dev/null; then
    tenths=$((tenths + 1))
  else
    sleep 1
    tenths=$((tenths + 10))
  fi
done

tmp=$dir/.$base.teamfile.$$
if [ "$mode" = task-update ]; then
  # 0: one task, 1: JSON but not a task, anything else: not JSON.
  jq -s -e '
    length == 1 and (.[0] | type == "object"
      and (.id | type) == "string" and (.subject | type) == "string" and (.description | type) == "string"
      and (.status == "pending" or .status == "in_progress" or .status == "completed")
      and (.blocks | type) == "array" and (.blockedBy | type) == "array")' "$file" >/dev/null 2>&1
  case $? in
    0) ;;
    1) answer "$file isn't a task file, so it was left as it was" ;;
    *) answer "$file isn't JSON, so it was left as it was" ;;
  esac
  # Only the patch's fields change; every other field stays as it was.
  printf '%s' "$input" | (set -C && jq --slurpfile cur "$file" '
    . as $p
    | $cur[0] + ($p | del(.owner))
    | if ($p | has("owner")) then (if $p.owner == null then del(.owner) else .owner = $p.owner end) else . end' >"$tmp") 2>/dev/null ||
    answer "$what couldn't be written: nothing was changed"
else
  if [ -f "$file" ]; then
    jq -s -e 'length == 1 and (.[0] | type == "array")' "$file" >/dev/null 2>&1
    case $? in
      0) ;;
      1) answer "$file isn't an inbox (a JSON array), so it was left as it was" ;;
      *) answer "$file isn't JSON, so it was left as it was" ;;
    esac
    printf '%s' "$input" | (set -C && jq --slurpfile cur "$file" '$cur[0] + [.]' >"$tmp") 2>/dev/null ||
      answer "the inbox couldn't be written: nothing was changed"
  else
    printf '%s' "$input" | (set -C && jq '[.]' >"$tmp") 2>/dev/null ||
      answer "the inbox couldn't be written: nothing was changed"
  fi
fi
mv -f "$tmp" "$file" 2>/dev/null || answer "$what couldn't be moved into place: nothing was changed"
tmp=
answer ok
