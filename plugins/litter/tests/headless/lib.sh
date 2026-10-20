# Tier 4: helpers for the headless runs (plan section 12). POSIX sh + jq.
# Each run is a real `claude -p` session in a scratch repo, so it needs a
# signed-in claude on PATH and spends tokens; CI doesn't run it.
#
# A case's files live in $H_OUT/<case>/ and are kept for reading afterwards:
#   repo/         the scratch checkout the session runs in
#   origin.git    its bare remote
#   litter/       a copy of the plugin, with fixtures/*.js as its workflows
#   debug.txt     the session's --debug-file
#   tool-log.jsonl  every hook input, from the toollog fixture's command hooks
#   guard-replay.jsonl  guard.sh's answers to a litter agent's live input as git commit and push
#   out.json, stderr.txt

H_HERE=$(cd "$(dirname "$0")" && pwd)
LITTER_ROOT=$(cd "$H_HERE/../.." && pwd)
H_FIX=$H_HERE/fixtures
H_OUT=${H_OUT:-${TMPDIR:-/tmp}/litter-tier4}
H_PASS=0
H_FAIL=0

h_git() { git -c user.name=tier4 -c user.email=tier4@example.invalid -c commit.gpgsign=false "$@"; }

# h_deepwork <dest>: the deepwork plugin for the compare cases, at <dest>.
# It left the repo in phase 7, so it's read from the tree tagged legacy-3.8
# (H_DEEPWORK_REF overrides the ref), or copied from H_DEEPWORK, a deepwork
# plugin folder. Exits when neither is there.
h_deepwork() {
  if [ -n "${H_DEEPWORK:-}" ]; then
    cp -R "$H_DEEPWORK" "$1" || exit 1
    return 0
  fi
  dw_ref=${H_DEEPWORK_REF:-legacy-3.8}
  git -C "$LITTER_ROOT" rev-parse -q --verify "$dw_ref^{tree}" >/dev/null ||
    { echo "$0: no $dw_ref in this clone for deepwork (git fetch --tags, or set H_DEEPWORK to a deepwork plugin folder)" >&2; exit 2; }
  rm -rf "$1.tmp" && mkdir -p "$1.tmp" || exit 1
  git -C "$LITTER_ROOT" archive "$dw_ref" plugins/deepwork >|"$1.tmp/deepwork.tar" || exit 1
  tar -x -f "$1.tmp/deepwork.tar" -C "$1.tmp" && mv "$1.tmp/plugins/deepwork" "$1" && rm -rf "$1.tmp" || exit 1
}

# h_scratch <case>: a fresh $H_DIR with the repo, its remote and the plugin copy.
# The checkout is one commit ahead of origin/main, and only that commit has
# README's PARENT-ONLY line and parent-only.txt. The repo pins the engine's
# worktree base to origin (worktree.baseRef fresh), so the engine's worktrees
# lack both. litter's are at the run's base, HEAD, so the parent also holds
# parent-local.txt (PARENT-LOCAL): ignored by git, so no snapshot, base or
# worktree has it, and un-ignored for ripgrep by the committed .ignore, so
# Grep finds it in the parent. An answer naming it came from the parent's
# files. The tree stays clean, which run.start needs. Like many repos, it
# ignores litter's and the engine's folders under .claude/.
h_scratch() {
  H_CASE=$1
  H_DIR=$H_OUT/$1
  rm -rf "$H_DIR"
  mkdir -p "$H_DIR/litter/workflows" || exit 1
  H_DIR=$(cd -P "$H_DIR" && pwd -P)
  H_REPO=$H_DIR/repo
  git init -q --bare "$H_DIR/origin.git" || exit 1
  git init -q -b main "$H_REPO" || exit 1
  mkdir -p "$H_REPO/.claude"
  printf 'hi\n' >|"$H_REPO/README"
  printf '{ "worktree": { "baseRef": "fresh" } }\n' >|"$H_REPO/.claude/settings.json"
  printf 'parent-local.txt\n/.claude/litter/\n/.claude/worktrees/\n' >|"$H_REPO/.gitignore"
  printf '!parent-local.txt\n' >|"$H_REPO/.ignore"
  h_git -C "$H_REPO" add README .claude/settings.json .gitignore .ignore
  h_git -C "$H_REPO" commit -q -m init || exit 1
  h_git -C "$H_REPO" remote add origin "$H_DIR/origin.git"
  h_git -C "$H_REPO" push -q origin main || exit 1
  printf 'hi\nPARENT-ONLY\n' >|"$H_REPO/README"
  printf 'PARENT-ONLY\n' >|"$H_REPO/parent-only.txt"
  h_git -C "$H_REPO" add README parent-only.txt
  h_git -C "$H_REPO" commit -q -m 'the parent only' || exit 1
  printf 'PARENT-LOCAL\n' >|"$H_REPO/parent-local.txt"
  for e in "$LITTER_ROOT"/.claude-plugin "$LITTER_ROOT"/*; do
    case ${e##*/} in tests | workflows) continue ;; esac
    cp -R "$e" "$H_DIR/litter/" || exit 1
  done
  cp "$H_FIX"/*.js "$H_DIR/litter/workflows/" || exit 1
  # Copies, since the engine writes types into a --plugin-dir folder it loads.
  cp -R "$H_FIX/toollog" "$H_FIX/broad" "$H_DIR/" || exit 1
}

# h_claude <prompt> [claude args...]: one headless session in the repo, with
# litter and the tool log loaded. Extra args go before the prompt's options.
# H_SUBDIR starts it in that folder of the repo instead of its top.
h_claude() {
  hc_prompt=$1
  shift
  (
    cd "$H_REPO/${H_SUBDIR:-}" || exit 1
    LITTER_TIER4_DIR=$H_DIR LITTER_TIER4_GUARD=$H_DIR/litter/hooks/guard.sh claude -p --plugin-dir "$H_DIR/litter" --plugin-dir "$H_DIR/toollog" "$@" \
      --debug-file "$H_DIR/debug.txt" --output-format json --max-turns 30 "$hc_prompt" \
      </dev/null >|"$H_DIR/out.json" 2>|"$H_DIR/stderr.txt"
  )
  printf '%s: claude exited %s\n' "$H_CASE" "$?"
}

# h_tool_steps <debug file>: drive.exp steps that end the session if litter's
# tool server hasn't connected within 90 s. Under heavy load, CC 2.1.289
# can't read the keychain within its 2 s timeout, and the mod's tool server
# never connects (McpCredentialStoreUnavailableError; T4-RESULTS.md, T4-2).
# The drive then exits 4, which h_tool_down reads.
h_tool_steps() {
  printf '%s\n' "# litter's tool server is up, or the session can't run the case." \
    "wait 90 grep -q 'MCP server \"litter\": Successfully connected' $1" \
    "abortif ! grep -q 'MCP server \"litter\": Successfully connected' $1"
}

# h_wait_steps: prompt steps (from 3) that keep a headless session's turn
# going until the run has a run.end, up to about 28 minutes. Once the turn
# ends, claude -p waits about 10 minutes for background work and then kills
# it ("print wind-down", 2.1.299), and a long run on a loaded machine takes
# longer. It writes $H_DIR/wait-end.sh, which waits at most 9.5 minutes, so
# one Bash call stays inside the tool's 10. The case needs 'Bash(sh:*)'.
h_wait_steps() {
  cat >|"$H_DIR/wait-end.sh" <<EOF
#!/bin/sh
i=0
while [ "\$i" -lt 114 ]; do
  ls "$H_REPO"/.claude/litter/*/ledger/*-run.end.json >/dev/null 2>&1 && { echo 'the run ended'; exit 0; }
  sleep 5
  i=\$((i + 1))
done
echo 'still running'
EOF
  printf '%s\n' "3. Run with Bash in the foreground, not in the background, with the tool's timeout set to 600000: sh $H_DIR/wait-end.sh" \
    '4. If it printed still running, run it again the same way, at most twice more.' \
    '5. Wait for the workflow task notification. Then reply with each step result and the workflow result, verbatim.'
}

# h_tool_down <drive exit code>: INCONCLUSIVE (exit 3) when the drive ended on h_tool_steps' abort.
h_tool_down() {
  [ "$1" = 4 ] || return 0
  echo "INCONCLUSIVE: litter's tool server never connected (debug.txt: McpCredentialStoreUnavailableError, the keychain read timing out under load); run it again on a quieter machine"
  exit 3
}

h_check() {
  if [ "$1" = ok ]; then
    H_PASS=$((H_PASS + 1))
    printf 'ok   %s\n' "$2"
  else
    H_FAIL=$((H_FAIL + 1))
    printf 'FAIL %s\n' "$2"
    [ -z "${3:-}" ] || printf '%s\n' "$3" | sed 's/^/     /'
  fi
}

# h_expect <description> <command...>: ok when the command succeeds.
h_expect() {
  he_what=$1
  shift
  if he_out=$("$@" 2>&1); then h_check ok "$he_what"; else h_check fail "$he_what" "$he_out"; fi
}

h_done() {
  printf '%s: %d passed, %d failed (files in %s)\n' "$H_CASE" "$H_PASS" "$H_FAIL" "$H_DIR"
  [ "$H_FAIL" -eq 0 ]
}

# The tool log's lines for one agent: `main`, or an agent_type.
h_log() {
  if [ "$1" = main ]; then
    jq -c 'select(.agent_id == null)' "$H_DIR/tool-log.jsonl"
  else
    jq -c --arg t "$1" 'select(.agent_type == $t)' "$H_DIR/tool-log.jsonl"
  fi
}

# The session's transcripts, its agents' included, one path per line.
h_transcripts() {
  ht_sid=$(jq -r 'if type == "array" then (map(select(.session_id != null)) | .[-1].session_id) else .session_id end' "$H_DIR/out.json")
  ht_proj=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$(printf '%s' "$H_REPO" | sed 's#[^A-Za-z0-9]#-#g')
  [ -f "$ht_proj/$ht_sid.jsonl" ] && printf '%s\n' "$ht_proj/$ht_sid.jsonl"
  [ -d "$ht_proj/$ht_sid" ] && find "$ht_proj/$ht_sid" -name '*.jsonl'
}

# Every tool the session and its agents called, one name per line.
h_tool_uses() {
  h_transcripts | while IFS= read -r f; do
    jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use") | .name' "$f"
  done
}

# An agent's worktree: the cwd of its SubagentStart.
h_worktree() {
  h_log "$1" | jq -r 'select(.ev == "SubagentStart") | .cwd' | head -n 1
}
