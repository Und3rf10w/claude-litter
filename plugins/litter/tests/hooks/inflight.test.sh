#!/bin/sh
# Tier 3: the guard's in-flight cases (guard.test.sh, bash.test.sh) against
# the policy.json hooks/inflight.ts writes (COMMON decision 24), not one made
# here: tests/unit/inflight.spec.ts checks these fixtures are what the module
# writes for critique, land and put back, with the project's path as
# @PROJECT@.
. "$(dirname "$0")/testlib.sh"

FIXTURES=$LITTER_ROOT/tests/hooks/fixtures

# from_fixture <name>: the fixture as the scratch project's policy.json, then
# `active`, and executor a1 bound in the checkout.
from_fixture() {
  project >/dev/null
  ff_hooks=$(hooks_dir)
  ff_co=$(real_project)
  sed "s|@PROJECT@|$ff_co|g" "$FIXTURES/$1" >|"$ff_hooks/policy.json" || fail "fixture $1"
  [ "$(jq -r '.run.checkout' "$ff_hooks/policy.json")" = "$ff_co" ] || fail "fixture $1 didn't take the project's path"
  : >|"$ff_hooks/active"
  bind a1 litter:executor
}

case_land_waits_writes() {
  from_fixture inflight-land.policy.json
  write_call litter:executor "$T_DIR/project/a.py" | run_hook guard.sh
  assert_deny 'a land is in flight for this checkout'
  write_call litter:executor "$T_DIR/project/a.py" Edit | run_hook guard.sh
  assert_deny 'a land is in flight for this checkout'
}

case_critique_reads_only() {
  from_fixture inflight-critique.policy.json
  for ci_cmd in 'echo x > a.py' 'rm a.py'; do
    bash_call litter:executor "$ci_cmd" | run_hook guard.sh
    assert_deny 'a critique is in flight, so Bash is read-only'
  done
  bash_call litter:executor 'git status' | run_hook guard.sh
  assert_pass
}

case_put_back_lets_writes_through() {
  from_fixture inflight-cleared.policy.json
  write_call litter:executor "$T_DIR/project/a.py" | run_hook guard.sh
  assert_pass
  bash_call litter:executor 'echo x > a.py' | run_hook guard.sh
  assert_pass
}

t "writes wait while the land inflight.ts flagged is in flight" case_land_waits_writes
t "while the critique inflight.ts flagged is in flight, the executor's Bash is read-only" case_critique_reads_only
t "once inflight.ts puts the flag back, the executor writes again" case_put_back_lets_writes_through
done_testing
