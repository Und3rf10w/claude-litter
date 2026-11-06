#!/bin/sh
# Tier 4: a ledger as long as a busy swarm's, read under the 2 s refresh, in
# an interactive session drive.exp types into:
#
#   sh tests/headless/ui-ledger.sh
#
# The repo holds one run whose ledger has 1650 chained records of about 4 KB
# (fixtures/bigledger.ts make), as long as the swarm launch ledger whose full
# re-reads overran litter's hooks until the engine killed the hooks worker.
# The session opens the run in the board (/litter runs <run>), and a grower
# appends a record every second for a minute and a half: each moves the
# ledger folder, so each tick re-reads the run. The session's store has no
# head for the scratch path, so the ledger reads as another store's, and
# every record is adopted.
#
# The checks: the board still draws the run at the end, the debug log names
# a whole walk of that ledger at most three times (its first read, then one
# a minute: ledgercore's LedgerReadCache), no ui tick is logged as slow but
# the first few, and nothing of litter overran its signal or was counted as a
# runaway. No model turn: it spends no tokens past the session's start.
#
# H_DRY=1 stops once the repo and the steps are made. H_CHECKS=<case folder>
# runs the checks again on a folder an earlier run left. Needs expect and bun.

set -u
. "$(dirname "$0")/lib.sh"

command -v expect >/dev/null || { echo "$0: needs expect" >&2; exit 2; }
command -v bun >/dev/null || { echo "$0: needs bun" >&2; exit 2; }

RECORDS=${LEDGER_RECORDS:-1650}
GROW_S=90

if [ -n "${H_CHECKS:-}" ]; then
  H_DIR=$(cd -P "$H_CHECKS" && pwd -P) || exit 2
  H_CASE=${H_DIR##*/}
  H_REPO=$H_DIR/repo
  RUN=$(cat "$H_DIR/run-id" 2>/dev/null)
else
  # A fresh path each run: $.store keeps ledger heads by their absolute paths.
  h_scratch "ui-ledger-$(date +%Y%m%d-%H%M%S)"
  RUN=$(date +%Y%m%d)-replay-$(od -An -N3 -tx1 /dev/urandom | tr -dc 0-9a-f)
  printf '%s\n' "$RUN" >|"$H_DIR/run-id"
fi
R=$H_REPO
LD=$R/.claude/litter
RD=$LD/$RUN
UI="sh $H_HERE/ui.sh"
# The run's body in the board, not the prompt that named it: a ledger with no head here is another store's (board/view.ts).
BODY="not this store.s: driven by another host"

if [ -z "${H_CHECKS:-}" ]; then
  bun "$H_FIX/bigledger.ts" make "$RD" "$RUN" "$RECORDS" 4300 >|"$H_DIR/make.txt" 2>&1 || { cat "$H_DIR/make.txt"; exit 1; }
  cat >|"$H_DIR/steps.txt" <<EOF
$(h_tool_steps "$H_DIR/debug.txt")
send /litter runs $RUN
wait 120 $UI shows $H_DIR '$BODY'
sleep 3
until $UI mark $H_DIR open
# The grower starts at the open mark; a minute and a half of appends, a tick every 2 s.
sleep $GROW_S
until $UI mark $H_DIR grown
sleep 3
exit
EOF
  [ "${H_DRY:-}" = 1 ] && { echo "$H_CASE: dry run, files in $H_DIR"; exit 0; }

  bun "$H_FIX/bigledger.ts" grow "$RD" "$RUN" 1000 "$H_DIR/marks/open" "$H_DIR/drive-done" 4300 >|"$H_DIR/grow.txt" 2>&1 &
  grower=$!
  echo "$H_CASE: driving the session in $R"
  (
    cd "$R" || exit 1
    # shellcheck disable=SC2086
    CLAUDE_CODE_NO_FLICKER=1 H_PERSIST=1 expect "$H_HERE/drive.exp" "$H_DIR/steps.txt" "$H_DIR/tty.txt" claude ${UI_MODEL:+--model "$UI_MODEL"} \
      --permission-mode auto --plugin-dir "$H_DIR/litter" --plugin-dir "$H_DIR/toollog" --debug-file "$H_DIR/debug.txt" >|"$H_DIR/drive.txt" 2>&1
  )
  rc=$?
  : >|"$H_DIR/drive-done"
  wait "$grower"
  printf '%s: drive exited %s\n' "$H_CASE" "$rc"
  h_tool_down "$rc"
fi

marked() { [ -f "$H_DIR/marks/$1" ] || { echo "no mark $1: the steps didn't get that far (drive.txt)"; return 1; }; }
grown() { sed -n 's/^grew \([0-9]*\) records$/\1/p' "$H_DIR/grow.txt" 2>/dev/null; }

c_drawn() {
  marked open || return 1
  marked grown || return 1
  $UI shows "$H_DIR" "$BODY" open || { echo "the board doesn't show $RUN's body at the open mark"; return 1; }
  $UI shows "$H_DIR" "$BODY" grown || { echo "the board doesn't show $RUN's body at the grown mark: blank, or another view"; return 1; }
  n=$(grown)
  [ "${n:-0}" -ge 60 ] || { echo "the grower appended ${n:-0} records, not at least 60 (grow.txt)"; return 1; }
}

c_walks() {
  n=$(grep -c "ledger $RD: read whole" "$H_DIR/debug.txt" 2>/dev/null)
  [ "${n:-0}" -ge 1 ] || { echo "the debug log names no whole walk of the ledger: did the board read it?"; return 1; }
  [ "${n:-0}" -le 3 ] || { echo "the debug log names $n whole walks of the ledger, more than 3 (its first read and one a minute)"; return 1; }
}

c_ticks() {
  n=$(grep -c 'ui tick: slow' "$H_DIR/debug.txt" 2>/dev/null)
  [ "${n:-0}" -le 3 ] || { echo "$n slow ui ticks; the first lines:"; grep 'ui tick: slow' "$H_DIR/debug.txt" | head -5; return 1; }
}

c_signal() {
  if grep -E 'ignored its signal|hook overran|runaway plugin|ms after its budget ran out' "$H_DIR/debug.txt" >|"$H_DIR/overran.txt" 2>/dev/null; then
    echo "the debug log has $(grep -c . "$H_DIR/overran.txt") overrun lines:"
    head -5 "$H_DIR/overran.txt"
    return 1
  fi
}

h_expect "the board draws the run, before and after $GROW_S s of appends to a $RECORDS-record ledger" c_drawn
h_expect "the ledger was walked whole at most three times; every other read took only what was new" c_walks
h_expect "at most three ui ticks were slow" c_ticks
h_expect "no litter hook overran its signal" c_signal
h_done
