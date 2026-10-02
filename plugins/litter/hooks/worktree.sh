#!/bin/sh
# worktree.sh: WorktreeCreate, every worktree the engine asks for (plan
# section 9, "Run worktrees"; section 10, "Command hooks"). A litter name gets
# its run's worktree at the launch commit; every other name is made as the
# engine would. It prints the worktree's absolute path as its last stdout
# line, and fails closed for a litter name it can't settle.
#
# Not built yet (phase 2b, package E): it refuses every creation.

printf 'litter: worktree.sh is not built yet (phase 2b); refusing\n' >&2
exit 1
