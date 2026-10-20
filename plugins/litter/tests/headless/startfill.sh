#!/bin/sh
# Tier 4: a repair swarm's start the lead's turn didn't make (WP-AS), for the
# steps of execute.sh bridge auto and repair.sh auto. litter submits the
# start to the lead after the notification turn; when that turn ends with no
# orchestrator spawned (the skill or the spawn refused), it puts
# /litter:swarm start <swarm> in the prompt box and records a swarm.event
# start-filled { filled } in the swarm's launch ledger. Read from the case's
# litter folder <ld> (repo/.claude/litter), its one run and its repair swarm:
#
#   sh tests/headless/startfill.sh enter <ld> <mark>
#       drive.exp keysh's keys: prints `enter` once a start-filled with
#       filled: true is recorded (and makes <mark>, so Enter is pressed
#       once), and nothing while it waits. Exits 1, ending the keysh, once
#       there's nothing more to press: <mark> exists, or an orchestrator was
#       spawned. The step's own condition before it ends it on the land or
#       the run's end.
#   sh tests/headless/startfill.sh stalled <ld>
#       exits 0 when no orchestrator was spawned within H_STALL_S seconds
#       (default 600) of the fill, or of run.repair when there's no fill, so
#       the long wait ends and the checks report it; 1 otherwise, and before
#       run.repair.
#   sh tests/headless/startfill.sh how <ld>
#       prints which way the swarm started, for an info line: on the lead's
#       turn, or on your Enter after litter filled the start line (a
#       start-filled event before the orchestrator's swarm.node).
#
# POSIX sh and jq. Nothing goes to stderr: drive.exp reads it as a failure.

mode=${1:-}
ld=${2:-}
[ -n "$ld" ] || exit 2

# The repair swarm's launch ledger: its first launch's ledger folder, or nothing.
ledger_dir() {
  for d in "$ld"/swarms/repair-*/launches/*/ledger; do
    [ -d "$d" ] && { printf '%s\n' "$d"; return 0; }
  done
  return 1
}
# Its records, sorted by seq, as one JSON list; [] when there are none.
records() {
  d=$(ledger_dir) || { echo '[]'; return 0; }
  set -- "$d"/*.json
  [ -f "$1" ] || { echo '[]'; return 0; }
  cat "$@" 2>/dev/null | jq -s -c 'sort_by(.seq)' 2>/dev/null
}

case $mode in
enter)
  mark=${3:-}
  [ -n "$mark" ] || exit 2
  [ -f "$mark" ] && exit 1
  r=$(records) || exit 0
  printf '%s' "$r" | jq -e 'any(.[]; .kind == "swarm.node" and .body.kind == "orchestrator")' >/dev/null 2>&1 && exit 1
  if printf '%s' "$r" | jq -e 'any(.[]; .kind == "swarm.event" and .body.kind == "start-filled" and .body.filled == true)' >/dev/null 2>&1; then
    : >|"$mark" 2>/dev/null
    echo enter
  fi
  exit 0
  ;;
stalled)
  set -- "$ld"/2*/ledger/*-run.repair.json
  [ -f "$1" ] || exit 1
  repair_at=$(jq -r '.at / 1000 | floor' "$1" 2>/dev/null) || exit 1
  r=$(records) || exit 1
  # Any orchestrator bound: the swarm started.
  n=$(printf '%s' "$r" | jq '[.[] | select(.kind == "swarm.node" and .body.kind == "orchestrator")] | length' 2>/dev/null) || exit 1
  [ "$n" = 0 ] || exit 1
  fill_at=$(printf '%s' "$r" | jq -r 'map(select(.kind == "swarm.event" and .body.kind == "start-filled")) | first | if . == null then "" else .at / 1000 | floor end' 2>/dev/null) || exit 1
  since=${fill_at:-$repair_at}
  case $since in '' | *[!0-9]*) exit 1 ;; esac
  now=$(date +%s 2>/dev/null) || exit 1
  [ $((now - since)) -ge "${H_STALL_S:-600}" ]
  ;;
how)
  if ! ledger_dir >/dev/null; then
    echo 'no repair swarm was made'
    exit 0
  fi
  r=$(records) || r='[]'
  w=$(printf '%s' "$r" | jq -r '
    (map(select(.kind == "swarm.event" and .body.kind == "start-filled")) | first) as $f
    | (map(select(.kind == "swarm.node" and .body.kind == "orchestrator")) | first) as $o
    | if $o == null then
        (if $f == null then "the swarm never started: no orchestrator was spawned, and litter filled no start line"
         else "the swarm never started: litter filled the start line (filled: \($f.body.filled)), and no orchestrator was spawned" end)
      elif $f == null or $f.seq > $o.seq then "the swarm started on the lead'"'"'s turn"
      elif $f.body.filled == true then "the swarm started on your Enter, after litter filled the start line (the lead'"'"'s start was refused)"
      else "the swarm started after litter tried to fill the start line, which the prompt box didn'"'"'t take (the lead'"'"'s start was refused)" end' 2>/dev/null) ||
    w="the launch ledger couldn't be read"
  printf '%s\n' "$w"
  ;;
*) exit 2 ;;
esac
