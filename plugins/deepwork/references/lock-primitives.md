# Lock primitives: `_acquire_lock` / `_release_lock`

The two-line API in [`scripts/instance-lib.sh`](../scripts/instance-lib.sh) hides several non-obvious correctness traps that have already produced real bugs in this plugin. Read this before adding a new caller, a new lock, or a new path that touches `events.jsonl` / `state.json` / their `.lock` files.

## What the API actually is

```bash
_acquire_lock <lock-path>   # 0 on success, 1 on timeout (5 s spin)
_release_lock <lock-path>   # always returns 0; do not rely on it failing
```

On Linux it uses `flock(1)` against fixed file descriptors. On macOS (no `flock` in base) it falls back to atomic `mkdir <lock-path>.dir`. The two backends look identical at the call site but have very different failure shapes — see traps §3 and §4 below.

## 1. Lock-ordering invariant

```
events.jsonl.lock   →   state.json.lock
   (outer)                  (inner)
```

Every nested-lock caller in this codebase acquires `events.jsonl.lock` first and `state.json.lock` second. The only nesting point today is `_emit_event` with `_EMIT_STAMP_HEAD=1` (used by `emit_revert_event` and the `pending_change_set` stamp path).

Reversing this order would deadlock against any concurrent `_emit_event` caller. There is no run-time assertion enforcing the order — keep it manual until that changes.

The invariant is documented at [`instance-lib.sh:137-148`](../scripts/instance-lib.sh) and [`state-transition.sh:131,144`](../scripts/state-transition.sh). The empirical reproduction is in `c4850af9/empirical_results.E6.md`.

## 2. Static fd convention (Linux / flock backend)

```
fd 200  ←  events.jsonl.lock   (outer)
fd 201  ←  state.json.lock     (inner)
default ←  fd 200               (single-lock callers)
```

The convention is enforced by a `case` dispatch in `_acquire_lock` and `_release_lock` ([`instance-lib.sh:174-225`](../scripts/instance-lib.sh)).

### Why a fixed-fd table and not `exec {fd}>...` per call

POSIX flock is keyed on the *open file description*, not the path. When a single bash process does `exec 200>events.jsonl.lock` and later `exec 200>state.json.lock`, the second `exec` rebinds fd 200 to a new open file description and the original description (with its flock) is closed by the kernel. The events.jsonl flock is silently released — nothing in the bash semantics surfaces this as an error.

The pre-F-B3 code used a single fd 200 for every lock. Under `_EMIT_STAMP_HEAD=1`, the inner `_acquire_lock state.json.lock` rebound fd 200 and dropped the outer events.jsonl flock. A peer process could then append to events.jsonl during the head-stamp window, producing exactly the `events.jsonl tail != state.event_head` mismatch the lock was supposed to prevent.

### Adding a third lock

If you ever introduce a third nested lock, you must:

1. Pick the next fd in the static table (e.g. fd 202).
2. Add a `case` branch to both `_acquire_lock` and `_release_lock`.
3. Decide and document where it sits in the lock-ordering invariant.
4. Add a regression test in `test-instance-lib.sh` that proves nested acquire keeps the prior locks held (the `flock -n` peer-probe pattern in T-B3-lock-nested).

Ad-hoc `exec {fd}>` allocation is **not** a substitute. Bash's `{varname}>` syntax was considered and rejected: it complicates `_release_lock`'s API (the callee no longer knows which fd it owns) and the static table is straightforward enough that the explicit branch is clearer.

## 3. `_release_lock` foot-guns

### 3a. Never write `2>/dev/null` next to `exec N>&-`

```bash
# WRONG — silently disables stderr for the rest of the shell
case "$_lp" in
  */events.jsonl.lock) exec 200>&- 2>/dev/null ;;
  ...

# RIGHT
case "$_lp" in
  */events.jsonl.lock) exec 200>&- ;;
  ...
```

`exec` *without a command* applies its redirections to the current shell permanently. The `2>/dev/null` rebinds fd 2 (stderr) to `/dev/null` for every subsequent command in the same process. `exec N>&-` does not write to stderr anyway, so the suppression buys nothing and the side effect is catastrophic — every later `printf '...' >&2` silently disappears.

This bit during the F-B3 implementation: `pass=5 fail=1` with no FAIL message visible because every `_fail` call's stderr had been redirected. See [`instance-lib.sh:213-220`](../scripts/instance-lib.sh) for the inline NOTE that captures this lesson.

### 3b. Never run `_release_lock` after a failed `_acquire_lock`

The macOS mkdir backend treats a successful acquire as "I now own this directory and may `rm -rf` it on release." If you call `_release_lock` after an acquire that returned non-zero, you delete *another process's* lock directory and effectively release a lock you never held — corrupting the contention guarantee for the duration of that other process's critical section.

The Linux flock backend has the analogous failure: if `flock -x` fails, the convention-fd is NOT yet bound to the lock file (the calling code closed it on failure), so a later `_release_lock` either no-ops (fd already closed) or accidentally closes a fd that some other code now owns.

```bash
# WRONG — release runs unconditionally even if acquire failed
_acquire_lock "$lock" || true
do_work
_release_lock "$lock"

# RIGHT — release only on the success branch
if _acquire_lock "$lock" 2>/dev/null; then
  do_work
  _release_lock "$lock"
else
  # Decide explicitly: skip the work, fail-closed, or surface the contention.
  printf 'lock contention: %s\n' "$lock" >&2
fi
```

`_emit_event`'s W20-c stamp path is the canonical example of the right shape — see [`state-transition.sh:216-220`](../scripts/state-transition.sh) for the inline comment. The pattern is also load-bearing for [`hooks/state-drift-marker.sh`](../hooks/state-drift-marker.sh)'s revert path post-F-C1.

## 4. macOS mkdir backend specifics

Used when `command -v flock` returns non-zero (default on macOS without Homebrew's `util-linux`). The acquire/release are:

```
acquire:  mkdir <lock>.dir         # atomic on POSIX; spins until success or 5 s
release:  rm -rf <lock>.dir
```

Differences from the flock backend that callers must keep in mind:

- **Per-path keying.** Each lock has its own directory; there is no fd table and no nesting hazard from fd reuse. Two locks really are independent. The lock-ordering invariant still applies for deadlock prevention, but the static-fd convention is moot.
- **Crash recovery.** A bash process that dies mid-critical-section leaves `<lock>.dir` behind. The next acquire will spin for 5 s and then fail with `return 1`. There is no automatic stale-lock detection — a stuck lock is a real symptom of an earlier crash, not flakiness. Inspect mtime + the surrounding instance dir before deleting.
- **EXIT trap accumulation.** `_acquire_lock` appends a `rm -rf <lock>.dir` to the shell's EXIT trap rather than replacing it, so multiple acquires in one process clean up correctly even on early exit. If you write code that manipulates EXIT traps, preserve any `rm -rf .*\.dir` segments that accumulated from upstream lock acquisitions.
- **Not byte-level atomic.** The lock guards a critical section; the section's writes still need their own atomicity (tmp + `mv`). The lock prevents concurrent writers from interleaving, not partial writes from a single writer that crashes mid-`mv`.

## 5. POSIX O_APPEND vs locks (when you don't need a lock)

For append-only JSONL files where each record is one line and each writer emits one line per call, POSIX O_APPEND on a regular filesystem (APFS, ext4, xfs) gives per-syscall atomicity for writes ≤ `PIPE_BUF` (typically 4 KB), and in practice for much larger payloads on contemporary kernels.

`empirical_results.E5.md` reproduced 6000 concurrent appends with payloads up to 50 KB on macOS APFS with zero corruptions. The conclusion was that the lock around `>>` writes to `test-results.jsonl` in the retest hooks is belt-and-suspenders, not a correctness requirement.

If your write pattern is one-record-per-line append-only and the records fit comfortably in a single write syscall, prefer the lockless `>>` redirect with a doc comment citing E5.md. Use `_acquire_lock` only for:

- Multi-write critical sections (e.g. read-modify-write of `state.json`).
- Records larger than ~50 KB.
- Cross-record invariants (e.g. "this set of writes is one logical event").
- Coordinating with non-append operations on the same file (e.g. `mv` over the file).

## 6. References in code

| Where | What it points out |
|---|---|
| [`instance-lib.sh:137-148`](../scripts/instance-lib.sh) | Lock-ordering invariant + static-fd table |
| [`instance-lib.sh:174-211`](../scripts/instance-lib.sh) | `_acquire_lock` case dispatch |
| [`instance-lib.sh:213-220`](../scripts/instance-lib.sh) | `_release_lock` `2>/dev/null` foot-gun |
| [`instance-lib.sh:221-225`](../scripts/instance-lib.sh) | `_release_lock` case dispatch |
| [`state-transition.sh:131,144`](../scripts/state-transition.sh) | Lock invariant in the W20-a comment block |
| [`state-transition.sh:216-220`](../scripts/state-transition.sh) | W21 #3: never release after failed acquire |
| [`hooks/state-drift-marker.sh:136-160`](../hooks/state-drift-marker.sh) | F-C1 banner-revert snapshot guard |

## 7. Test suite

| Test | What it locks in |
|---|---|
| `T-B3-lock-nested` ([`test-instance-lib.sh`](../scripts/regressions/test-instance-lib.sh)) | Nested acquire keeps outer flock held; nested release drops only the inner |
| `T-B1-events-lock-window` ([`test-instance-lib.sh`](../scripts/regressions/test-instance-lib.sh)) | Multi-process race: peer is correctly blocked from `events.jsonl.lock` during the inner stamp window |
| `T-A1` / `T-A2` ([`test-state-transition.sh`](../scripts/regressions/test-state-transition.sh)) | Stamp-jq fail-closed posture in `_write_with_hash` and `_emit_event` |
| `T11-p` ([`T11-drift.sh`](../scripts/regressions/T11-drift.sh)) | `_acquire_lock` failure path: skip stamp, do not release, append still succeeds |
| `T-C1-banner-no-snap` ([`T11-drift.sh`](../scripts/regressions/T11-drift.sh)) | Banner-revert path is gated on snapshot presence; no fake `state_reverted` event |

T-B3 + T-B1 are Linux-only and skip cleanly on macOS (no `flock(1)` available). The mkdir-backend correctness on macOS is exercised indirectly by every other test that runs on the suite.
