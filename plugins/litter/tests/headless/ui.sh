#!/bin/sh
# Tier 4: the screen of a case's interactive session, for phase 5's cases
# (ui-*.sh) and their drive.exp steps. fixtures/screen.ts rebuilds the screen
# from <dir>/tty.txt (drive.exp's transcript), as it stood at the last whole
# frame, since the engine rewrites only the cells that changed and a grep of
# the raw bytes can't tell a row still drawn from one that's gone. Needs bun.
#
#   sh tests/headless/ui.sh mark <dir> <name>
#       notes the transcript's size and the time in <dir>/marks/<name> ("<bytes> <epoch s>"),
#       so a check reads the screen as it stood then. Always exits 0
#   sh tests/headless/ui.sh screen <dir> [<name>]
#       prints the screen, one row a line: at the mark <name>, else now
#   sh tests/headless/ui.sh shows <dir> <ERE> [<name>]
#       exits 0 when a row of that screen matches the extended regex
#   sh tests/headless/ui.sh at <dir> <text> [<anchor>]
#       prints the column and row (1-based) of <text> on the screen now, the
#       lowest row holding it; nothing, and exit 1, when it isn't there. With
#       <anchor>, only right of where it shows (a docked pane's header)
#   sh tests/headless/ui.sh when <dir> <name>
#       prints the mark's epoch seconds
#
# POSIX sh. Nothing goes to stderr: drive.exp reads it as a failure.

here=$(cd "$(dirname "$0")" && pwd)
op=${1:-}
dir=${2:-}
[ -n "$op" ] && [ -n "$dir" ] || exit 2
tty=$dir/tty.txt

# The byte count a mark noted, or `all`.
bytes_at() {
  if [ -n "${1:-}" ]; then
    b=$(cut -d' ' -f1 "$dir/marks/$1" 2>/dev/null)
    case $b in '' | *[!0-9]*) return 1 ;; esac
    printf '%s\n' "$b"
  else
    echo all
  fi
}

screen() {
  [ -f "$tty" ] || return 1
  at=$(bytes_at "${1:-}") || return 1
  bun "$here/fixtures/screen.ts" "$tty" "$at" 2>/dev/null
}

case $op in
mark)
  [ -n "${3:-}" ] || exit 2
  mkdir -p "$dir/marks" 2>/dev/null
  n=$(wc -c <"$tty" 2>/dev/null | tr -dc 0-9)
  printf '%s %s\n' "${n:-0}" "$(date +%s)" >|"$dir/marks/$3" 2>/dev/null
  exit 0
  ;;
screen) screen "${3:-}" ;;
shows)
  [ -n "${3:-}" ] || exit 2
  s=$(screen "${4:-}") || exit 1
  printf '%s\n' "$s" | grep -Eq -- "$3"
  ;;
at)
  [ -n "${3:-}" ] && [ -f "$tty" ] || exit 1
  if [ -n "${4:-}" ]; then
    bun "$here/fixtures/screen.ts" "$tty" all --at "$3" --in "$4" 2>/dev/null
  else
    bun "$here/fixtures/screen.ts" "$tty" all --at "$3" 2>/dev/null
  fi
  ;;
when)
  t=$(cut -d' ' -f2 "$dir/marks/${3:-}" 2>/dev/null)
  case $t in '' | *[!0-9]*) exit 1 ;; esac
  printf '%s\n' "$t"
  ;;
*) exit 2 ;;
esac
