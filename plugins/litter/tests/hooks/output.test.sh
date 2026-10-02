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
t "a role with no observed fields passes, and its result is spooled" case_no_fields_needed
t "an unreadable or other-version out file denies" case_out_unreadable
t "an out file for another agent denies" case_out_for_another_agent
t "a StructuredOutput that isn't an object is denied" case_not_an_object
t "a result over 4 KiB goes to spool/blobs, and the line names it" case_big_result_blob
done_testing
