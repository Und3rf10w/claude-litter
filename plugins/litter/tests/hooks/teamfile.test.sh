# Tier 3: teamfile.sh, the locked writer of the engine's task and inbox files
# (phase 5; COMMON decisions 4 and 5). An update changes only the patch's
# fields; an append adds one entry, to a missing inbox too; the engine's lock
# is waited on and given up after 5 s, broken when it's stale; a file that
# isn't JSON, or isn't a task, is refused and left as it was; and every path
# out removes the lock and the temporary file. Owner: WP-CE.

. "$(dirname "$0")/testlib.sh"

# A task list folder with task 3, as the engine writes it.
task_fixture() {
  mkdir -p "$T_DIR/config/tasks/team-a" || fail "tasks folder"
  cat >|"$T_DIR/config/tasks/team-a/3.json" <<'EOF' || fail "task fixture"
{
  "id": "3",
  "subject": "Write the parser",
  "description": "Line one\nline two",
  "activeForm": "Writing the parser",
  "owner": "researcher",
  "status": "in_progress",
  "blocks": ["4"],
  "blockedBy": ["1", "2"],
  "metadata": {"k": 1}
}
EOF
  printf '%s\n' "$T_DIR/config/tasks/team-a/3.json"
}

# teamfile <mode> <file> [args...] < change: the script under the shell being tested.
teamfile() { run_hook teamfile.sh "$@"; }

assert_ok() {
  assert_code 0
  assert_eq '{"ok":true}' "$(cat "$T_DIR/out")" 'answer'
}

# assert_refused <text>: exit 0, one line {"ok":false,"error":...} holding the text.
assert_refused() {
  assert_code 0
  assert_eq 'false' "$(jq -r '.ok' "$T_DIR/out")" 'ok'
  assert_eq '1' "$(wc -l <"$T_DIR/out" | tr -d ' ')" 'lines printed'
  assert_contains "$1" "$(jq -r '.error' "$T_DIR/out")" 'error'
}

# Only the names given are in the folder: no lock, no temporary file.
assert_only() {
  ao_dir=$1
  shift
  assert_eq "$*" "$(ls -A "$ao_dir" | tr '\n' ' ' | sed 's/ $//')" "what $ao_dir holds"
}

case_update_keeps_fields() {
  f=$(task_fixture)
  printf '{"subject": "Write the lexer", "status": "completed", "owner": "executor"}' | teamfile task-update "$f"
  assert_ok
  assert_eq 'Write the lexer|completed|executor' "$(jq -r '[.subject, .status, .owner] | join("|")' "$f")" 'patched'
  assert_eq '3|Line one
line two|Writing the parser|4|1,2|1' "$(jq -r '[.id, .description, .activeForm, (.blocks | join(",")), (.blockedBy | join(",")), (.metadata.k | tostring)] | join("|")' "$f")" 'kept'
  printf '{"description": "only this"}' | teamfile task-update "$f"
  assert_ok
  assert_eq 'only this|Write the lexer|executor' "$(jq -r '[.description, .subject, .owner] | join("|")' "$f")" 'one field'
  assert_only "${f%/*}" 3.json
}

case_owner_null() {
  f=$(task_fixture)
  printf '{"owner": null}' | teamfile task-update "$f"
  assert_ok
  assert_eq 'false' "$(jq 'has("owner")' "$f")" 'owner key'
  assert_eq 'Write the parser' "$(jq -r '.subject' "$f")" 'subject'
}

case_append() {
  mkdir -p "$T_DIR/config/teams/team-a" || fail "team folder"
  inbox=$T_DIR/config/teams/team-a/inboxes/reviewer.json
  # No inboxes/ folder yet: made, since the team's folder is there.
  printf '{"from": "user", "text": "first", "timestamp": "2026-10-05T10:00:00.000Z", "type": "message", "read": false}' | teamfile inbox-append "$inbox"
  assert_ok
  assert_eq '1|first|false' "$(jq -r '[length, .[0].text, (.[0].read | tostring)] | join("|")' "$inbox")" 'created'
  printf '{"from": "user", "text": "second", "timestamp": "2026-10-05T10:01:00.000Z", "summary": "a summary"}' | teamfile inbox-append "$inbox"
  assert_ok
  assert_eq '2|first|second|a summary' "$(jq -r '[length, .[0].text, .[1].text, .[1].summary] | join("|")' "$inbox")" 'appended'
  assert_only "${inbox%/*}" reviewer.json
}

case_append_existing() {
  mkdir -p "$T_DIR/config/teams/team-a/inboxes" || fail "inbox folder"
  inbox=$T_DIR/config/teams/team-a/inboxes/lead.json
  printf '[{"from": "researcher", "text": "done", "timestamp": "2026-10-05T09:00:00.000Z", "color": "blue", "msg_id": "m-1"}]' >|"$inbox"
  printf '{"from": "user", "text": "thanks", "timestamp": "2026-10-05T10:00:00.000Z"}' | teamfile inbox-append "$inbox"
  assert_ok
  assert_eq '2|done|m-1|blue|thanks' "$(jq -r '[length, .[0].text, .[0].msg_id, .[0].color, .[1].text] | join("|")' "$inbox")" 'kept and appended'
}

case_no_team_folder() {
  mkdir -p "$T_DIR/config/teams" || fail "teams folder"
  printf '{"from": "user", "text": "hi", "timestamp": "2026-10-05T10:00:00.000Z"}' | teamfile inbox-append "$T_DIR/config/teams/gone/inboxes/x.json"
  assert_refused "the team folder $T_DIR/config/teams/gone isn't there"
  assert_no_file "$T_DIR/config/teams/gone"
}

# A lock someone holds: waited on for 5 s, then given up; the file and the lock stay.
# A task's lock is beside its real path (reached here through a link), an inbox's beside the path as given.
case_held_lock() {
  f=$(task_fixture)
  ln -s "$T_DIR/config" "$T_DIR/linked" || fail "link"
  mkdir "$f.lock" || fail "held lock"
  mkdir -p "$T_DIR/config/teams/team-a/inboxes" || fail "inbox folder"
  inbox=$T_DIR/config/teams/team-a/inboxes/lead.json
  printf '[]' >|"$inbox"
  mkdir "$inbox.lock" || fail "held inbox lock"
  before=$(cat "$f")
  # Both at once, so the case waits 5 s, not 10. The cutoff is before either lock was made: neither is stale.
  (printf '{"status": "completed"}' | PATH=$PATH CLAUDE_PLUGIN_ROOT=$LITTER_ROOT ${SHELL_UNDER_TEST:-sh} "$LITTER_ROOT/hooks/teamfile.sh" \
    task-update "$T_DIR/linked/tasks/team-a/3.json" --stale-before 202001010000.00 >|"$T_DIR/out.task" 2>&1) &
  printf '{"from": "user", "text": "hi", "timestamp": "2026-10-05T10:00:00.000Z"}' | teamfile inbox-append "$inbox" --stale-before 202001010000.00
  wait
  assert_refused 'is locked by another writer'
  assert_contains 'is locked by another writer' "$(cat "$T_DIR/out.task")" 'task answer'
  assert_eq "$before" "$(cat "$f")" 'task file'
  assert_eq '[]' "$(cat "$inbox")" 'inbox file'
  [ -d "$f.lock" ] || fail "the task's lock was removed"
  [ -d "$inbox.lock" ] || fail "the inbox's lock was removed"
  assert_only "${f%/*}" 3.json 3.json.lock
  assert_only "${inbox%/*}" lead.json lead.json.lock
}

# A lock no newer than the cutoff: broken (rmdir, mkdir), the write made, the lock gone after.
case_stale_lock() {
  f=$(task_fixture)
  mkdir "$f.lock" || fail "stale lock"
  TZ=UTC0 touch -t 202001010000.00 "$f.lock" || fail "age the lock"
  printf '{"status": "completed"}' | teamfile task-update "$f" --stale-before 202601010000.00
  assert_ok
  assert_eq 'completed' "$(jq -r '.status' "$f")" 'status'
  assert_only "${f%/*}" 3.json
}

case_not_json() {
  f=$(task_fixture)
  printf '{"id": "3", "subject": "cut off' >|"$f"
  printf '{"status": "completed"}' | teamfile task-update "$f"
  assert_refused "isn't JSON, so it was left as it was"
  assert_eq '{"id": "3", "subject": "cut off' "$(cat "$f")" 'task file'
  assert_only "${f%/*}" 3.json
  mkdir -p "$T_DIR/config/teams/team-a/inboxes" || fail "inbox folder"
  inbox=$T_DIR/config/teams/team-a/inboxes/lead.json
  printf 'not json' >|"$inbox"
  printf '{"from": "user", "text": "hi", "timestamp": "2026-10-05T10:00:00.000Z"}' | teamfile inbox-append "$inbox"
  assert_refused "isn't JSON, so it was left as it was"
  assert_eq 'not json' "$(cat "$inbox")" 'inbox file'
  assert_only "${inbox%/*}" lead.json
}

# Refused under the lock: the lock is removed on that path too.
case_not_a_task() {
  f=$(task_fixture)
  printf '{"id": "3", "subject": "no status"}' >|"$f"
  printf '{"status": "completed"}' | teamfile task-update "$f"
  assert_refused "isn't a task file"
  assert_eq '{"id": "3", "subject": "no status"}' "$(cat "$f")" 'task file'
  assert_only "${f%/*}" 3.json
  mkdir -p "$T_DIR/config/teams/team-a/inboxes" || fail "inbox folder"
  inbox=$T_DIR/config/teams/team-a/inboxes/lead.json
  printf '{"not": "an array"}' >|"$inbox"
  printf '{"from": "user", "text": "hi", "timestamp": "2026-10-05T10:00:00.000Z"}' | teamfile inbox-append "$inbox"
  assert_refused "isn't an inbox"
  assert_only "${inbox%/*}" lead.json
}

case_missing_task() {
  f=$(task_fixture)
  printf '{"status": "completed"}' | teamfile task-update "${f%/*}/9.json"
  assert_refused "task #9 isn't there"
  assert_only "${f%/*}" 3.json
  printf '{"status": "completed"}' | teamfile task-update "$T_DIR/config/tasks/nowhere/3.json"
  assert_refused "the task list folder $T_DIR/config/tasks/nowhere isn't there"
}

# A bad change is refused before the lock is taken.
case_bad_change() {
  f=$(task_fixture)
  before=$(cat "$f")
  for change in '{"status": "deleted"}' '{"blocks": []}' '{"owner": ""}' '{"subject": 7}' '{}' '[1]' 'not json' ''; do
    printf '%s' "$change" | teamfile task-update "$f"
    assert_refused 'the patch must set'
  done
  assert_eq "$before" "$(cat "$f")" 'task file'
  assert_only "${f%/*}" 3.json
  mkdir -p "$T_DIR/config/teams/team-a/inboxes" || fail "inbox folder"
  for entry in '{"from": "user", "text": "hi"}' '{"from": "user", "text": 3, "timestamp": "t"}' '{"from": "u", "text": "t", "timestamp": "t", "extra": 1}' 'nope'; do
    printf '%s' "$entry" | teamfile inbox-append "$T_DIR/config/teams/team-a/inboxes/lead.json"
    assert_refused 'the entry must have'
  done
  assert_only "$T_DIR/config/teams/team-a/inboxes"
}

case_link_refused() {
  f=$(task_fixture)
  printf '{"id": "9"}' >|"$T_DIR/elsewhere.json"
  ln -s "$T_DIR/elsewhere.json" "${f%/*}/9.json" || fail "link"
  printf '{"status": "completed"}' | teamfile task-update "${f%/*}/9.json"
  assert_refused 'is a symbolic link'
  assert_eq '{"id": "9"}' "$(cat "$T_DIR/elsewhere.json")" 'link target'
}

case_usage() {
  f=$(task_fixture)
  for args in "task-delete $f" "task-update relative/3.json" "task-update ${f%.json}.txt" "task-update $f --stale-before yesterday" "task-update $f --stale 202001010000.00" "task-update"; do
    # shellcheck disable=SC2086
    printf '{"status": "completed"}' | teamfile $args
    assert_code 2
    assert_stdout_empty
    assert_stderr_contains 'usage: sh teamfile.sh'
  done
  printf '{"subject": "x"}' | teamfile task-update "${f%/*}/x3.json"
  assert_refused "isn't a task file's name"
  assert_eq 'Write the parser' "$(jq -r '.subject' "$f")" 'subject'
}

case_no_jq() {
  f=$(task_fixture)
  nj_path=$PATH
  PATH=$(path_without_jq)
  printf '{"status": "completed"}' | teamfile task-update "$f"
  PATH=$nj_path
  assert_code 0
  assert_eq '{"ok":false,"error":"jq is not on PATH, so nothing was written"}' "$(cat "$T_DIR/out")" 'answer'
  assert_eq 'in_progress' "$(jq -r '.status' "$f")" 'status'
  assert_only "${f%/*}" 3.json
}

t "an update changes only the patch's fields and keeps every other" case_update_keeps_fields
t "owner null removes the key" case_owner_null
t "an append to a missing inbox makes it, and the next one appends" case_append
t "an append to an existing inbox keeps what it holds" case_append_existing
t "an append for a team with no folder is refused" case_no_team_folder
t "a held lock times out after 5 s, the files untouched; a task's lock is at its real path" case_held_lock
t "a stale lock is broken and the write made" case_stale_lock
t "a file that isn't JSON is refused and untouched, with no temporary file left" case_not_json
t "a file that isn't a task or an inbox is refused, and the lock is removed after the error" case_not_a_task
t "a task that isn't there is refused" case_missing_task
t "a bad patch or entry is refused before the lock" case_bad_change
t "a task file that's a link is refused" case_link_refused
t "a usage error exits 2; a bad file name is refused" case_usage
t "with no jq on PATH it answers a failure and changes nothing" case_no_jq
done_testing
