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
# hooks running. Swarm nodes (litter:sw-*, phase 2b) are refused where
# guard_node would slot in.

set -u
case $0 in */*) lt_here=${0%/*} ;; *) lt_here=. ;; esac
if [ ! -r "$lt_here/lib.sh" ]; then
  # No lib, no checks: refuse while a run may be active, pass otherwise.
  [ -f "${CLAUDE_PROJECT_DIR:-/nonexistent}/.claude/litter/hooks/active" ] || exit 0
  printf 'litter guard failed: loading lib.sh; refusing\n' >&2
  exit 2
fi
. "$lt_here/lib.sh"

# Who's calling, and the rules for anyone but a litter agent: a litter role
# spawned outside a workflow, a named swarm node, and the main thread's
# EnterWorktree and ExitWorktree, which would move every agent the run starts
# later ("Background sessions"). The one EnterWorktree allowed is the
# launcher's, into the run's own checkout before the launch (section 9).
# Prints `who …`, then `next` and the agent_id, or a decision.
GUARD_JQ_HEAD='
. as $in
| ($in.agent_id | str) as $id
| ($in.agent_type | str) as $type
| ($in.tool_name | str) as $tool
| ($in.tool_input | if type == "object" then . else {} end) as $ti
| ($ti.subagent_type | str) as $sub
| if ($type | startswith("litter:")) then
    "who litter\n" + (if $id | okid then "next\n" + $id
      else deny($in; "this call carries no usable agent_id, so litter cannot tell which agent made it; refusing") end)
  else "who other\n" + (
    if $tool == "Agent" and ($sub | startswith("litter:sw-")) then
      (if ($ti.name | str) != "" then deny($in; "a swarm node takes no name: with one it would become an unchecked teammate. Spawn \($sub) again without name")
       else "pass" end)
    elif $tool == "Agent" and ($sub | startswith("litter:")) then
      deny($in; "litter roles run inside litter workflows; start one with /litter:execute, /litter:design or /litter:fanout instead of spawning \($sub)")
    elif $id != "" then "pass"
    elif $tool == "ExitWorktree" then
      deny($in; "a litter run is active, so the session stays in its working directory until the run ends: the run starts its agents there")
    elif $tool == "EnterWorktree" then
      readj($pol) as $p
      | if ($p | ok1) and ($p.run | type) == "object" and (($p.run.runIds // []) | length) == 0
          and $p.run.launching != true and ($ti.path | str) != ""
          and (($ti.path | str) == ($p.run.checkout | str) or ($ti.path | str) == ($p.run.roots.checkout | str))
        then "pass"
        else deny($in; "a litter run is active, so the session stays in its working directory until the run ends; before the launch, only EnterWorktree({ path }) into the run checkout is allowed") end
    else "pass" end)
  end
'

# Bash, read as a heuristic (section 9, "Bash"): the role tools allowlist and
# the classifier are the other two layers. A command is split into simple
# commands at every separator, even inside quotes, since sh -c "a; b" runs
# both; quotes and backslashes are then dropped from each word. A command's
# first word counts, and after a wrapper (sudo, env, sh -c, find -exec, xargs,
# …) every later word may start one too.
GUARD_JQ_BASH='
def oneof($xs): . as $x | ($xs | index([$x])) != null;
def base: split("/") | last | ascii_downcase;
def words: [splits("[ \\t]+")] | map(gsub("[\"\\x27\\\\]"; "")) | map(select(. != ""));
def segs: [splits("\\$\\(|`|&&|\\|\\||[;&|\\n\\r(){}]")] | map(words) | map(select(length > 0));
def wrappers: ["env", "sudo", "doas", "command", "builtin", "exec", "nohup", "time", "nice", "timeout",
  "gtimeout", "stdbuf", "ionice", "eval", "xargs", "watch", "setsid", "chroot", "flock", "unbuffer",
  "caffeinate", "then", "else", "elif", "do", "if", "while", "until", "!", "sh", "bash", "zsh", "dash",
  "ksh", "ash", "mksh", "busybox", "su", "runuser", "find", "parallel", "script", "strace"];
def cmds: (map(test("^[A-Za-z_][A-Za-z0-9_]*=")) | index(false)) as $i
  | if $i == null then empty
    else .[$i:] as $c
    | $c, (if ($c[0] | base | oneof(wrappers)) then range(1; $c | length) as $k | $c[$k:] else empty end)
    end;

def has1($f): any(.[]; . == $f);
def hasp($p): any(.[]; startswith($p));
def short($cs): any(.[]; test("^-[A-Za-z0-9]*[" + $cs + "]"));
def pos: map(select(startswith("-") | not));
def first1: (pos | .[0]) // "";

# git past its global options; -c and --config-env are noted, and so is every
# -C, --git-dir and --work-tree, as [option, value] in loc.
def gitsub:
  def go($cfg; $loc):
    if length == 0 then {sub: "", args: [], cfg: $cfg, loc: $loc}
    else .[0] as $w
    | if $w == "-c" then .[2:] | go(true; $loc)
      elif ($w | startswith("--config-env")) then (if ($w | contains("=")) then .[1:] else .[2:] end) | go(true; $loc)
      elif ($w | oneof(["-C", "--git-dir", "--work-tree"])) then (.[1] // "") as $v | .[2:] | go($cfg; $loc + [[$w, $v]])
      elif ($w | startswith("--git-dir=")) or ($w | startswith("--work-tree=")) then
        .[1:] | go($cfg; $loc + [[($w | split("=") | .[0]), ($w | sub("^[^=]*="; ""))]])
      elif ($w | oneof(["--namespace", "--super-prefix", "--attr-source"])) then .[2:] | go($cfg; $loc)
      elif ($w | startswith("-")) then .[1:] | go($cfg; $loc)
      else {sub: ($w | ascii_downcase), args: .[1:], cfg: $cfg, loc: $loc} end
    end;
  go(false; []);
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
    elif any($ws[]; (.[0] | base | oneof(["cd", "pushd", "popd"])) and (((.[1] // "") | rtrimstr("/")) != $wcwd)) then
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
def pairwhy($table; $what): (.[0] | base) as $n | (.[1:] | map(ascii_downcase)) as $r
  | [$table[] | select(.[0] == $n and (.[1] == "" or (.[1] as $s | $r | index([$s]) != null)))] | .[0]
  | if . == null then empty else "\(.[0])\(if .[1] == "" then "" else " " + .[1] end) \($what)" end;

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
def targets: [gsub("[\"\\x27\\\\]"; "") | scan("[0-9&]*>>?\\|?[ \\t]*([^ \\t;&|<>()]+)") | .[0]];
# Names .claude/litter, a rule folder (section 16.1) or one of the run roots.
def prot($roots): ascii_downcase as $s
  | ($s | contains(".claude/litter")) or ($s | contains(".claude/rules/litter"))
    or ($s | test("(^|[^A-Za-z0-9_-])\\.litter(\\.local)?($|[^A-Za-z0-9_.-])"))
    or any($roots[]; . as $r | $s | contains($r));

# The first reason to deny a Bash call, or null. $fw and $wcwd: the caller is
# a bound fanout writer, and its worktree.
def bashwhy($rowhy; $noinstall; $roots; $fw; $wcwd):
  (.tool_input.command | str) as $cmd
  | if $cmd == "" then "Bash needs a command"
    else [$cmd | segs[] | cmds] as $cs
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
  elif ($role | startswith("sw-")) then deny($in; "\($type) is a swarm node, and this build has no swarm rules; refusing")
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
'

# guard_nojq <reason>: jq is gone, or failed. A litter agent is recognised by
# its raw agent_type, and the rules for everyone else are kept with plain
# matches: no litter role spawned, and no worktree moves on the main thread.
guard_nojq() {
  if lt_raw_litter; then
    lt_cant "$1"
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

guard_work() {
  echo 'step finding the hooks folder'
  if [ -n "$LT_DIR_ERR" ]; then
    lt_cant "$LT_PREFIX can't find litter's hooks folder ($LT_DIR_ERR); refusing"
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
  if [ "$lt_t" != next ]; then
    printf '%s\n%s\n' "$lt_t" "$lt_rest"
    return 0
  fi
  lt_id=$lt_rest

  # guard_node: swarm nodes (phase 2b) slot in here; GUARD_JQ_CALL refuses them for now.

  echo 'step reading policy.json, the bindings and the mode'
  lt_file "$LT_DIR/policy.json"
  lt_pf=$LT_FF lt_pv=$LT_FV
  lt_file "$LT_DIR/bind/$lt_id"
  lt_bf=$LT_FF lt_bv=$LT_FV
  lt_file "$LT_DIR/agents/$lt_id.json"
  lt_af=$LT_FF lt_av=$LT_FV
  lt_file "$LT_DIR/mode"
  lt_mf=$LT_FF lt_mv=$LT_FV
  lt_cfg=
  case ${CLAUDE_CONFIG_DIR:-} in
    /*) lt_cfg=$(lt_realdir "$CLAUDE_CONFIG_DIR") || lt_cfg=${CLAUDE_CONFIG_DIR%/} ;;
  esac
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
