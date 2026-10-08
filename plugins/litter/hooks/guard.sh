#!/bin/sh
# guard.sh: PreToolUse with no matcher, so every tool (plan section 9, "Guard
# (litter agents only)"). The main thread and other plugins' agents pass, but
# for three narrow rules while a run is active. A litter agent is checked
# against policy.json, its bind/<agent_id> and its own permission_mode, and
# every failure on its call ends in a deny: the deny decision, or exit 2.
#
# A fanout writer (a litter:executor in a fanout run) is bound twice: to its
# worktree by bind/<agent_id>, and to its task by agents/<agent_id>.json,
# which the mod writes at task.bind (section 7, fanout.js step 2). Until then
# it gets StructuredOutput (and the record tool) alone; after, it writes only
# its task's files and may stage and commit in its own worktree, with the
# hooks running.
#
# A swarm node, or a node's child, is bound by agents/<agent_id>.json with
# `node`, which the mod writes at its binding (plan 15.4, "The guard for
# nodes"). It gets the node rules (guard_node) against its swarm's entry in
# policy.json, whatever its agent_type: a child keeps its own type, and a node
# that lost its type is denied for that. Keyed by agent_id, never by session,
# so a /clear changes nothing here. An unknown agent waits up to 2 s for a
# binding while one may be landing ("The guard closes the race").
#
# Every call it passes from a node, a child or a run agent is spooled as a
# `call` start, and every one it denies as a `deny`, which closes the call
# (15.4, "Ending", step 2). The spool never changes a decision.

set -u
case $0 in */*) lt_here=${0%/*} ;; *) lt_here=. ;; esac
if [ ! -r "$lt_here/lib.sh" ]; then
  # No lib, no checks: refuse while a run may be active or a binding remains
  # (lib.sh's lt_begin), pass otherwise.
  lt_d=${CLAUDE_PROJECT_DIR:-/nonexistent}/.claude/litter/hooks
  lt_any=
  for lt_f in "$lt_d"/agents/*.json; do [ -e "$lt_f" ] && lt_any=1; done
  [ -f "$lt_d/active" ] || [ -n "$lt_any" ] || exit 0
  printf 'litter guard failed: loading lib.sh; refusing\n' >&2
  exit 2
fi
. "$lt_here/lib.sh"

# Who's calling, and the rules for anyone but a litter agent or a swarm node:
# a litter role spawned outside a workflow, a named swarm node, and the main
# thread's EnterWorktree and ExitWorktree. Those would move every agent the
# run starts later ("Background sessions"), and while a swarm is live they
# would confine every node to the session's worktree (plan 15.4, spike 1).
# The one EnterWorktree allowed is the launcher's, into the run's own checkout
# before the launch, with no swarm live (section 9). Prints `who …`, then:
#   next <agent_id>                      a run agent (litter:<role>)
#   node <agent_id> wait|nowait          a litter:sw-* agent; wait: its type is a live swarm's
#   maybe <agent_id> fork|typed <decision…>  any other agent: a node's child if the
#                                        mod bound it, else the decision after it
# or a decision.
GUARD_JQ_HEAD='
def swarms($p): if ($p | ok1) and ($p.swarm | type) == "object" and ($p.swarm.swarms | type) == "object"
  then $p.swarm.swarms else {} end;
def other($in; $id; $tool; $ti; $sub):
  if $tool == "Agent" and ($sub | startswith("litter:sw-")) then
    (if ($ti.name | str) != "" then deny($in; "a swarm node takes no name: where agent teams are on, a named agent starts as a teammate, which runs in the directory of the session and ignores the cwd and background litter gives it. Spawn \($sub) again without name")
     else "pass" end)
  elif $tool == "Agent" and ($sub | startswith("litter:")) then
    deny($in; "litter roles run inside litter workflows; start one with /litter:execute, /litter:design or /litter:fanout instead of spawning \($sub)")
  elif $id != "" then "pass"
  elif $tool == "ExitWorktree" or $tool == "EnterWorktree" then
    readj($pol) as $p
    | if (swarms($p) | length) > 0 then
        deny($in; "a litter swarm is live: a session in a worktree confines the Bash, Write and Edit of every agent to that worktree, which would cut off every node pinned elsewhere in the repository (plan 15.4). Stay in this directory until the swarm ends")
      elif $tool == "ExitWorktree" then
        deny($in; "a litter run is active, so the session stays in its working directory until the run ends: the run starts its agents there")
      elif ($p | ok1) and ($p.run | type) == "object" and (($p.run.runIds // []) | length) == 0
          and $p.run.launching != true and ($ti.path | str) != ""
          and (($ti.path | str) == ($p.run.checkout | str) or ($ti.path | str) == ($p.run.roots.checkout | str))
        then "pass"
      else deny($in; "a litter run is active, so the session stays in its working directory until the run ends; before the launch, only EnterWorktree({ path }) into the run checkout is allowed") end
  else "pass" end;
. as $in
| ($in.agent_id | str) as $id
| ($in.agent_type | str) as $type
| ($in.tool_name | str) as $tool
| ($in.tool_input | if type == "object" then . else {} end) as $ti
| ($ti.subagent_type | str) as $sub
| if ($type | startswith("litter:")) and ($id | okid | not) then
    "who litter\n" + deny($in; "this call carries no usable agent_id, so litter cannot tell which agent made it; refusing")
  elif ($type | startswith("litter:sw-")) then
    "who litter\nnode\n" + $id + "\n"
      + (if any(swarms(readj($pol))[] | (.nodeTypes // []) | if type == "array" then .[] else empty end; . == $type)
         then "wait" else "nowait" end)
  elif ($type | startswith("litter:")) then "who litter\nnext\n" + $id
  elif ($id | okid) then
    "who other\nmaybe\n" + $id + "\n" + (if $type == "" then "fork" else "typed" end) + "\n" + other($in; $id; $tool; $ti; $sub)
  else "who other\n" + other($in; $id; $tool; $ti; $sub) end
'

# Bash, read as a heuristic (section 9, "Bash"): the role tools allowlist and
# the classifier are the other two layers. A command is split into simple
# commands at every separator, even inside quotes, since sh -c "a; b" runs
# both; quotes and backslashes are then dropped from each word. It is also
# read with each quoted part kept whole, as the shell reads it, and the
# simple commands of both readings are checked (segs). A command's first
# word past its assignments and redirections counts, and after a wrapper (sudo, env, sh -c, find -exec, xargs,
# …) every later word that names a command some rule checks (git, a writer, a
# deploy or install tool, a bash.deny entry) starts one too.
#
# The hook has 30 s, and a command hook that runs out of time lets the call
# run, so the parse stays linear in the command (bashparse): a command over
# 32 KiB or 4,000 words is denied unread, and so is one with more than 32
# such words after a wrapper.
GUARD_JQ_BASH='
def oneof($xs): . as $x | ($xs | index([$x])) != null;
def base: split("/") | last | ascii_downcase;
# Plain-string splits, not regex ones: jq 1.7 finds each regex match from the
# start of the string, so a regex over a command with thousands of matches
# takes seconds.
def dequote: split("\"") | join("") | split([39] | implode) | join("") | split("\\") | join("");
def cuts($seps): reduce $seps[] as $sep ([.]; [.[] | split($sep)[]]);
# A redirection is a word of its own (redsplit): a word with < or > in it is
# cut before the first one, unless what comes before is a descriptor number,
# so git push>x reads as git, push and >x, and 2>x stays one word.
def redsplit: ([indices(">")[0], indices("<")[0]] | map(select(. != null)) | min) as $i
  | if $i == null or $i == 0 or (.[:$i] | test("^[0-9]+$")) then . else .[:$i], .[$i:] end;
def rawwords: [cuts([" ", "\t"])[] | dequote | select(. != "")];
def words: [rawwords[] | redsplit];
# >| (noclobber), >& and <& (descriptor copies) are redirections, never a
# pipe or a background &: they become > and < before the command is cut.
# &> is left to the cut, so a shell that reads it as & then > runs what
# follows as a command of its own, and that command is checked.
def norm: split(">|") | join(">") | split(">&") | join(">") | split("<&") | join("<");
def seps: ["$(", "`", ";", "&", "|", "\n", "\r", "(", ")", "{", "}"];
# The command read two ways, and the simple commands of both checked:
#  - plainsegs cuts it at every separator, even inside quotes, since
#    sh -c "a; b" runs both, then each piece at its blanks;
#  - quotedsegs keeps a quoted or backslash-escaped part whole, as the
#    shell does, so A="x y" git push, >"a b" git push and A="x;y" git push
#    have git as their command word. qprotect swaps each blank and
#    separator character in such a part for a private-use character
#    (U+E000 plus its code), and unprotect swaps it back in each word.
# One pass over the characters, no regex; a backslash-newline outside single
# quotes joins two lines, as in the shell.
def plainsegs: norm | cuts(seps) | map(rawwords) | map(select(length > 0));
def pcodes: [32, 9, 10, 13, 59, 38, 124, 40, 41, 123, 125, 96, 36];
def qprotect: (reduce pcodes[] as $c ([range(0; 128) | false]; .[$c] = true)) as $pt
  | [foreach explode[] as $c ({q: 0, e: false, o: null};
      if .e then {q: .q, e: false, o: (if $c == 10 then null elif $c < 128 and $pt[$c] then 57344 + $c else $c end)}
      elif .q == 39 then {q: (if $c == 39 then 0 else 39 end), e: false, o: (if $c != 39 and $c < 128 and $pt[$c] then 57344 + $c else $c end)}
      elif $c == 92 then {q: .q, e: true, o: null}
      elif .q == 34 then {q: (if $c == 34 then 0 else 34 end), e: false, o: (if $c != 34 and $c < 128 and $pt[$c] then 57344 + $c else $c end)}
      elif $c == 34 or $c == 39 then {q: $c, e: false, o: $c}
      else {q: 0, e: false, o: $c} end;
      .o // empty)] | implode;
def unprotect: reduce pcodes[] as $c (.; ([57344 + $c] | implode) as $ph | if contains($ph) then split($ph) | join([$c] | implode) else . end);
def quotedsegs: norm | qprotect | cuts(seps) | map([rawwords[] | unprotect]) | map(select(length > 0));
def splitreds: map([.[] | redsplit]);
def segs: plainsegs as $pa | ($pa + quotedsegs) | splitreds;
def isassign: test("^[A-Za-z_][A-Za-z0-9_]*=");
# A redirection operator alone (its target is the next word), or one with its target.
def redirop: test("^[0-9]*(<<-|[<>]+)$");
def isredir: test("^[0-9]*[<>]");
# The index of a simple command word, past the assignments and redirections
# before it, wherever they come; null when there is none.
def cmdat: . as $w
  | first(foreach range(0; $w | length) as $k ({skip: false};
      if .skip then {skip: false}
      elif ($w[$k] | isassign) then {skip: false}
      elif ($w[$k] | redirop) then {skip: true}
      elif ($w[$k] | isredir) then {skip: false}
      else {at: $k} end;
      select(.at != null) | .at)) // null;
# The simple command from its command word on, or [] when it has none.
def lead: cmdat as $i | if $i == null then [] else .[$i:] end;
# A cd (pushd, popd) command: the folder it goes to, its first word after cd
# that is no redirection; "" for none.
def cdto: .[1:] as $w
  | first(foreach range(0; $w | length) as $k ({skip: false};
      if .skip then {skip: false}
      elif ($w[$k] | redirop) then {skip: true}
      elif ($w[$k] | isredir) then {skip: false}
      else {at: $k} end;
      select(.at != null) | $w[.at])) // "";
def wrappers: ["env", "sudo", "doas", "command", "builtin", "exec", "nohup", "time", "nice", "timeout",
  "gtimeout", "stdbuf", "ionice", "eval", "xargs", "watch", "setsid", "chroot", "flock", "unbuffer",
  "caffeinate", "then", "else", "elif", "do", "if", "while", "until", "!", "sh", "bash", "zsh", "dash",
  "ksh", "ash", "mksh", "busybox", "su", "runuser", "find", "parallel", "script", "strace"];
# A simple command, past its assignments and redirections, and after a
# wrapper each later word in $hs (an object: name to true) with the rest of
# the command after it, or "many" when there are more than 32 of those.
def cmds($hs): cmdat as $i
  | if $i == null then empty
    else .[$i:] as $c
    | $c, (if ($c[0] | base | oneof(wrappers)) then
        [range(1; $c | length) as $k | select($hs[$c[$k] | base] == true) | $k] as $ks
        | if ($ks | length) > 32 then "many" else ($ks[] as $k | $c[$k:]) end
      else empty end)
    end;
def toolong: "this command is too long for the guard to check; split it";

def has1($f): any(.[]; . == $f);
def hasp($p): any(.[]; startswith($p));
def short($cs): any(.[]; test("^-[A-Za-z0-9]*[" + $cs + "]"));
def pos: map(select(startswith("-") | not));
def first1: (pos | .[0]) // "";

# git past its global options; -c and --config-env are noted, and so is every
# -C, --git-dir and --work-tree, as [option, value] in loc. One pass by index:
# each option is an event, and the first word that is no option (nor a
# redirection) is the subcommand, which ends the pass.
def gitsub:
  . as $w
  | [label $out | foreach range(0; $w | length) as $k ({at: 0, ev: null};
      if $k < .at then .ev = null
      else $w[$k] as $x
      | if $x == "-c" then .at = $k + 2 | .ev = {cfg: true}
        elif ($x | startswith("--config-env")) then .at = $k + (if ($x | contains("=")) then 1 else 2 end) | .ev = {cfg: true}
        elif ($x | oneof(["-C", "--git-dir", "--work-tree"])) then .at = $k + 2 | .ev = {loc: [$x, ($w[$k + 1] // "")]}
        elif ($x | startswith("--git-dir=")) or ($x | startswith("--work-tree=")) then
          .at = $k + 1 | .ev = {loc: [($x | split("=") | .[0]), ($x | sub("^[^=]*="; ""))]}
        elif ($x | oneof(["--namespace", "--super-prefix", "--attr-source"])) then .at = $k + 2 | .ev = null
        elif ($x | redirop) then .at = $k + 2 | .ev = null
        elif ($x | startswith("-")) or ($x | isredir) then .at = $k + 1 | .ev = null
        else .ev = {sub: $k} end
      end;
      if .ev == null then empty elif .ev.sub != null then (.ev, break $out) else .ev end)] as $evs
  | ([$evs[] | .sub // empty] | .[0]) as $s
  | {sub: (if $s == null then "" else $w[$s] | ascii_downcase end), args: (if $s == null then [] else $w[$s + 1:] end),
     cfg: any($evs[]; .cfg == true), loc: [$evs[] | .loc // empty]};
# A long option, spelled in full or by any prefix git would accept for it.
def longopt($full; $min): any(.[]; . as $w | ($w | startswith("--")) and ($w | length) >= $min and ($full | startswith($w)));
# The git commands that write the index (section 9, "Bash"): only a bound
# fanout writer runs them, and only in its own worktree.
def indexwrite: .sub as $s | .args as $a
  | ($s | oneof(["add", "rm", "mv", "update-index", "read-tree", "reset", "stash"]))
    or ($s == "restore" and (($a | has1("--staged")) or ($a | short("S"))))
    or ($s == "apply" and (($a | has1("--cached")) or ($a | has1("--index")) or ($a | hasp("--3way")) or ($a | short("3"))));
def gitwrite: .cfg != true and (.sub == "commit" or indexwrite);
# A fanout writer commit or index write runs in its own worktree: -C only to
# that folder (or .), and no --git-dir or --work-tree at all.
def ownwork($wcwd): .loc | all(.[]; .[0] == "-C" and (.[1] == "." or (.[1] | rtrimstr("/")) == $wcwd));
def fanoutgitwhy($wcwd):
  .sub as $s | .args as $a
  | if (ownwork($wcwd) | not) then
      "git \($s) runs only in your own worktree \($wcwd): run it there, without -C to another folder, --git-dir or --work-tree"
    elif $s == "commit" and (($a | longopt("--no-verify"; 6)) or ($a | short("n"))) then
      "git commit --no-verify and -n skip your repository hooks, which every fanout commit runs; commit without them, and fix what the hooks report"
    elif $s == "commit" and ($a | longopt("--amend"; 4)) then
      "git commit --amend rewrites a commit; make a new commit on your branch instead"
    elif $s == "reset" and ($a | longopt("--hard"; 4)) then
      "git reset --hard discards work, and is denied to every litter agent"
    elif ($a | hasp("--force")) then "force flags are denied to litter agents (git \($s) \($a | map(select(startswith("--force"))) | .[0]))"
    elif $s == "stash" then
      # The plan allows it; refs/stash is one stack for every worktree, so a
      # writer could pop another writer stash into its own worktree.
      "git stash writes refs/stash, which every worktree of your repository shares, the other writers too; commit on your branch instead"
    else empty end;
# The command-level rules for a fanout writer command that commits or writes
# the index: no hook-skipping or git-redirecting variables, and no cd away
# from its worktree first.
def fanoutcmdwhy($cmd; $wcwd):
  [$cmd | segs[]] as $ws
  | ([$ws[][] | select(test("^(HUSKY|HUSKY_SKIP_HOOKS|SKIP|PRE_COMMIT_ALLOW_NO_CONFIG|LEFTHOOK|LEFTHOOK_EXCLUDE|OVERCOMMIT_DISABLE|GIT_[A-Za-z0-9_]*)="))] | .[0]) as $var
  | if $var != null then
      "a fanout commit or index write runs with your repository hooks and git environment as they are: drop \($var | split("=") | .[0])"
    elif any($ws[] | lead | select((.[0] // "") | base | oneof(["cd", "pushd", "popd"])); ((cdto | rtrimstr("/")) != $wcwd)) then
      "git commit and index writes run only in your own worktree \($wcwd): run them there, without cd"
    else empty end;
def configwrite: .args as $a | ($a | first1) as $p1
  | ($a | any(.[]; oneof(["--unset", "--unset-all", "--add", "--replace-all", "--rename-section", "--remove-section", "-e", "--edit"])))
    or ($p1 | oneof(["set", "unset", "rename-section", "remove-section", "edit"]))
    or ((($a | pos | length) >= 2) and (($a | any(.[]; startswith("--get") or . == "--list" or . == "-l")) | not)
        and (($p1 | oneof(["get", "list"])) | not));
# Commits, pushes, history rewrites and force flags are denied to every role,
# and so is every git command that writes the real index (section 9, "Bash"),
# but for a bound fanout writer ($fw) committing and staging in its own
# worktree ($wcwd).
def gitwhy($rowhy; $fw; $wcwd):
  .sub as $s | .args as $a | ($a | first1) as $p1
  | if .cfg then "git -c and --config-env overrides are denied to litter agents; run git without them"
    elif $fw and gitwrite then fanoutgitwhy($wcwd)
    elif ($s | oneof(["commit", "push", "merge", "cherry-pick", "revert", "am", "pull", "rebase", "update-ref",
        "symbolic-ref", "commit-tree", "filter-branch", "filter-repo", "replace"])) then
      "git \($s) is denied to litter agents: commits, refs and history belong to the mod, which lands verified work itself"
    elif ($s | oneof(["add", "rm", "mv", "update-index", "read-tree", "reset", "stash", "checkout-index"])) then
      "git \($s) writes the real index, which stays yours during a run; the mod snapshots the tree with its own index, so nothing needs staging"
    elif ($s | oneof(["checkout", "switch", "bisect"])) then
      "git \($s) moves the checkout or rewrites its files, and the run branch stays where it is; to read another version, use git show <rev>:<path>"
    elif ($s | oneof(["gc", "prune", "repack", "maintenance"])) then "git \($s) can drop objects the mod still needs during a run"
    elif ($a | hasp("--force")) then "force flags are denied to litter agents (git \($s) \($a | map(select(startswith("--force"))) | .[0]))"
    elif $s == "fetch" and ($a | short("f")) then "force flags are denied to litter agents (git fetch -f)"
    elif $s == "restore" and (($a | has1("--staged")) or ($a | short("S"))) then
      "git restore --staged writes the real index, which stays yours during a run"
    elif $s == "apply" and (($a | has1("--cached")) or ($a | has1("--index")) or ($a | hasp("--3way")) or ($a | short("3"))) then
      "git apply --cached, --index or --3way writes the real index, which stays yours during a run"
    elif $s == "clean" and ((($a | has1("--dry-run")) or ($a | short("n"))) | not) then
      "git clean deletes files; only a dry run (git clean -n) is allowed"
    elif $s == "branch" and (($a | any(.[]; oneof(["--delete", "--move", "--copy", "--force", "--unset-upstream",
        "--edit-description", "--set-upstream-to"]) or startswith("--set-upstream-to="))) or ($a | short("dDmMcCfu"))) then
      "git branch may only list here; deleting, moving, copying or forcing branches is denied"
    elif $s == "branch" and (($a | pos | length) > 0) and (($a | any(.[]; oneof(["-l", "--list", "-a", "--all", "-r", "--remotes"])
        or startswith("--contains") or startswith("--no-contains") or startswith("--merged") or startswith("--no-merged")
        or startswith("--points-at") or startswith("--format") or startswith("--sort"))) | not) then
      "git branch <name> creates a branch, and litter agents make none"
    elif $s == "tag" and (($a | length) > 0) and ((($a | any(.[]; oneof(["-l", "--list"]) or startswith("--contains")
        or startswith("--points-at") or startswith("--merged") or startswith("--no-merged") or startswith("--sort")
        or startswith("--format"))) | not)
        or ($a | any(.[]; oneof(["-d", "--delete", "-f", "-a", "--annotate", "-s", "--sign", "-m", "--message", "-F", "--file"])))) then
      "git tag may only list here (git tag -l)"
    elif ($s == "worktree" or $s == "sparse-checkout") and $p1 != "list" then "git \($s) may only list here; litter makes the run worktrees"
    elif $s == "submodule" and (($p1 | oneof(["", "status", "summary"])) | not) then "git submodule may only report here (status, summary)"
    elif $s == "config" and ($a | any(.[]; ascii_downcase | contains("hook"))) then "git config touching hooks is denied to litter agents"
    elif $s == "config" and configwrite then "git config may only read here (git config --get <key>)"
    elif $s == "remote" and ($p1 | oneof(["add", "remove", "rm", "rename", "set-url", "set-head", "set-branches", "prune", "update"])) then
      "git remote may only report here"
    elif $s == "notes" and (($p1 | oneof(["", "list", "show"])) | not) then "git notes may only read here"
    elif $s == "reflog" and ($p1 | oneof(["expire", "delete"])) then "git reflog \($p1) drops history"
    elif $rowhy != "" and ($s | oneof(["restore", "clean", "init", "clone", "fetch", "mergetool", "notes", "submodule"])) then
      "\($rowhy): git \($s) writes files or refs"
    elif $rowhy != "" and $s == "apply" and (($a | any(.[]; oneof(["--check", "--stat", "--numstat", "--summary"]))) | not) then
      "\($rowhy): git apply writes files"
    elif $rowhy != "" and ($a | hasp("--output")) then "\($rowhy): git --output writes a file"
    else empty end;

# Publish and deploy commands are always denied (section 9, "Bash"); an empty
# second word means the command alone.
def deploys: [["npm", "publish"], ["npm", "unpublish"], ["pnpm", "publish"], ["yarn", "publish"], ["bun", "publish"],
  ["cargo", "publish"], ["twine", "upload"], ["gem", "push"], ["poetry", "publish"], ["uv", "publish"], ["flit", "publish"],
  ["hatch", "publish"], ["mvn", "deploy"], ["gradle", "publish"], ["gradlew", "publish"], ["dotnet", "push"], ["nuget", "push"],
  ["docker", "push"], ["podman", "push"], ["kubectl", "apply"], ["kubectl", "create"], ["kubectl", "delete"],
  ["kubectl", "replace"], ["kubectl", "patch"], ["kubectl", "rollout"], ["kubectl", "scale"], ["kubectl", "edit"],
  ["kubectl", "set"], ["helm", "install"], ["helm", "upgrade"], ["helm", "uninstall"], ["helm", "rollback"],
  ["terraform", "apply"], ["terraform", "destroy"], ["terraform", "import"], ["tofu", "apply"], ["tofu", "destroy"],
  ["pulumi", "up"], ["pulumi", "destroy"], ["cdk", "deploy"], ["cdk", "destroy"], ["serverless", "deploy"],
  ["serverless", "remove"], ["sls", "deploy"], ["sls", "remove"], ["netlify", "deploy"], ["fly", "deploy"],
  ["flyctl", "deploy"], ["firebase", "deploy"], ["gcloud", "deploy"], ["aws", "deploy"], ["sam", "deploy"], ["eb", "deploy"],
  ["az", "deploy"], ["gh", "release"], ["gh", "create"], ["gh", "merge"], ["vercel", ""]];
# Installs, denied to read-only roles and the prober (section 6).
def installs: [["npm", "install"], ["npm", "i"], ["npm", "ci"], ["npm", "add"], ["pnpm", "install"], ["pnpm", "i"],
  ["pnpm", "add"], ["yarn", "install"], ["yarn", "add"], ["bun", "install"], ["bun", "add"], ["bun", "i"],
  ["pip", "install"], ["pip3", "install"], ["pipx", "install"], ["uv", "add"], ["uv", "install"], ["uv", "sync"],
  ["poetry", "add"], ["poetry", "install"], ["cargo", "install"], ["cargo", "add"], ["go", "install"], ["go", "get"],
  ["gem", "install"], ["bundle", "install"], ["brew", "install"], ["apt", "install"], ["apt-get", "install"],
  ["dnf", "install"], ["yum", "install"], ["apk", "add"], ["conda", "install"], ["composer", "install"],
  ["composer", "require"]];
# The head first: the rest of the command is read only when the table has it.
def pairwhy($table; $what): (.[0] | base) as $n
  | [$table[] | select(.[0] == $n)] as $rows
  | if ($rows | length) == 0 then empty
    else (.[1:] | map(ascii_downcase)) as $r
    | [$rows[] | select(.[1] == "" or (.[1] as $s | $r | index([$s]) != null))] | .[0]
    | if . == null then empty else "\(.[0])\(if .[1] == "" then "" else " " + .[1] end) \($what)" end
    end;

# Commands that write files: denied to read-only roles (the deepwork
# state-bash-gate port), and to everyone when the command names a litter folder.
def writers: ["tee", "cp", "mv", "rm", "rmdir", "mkdir", "touch", "ln", "chmod", "chown", "chgrp", "dd", "truncate",
  "install", "rsync", "unlink", "shred", "patch", "wget", "mkfifo", "mknod"];
def writes: (.[0] | base) as $n | .[1:] as $r
  | ($n | oneof(writers))
    or ($n == "sed" and ($r | any(.[]; startswith("--in-place") or test("^-[nrEsuz]*i"))))
    or (($n == "perl" or $n == "ruby") and ($r | any(.[]; test("^-[pnlaw]*i"))))
    or ($n == "curl" and ($r | any(.[]; . == "--remote-name" or startswith("--output") or test("^-[A-Za-z]*[oO]"))))
    or ($n == "tar" and ((($r[0] // "") | test("^-?[A-Za-z]*[xcru][A-Za-z]*$"))
        or ($r | any(.[]; oneof(["--extract", "--create", "--append", "--update", "--get"])))))
    or ($n == "unzip" and (($r | any(.[]; oneof(["-l", "-v", "-t", "-Z"]))) | not))
    or ($n == "find" and ($r | any(.[]; oneof(["-delete", "-fprint", "-fprintf", "-fls"]))));
# A redirection to a file: quoted text is literal, so it goes first (double
# quotes only without $ or a backtick), then /dev/null and descriptor copies.
def unquoted: gsub("\\x27[^\\x27]*\\x27"; "") | gsub("\"([^\"\\\\$`]|\\\\.)*\""; "");
def redirects: unquoted | gsub("[0-9]*>&[0-9-]+"; "") | gsub("[0-9&]*>>?\\|?[ \\t]*/dev/null"; "") | test(">");
def targets: [dequote | scan("[0-9&]*>>?\\|?[ \\t]*([^ \\t;&|<>()]+)") | .[0]];
# Names .claude/litter, a rule folder (section 16.1) or one of the run roots.
def prot($roots): ascii_downcase as $s
  | ($s | contains(".claude/litter")) or ($s | contains(".claude/rules/litter"))
    or ($s | test("(^|[^A-Za-z0-9_-])\\.litter(\\.local)?($|[^A-Za-z0-9_.-])"))
    or any($roots[]; . as $r | $s | contains($r));

# Every word that may start a command after a wrapper: the heads the rules
# check, and $extra (a node bash.deny heads).
def cmdheads($extra): [deploys[][0], installs[][0], writers[], "git", "sed", "perl", "ruby", "curl", "tar", "unzip", "find", $extra[]]
  | reduce .[] as $h ({}; .[$h] = true);
# $cmd as {ss: its simple commands, cs: the commands in them}, or {why: the
# reason it cannot be checked}: the sizes first, before any parse.
def bashparse($cmd; $extra):
  if ($cmd | utf8bytelength) > 32768 then {why: toolong}
  else ($cmd | plainsegs) as $pa
  # The words as the command has them, before redsplit cuts any further.
  | if ([$pa[] | length] | add // 0) > 4000 then {why: toolong}
    else (($pa + ($cmd | quotedsegs)) | splitreds) as $ss
    | cmdheads($extra) as $hs
    | [$ss[] | cmds($hs)] as $cs
    | if any($cs[]; . == "many") then
        {why: "this command has too many words that may start a command (over 32 after a wrapper) for the guard to check; split it"}
      else {ss: $ss, cs: $cs} end
    end
  end;

# The first reason to deny a Bash call, or null. $fw and $wcwd: the caller is
# a bound fanout writer, and its worktree.
def bashwhy($rowhy; $noinstall; $roots; $fw; $wcwd):
  (.tool_input.command | str) as $cmd
  | if $cmd == "" then "Bash needs a command"
    else bashparse($cmd; []) as $bp
    | if $bp.why != null then $bp.why
      else $bp.cs as $cs
      | [ (if $fw and any($cs[] | select((.[0] | base) == "git") | .[1:] | gitsub; gitwrite) then fanoutcmdwhy($cmd; $wcwd) else empty end),
          ($cs[] | select((.[0] | base) == "git") | .[1:] | gitsub | gitwhy($rowhy; $fw; $wcwd)),
          ($cs[] | pairwhy(deploys; "publishes or deploys, which litter agents never do")),
          (if $noinstall != "" then ($cs[] | pairwhy(installs; "installs packages: \($noinstall)")) else empty end),
          (if ($cmd | prot($roots)) and (any($cs[]; writes) or ([$cmd | targets[] | select(. != "/dev/null")] | length) > 0) then
            "Bash may not write under .claude/litter or a litter rule folder (this command names one and writes): records go through mcp__litter__record and rules through /litter:rules, and reading them is fine"
           else empty end),
          (if $rowhy != "" and ($cmd | redirects) then "\($rowhy): Bash output may go only to /dev/null or another descriptor, not to a file" else empty end),
          (if $rowhy != "" then ($cs[] | select(writes) | "\($rowhy): \(.[0] | base) writes files") else empty end)
        ] | .[0]
      end
    end;
'

# A litter agent's call. First its own context (mode, binding, working
# directory), then the rule for its tool (section 9). Prints a decision, or
# `path` and what the script has to resolve for a write.
GUARD_JQ_CALL='
def litterroots($p): [$p.litterDir, $p.run.roots.litterDir, ($p.run.roots.litterCopies // [])[], ($p.run.roots.ruleDirs // [])[],
    (if $cfg != "" then ($cfg + "/litter"), ($cfg + "/rules/litter") else empty end)]
  | map(str | rtrimstr("/") | select(. != "") | ascii_downcase);
def writecheck($in; $p; $b; $rp; $type; $tool; $ti):
  ($rp.write | str) as $w
  | ((if $tool == "NotebookEdit" then $ti.notebook_path else $ti.file_path end) | str) as $fp
  | if $w == "none" or $w == "" then deny($in; "\($type) does not write files; put what you found in your result")
    elif ($p.run.inflight | str) != "" then deny($in; "a \($p.run.inflight) is in flight for this checkout, so writes wait; try again once it is done")
    elif $fp == "" then deny($in; "\($tool) needs \(if $tool == "NotebookEdit" then "notebook_path" else "file_path" end)")
    elif ($fp | test("[\\x00-\\x1f]")) or ($fp | startswith("~")) or ($fp | startswith("//")) then
      deny($in; "could not resolve \($fp | tojson): give an absolute path")
    else (if $fp | startswith("/") then $fp else (($b.cwd | str) + "/" + $fp) end | gsub("/+"; "/")) as $t
      | if ($t | startswith("/") | not) or ($t | split("/") | .[1:] | any(. == "" or . == "." or . == "..")) then
          deny($in; "could not resolve \($fp): give an absolute path with no empty, . or .. parts")
        else ({"checkout": ($p.run.roots.checkout | str), "own-worktree": ($b.cwd | str)}[$w] // "") as $root
        | if $root == "" then deny($in; "\($type) writes only inside the run \($w), and run \($p.run.run | str) has none recorded")
          else ["path", $w, $t, $root, $fp] | join("\n") end
        end
    end;
def rules($in; $p; $b; $role; $type; $tool; $ti; $fw):
  $p.roles[$role] as $rp
  | (if ($rp.bash | str) != "rw" then "\($type) is read-only"
     elif ($p.run.inflight | str) != "" then "a \($p.run.inflight) is in flight, so Bash is read-only for now"
     else "" end) as $rowhy
  | (if $rowhy != "" then $rowhy elif $role == "prober" then "\($type) may not install anything" else "" end) as $noinstall
  | if $tool == "Agent" then deny($in; "litter roles do not start agents; do the work yourself, or say what is missing in your result")
    elif $tool == "EnterWorktree" or $tool == "ExitWorktree" then deny($in; "a litter agent works where its run put it, so \($tool) is not available")
    elif $tool == "PowerShell" or $tool == "Monitor" then deny($in; "\($tool) is not checked for litter agents; use Bash")
    elif $tool == "Write" or $tool == "Edit" or $tool == "NotebookEdit" then writecheck($in; $p; $b; $rp; $type; $tool; $ti)
    elif $tool == "Bash" then
      ($in | bashwhy($rowhy; $noinstall; litterroots($p); $fw; ($b.cwd | str | rtrimstr("/")))) as $why
      | if $why == null then "pass" else deny($in; $why) end
    else "pass" end;
# A fanout writer (section 7, fanout.js step 2), and its task once task.bind
# wrote agents/<agent_id>.json for this run: null while it is unbound.
def fanoutwriter($p; $role): $role == "executor" and ($p.run.workflow | str) == "fanout";
def taskof($p; $a):
  if ($a | ok1) and ($a.task | type) == "object" and ($a.task.id | str) != "" and ($a.task.owned | type) == "array"
    and ($a.run == null or ($a.run | str) == ($p.run.run | str))
  then $a.task else null end;

. as $in
| ($in.agent_id | str) as $id
| ($in.agent_type | str) as $type
| ($type | ltrimstr("litter:")) as $role
| ($in.tool_name | str) as $tool
| ($in.tool_input | if type == "object" then . else {} end) as $ti
| readj($pol) as $p
| readj($bind) as $b
| readj($agent) as $a
| (($in.permission_mode | str) as $m | if $m != "" then $m else ($mode | gsub("[^A-Za-z]"; "")) end) as $mode_now
| if ($p | ok1 | not) then
    deny($in; "policy.json is unreadable (\(why($pol; $p))), so this call cannot be checked; refusing until the mod rewrites it")
  elif ($p.run | type) != "object" then deny($in; "no litter run is active, so \($type) has nothing to do; end your turn")
  elif ($p.roles | type) != "object" or ($p.roles[$role] | type) != "object" then
    deny($in; "\($type) is not a role of run \($p.run.run | str); refusing")
  elif $p.run.stopping == true then deny($in; "run \($p.run.run | str) is stopping; make no more tool calls and end your turn")
  elif $p.run.isolationLost == true then
    deny($in; "run \($p.run.run | str) is halting because an agent lost its working-directory isolation context; make no more tool calls")
  elif $mode_now == "acceptEdits" or $mode_now == "bypassPermissions" then
    deny($in; "the session switched to \($mode_now) during a litter run; switch back with shift+tab")
  elif ($b | ok1 | not) then
    deny($in; "agent \($id) has no usable binding (bind/\($id) is \(why($bind; $b))), so litter cannot tell where it works; refusing")
  elif ($b.agent_id | str) != $id or ($b.agent_type | str) != $type then
    deny($in; "bind/\($id) belongs to \($b.agent_type | str), not to \($type); refusing")
  elif $p.roles[$role].isolated == true and ($in.cwd | str) != ($b.cwd | str) then
    out($in; "this agent works in \($in.cwd | str), not in its worktree \($b.cwd | str): its working-directory isolation context was lost, most likely to another plugin whose tool.call hook matches this agent tools. The run halts; make no more tool calls";
      [{v: 1, ev: "isolation-lost", ts: ts, session_id: ($in.session_id | str), agent_id: $id, agent_type: $type,
        tool: $tool, cwd: ($in.cwd | str), expected: ($b.cwd | str | orNull), source: "guard"}])
  elif fanoutwriter($p; $role) and $agent != "" and ($a | ok1 | not) then
    deny($in; "agents/\($id).json is unreadable (\(why($agent; $a))), so the task this writer is bound to cannot be read; refusing until the mod rewrites it")
  elif fanoutwriter($p; $role) and taskof($p; $a) == null then
    # Unbound: its result can still say why (output.sh takes only a blocked
    # one). The mod answers mcp__litter__record before any hook, so the bind
    # never comes here; were it to, denying it would leave no way to bind.
    (if $tool == "StructuredOutput" or $tool == "mcp__litter__record" then "pass"
     else deny($in; "bind first: call mcp__litter__record with kind task.bind and the bind value from your <task>") end)
  else rules($in; $p; $b; $role; $type; $tool; $ti; fanoutwriter($p; $role)) end
| if . == "pass" then passcall($in) else . end
'

# A write, once the script resolved its target ($real, empty when it could
# not) and the role root ($root). Every deny rule matches the resolved path
# case-insensitively, so folding only denies more; the scope compares exactly
# (section 9, "checked against the resolved target, never the spelling").
GUARD_JQ_PATH='
. as $in
| readj($pol) as $p
| readj($agent) as $a
| ($in.agent_type | str) as $type
| ($real | ascii_downcase) as $l
| ([$p.litterDir, $p.run.roots.litterDir, ($p.run.roots.litterCopies // [])[]]
    | map(str | rtrimstr("/") | select(. != "") | ascii_downcase)) as $litter
| ([($p.run.roots.ruleDirs // [])[], (if $cfg != "" then ($cfg + "/litter"), ($cfg + "/rules/litter") else empty end)]
    | map(str | rtrimstr("/") | select(. != "") | ascii_downcase)) as $ruledirs
| if $real == "" then
    deny($in; "could not resolve \($fp): a folder on the way cannot be entered, a link loops, or a part of it is not a folder")
  elif (($l + "/") | contains("/.claude/litter/")) or any($litter[]; . as $r | $l == $r or ($l | startswith($r + "/"))) then
    deny($in; "\($fp) is under .claude/litter (it resolves to \($real)); litter records change only through mcp__litter__record")
  elif (($l + "/") | test("/\\.litter(\\.local)?/|/\\.claude/rules/litter(-local)?/"))
      or any($ruledirs[]; . as $r | $l == $r or ($l | startswith($r + "/"))) then
    deny($in; "\($fp) is in a litter rule folder (it resolves to \($real)); rules change only through /litter:rules")
  elif $root == "" then deny($in; "could not resolve the folder \($type) may write in")
  elif $w == "own-worktree" and (($p.run.roots.checkout | str) as $c | $c == $root or ($c | startswith($root + "/"))
      or ((($p.run.roots.worktrees // []) | length) > 0 and ((($p.run.roots.worktrees // []) | index([$root])) == null))) then
    deny($in; "\($type) writes only inside its own worktree, and its bound folder \($root) is not one")
  elif ($real | startswith($root + "/") | not) then deny($in; "\($type) writes only inside \($root), and \($fp) resolves to \($real)")
  elif $w == "own-worktree" and ($in.agent_type | str) == "litter:executor" and ($p.run.workflow | str) == "fanout" then
    # A fanout writer writes only its task files: an entry ending in / owns everything under it (section 7, "Ownership").
    (if ($a | type) == "object" and ($a.task | type) == "object" then $a.task else {} end) as $task
    | ($task.owned // [] | if type == "array" then map(str | select(. != "")) else [] end) as $own
    | ($real | ltrimstr($root + "/")) as $rel
    | if any($own[]; . as $o | if ($o | endswith("/")) then ($rel | startswith($o)) else $rel == $o end) then "pass"
      else deny($in; "task \($task.id | str) owns only \($own | join(", ")), and \($fp) resolves to \($rel) in your worktree; change only those files, or return blocked and name the file you need") end
  else "pass" end
| if . == "pass" then passcall($in) else . end
'

# A swarm node's or a node's child's call (plan 15.4, "The guard for nodes";
# 15.8, "The node policy"), from agents/<agent_id>.json and its swarm's entry
# in policy.json, in 15.4's order: the swarm's state, the node's own, its
# type, then the tools. Three checks need the script, and each comes back as
# a request it answers by running this program again:
#   owner <commonDir> <ref> <oid>  the last beat's check is over 10 s old: $owner is then `same` or `moved`
#   path <target>                  a write: $real is then `=` and the resolved path (empty: unresolvable)
#   head <dir>                     a commit: $head is then `=` and `git symbolic-ref -q HEAD` there
# `other` sends a caller with no node binding back to the rules for anyone.
GUARD_JQ_NODE='
def strs: if type == "array" then map(str | select(. != "")) else [] end;
def num: if type == "number" then . else null end;
# At or under $dir: an absolute path, or a relative one with no .. part, since
# the call runs in $dir. Nothing for cd, which goes home.
def within($dir): . as $v
  | $v != "" and (if ($v | startswith("/")) then ($v | rtrimstr("/")) as $c | $c == $dir or ($c | startswith($dir + "/"))
      else ($v | split("/") | all(.[]; . != "..")) and (($v | startswith("~")) or ($v | startswith("-")) | not) end);
def commitlike: .sub | oneof(["commit", "merge", "cherry-pick", "revert", "am", "pull", "rebase"]);
def owndir($dir): .loc | all(.[]; .[0] == "-C" and (.[1] == "." or (.[1] | rtrimstr("/")) == $dir));
# What moves a worktree off its bound branch, or the branch itself (15.4,
# "Commits stay on the bound branch"). A checkout without -- may name a
# branch; a reset with one revision and no paths moves the branch to it.
def switchwhy: .sub as $s | .args as $a | ($a | index(["--"])) as $dd
  | (if $dd == null then $a else $a[:$dd] end | pos) as $pre
  | (if $dd == null then [] else $a[$dd + 1:] end) as $post
  | if $s == "switch" then "git switch"
    elif $s == "checkout" and (($a | any(.[]; oneof(["-b", "-B", "--detach", "--orphan"]))) or ($a | short("bB"))) then
      "git checkout -b, -B or --detach"
    elif $s == "checkout" and $dd == null and ($pre | map(select(. != ".")) | length) > 0 then "git checkout naming a branch"
    elif $s == "branch" and (($a | short("fmMC")) or ($a | longopt("--force"; 6)) or ($a | longopt("--move"; 5))) then
      "git branch -f, -m, -M or -C"
    elif $s == "symbolic-ref" and ((($a | pos | length) >= 2) or ($a | has1("--delete")) or ($a | short("d"))) then "git symbolic-ref"
    elif $s == "update-ref" then "git update-ref"
    elif $s == "reset" and ($pre | length) == 1 and (($pre[0] | oneof(["HEAD", "@"])) | not) and ($post | length) == 0 then
      "git reset <commit>"
    else empty end;
def rewritewhy: .sub as $s | .args as $a
  | if $s == "rebase" then "git rebase"
    elif $s == "reset" and ($a | longopt("--hard"; 4)) then "git reset --hard"
    elif $s == "commit" and ($a | longopt("--amend"; 4)) then "git commit --amend"
    elif ($s | oneof(["filter-branch", "filter-repo"])) then "git \($s)"
    else empty end;
def worktreewhy($dir): .sub as $s
  | if $s == "worktree" and ((.args | first1) != "list") then "git worktree \(.args | first1)"
    elif any(.loc[]; .[0] == "-C" and ((.[1] | within($dir)) | not)) then "git -C into another folder"
    else empty end;
def nodegitwhy($node; $au; $dir; $branch):
  .sub as $s
  | (if $s == "push" or $s == "send-pack" then "git push is denied to swarm nodes: report ready-to-push; the lead pushes" else empty end),
    (if $au.commit == false and (commitlike or indexwrite) then
       "git \($s) \(if commitlike then "makes a commit" else "writes the index" end), and node \($node) may not commit (authority.commit is false): leave the change in place and report it"
     else empty end),
    (if $au.commit == true and (commitlike or indexwrite) and (owndir($dir) | not) then
       "git \($s) runs only in your directory \($dir): run it there, without -C to another folder, --git-dir or --work-tree"
     else empty end),
    (if $au.commit == true then (switchwhy | "\(.) would move you off your bound branch \($branch): your branch is fixed by the swarm; ask your parent. To restore files use git restore <path>, and to unstage git reset -- <path>") else empty end),
    (if $au.rewriteHistory == false then (rewritewhy | "\(.) rewrites history, and node \($node) may not (authority.rewriteHistory is false); make a new commit instead") else empty end),
    (if $au.worktreeOps == false then (worktreewhy($dir) | "\(.) works on another worktree, and node \($node) may not (authority.worktreeOps is false); work in \($dir)") else empty end);
# A commit or index write runs in the node directory as git finds it: no
# git-redirecting variables, and no cd away from it first.
def nodecmdwhy($cmd; $dir):
  [$cmd | segs[]] as $ws
  | ([$ws[][] | select(test("^GIT_[A-Za-z0-9_]*="))] | .[0]) as $var
  | if $var != null then "a commit or index write runs with git as your directory sets it up: drop \($var | split("=") | .[0])"
    elif any($ws[] | lead | select((.[0] // "") | base | oneof(["cd", "pushd"])); (cdto | within($dir)) | not) then
      "git commit and index writes run only in your directory \($dir): run them there, without cd elsewhere"
    else empty end;
# bash.deny: an entry is a command prefix, matched word for word against each
# simple command, its first word by name, so a path to the same program counts.
def denyprefix($deny): . as $c
  | first($deny[] | . as $e | ($e | words) as $ew
      | select(($ew | length) > 0 and ($c | length) >= ($ew | length)
          and ($c[0] | base) == ($ew[0] | base) and $c[1:($ew | length)] == $ew[1:]) | $e) // empty;
# The litter hooks folder and the ledgers, named in a node Bash (boundary
# review 1d): a node that removed hooks/active, or rewrote policy.json or its
# own binding, would switch these rules off. Bash is not parsed for writes
# (plan 15.3), so this is a fence against the obvious spellings, not a
# sandbox: a command that reaches the folder in steps (cd litter, then cd
# hooks) still passes. Each word, quotes and backslashes dropped and folded to
# lower case, is cut at < > = : , into paths and each path at /, with empty
# and . parts dropped. A path is denied when
#  - a litter part, at its start or after .claude, .. or a part the shell
#    expands ($, ~, a glob), comes before a hooks or ledger part (so
#    plugins/litter/hooks, the plugin source, passes);
#  - or a hooks part is followed by one of the hooks/ names (hookfiles.ts).
# A glob part counts when it would match the name, and a bare * or ? does not
# (src/hooks/* passes), but for a litter part right after .claude.
def hooknames: ["active", "policy.json", "agents", "pending", "done", "hold", "spool", "bind", "out", "mode", "pointer",
  "worktree.json", "wt", "shells"];
def isglob: test("[*?\\[]");
def pureglob: test("^[*?]+$");
def globmatch($name): ("^" + (gsub("(?<c>[.+^$])"; "\\\(.c)") | gsub("\\[!"; "[^") | gsub("\\*"; ".*") | gsub("\\?"; ".")) + "$") as $re
  | try ($name | test($re)) catch false;
def segis($name): . == $name or (isglob and (pureglob | not) and globmatch($name));
def pathparts: ascii_downcase | cuts(["<", ">", "=", ":", ","])[] | select(. != "") | split("/") | map(select(. != "" and . != "."));
def anchors: . == ".claude" or . == ".." or test("[$~*?\\[]") or segis(".claude");
def litterpath: . as $s
  | ([range(0; $s | length) as $j | select($s[$j] | segis("hooks") or segis("ledger")) | $j] | max) as $last
  | $last != null and any(range(0; $last) as $i
      | select(($s[$i] | segis("litter")) or ($i > 0 and ($s[$i] | pureglob) and $s[$i - 1] == ".claude")) | $i;
      . == 0 or ($s[. - 1] | anchors));
def hooksfile: . as $s
  | any(range(1; $s | length) as $j | select($s[$j - 1] | segis("hooks")) | $s[$j] as $x | hooknames[] as $h | $x | segis($h); .);
def litterhit($ss): first($ss[][] | pathparts | select(litterpath or hooksfile) | join("/")) // null;
def nodebashwhy($n; $cmd; $roots; $dir; $branch; $bp):
  ($n.authority | if type == "object" then . else {} end) as $au
  | ($n.node | str) as $node
  | $bp.cs as $cs
  | [$cs[] | select((.[0] | base) == "git") | .[1:] | gitsub] as $gs
  | [ ($gs[] | nodegitwhy($node; $au; $dir; $branch)),
      (if $au.commit == true and any($gs[]; commitlike or indexwrite) then nodecmdwhy($cmd; $dir) else empty end),
      ($cs[] | pairwhy(deploys; "publishes or deploys, which litter agents never do")),
      ($cs[] | denyprefix($n.bashDeny | strs) | "\(.) is denied to node \($node) by its spec (bash.deny)"),
      (litterhit($bp.ss) | if . == null then empty else
        "Bash may not name the litter hooks folder or a litter ledger (this command names \(.[0:120])): the mod alone changes them, and the guard reads them. To look at one, use Read"
       end),
      (if ($cmd | prot($roots)) and (any($cs[]; writes) or ([$cmd | targets[] | select(. != "/dev/null")] | length) > 0) then
        "Bash may not write under .claude/litter or a litter rule folder (this command names one and writes): records go through mcp__litter__record and rules through /litter:rules, and reading them is fine"
       else empty end)
    ] | .[0];
def nodewrite($in; $n; $tool; $ti; $dir; $roots):
  ((if $tool == "NotebookEdit" then $ti.notebook_path else $ti.file_path end) | str) as $fp
  | ($n.node | str) as $node
  | if $fp == "" then deny($in; "\($tool) needs \(if $tool == "NotebookEdit" then "notebook_path" else "file_path" end)")
    elif ($fp | test("[\\x00-\\x1f]")) or ($fp | startswith("~")) or ($fp | startswith("//")) then
      deny($in; "could not resolve \($fp | tojson): give an absolute path")
    else (if $fp | startswith("/") then $fp else $dir + "/" + $fp end | gsub("/+"; "/")) as $t
    | if ($t | startswith("/") | not) or ($t | split("/") | .[1:] | any(. == "" or . == "." or . == "..")) then
        deny($in; "could not resolve \($fp): give an absolute path with no empty, . or .. parts")
      elif $real == "" then "path\n" + $t
      else ($real | ltrimstr("=")) as $r | ($r | ascii_downcase) as $l
      | ($n.paths | if type == "array" then map(str | select(. != "")
          | if startswith("/") then . else $dir + "/" + . end) else null end) as $paths
      | if $r == "" then
          deny($in; "could not resolve \($fp): a folder on the way cannot be entered, a link loops, or a part of it is not a folder")
        elif (($l + "/") | contains("/.claude/litter/")) then
          deny($in; "\($fp) is under .claude/litter (it resolves to \($r)); litter records change only through mcp__litter__record")
        elif (($l + "/") | test("/\\.litter(\\.local)?/|/\\.claude/rules/litter(-local)?/")) then
          deny($in; "\($fp) is in a litter rule folder (it resolves to \($r)); rules change only through /litter:rules")
        elif any($roots[]; . as $x | $l == $x or ($l | startswith($x + "/"))) then
          deny($in; "\($fp) resolves to \($r), inside a folder litter protects (a .claude/litter copy or a rule folder): records change only through mcp__litter__record, and rules only through /litter:rules")
        elif $paths != null and ($paths | length) == 0 then
          deny($in; "node \($node) writes no files (its spec gives it no paths); report what you need changed to your parent")
        elif $paths != null and (any($paths[]; . as $x | if ($x | endswith("/")) then ($r | startswith($x)) else $r == $x end) | not) then
          deny($in; "node \($node) writes only in \($paths | join(", ")), and \($fp) resolves to \($r); change only those, or report what you need to your parent")
        else passcall($in) end
      end
    end;
# No parameter is named after a builtin: a $name parameter is also a filter
# `name` in the body, so a $type would turn every `type` into the agent type.
def nodetools($in; $n; $tool; $ti):
  ($n.node | str) as $node
  | ($n.dir | str | rtrimstr("/")) as $dir
  | ($n.authority | if type == "object" then . else {} end) as $au
  | ($n.branch | str) as $branch
  | ([($n.protect | strs[]), (if $cfg != "" then ($cfg + "/litter"), ($cfg + "/rules/litter") else empty end)]
      | map(rtrimstr("/") | select(. != "") | ascii_downcase)) as $roots
  | ($ti.subagent_type | str) as $sub
  | if $tool == "EnterWorktree" or $tool == "ExitWorktree" then deny($in; "your directory is fixed by the swarm; ask your parent")
    elif ($n.toolsDeny | strs | index([$tool])) != null then deny($in; "\($tool) is denied to node \($node) by its spec (tools.deny)")
    elif $tool == "Agent" and ($ti.name | str) != "" then
      deny($in; "a swarm node spawns no named agent: where agent teams are on, a named agent starts as a teammate, which runs in the directory of the session and ignores the cwd and background litter gives it. Spawn it again without name")
    elif $tool == "Agent" and ($sub | startswith("litter:sw-")) then
      (if ($n.spawns | strs | index([$sub])) != null then passcall($in)
       elif ($n.spawns | strs | length) == 0 then deny($in; "node \($node) spawns no swarm workers (its spec lists none), so not \($sub)")
       else deny($in; "node \($node) may spawn only \($n.spawns | strs | join(", ")), and \($sub) is not one of them") end)
    elif $tool == "Agent" and ($sub | startswith("litter:")) then
      deny($in; "litter roles run inside litter workflows, not under a swarm node; do the work yourself, or report what is missing")
    elif $tool == "Agent" and $n.spawnOther == false then
      deny($in; "node \($node) may spawn no agent types but its swarm workers (spawnOther is false)")
    elif $tool == "PowerShell" then deny($in; "PowerShell is not checked for swarm nodes; use Bash")
    elif $tool == "Write" or $tool == "Edit" or $tool == "NotebookEdit" then nodewrite($in; $n; $tool; $ti; $dir; $roots)
    elif $tool == "Bash" or ($tool == "Monitor" and ($ti.command | str) != "") then
      ($ti.command | str) as $cmd
      | if $cmd == "" then deny($in; "Bash needs a command")
        else bashparse($cmd; [$n.bashDeny | strs[] | words | .[0] // empty | base]) as $bp
        | (if $bp.why != null then $bp.why else nodebashwhy($n; $cmd; $roots; $dir; $branch; $bp) end) as $why
        | if $why != null then deny($in; $why)
          elif $au.commit == true and any($bp.cs[] | select((.[0] | base) == "git") | .[1:] | gitsub; commitlike) then
            (if $branch == "" then deny($in; "node \($node) has no bound branch, so it cannot commit; report blocked to your parent")
             elif $head == "" then "head\n" + $dir
             elif ($head | ltrimstr("=")) == $branch then passcall($in)
             else deny($in; "HEAD in \($dir) is \(($head | ltrimstr("=")) as $h | if $h == "" then "detached" else $h end), not your bound branch \($branch): your branch is fixed by the swarm; ask your parent") end)
          else passcall($in) end
        end
    else passcall($in) end;

. as $in
| ($in.agent_id | str) as $id
| ($in.agent_type | str) as $type
| ($in.tool_name | str) as $tool
| ($in.tool_input | if type == "object" then . else {} end) as $ti
| readj($pol) as $p
| readj($agent) as $a
| if $agent != "" and ($a | ok1 | not) then
    deny($in; "agents/\($id).json is unreadable (\(why($agent; $a))), so the swarm rules for this agent cannot be read; refusing until the mod rewrites it")
  elif ($a | type) != "object" or ($a.node | type) != "object" then
    if ($type | startswith("litter:sw-")) | not then "other"
    elif $tool == "mcp__litter__record" then passcall($in)
    else deny($in; "\($type) is a swarm node that is not bound yet: if your <instance> block names a token, record kind swarm.bind with it; otherwise try again") end
  elif ($p | ok1 | not) then
    deny($in; "policy.json is unreadable (\(why($pol; $p))), so this call cannot be checked; refusing until the mod rewrites it")
  else $a.node as $n
  | ($n.swarm | str) as $sw
  | (if ($p.swarm | type) == "object" and ($p.swarm.swarms | type) == "object" then $p.swarm.swarms[$sw] else null end) as $e
  | (try ($now | tonumber) catch null) as $t
  | if ($e | type) != "object" then deny($in; "swarm \($sw) is not live, so this node has nothing to do; make no more tool calls and end your turn")
    elif ($e.owner | type) != "object" or ($n.generation | num) == null or $n.generation != $e.owner.generation then
      deny($in; "swarm \($sw) was handed to another session; make no more tool calls and end your turn")
    elif ($n.launch | str) == "" or ($n.launch | str) != ($e.launch | str) then
      # Every launch starts at generation 1, so a binding left from an earlier
      # launch of the same swarm would pass the check above.
      deny($in; "this binding belongs to launch \($n.launch | str) of swarm \($sw), not to its live launch \($e.launch | str); make no more tool calls and end your turn")
    elif $owner == "" and ($t == null or ($e.owner.checkedAt | num) == null or ($t - $e.owner.checkedAt) > 10) then
      (if ($e.owner.ref | str) != "refs/litter-swarm/" + $sw or ($sw | test("^[a-z0-9][a-z0-9-]{0,23}$") | not)
          or ($e.commonDir | str | startswith("/") | not) or ($e.commonDir | str | test("[\\x00-\\x1f]"))
          or ($e.owner.oid | str | test("^[0-9a-f]{40,64}$") | not) then
         deny($in; "the ownership check of swarm \($sw) cannot run: its entry in policy.json names no usable ref, oid or common dir; refusing")
       else ["owner", $e.commonDir, $e.owner.ref, $e.owner.oid] | join("\n") end)
    elif $owner == "moved" then
      deny($in; "swarm \($sw) was handed to another session (its ownership ref no longer names this owner); make no more tool calls and end your turn")
    elif $owner != "" and $owner != "same" then
      deny($in; "the ownership ref of swarm \($sw) could not be read (git failed), so this call cannot be checked; refusing")
    elif $e.state == "stopping" and (($tool | oneof(["SendMessage", "SubagentHandback"])) | not) then
      deny($in; "swarm \($sw) is ending; report and end your turn")
    elif $n.stopped != null and $tool != "SubagentHandback" then
      deny($in; "you were stopped from the swarm browser: deliver your report and end your turn")
    elif $n.bind == true and $tool != "mcp__litter__record" then
      deny($in; "bind first: record kind swarm.bind with the token from your <instance> block")
    elif $n.admitted != true then deny($in; "not admitted; end your turn")
    elif ($n.kind | str) != "child" and $type != ($n.type | str) then deny($in; "this node lost its type; end your turn")
    else nodetools($in; $n; $tool; $ti) end
  end
'

# guard_nojq <reason>: jq is gone, or failed. A litter agent is recognised by
# its raw agent_type, a node's child by the binding the mod wrote for its
# agent_id, and the rules for everyone else are kept with plain matches: no
# litter role spawned, and no worktree moves on the main thread.
guard_nojq() {
  if lt_raw_litter; then
    lt_cant "$1"
    return 0
  fi
  if lt_raw_node; then
    printf 'who litter\nblock\n%s\n' "$1"
    return 0
  fi
  case $LT_IN in
    *'"subagent_type":"litter:'*) printf 'who other\nblock\n%s\n' "$1"; return 0 ;;
  esac
  case $LT_IN in
    *'"agent_id":"'*) ;;
    *'"tool_name":"EnterWorktree"'* | *'"tool_name":"ExitWorktree"'*)
      printf 'who other\nblock\n%s\n' "$1"
      return 0
      ;;
  esac
  printf 'who other\npass\n'
}

# guard_node <agent_id> <decision for anyone else>: the node rules
# (GUARD_JQ_NODE), and the checks they ask the script for. Git runs only with
# argv built here, from values the program checked: the swarm's own ref under
# refs/litter-swarm/, its common dir, and the node's directory.
guard_node() {
  gn_id=$1
  gn_other=$2
  echo 'step reading the node binding and policy.json'
  lt_file "$LT_DIR/policy.json"
  gn_pf=$LT_FF gn_pv=$LT_FV
  lt_file "$LT_DIR/agents/$gn_id.json"
  gn_af=$LT_FF gn_av=$LT_FV
  # A clock that can't be read makes the last check stale.
  gn_now=$(date +%s 2>/dev/null) || gn_now=
  case $gn_now in *[!0-9]*) gn_now= ;; esac
  gn_owner= gn_real= gn_head= gn_n=0
  while :; do
    gn_n=$((gn_n + 1))
    [ "$gn_n" -le 4 ] || return 1
    echo 'step checking the node rules'
    gn_d=$(printf '%s' "$LT_IN" | jq -r --arg GP "$LT_PREFIX" --arg cfg "$lt_cfg" \
      "$gn_pf" pol "$gn_pv" "$gn_af" agent "$gn_av" \
      --arg now "$gn_now" --arg owner "$gn_owner" --arg real "$gn_real" --arg head "$gn_head" \
      "$LT_JQ_DEFS$GUARD_JQ_BASH$GUARD_JQ_NODE") || return 1
    lt_rest=$gn_d
    lt_take
    case $lt_t in
      owner)
        [ -z "$gn_owner" ] || return 1
        lt_take; gn_cd=$lt_t
        lt_take; gn_ref=$lt_t
        lt_take; gn_oid=$lt_t
        echo 'step checking the ownership ref'
        gn_got=$(git --git-dir="$gn_cd" rev-parse -q --verify "$gn_ref" 2>/dev/null)
        case $? in
          0) if [ "$gn_got" = "$gn_oid" ]; then gn_owner=same; else gn_owner=moved; fi ;;
          1) gn_owner=moved ;; # -q --verify: the ref is gone
          *) gn_owner=unread ;;
        esac
        ;;
      path)
        [ -z "$gn_real" ] || return 1
        echo 'step resolving the path'
        gn_r=$(lt_realpath "$lt_rest") || gn_r=
        gn_real="=$gn_r"
        ;;
      head)
        [ -z "$gn_head" ] || return 1
        echo 'step reading the bound branch'
        gn_h=
        case $lt_rest in
          /*) gn_h=$(git -C "$lt_rest" symbolic-ref -q HEAD 2>/dev/null) || gn_h= ;;
        esac
        gn_head="=$gn_h"
        ;;
      other)
        printf '%s\n' "$gn_other"
        return 0
        ;;
      *)
        printf '%s\n' "$gn_d"
        return 0
        ;;
    esac
  done
}

guard_work() {
  echo 'step finding the hooks folder'
  if [ -n "$LT_DIR_ERR" ]; then
    # No binding can be read, so an agent in a swarm worktree (a node's
    # child keeps its own type) is refused like a litter agent. The main
    # thread isn't: refusing it would lock the session out.
    lt_why="$LT_PREFIX can't find litter's hooks folder ($LT_DIR_ERR); refusing"
    if ! lt_raw_litter && lt_raw_swarm_cwd; then
      printf 'who litter\nblock\n%s\n' "$lt_why"
    else
      lt_cant "$lt_why"
    fi
    return 0
  fi
  echo 'step checking for jq'
  if ! lt_have_jq; then
    guard_nojq "$LT_NOJQ"
    return 0
  fi
  echo 'step reading the hook input'
  lt_file "$LT_DIR/policy.json"
  lt_h=$(printf '%s' "$LT_IN" | jq -r --arg GP "$LT_PREFIX" "$LT_FF" pol "$LT_FV" "$LT_JQ_DEFS$GUARD_JQ_HEAD") || return 1
  lt_rest=$lt_h
  lt_take
  printf '%s\n' "$lt_t"
  lt_take
  lt_cfg=
  case ${CLAUDE_CONFIG_DIR:-} in
    /*) lt_cfg=$(lt_realdir "$CLAUDE_CONFIG_DIR") || lt_cfg=${CLAUDE_CONFIG_DIR%/} ;;
  esac
  case $lt_t in
    next) lt_id=$lt_rest ;;
    node)
      lt_take; lt_id=$lt_t
      lt_take
      # A litter:sw-* agent: its binding may still be landing, if its type is a live swarm's.
      if [ "$lt_t" = wait ] && [ ! -f "$LT_DIR/agents/$lt_id.json" ]; then
        echo 'step waiting for the binding'
        lt_wait_for "$LT_DIR/agents/$lt_id.json" || :
      fi
      guard_node "$lt_id" ''
      return
      ;;
    maybe)
      lt_take; lt_id=$lt_t
      lt_take; lt_kind=$lt_t
      # Bound: a node's child, or a node that lost its type. Unbound: an
      # agent-summary fork passes at once (15.9, item 18); anyone else waits
      # for a binding while a spawn is pending.
      if [ ! -f "$LT_DIR/agents/$lt_id.json" ] && [ "$lt_kind" = typed ] && lt_pending; then
        echo 'step waiting for a pending binding'
        lt_wait_for "$LT_DIR/agents/$lt_id.json" || :
      fi
      if [ -f "$LT_DIR/agents/$lt_id.json" ]; then
        echo 'who litter'
        guard_node "$lt_id" "$lt_rest"
        return
      fi
      printf '%s\n' "$lt_rest"
      return 0
      ;;
    *)
      printf '%s\n%s\n' "$lt_t" "$lt_rest"
      return 0
      ;;
  esac

  echo 'step reading policy.json, the bindings and the mode'
  lt_file "$LT_DIR/policy.json"
  lt_pf=$LT_FF lt_pv=$LT_FV
  lt_file "$LT_DIR/bind/$lt_id"
  lt_bf=$LT_FF lt_bv=$LT_FV
  lt_file "$LT_DIR/agents/$lt_id.json"
  lt_af=$LT_FF lt_av=$LT_FV
  lt_file "$LT_DIR/mode"
  lt_mf=$LT_FF lt_mv=$LT_FV
  lt_d=$(printf '%s' "$LT_IN" | jq -r --arg GP "$LT_PREFIX" --arg cfg "$lt_cfg" \
    "$lt_pf" pol "$lt_pv" "$lt_bf" bind "$lt_bv" "$lt_af" agent "$lt_av" "$lt_mf" mode "$lt_mv" \
    "$LT_JQ_DEFS$GUARD_JQ_BASH$GUARD_JQ_CALL") || return 1
  case $lt_d in
    "path$LT_NL"*) ;;
    *) printf '%s\n' "$lt_d"; return 0 ;;
  esac

  echo 'step resolving the path'
  lt_rest=$lt_d
  lt_take
  lt_take; lt_w=$lt_t
  lt_take; lt_target=$lt_t
  lt_take; lt_root=$lt_t
  lt_take; lt_fp=$lt_t
  lt_real=$(lt_realpath "$lt_target") || lt_real=
  if [ "$lt_w" = own-worktree ]; then
    lt_root=$(lt_realdir "$lt_root") || lt_root=
  else
    lt_root=${lt_root%/}
  fi
  echo 'step checking the resolved path'
  lt_d=$(printf '%s' "$LT_IN" | jq -r --arg GP "$LT_PREFIX" --arg cfg "$lt_cfg" "$lt_pf" pol "$lt_pv" \
    "$lt_af" agent "$lt_av" --arg w "$lt_w" --arg real "$lt_real" --arg root "$lt_root" --arg fp "$lt_fp" \
    "$LT_JQ_DEFS$GUARD_JQ_PATH") || return 1
  printf '%s\n' "$lt_d"
}

lt_begin
lt_run guard_work
# A step that failed before the caller was known left no decision: lt_finish
# refuses a litter agent, and for anyone else the plain matches still apply.
if [ -z "$LT_L1" ] && [ -z "$LT_WHO" ] && ! lt_raw_litter; then
  lt_why="litter guard failed: $LT_STEP; refusing"
  lt_run guard_nojq "$lt_why"
fi
lt_finish
