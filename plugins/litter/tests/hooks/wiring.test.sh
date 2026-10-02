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

t "every script hooks.json names exists" case_scripts_exist
t "every command hook is exec form, sh" case_exec_form
done_testing
