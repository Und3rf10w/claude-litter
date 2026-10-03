# Tier 3: every script hooks.json names exists, and runs in exec form.

. "$(dirname "$0")/testlib.sh"

case_scripts_exist() {
  for s in $(sed -n 's|.*"\${CLAUDE_PLUGIN_ROOT}/hooks/\([a-z]*\.sh\)".*|\1|p' "$LITTER_ROOT/hooks/hooks.json" | sort -u); do
    assert_file "$LITTER_ROOT/hooks/$s"
  done
}

case_exec_form() {
  assert_not_contains '"command": "${CLAUDE_PLUGIN_ROOT}' "$(cat "$LITTER_ROOT/hooks/hooks.json")" hooks.json
  if grep -n '"command"' "$LITTER_ROOT/hooks/hooks.json" | grep -v '"command": *"sh"' >&2; then
    fail 'a command hook that is not "command": "sh"'
  fi
}

# hold.sh on SubagentStop, with the 600 s its 570 s cap stays under, beside
# identity.sh's stop (plan 15.4, option C).
case_hold_wired() {
  assert_eq '600' "$(jq -r '[.hooks.SubagentStop[] | select(.matcher == null) | .hooks[]
      | select(.command == "sh" and .args == ["${CLAUDE_PLUGIN_ROOT}/hooks/hold.sh"]) | .timeout] | join(",")' \
    "$LITTER_ROOT/hooks/hooks.json")" "hold.sh's SubagentStop timeout"
  assert_eq '1' "$(jq -r '[.hooks.SubagentStop[].hooks[] | select(.args == ["${CLAUDE_PLUGIN_ROOT}/hooks/identity.sh", "stop"])] | length' \
    "$LITTER_ROOT/hooks/hooks.json")" "identity.sh stop"
  assert_contains 'hw_cap=${LT_HOLD_CAP:-570}' "$(cat "$LITTER_ROOT/hooks/hold.sh")" "hold.sh's cap"
}

t "every script hooks.json names exists" case_scripts_exist
t "every command hook is exec form, sh" case_exec_form
t "hold.sh runs on every SubagentStop with timeout 600" case_hold_wired
done_testing
