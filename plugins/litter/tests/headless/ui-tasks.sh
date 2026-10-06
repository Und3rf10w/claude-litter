#!/bin/sh
# Tier 4: phase 5's tasks pane (COMMON step 5, decisions 4 and 15), in an
# interactive session drive.exp types into:
#
#   sh tests/headless/ui-tasks.sh
#
# The session runs with CLAUDE_CODE_ENABLE_TODO_TOOLS=1, so its model has the
# task tools, and with agent teams on, so its own list is its implicit team's
# (session-<first 8 of its id>, whose one member is team-lead). The model
# makes a task with TaskCreate. /litter tasks opens that list; a click on the
# task's row opens its editor, the Status and Owner selects are picked from
# the keyboard (a click opens a Select, the arrows move, Enter picks), and
# [ Save ] saves through TaskUpdate, since the list is this session's own.
# The model then reads it with TaskGet (in progress) and TaskList (in
# progress, owned by team-lead): 2.1.290's TaskGet gives no owner.
#
# Then a team list this session doesn't lead: a team made for the case in the
# config dir (teams/<team>/config.json with members alpha and beta, and
# tasks/<team>/1.json). /litter tasks <team>, the same editor, and [ Save ]
# writes the file directly (hooks/teamfile.sh, under the engine's lock): the
# file holds the new status and owner and nothing else changed, and no lock
# or temporary file is left. The case's team and list are removed at the end.
#
# The pane's elements are pressed with the pointer (drive.exp's click, where
# ui.sh finds them on the screen). The screens are read through ui.sh
# (fixtures/screen.ts) at each mark (marks/).
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
  h_scratch "ui-tasks-$(date +%Y%m%d-%H%M%S)"
  # A name the engine's sanitizing keeps as it is, so the folders are the name.
  TEAM=litter-t4-tasks-$(date +%Y%m%d%H%M%S)
  printf '%s\n' "$TEAM" >|"$H_DIR/team"
fi
R=$H_REPO
UI="sh $H_HERE/ui.sh"
LOG=$H_DIR/tool-log.jsonl
TD=$CFG/teams/$TEAM
TL=$CFG/tasks/$TEAM
case $TEAM in litter-t4-tasks-[0-9]*) ;; *) echo "$0: no case team in $H_DIR/team" >&2; exit 2 ;; esac
cleanup() { rm -rf "$TD" "$TL"; }

if [ -z "${H_CHECKS:-}" ]; then
  mkdir -p "$TD" "$TL" || exit 1
  trap cleanup EXIT
  jq -n --arg t "$TEAM" '{name: $t, leadSessionId: "tier4-not-this-session", members: [{name: "alpha"}, {name: "beta"}]}' >|"$TD/config.json" || exit 1
  jq -n '{id: "1", subject: "tier4 team task", description: "written by the tasks pane", status: "pending", blocks: [], blockedBy: []}' >|"$TL/1.json" || exit 1
  printf '1' >|"$TL/.highwatermark"
  cp "$TL/1.json" "$H_DIR/team-task-before.json"

  # The pane's elements are found by what they draw: a row's "#1 · pending", a Select's
  # "Status: · pending ▾" and "Owner: none ▾" (texts a reply in the transcript won't hold).
  cat >|"$H_DIR/steps.txt" <<EOF
$(h_tool_steps "$H_DIR/debug.txt")
# The model's task.
wait 300 jq -e 'select(.ev == "PostToolUse" and .tool == "TaskCreate")' $LOG >/dev/null 2>&1
sleep 10
send /litter tasks
wait 30 $UI shows $H_DIR '#1 · pending'
sleep 2
until $UI mark $H_DIR own-list
click $UI at $H_DIR '#1 · pending'
wait 20 $UI shows $H_DIR 'Status: · pending'
sleep 2
# Status: in progress (one down from pending).
click $UI at $H_DIR 'Status: · pending'
sleep 2
key down enter
sleep 2
# Owner: team-lead (one down from none).
click $UI at $H_DIR 'Owner: none'
sleep 2
key down enter
sleep 2
until $UI mark $H_DIR own-edited
click $UI at $H_DIR '[ Save ]'
wait 20 $UI shows $H_DIR 'saved through TaskUpdate'
sleep 2
until $UI mark $H_DIR own-saved
key esc
sleep 2
send Call TaskGet for task 1, then TaskList, then reply with task 1's status and owner exactly as they give them, and nothing else.
wait 300 jq -e 'select(.ev == "PostToolUse" and .tool == "TaskList")' $LOG >/dev/null 2>&1
sleep 15
# The case's team list: a direct write.
send /litter tasks $TEAM
wait 30 $UI shows $H_DIR '#1 · pending'
sleep 2
until $UI mark $H_DIR team-list
click $UI at $H_DIR '#1 · pending'
wait 20 $UI shows $H_DIR 'saves by a direct write'
sleep 2
# Status: completed (two down from pending).
click $UI at $H_DIR 'Status: · pending'
sleep 2
key down down enter
sleep 2
# Owner: alpha (one down from none).
click $UI at $H_DIR 'Owner: none'
sleep 2
key down enter
sleep 2
until $UI mark $H_DIR team-edited
click $UI at $H_DIR '[ Save ]'
wait 20 $UI shows $H_DIR 'written directly'
sleep 2
until $UI mark $H_DIR team-saved
key esc
sleep 2
exit
EOF
  [ "${H_DRY:-}" = 1 ] && { echo "$H_CASE: dry run, files in $H_DIR (team $TEAM)"; exit 0; }

  FIRST='Use ToolSearch to load TaskCreate, then call TaskCreate with the subject "tier4 pane task" and the description "made for the tasks pane". Then reply with the single word ready, and nothing else.'
  SETTINGS=$(jq -cn '{env: {CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1"}}') || exit 1
  echo "$H_CASE: driving the session in $R (team $TEAM)"
  (
    cd "$R" || exit 1
    # shellcheck disable=SC2086
    CLAUDE_CODE_ENABLE_TODO_TOOLS=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 CLAUDE_CODE_NO_FLICKER=1 H_PERSIST=1 \
      expect "$H_HERE/drive.exp" "$H_DIR/steps.txt" "$H_DIR/tty.txt" claude ${UI_MODEL:+--model "$UI_MODEL"} \
      --permission-mode auto --settings "$SETTINGS" --allowedTools ToolSearch TaskCreate TaskGet TaskUpdate TaskList \
      --plugin-dir "$H_DIR/litter" --plugin-dir "$H_DIR/toollog" --debug-file "$H_DIR/debug.txt" "$FIRST" >|"$H_DIR/drive.txt" 2>&1
  )
  rc=$?
  printf '%s: drive exited %s\n' "$H_CASE" "$rc"
  # The team task as the session left it, kept with the case before the cleanup removes it.
  cp "$TL/1.json" "$H_DIR/team-task-after.json" 2>/dev/null
  ls -a "$TL" >|"$H_DIR/team-list-files.txt" 2>/dev/null
  h_tool_down "$rc"
fi

SID=$(jq -r 'select(.session != null) | .session' "$LOG" 2>/dev/null | head -n 1)
OWN=$CFG/tasks/session-$(printf '%s' "$SID" | cut -c1-8)
marked() { [ -f "$H_DIR/marks/$1" ] || { echo "no mark $1: the steps didn't get that far (drive.txt)"; return 1; }; }
saidat() { $UI shows "$H_DIR" "$2" "$1" || { echo "the pane at $1 doesn't say /$2/:"; $UI screen "$H_DIR" "$1" | grep -v '^ *$' | tail -n 25; return 1; }; }

c_created() {
  [ -n "$SID" ] || { echo "no session id in the tool log"; return 1; }
  [ -f "$OWN/1.json" ] || { echo "no task 1 in this session's list ($OWN)"; return 1; }
  jq -e '.subject == "tier4 pane task"' "$OWN/1.json" >/dev/null || { echo "task 1 isn't the model's: $(cat "$OWN/1.json")"; return 1; }
}
c_own_saved() {
  marked own-saved || return 1
  saidat own-saved '#1 saved through TaskUpdate' || return 1
  jq -e '.status == "in_progress" and .owner == "team-lead"' "$OWN/1.json" >/dev/null || { echo "task 1's file: $(jq -c '{status, owner}' "$OWN/1.json")"; return 1; }
  jq -e 'select(.ev == "PostToolUse" and .tool == "TaskUpdate" and .input.taskId == "1" and .input.status == "in_progress" and .input.owner == "team-lead")' "$LOG" >/dev/null 2>&1 ||
    { echo "no TaskUpdate of task 1 to in_progress and team-lead in the tool log"; return 1; }
}
# TaskGet gives no owner in 2.1.290 (cli_formatted_2.1.290.js:770394-770404), TaskList does (:770847).
c_taskget() {
  r=$(jq -r 'select(.ev == "PostToolUse" and .tool == "TaskGet") | .result' "$LOG" 2>/dev/null | tail -n 1)
  printf '%s' "$r" | jq -e '.task.id == "1" and .task.status == "in_progress"' >/dev/null 2>&1 || { echo "TaskGet's result: ${r:-none}"; return 1; }
  l=$(jq -r 'select(.ev == "PostToolUse" and .tool == "TaskList") | .result' "$LOG" 2>/dev/null | tail -n 1)
  printf '%s' "$l" | jq -e '.tasks[] | select(.id == "1") | .status == "in_progress" and .owner == "team-lead"' >/dev/null 2>&1 ||
    { echo "TaskList's result: ${l:-none}"; return 1; }
}
c_team_saved() {
  marked team-saved || return 1
  saidat team-saved '#1 written directly: no hooks ran, and no assignment message was sent' || return 1
  a=$H_DIR/team-task-after.json
  [ -f "$a" ] || { echo "the team's task file wasn't kept"; return 1; }
  jq -e '.status == "completed" and .owner == "alpha"' "$a" >/dev/null || { echo "the team task: $(jq -c '{status, owner}' "$a")"; return 1; }
  # Nothing else changed.
  d=$(jq -n --slurpfile b "$H_DIR/team-task-before.json" --slurpfile a "$a" '$b[0] as $b | $a[0] | del(.status, .owner) | . == ($b | del(.status, .owner))')
  [ "$d" = true ] || { echo "other fields changed: before $(jq -c . "$H_DIR/team-task-before.json"), after $(jq -c . "$a")"; return 1; }
  grep -Eq '\.lock|\.tmp|^1\.json\..' "$H_DIR/team-list-files.txt" && { echo "the list folder kept a lock or a temporary file: $(tr '\n' ' ' <"$H_DIR/team-list-files.txt")"; return 1; }
  jq -e 'select(.tool == "TaskUpdate" and (.input.taskId // "") == "1" and (.input.status // "") == "completed")' "$LOG" >/dev/null 2>&1 &&
    { echo "a TaskUpdate wrote the team task, not the direct write"; return 1; }
  return 0
}

h_expect "the model's TaskCreate made task 1 in this session's list" c_created
h_expect "the pane saved status in progress and owner team-lead through TaskUpdate" c_own_saved
h_expect "the model reads the pane's edit: TaskGet in_progress, TaskList in_progress and team-lead (TaskGet has no owner)" c_taskget
h_expect "the team list's task was written directly: completed, alpha, nothing else changed, no lock or temporary file left" c_team_saved
h_done
