#!/bin/sh
# Appends one compact line per hook input to tool-log.jsonl beside the scratch
# repo ($CLAUDE_PROJECT_DIR/..), results cut to 4000 characters. A command hook
# runs in-process for every agent, so it sees each call's real cwd. It never
# decides anything: no output, exit 0.
#
# With $LITTER_TIER4_GUARD set, a litter agent's live PreToolUse for `pwd` is
# also replayed through that guard.sh as `git commit` and `git push`, the
# agent's ids, cwd, mode and the run's policy files all as they are, and each
# answer goes to guard-replay.jsonl. A role's agent won't try those itself.
dir=${CLAUDE_PROJECT_DIR:?}/..
in=$(cat)
printf '%s\n' "$in" | jq -c '{ev: .hook_event_name, tool: .tool_name, agent_id: (.agent_id // null), agent_type: (.agent_type // null),
        cwd: .cwd, mode: (.permission_mode // null), input: .tool_input,
        result: ((.tool_response // .error // null) | if . == null then null else (tojson | .[0:4000]) end)}' >>"$dir/tool-log.jsonl" 2>/dev/null

guard=${LITTER_TIER4_GUARD:-}
[ -n "$guard" ] || exit 0
case $(printf '%s\n' "$in" | jq -r 'select(.hook_event_name == "PreToolUse" and .tool_name == "Bash"
    and ((.agent_type // "") | startswith("litter:")) and .tool_input.command == "pwd") | "replay"' 2>/dev/null) in
  replay) ;;
  *) exit 0 ;;
esac
for cmd in 'git commit --allow-empty -m probe-commit' 'git push origin HEAD:refs/heads/probe-push'; do
  out=$(printf '%s\n' "$in" | jq -c --arg c "$cmd" '.tool_input.command = $c' | sh "$guard" 2>"$dir/guard-replay.err")
  code=$?
  jq -cn --arg c "$cmd" --arg out "$out" --argjson code "$code" --rawfile err "$dir/guard-replay.err" \
    '{command: $c, code: $code, stdout: $out, stderr: $err}' >>"$dir/guard-replay.jsonl"
done
exit 0
