# Tier 3: output.sh, PreToolUse on StructuredOutput (plan section 9,
# "Observed facts beat claimed ones"; section 12, "StructuredOutput").

. "$(dirname "$0")/testlib.sh"

# out_file <for JSON> <fields JSON> [agent_id]: the mod's out/<agent_id>.json.
out_file() {
  of_hooks=$(hooks_dir)
  mkdir -p "$of_hooks/out"
  jq -n --arg id "${3:-a1}" --argjson for "$1" --argjson fields "$2" \
    '{v: 1, agent_id: $id, for: $for, fields: $fields}' >|"$of_hooks/out/${3:-a1}.json" || fail "out fixture"
}

# so <agent_type> <input JSON>: a StructuredOutput call's input.
so() { call "$1" StructuredOutput "$2"; }

# The updatedInput output.sh printed.
updated() { jq -c '.hookSpecificOutput.updatedInput' "$T_DIR/out"; }

VERDICT='{"verify_id":"v1","plan_adherence":{"pass":true,"evidence":"e","gaps":[]},"tests_green":{"pass":true,"evidence":"claimed","gaps":[]},"no_regressions":{"pass":true,"evidence":"e","gaps":[]},"rules":{"pass":true,"evidence":"none apply","gaps":[]},"plan_gap":"","proposed_rules":[]}'
RED='{"tests_green":{"pass":false,"evidence":"verify v1 exited 1","gaps":[]}}'

setup() {
  project >/dev/null
  policy
}

case_not_litter() {
  setup
  so - '{"anything":1}' | run_hook output.sh
  assert_pass
  so general-purpose '{"anything":1}' | run_hook output.sh
  assert_pass
  assert_eq '' "$(spool_lines)" spool
}

case_critic_rewritten() {
  setup
  out_file '{"verify_id":"v1"}' "$RED"
  so litter:gate-critic "$VERDICT" | run_hook output.sh
  assert_code 0
  assert_eq false "$(updated | jq -r '.tests_green.pass')" tests_green.pass
  assert_eq 'verify v1 exited 1' "$(updated | jq -r '.tests_green.evidence')" tests_green.evidence
  # Every field the schema requires is still there, with its type.
  assert_eq '["no_regressions","plan_adherence","plan_gap","proposed_rules","rules","tests_green","verify_id"]' \
    "$(updated | jq -c 'keys')" keys
  assert_eq '"v1"' "$(updated | jq -c '.verify_id')" verify_id
  assert_eq '[]' "$(updated | jq -c '.proposed_rules')" proposed_rules
  line=$(spool_lines | jq -c 'select(.ev == "output")')
  assert_eq 'false' "$(printf '%s' "$line" | jq -r '.input.tests_green.pass')" "spooled input"
  assert_eq 'litter:gate-critic toolu_1 a1' "$(printf '%s' "$line" | jq -r '"\(.agent_type) \(.tool_use_id) \(.agent_id)"')" "spooled ids"
}

case_critic_no_out() {
  setup
  so litter:gate-critic "$VERDICT" | run_hook output.sh
  assert_deny 'no verify recorded by you for verify_id \"v1\"'
  assert_contains 'kind verify' "$(cat "$T_DIR/out")" reason
}

case_critic_other_verify() {
  setup
  out_file '{"verify_id":"v2"}' "$RED"
  so litter:gate-critic "$VERDICT" | run_hook output.sh
  assert_deny 'your result gives verify_id \"v1\", but your latest record is for \"v2\"'
}

case_relay_verify() {
  setup
  out_file '{"verify_id":"v7"}' '{"exit_code":null,"signal":"SIGKILL","timed_out":true,"green":false}'
  so litter:relay '{"verify_id":"v7","exit_code":0,"green":true}' | run_hook output.sh
  assert_eq '{"verify_id":"v7","exit_code":null,"green":false,"signal":"SIGKILL","timed_out":true}' "$(updated)" updatedInput
}

case_relay_land() {
  setup
  out_file '{"land_of":"v7"}' '{"landed":false,"reason":"the tree moved","retry":true}'
  so litter:relay '{"landed":true,"commit":"abc"}' | run_hook output.sh
  assert_eq '{"landed":false,"commit":"abc","reason":"the tree moved","retry":true}' "$(updated)" updatedInput
}

case_relay_land_missing() {
  setup
  so litter:relay '{"landed":true,"commit":"abc"}' | run_hook output.sh
  assert_deny 'no land recorded by you yet'
  # An out file from a verify doesn't answer a land.
  out_file '{"verify_id":"v7"}' '{"green":true}'
  so litter:relay '{"landed":true}' | run_hook output.sh
  assert_deny 'no land recorded by you yet'
}

case_author_filled() {
  setup
  out_file '{"version":"v2"}' '{"proposal":"# The recorded text\n\n### G1: one\n"}'
  so litter:author '{"version":"v2","proposal":"whatever it sent","user_decisions":[]}' | run_hook output.sh
  assert_eq '# The recorded text' "$(updated | jq -r '.proposal' | head -n 1)" proposal
}

case_author_other_version() {
  setup
  out_file '{"version":"v2"}' '{"proposal":"x"}'
  so litter:author '{"version":"v1","proposal":"y"}' | run_hook output.sh
  assert_deny 'your result gives version \"v1\"'
}

case_design_critic() {
  setup
  so litter:design-critic '{"version":"v3","criteria":[]}' | run_hook output.sh
  assert_deny 'no verdict recorded by you for version \"v3\"'
  out_file '{"version":"v3"}' '{"source_changed":true}'
  so litter:design-critic '{"version":"v3","criteria":[]}' | run_hook output.sh
  assert_eq 'true' "$(updated | jq -r '.source_changed')" source_changed
}

# The design critic's out file as recordVerdict writes it (decision 7): the
# recorded version, source_changed, criteria and overall.
DESIGN_RECORDED='{"version":"v3","source_changed":true,"criteria":[{"id":"C1","verdict":"PASS","evidence":"src/a.ts:1"},{"id":"B1","verdict":"FAIL","evidence":"none found","gap_or_reason":"no fallback","gap_kind":"design"}],"overall":"HOLDING"}'
DESIGN_CLAIMED='{"version":"v3","source_changed":false,"criteria":[{"id":"C1","verdict":"PASS","evidence":"claimed"},{"id":"B1","verdict":"PASS","evidence":"claimed"}],"overall":"APPROVED","notes":"kept"}'

case_design_critic_recorded() {
  setup
  out_file '{"version":"v3"}' "$DESIGN_RECORDED"
  so litter:design-critic "$DESIGN_CLAIMED" | run_hook output.sh
  assert_code 0
  # The four fields are the ledger's, and the critic's other fields stay.
  assert_eq "$(printf '%s' "$DESIGN_RECORDED" | jq -c '. + {notes: "kept"}')" "$(updated | jq -c '{version, source_changed, criteria, overall, notes}')" updatedInput
  assert_eq 'HOLDING design' "$(spool_lines | jq -r 'select(.ev == "output") | "\(.input.overall) \(.input.criteria[1].gap_kind)"')" "spooled result"
}

case_design_critic_other_version() {
  setup
  out_file '{"version":"v2"}' "$(printf '%s' "$DESIGN_RECORDED" | jq -c '.version = "v2"')"
  so litter:design-critic "$DESIGN_CLAIMED" | run_hook output.sh
  assert_deny 'your result gives version \"v3\", but your latest record is for \"v2\": return that version, or record again first'
  assert_eq '' "$(spool_lines | jq -c 'select(.ev == "output")')" "no result spooled"
}

case_design_critic_no_out() {
  setup
  so litter:design-critic "$DESIGN_CLAIMED" | run_hook output.sh
  assert_deny 'no verdict recorded by you for version \"v3\": record kind verdict first, then return'
  assert_eq '' "$(spool_lines | jq -c 'select(.ev == "output")')" "no result spooled"
}

case_no_fields_needed() {
  setup
  so litter:executor '{"status":"done","plan_lines":[],"files":["a.py"],"checks":[],"notes":"n"}' | run_hook output.sh
  assert_pass
  assert_eq 'done' "$(spool_lines | jq -r 'select(.ev == "output") | .input.status')" "spooled result"
}

case_out_unreadable() {
  setup
  mkdir -p "$(hooks_dir)/out"
  printf '{"v":1,"agent_id":' >|"$(hooks_dir)/out/a1.json"
  so litter:gate-critic "$VERDICT" | run_hook output.sh
  assert_deny 'out/a1.json is unreadable (it does not parse)'
  printf '{"v":2,"agent_id":"a1","for":{},"fields":{}}' >|"$(hooks_dir)/out/a1.json"
  so litter:executor '{"status":"done"}' | run_hook output.sh
  assert_deny 'out/a1.json is unreadable (not version 1)'
  out_file '{"verify_id":"v1"}' "$RED" a1
  call litter:gate-critic StructuredOutput "$VERDICT" '.agent_id = "a2"' | run_hook output.sh
  assert_deny 'no verify recorded by you'
}

case_out_for_another_agent() {
  setup
  out_file '{"verify_id":"v1"}' "$RED"
  jq '.agent_id = "a9"' "$(hooks_dir)/out/a1.json" >|"$T_DIR/o.json"
  mv "$T_DIR/o.json" "$(hooks_dir)/out/a1.json"
  so litter:gate-critic "$VERDICT" | run_hook output.sh
  assert_deny 'not this agent'
}

case_not_an_object() {
  setup
  so litter:gate-critic '"just text"' | run_hook output.sh
  assert_deny 'needs an object'
}

case_big_result_blob() {
  setup
  big=$(jq -rn '[range(0; 600)] | map("line \(.)") | join("\n")')
  out_file '{"version":"v2"}' "$(jq -cn --arg p "$big" '{proposal: $p}')"
  so litter:author '{"version":"v2","proposal":"x"}' | run_hook output.sh
  assert_code 0
  line=$(spool_lines)
  assert_eq 1 "$(printf '%s\n' "$line" | wc -l | tr -d ' ')" "one short line"
  file=$(printf '%s' "$line" | jq -r '.file')
  assert_eq 'output a1 toolu_1' "$(printf '%s' "$line" | jq -r '"\(.ev) \(.agent_id) \(.tool_use_id)"')" "the line keeps ev and ids"
  assert_file "$(hooks_dir)/spool/blobs/$file"
  assert_eq "$big" "$(jq -r '.input.proposal' "$(hooks_dir)/spool/blobs/$file")" "the blob holds the whole line"
  [ "$(printf '%s' "$line" | wc -c)" -lt 4096 ] || fail "the line is 4 KiB or more"
}

# --- fanout (section 7, fanout.js) -------------------------------------------

# A fanout run, its writer a1 bound to task t1 by agents/a1.json when [bound]
# is given.
setup_writer() {
  project >/dev/null
  policy '.run.workflow = "fanout" | .roles.executor = {write: "own-worktree", bash: "rw", isolated: true}'
  if [ -n "${1:-}" ]; then
    mkdir -p "$(hooks_dir)/agents"
    printf '%s\n' '{"v":1,"run":"20261002-test","task":{"id":"t1","owned":["src/a.py"]}}' >|"$(hooks_dir)/agents/a1.json"
  fi
}

BLOCKED='{"status":"blocked","files":[],"checks":[],"summary":"task.bind refused: t1 is bound to another writer","notes":""}'
TASK_DONE='{"status":"done","files":["src/a.py"],"checks":[{"command":"pytest","pass":true}],"summary":"did it","notes":""}'
FANOUT_CHECK='{"verify_id":"v4","tasks":[{"id":"t1","pass":true,"evidence":"e","gaps":[]}],"combined":{"pass":true,"evidence":"claimed","gaps":[]}}'

case_writer_unbound_blocked() {
  setup_writer
  so litter:executor "$BLOCKED" | run_hook output.sh
  assert_code 0
  assert_eq 'true blocked' "$(updated | jq -r '"\(.unbound) \(.status)"')" "unbound and status"
  assert_eq false "$(updated | jq 'has("bind_refusal")')" "bind_refusal without an out file"
  assert_eq true "$(spool_lines | jq -r 'select(.ev == "output") | .input.unbound')" "spooled result"
  # The refusal the mod recorded, from an out file with an empty for.
  out_file '{}' '{"unbound":true,"bind_refusal":"task t1 is bound to a2"}'
  so litter:executor "$(printf '%s' "$BLOCKED" | jq -c '.bind_refusal = "made up"')" | run_hook output.sh
  assert_eq 'task t1 is bound to a2' "$(updated | jq -r '.bind_refusal')" bind_refusal
  # A claimed refusal with no recorded one is dropped.
  rm "$(hooks_dir)/out/a1.json"
  so litter:executor "$(printf '%s' "$BLOCKED" | jq -c '.bind_refusal = "made up"')" | run_hook output.sh
  assert_eq false "$(updated | jq 'has("bind_refusal")')" "a claimed bind_refusal"
}

case_writer_unbound_denied() {
  setup_writer
  so litter:executor "$TASK_DONE" | run_hook output.sh
  assert_deny 'bind first; only a blocked result is accepted unbound'
  so litter:executor "$(printf '%s' "$BLOCKED" | jq -c '.files = ["src/a.py"]')" | run_hook output.sh
  assert_deny 'bind first'
  so litter:executor "$(printf '%s' "$BLOCKED" | jq -c '.checks = [{"command":"x","pass":true}]')" | run_hook output.sh
  assert_deny 'bind first'
  so litter:executor "$(printf '%s' "$BLOCKED" | jq -c '.summary = " \n "')" | run_hook output.sh
  assert_deny 'bind first'
  assert_eq '' "$(spool_lines | jq -c 'select(.ev == "output")')" "nothing spooled as a result"
  # agents/a1.json for another run doesn't bind it.
  mkdir -p "$(hooks_dir)/agents"
  printf '%s\n' '{"v":1,"run":"20261001-other","task":{"id":"t1","owned":["src/a.py"]}}' >|"$(hooks_dir)/agents/a1.json"
  so litter:executor "$TASK_DONE" | run_hook output.sh
  assert_deny 'bind first'
}

case_writer_unreadable_files() {
  setup_writer
  mkdir -p "$(hooks_dir)/agents" "$(hooks_dir)/out"
  printf '{"v":1,"task":' >|"$(hooks_dir)/agents/a1.json"
  so litter:executor "$BLOCKED" | run_hook output.sh
  assert_deny 'agents/a1.json is unreadable (it does not parse)'
  rm "$(hooks_dir)/agents/a1.json"
  printf '{"v":1,"agent_id":' >|"$(hooks_dir)/out/a1.json"
  so litter:executor "$BLOCKED" | run_hook output.sh
  assert_deny 'out/a1.json is unreadable'
  printf '{"v":1,"run":' >|"$(hooks_dir)/policy.json"
  so litter:executor "$BLOCKED" | run_hook output.sh
  assert_deny 'policy.json is unreadable (it does not parse)'
}

case_writer_bound() {
  setup_writer bound
  so litter:executor "$TASK_DONE" | run_hook output.sh
  assert_pass
  assert_eq done "$(spool_lines | jq -r 'select(.ev == "output") | .input.status')" "spooled result"
  # unbound and bind_refusal are never claimed.
  so litter:executor "$(printf '%s' "$TASK_DONE" | jq -c '.unbound = true | .bind_refusal = "x"')" | run_hook output.sh
  assert_eq '["checks","files","notes","status","summary"]' "$(updated | jq -c 'keys')" keys
}

case_writer_bound_merged() {
  setup_writer bound
  out_file '{}' '{"notes":"observed","unbound":true,"bind_refusal":"from before the bind"}'
  so litter:executor "$TASK_DONE" | run_hook output.sh
  assert_code 0
  assert_eq 'observed false false' "$(updated | jq -r '"\(.notes) \(has("unbound")) \(has("bind_refusal"))"')" "merged fields"
  assert_eq observed "$(spool_lines | jq -r 'select(.ev == "output") | .input.notes')" "spooled result"
}

case_verifier() {
  setup_writer
  so litter:verifier "$FANOUT_CHECK" | run_hook output.sh
  assert_deny 'no verify recorded by you for verify_id \"v4\"'
  assert_contains 'gate integration and attempt 1' "$(cat "$T_DIR/out")" reason
  out_file '{"verify_id":"v5"}' '{"combined":{"pass":false,"evidence":"verify v5 exited 1","gaps":[]}}'
  so litter:verifier "$FANOUT_CHECK" | run_hook output.sh
  assert_deny 'your result gives verify_id \"v4\", but your latest record is for \"v5\"'
  out_file '{"verify_id":"v4"}' '{"combined":{"pass":false,"evidence":"verify v4 exited 1","gaps":[]}}'
  so litter:verifier "$FANOUT_CHECK" | run_hook output.sh
  assert_eq 'false verify v4 exited 1' "$(updated | jq -r '"\(.combined.pass) \(.combined.evidence)"')" combined
  assert_eq '"t1"' "$(updated | jq -c '.tasks[0].id')" tasks
}

case_integrate_relay() {
  setup_writer
  so litter:relay '{"integrate_id":"i1","status":"merged"}' | run_hook output.sh
  assert_deny 'no integrate recorded by you for integrate_id \"i1\"'
  # A verify's out file doesn't answer an integrate.
  out_file '{"verify_id":"v4"}' '{"green":true}'
  so litter:relay '{"integrate_id":"i1","status":"merged"}' | run_hook output.sh
  assert_deny 'no integrate recorded by you'
  out_file '{"integrate_id":"i2"}' '{"status":"conflict"}'
  so litter:relay '{"integrate_id":"i1","status":"merged"}' | run_hook output.sh
  assert_deny 'your result gives integrate_id \"i1\", but your latest record is for \"i2\"'
  out_file '{"integrate_id":"i1"}' '{"status":"conflict","conflicts":["src/a.py"]}'
  so litter:relay '{"integrate_id":"i1","status":"merged"}' | run_hook output.sh
  assert_eq '{"integrate_id":"i1","status":"conflict","conflicts":["src/a.py"]}' "$(updated)" updatedInput
}

t "a StructuredOutput from anyone but a litter agent passes untouched" case_not_litter
t "a critic's tests_green: true against a red verify is rewritten to false" case_critic_rewritten
t "a critic with no verify recorded is denied" case_critic_no_out
t "a critic citing another verify_id is denied" case_critic_other_verify
t "a verify relay gets the observed exit_code, signal, timed_out and green" case_relay_verify
t "a land relay gets the observed landed, reason and retry" case_relay_land
t "a land relay with no land recorded is denied" case_relay_land_missing
t "an author's proposal is filled with the recorded text" case_author_filled
t "an author naming a version it didn't record is denied" case_author_other_version
t "a design critic's source_changed is filled, and needs its verdict" case_design_critic
t "a design critic gets the recorded version, source_changed, criteria and overall" case_design_critic_recorded
t "a design critic naming another version than it recorded is denied" case_design_critic_other_version
t "a design critic with no out file is told to record its verdict first" case_design_critic_no_out
t "a role with no observed fields passes, and its result is spooled" case_no_fields_needed
t "an unreadable or other-version out file denies" case_out_unreadable
t "an out file for another agent denies" case_out_for_another_agent
t "a StructuredOutput that isn't an object is denied" case_not_an_object
t "a result over 4 KiB goes to spool/blobs, and the line names it" case_big_result_blob
t "an unbound fanout writer's blocked result gets unbound and the recorded refusal" case_writer_unbound_blocked
t "an unbound fanout writer's other results are denied" case_writer_unbound_denied
t "a fanout writer's unreadable agents, out or policy file denies" case_writer_unreadable_files
t "a bound fanout writer's result is spooled, unbound never claimed" case_writer_bound
t "a bound fanout writer gets its out file's fields, but a stale refusal" case_writer_bound_merged
t "the fanout verifier needs the verify it records, and gets its fields" case_verifier
t "an integrate relay is matched by integrate_id" case_integrate_relay
done_testing
