#!/bin/sh
# Tier 4: phase 5's agents pane (COMMON step 6, decisions 5 and 6), in an
# interactive session drive.exp types into:
#
#   sh tests/headless/ui-agents.sh
#
# Agent teams are on: CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1, the switch
# 2.1.290 reads (`Lo()`, cli_formatted_2.1.290.js:353719-353723: that env
# var, parsed as a boolean, or a bare --agent-teams in argv, and then the
# tengu_amber_flint flag, default on), set in the environment and in
# --settings' env. An interactive session then has one implicit team,
# session-<first 8 of its id>, which it leads (:1568983); there's no
# TeamCreate any more, and an Agent call with a `name` spawns a teammate.
#
# The model spawns two teammates, alpha and beta, each told to answer any
# message with a SendMessage to team-lead quoting it, and one background
# agent (run_in_background, description "sleeper") that sleeps. Then:
#  - /litter agents; a click on alpha's row, a message typed in the
#    composer and Enter: alpha gets it, and quotes it back (its SendMessage
#    in the tool log);
#  - /litter agents <team>, for a team made for the case that this session
#    doesn't lead (teams/<team>/config.json, members m1 and m2), the
#    composer's text and [ Broadcast to <team> ]: each member's inbox file
#    holds the message, from user (hooks/teamfile.sh's locked append);
#  - /litter agents, a click on the sleeper's row, and [ Stop ] twice: the
#    first arms it, the second stops it through TaskStop.
# The case's team is removed at the end.
#
# The pane's elements are pressed with the pointer (drive.exp's click, where
# ui.sh finds them on the screen, right of the pane's header). The screens
# are read through ui.sh (fixtures/screen.ts) at each mark (marks/).
#
# H_DRY=1 stops once the files and the steps are made. H_CHECKS=<case folder>
# runs the checks again on a folder an earlier run left. Needs expect and bun.
# UI_MODEL sets the session's model (--model).

set -u
. "$(dirname "$0")/lib.sh"

command -v expect >/dev/null || { echo "$0: needs expect" >&2; exit 2; }
command -v bun >/dev/null || { echo "$0: needs bun" >&2; exit 2; }

CFG=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
if [ -n "${H_CHECKS:-}" ]; then
  H_DIR=$(cd -P "$H_CHECKS" && pwd -P) || exit 2
  H_CASE=${H_DIR##*/}
  H_REPO=$H_DIR/repo
  TEAM=$(cat "$H_DIR/team" 2>/dev/null)
else
  h_scratch "ui-agents-$(date +%Y%m%d-%H%M%S)"
  TEAM=litter-t4-agents-$(date +%Y%m%d%H%M%S)
  printf '%s\n' "$TEAM" >|"$H_DIR/team"
fi
R=$H_REPO
UI="sh $H_HERE/ui.sh"
LOG=$H_DIR/tool-log.jsonl
TD=$CFG/teams/$TEAM
case $TEAM in litter-t4-agents-[0-9]*) ;; *) echo "$0: no case team in $H_DIR/team" >&2; exit 2 ;; esac
# The messages: one direct, one broadcast, each a word no other text holds.
DIRECT=tier4-direct-${TEAM##*-}
CAST=tier4-cast-${TEAM##*-}
PANE='litter · agents'

if [ -z "${H_CHECKS:-}" ]; then
  mkdir -p "$TD" || exit 1
  trap 'rm -rf "$TD"' EXIT
  jq -n --arg t "$TEAM" '{name: $t, leadSessionId: "tier4-not-this-session", members: [{name: "m1"}, {name: "m2"}]}' >|"$TD/config.json" || exit 1

  agents3="[ \$(jq -s '[.[] | select(.ev == \"PostToolUse\" and .tool == \"Agent\")] | length' $LOG 2>/dev/null) -ge 3 ]"
  cat >|"$H_DIR/steps.txt" <<EOF
$(h_tool_steps "$H_DIR/debug.txt")
# The teammates and the sleeper.
wait 600 $agents3
sleep 20
send /litter agents
wait 30 $UI shows $H_DIR '$PANE · this session · [0-9]+ agents'
sleep 3
until $UI mark $H_DIR session
# A message to alpha, from the composer.
click $UI at $H_DIR 'alpha' '$PANE'
wait 20 $UI shows $H_DIR 'a message for alpha'
sleep 2
click $UI at $H_DIR 'a message for alpha' '$PANE'
sleep 2
type $DIRECT
sleep 1
key enter
wait 20 $UI shows $H_DIR 'queued for alpha'
sleep 2
until $UI mark $H_DIR direct-sent
wait 240 grep -q '$DIRECT' $LOG
sleep 5
# A broadcast to the case's team.
key esc
sleep 2
send /litter agents $TEAM
wait 30 $UI shows $H_DIR 'Broadcast to $TEAM'
sleep 2
until $UI mark $H_DIR team
click $UI at $H_DIR 'a message for every member' '$PANE'
sleep 2
type $CAST
sleep 2
click $UI at $H_DIR '[ Broadcast to $TEAM ]' '$PANE'
wait 20 $UI shows $H_DIR 'broadcast to $TEAM: '
sleep 2
until $UI mark $H_DIR cast
# [ Stop ] twice on the sleeper.
key esc
sleep 2
send /litter agents
wait 30 $UI shows $H_DIR '$PANE · this session · [0-9]+ agents'
sleep 2
click $UI at $H_DIR 'sleeper' '$PANE'
wait 20 $UI shows $H_DIR '\[ Stop \]'
sleep 2
click $UI at $H_DIR '[ Stop ]' '$PANE'
wait 10 $UI shows $H_DIR 'again to stop sleeper'
until $UI mark $H_DIR armed
click $UI at $H_DIR '[ Stop ]' '$PANE'
wait 20 $UI shows $H_DIR 'stopped sleeper'
sleep 5
until $UI mark $H_DIR stopped
key esc
sleep 2
exit
EOF
  [ "${H_DRY:-}" = 1 ] && { echo "$H_CASE: dry run, files in $H_DIR (team $TEAM)"; exit 0; }

  FIRST='You are running a scripted test. Do exactly these steps, in order, and nothing else.
1. With the Agent tool, spawn a teammate named alpha, with the prompt: "You are a tier-4 test teammate. Whenever you get a message, send team-lead one message with SendMessage that quotes it verbatim, then wait for the next one. Do nothing else."
2. The same for a teammate named beta, with the same prompt.
3. With the Agent tool, start one background agent (run_in_background: true, no name) with the description "sleeper" and the prompt: "Run the Bash command sleep 900, then reply done."
4. Reply with the single word ready, and nothing else. Messages from your teammates need no answer.'
  SETTINGS=$(jq -cn '{env: {CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1"}}') || exit 1
  echo "$H_CASE: driving the session in $R (team $TEAM)"
  (
    cd "$R" || exit 1
    # shellcheck disable=SC2086
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 CLAUDE_CODE_NO_FLICKER=1 H_PERSIST=1 \
      expect "$H_HERE/drive.exp" "$H_DIR/steps.txt" "$H_DIR/tty.txt" claude ${UI_MODEL:+--model "$UI_MODEL"} \
      --permission-mode auto --settings "$SETTINGS" --allowedTools Agent SendMessage 'Bash(sleep:*)' \
      --plugin-dir "$H_DIR/litter" --plugin-dir "$H_DIR/toollog" --debug-file "$H_DIR/debug.txt" "$FIRST" >|"$H_DIR/drive.txt" 2>&1
  )
  rc=$?
  printf '%s: drive exited %s\n' "$H_CASE" "$rc"
  # The inboxes as the session left them, kept with the case before the cleanup removes the team.
  mkdir -p "$H_DIR/inboxes"
  cp "$TD"/inboxes/*.json "$H_DIR/inboxes/" 2>/dev/null
  h_tool_down "$rc"
fi

marked() { [ -f "$H_DIR/marks/$1" ] || { echo "no mark $1: the steps didn't get that far (drive.txt)"; return 1; }; }
saidat() { $UI shows "$H_DIR" "$2" "$1" || { echo "the pane at $1 doesn't say /$2/:"; $UI screen "$H_DIR" "$1" | grep -v '^ *$' | tail -n 25; return 1; }; }
agent_of() { jq -r --arg n "$1" 'select(.ev == "PostToolUse" and .tool == "Agent" and (.input.name // "") == $n) | .result' "$LOG" 2>/dev/null | head -n 1; }
# The sleeper's agent id: an unnamed Agent call the engine ran in the background (the model may leave run_in_background out).
sleeper_id() {
  jq -r 'select(.ev == "PostToolUse" and .tool == "Agent" and (.input.name // "") == "" and .input.description == "sleeper") | .result | fromjson?
    | select(.status == "async_launched") | .agentId' "$LOG" 2>/dev/null | head -n 1
}

c_spawned() {
  for n in alpha beta; do
    [ -n "$(agent_of "$n")" ] || { echo "no Agent call spawned $n"; return 1; }
  done
  [ -n "$(sleeper_id)" ] || { echo "no Agent call launched the sleeper in the background (async_launched)"; return 1; }
  marked session || return 1
  # The sleeper is live either way: running, or waiting when it put its sleep in a background shell (agents/view.ts).
  for r in 'sleeper .*(▸ running|· waiting)' 'alpha teammate' 'beta teammate'; do saidat session "$r" || return 1; done
}
c_direct() {
  marked direct-sent || return 1
  saidat direct-sent 'queued for alpha' || return 1
  # alpha's call that quotes it back to the lead: the pane's send is no tool call, and only alpha had the word.
  jq -e --arg w "$DIRECT" 'select(.ev == "PreToolUse" and .tool == "SendMessage" and ((.input.to // "") | tostring | contains("team-lead")) and (.input | tostring | contains($w)))' "$LOG" >/dev/null 2>&1 ||
    { echo "no SendMessage to team-lead quotes $DIRECT (tool-log.jsonl)"; return 1; }
}
c_broadcast() {
  marked cast || return 1
  saidat cast "broadcast to $TEAM: queued for m1, m2" || return 1
  for m in m1 m2; do
    f=$H_DIR/inboxes/$m.json
    [ -f "$f" ] || { echo "no inbox file for $m"; return 1; }
    jq -e --arg w "$CAST" 'type == "array" and any(.[]; .from == "user" and .text == $w and (.timestamp | type) == "string")' "$f" >/dev/null 2>&1 ||
      { echo "$m's inbox doesn't hold the broadcast: $(cat "$f")"; return 1; }
  done
}
c_stopped() {
  marked armed || return 1
  saidat armed '\[Stop\] again to stop sleeper' || return 1
  marked stopped || return 1
  id=$(sleeper_id)
  saidat stopped "stopped sleeper: .*${id:-no-id}" || return 1
  # The row: $.agent.list()'s killed, drawn "− stopped" (agents/view.ts).
  saidat stopped 'sleeper .*− stopped' || return 1
}

h_expect "the model spawned alpha, beta and a background sleeper, and the pane lists all three" c_spawned
h_expect "a message composed in the pane reached alpha, which quoted it back" c_direct
h_expect "a broadcast to the case's team is in each member's inbox file, from user" c_broadcast
h_expect "[ Stop ] pressed twice stopped the sleeper" c_stopped
h_done
