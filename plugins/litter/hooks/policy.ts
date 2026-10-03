// The mod's side of the files it shares with the command hooks (plan section 9,
// "Mod-to-hook state"; contract in hookfiles.ts). Owner: phase 1b, work package B.
//
//  - the `active` marker and policy.json, replaced atomically (fsx.atomicWrite);
//  - the spool drain: rename aside, read in order, hand each line to every
//    consumer in registry.ts, show a line that doesn't parse and skip it;
//  - the agent map built from the spooled starts and stops, kept in $.store
//    with the run (consumeAgents, agentInfo);
//  - the drain timer ($.clock.every, every 2 s while a run is active).

import type { Ports } from './ports'
import type { Policy, SpoolConsumer, SpoolCtx, SpoolEvent, SpoolLine } from './hookfiles'
import { activePath, policyPath, spoolBlobDir, spoolDir, spoolPath } from './layout'
import { atomicWrite, atomicWriteJson, randomId, readJson, remove, rename, serial } from './fsx'
import { isRoleName } from './roles'
import { session } from './session'

// writePolicy, readPolicy and setActive were built in phase 1a, so run.start
// (D) can use them; B owns them from here on.

/** Writes policy.json atomically, before the call that changed it is answered. */
export async function writePolicy(p: Ports, litterDir: string, policy: Policy): Promise<void> {
  await atomicWriteJson(p, policyPath(litterDir), policy)
}

/** Reads policy.json, or undefined when there's none. One of another version reads as undefined. */
export async function readPolicy(p: Ports, litterDir: string): Promise<Policy | undefined> {
  const policy = await readJson<Policy>(p, policyPath(litterDir))
  return policy?.v === 1 ? policy : undefined
}

/**
 * The serial key every read-modify-write of policy.json runs under: updatePolicy,
 * a run's activate and deactivate (lifecycle.ts), and the swarm part's writer
 * (swarm/guard.ts), which creates the file when there's none. Work under it
 * never calls updatePolicy: a nested serial on the same key waits on itself.
 */
export const policyKey = (litterDir: string) => `policy:${litterDir}`

/**
 * Read-modify-write of policy.json, serialised in this module instance, so two
 * changes (a /clear rebind and a stop, say) can't both start from the same
 * file. Resolves the policy written, or undefined when there was none. `change`
 * returns null to leave the file alone.
 */
export function updatePolicy(
  p: Ports,
  litterDir: string,
  change: (policy: Policy) => Policy | null,
): Promise<Policy | undefined> {
  return serial(policyKey(litterDir), async () => {
    const policy = await readPolicy(p, litterDir)
    if (!policy) return undefined
    const next = change(policy)
    if (next === null) return policy
    await writePolicy(p, litterDir, next)
    return next
  })
}

/** Creates or removes `hooks/active`. Create it after policy.json is written, and remove it before. */
export async function setActive(p: Ports, litterDir: string, on: boolean): Promise<void> {
  if (on) await atomicWrite(p, activePath(litterDir), '')
  else await remove(p, activePath(litterDir))
}

// The drain. Every drain of one litterDir runs under one serial key, so the
// timer, a record call and session.start never take the same spool apart
// twice; the helpers below it are unserialised (a nested serial on the same
// key would wait on itself).

const spoolKey = (litterDir: string) => `spool:${litterDir}`

/** A spool file the drain renamed aside: `<session>.jsonl.draining-<id>`. */
const ASIDE = /^(.+)\.jsonl\.draining-[A-Za-z0-9-]+$/
const LIVE = /^(.+)\.jsonl$/
/** A blob name: one plain file name under spool/blobs/, never a path. */
const BLOB_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Why a parsed line isn't a spool line, or null when it is one. */
function lineProblem(line: Record<string, unknown>): string | null {
  if (line.v !== 1) return `version ${JSON.stringify(line.v)}, not 1`
  // REQUIRED is keyed by every SpoolEvent, so a new event can't be left out of this check.
  if (typeof line.ev !== 'string' || !Object.hasOwn(REQUIRED, line.ev)) return `unknown ev ${JSON.stringify(line.ev)}`
  if (typeof line.session_id !== 'string' || line.session_id === '') return 'no session_id'
  if (typeof line.ts !== 'number' || !Number.isFinite(line.ts)) return 'no ts'
  for (const field of REQUIRED[line.ev as SpoolEvent]) {
    if (typeof line[field] !== 'string' || line[field] === '') return `no ${field}`
  }
  return null
}

/** The string fields each event can't do without (hookfiles.ts, SpoolLine). */
const REQUIRED: Readonly<Record<SpoolEvent, readonly string[]>> = {
  start: ['agent_id', 'agent_type', 'cwd'],
  stop: ['agent_id', 'agent_type'],
  output: ['agent_id', 'agent_type', 'tool_use_id'],
  mode: ['mode'],
  'isolation-lost': ['agent_id', 'agent_type', 'tool'],
  deny: ['tool', 'reason'],
  worktree: ['step', 'run', 'name', 'path', 'branch', 'base'],
  // Phase 2b's swarm lines (consumed by swarm/observe.ts).
  call: ['agent_id', 'agent_type', 'tool', 'tool_use_id', 'phase'],
  handback: ['agent_id', 'agent_type', 'tool_use_id'],
  hold: ['agent_id', 'phase'],
}

/**
 * The line with its blob merged in, when it names one in `file`. The blob is
 * the whole line, with `ev` and the ids also kept on the stub; for an `output`
 * line, a blob without `ev` is taken as the `input` alone.
 */
async function withBlob(
  p: Ports,
  litterDir: string,
  stub: Record<string, unknown>,
): Promise<{ line: Record<string, unknown>; blob: string | null } | { error: string }> {
  if (stub.file === undefined) return { line: stub, blob: null }
  const name = stub.file
  if (typeof name !== 'string' || !BLOB_NAME.test(name)) return { error: `'file' isn't a blob name: ${JSON.stringify(name)}` }
  const dir = spoolBlobDir(litterDir)
  const path = (await p.fs.exists(`${dir}/${name}`)) ? `${dir}/${name}` : `${dir}/${name}.json`
  let blob: unknown
  try {
    blob = JSON.parse(await p.fs.read(path))
  } catch (err) {
    return { error: `blob ${name}: ${errText(err)}` }
  }
  if (blob === null || typeof blob !== 'object' || Array.isArray(blob)) return { error: `blob ${name} isn't a JSON object` }
  const { file: _file, ...rest } = stub
  const full = 'ev' in blob ? { ...(blob as Record<string, unknown>), ...rest } : stub.ev === 'output' ? { ...rest, input: blob } : null
  return full ? { line: full, blob: path } : { error: `blob ${name} isn't a spool line` }
}

/**
 * Hands the complete lines of `text` from `from` on to every consumer, in
 * order. Resolves how far it read (a cut-off last line is left for the next
 * read unless `final`), and counts what it skipped.
 */
async function deliver(
  ctx: SpoolCtx,
  consumers: readonly SpoolConsumer[],
  name: string,
  text: string,
  from: number,
  final: boolean,
  tally: { lines: number; bad: number; blobs: string[] },
): Promise<number> {
  let at = from
  for (;;) {
    const nl = text.indexOf('\n', at)
    if (nl === -1 && !(final && at < text.length)) return at
    const end = nl === -1 ? text.length : nl
    const raw = text.slice(at, end).trim()
    at = nl === -1 ? text.length : nl + 1
    if (raw === '') continue
    tally.lines++
    const skip = (why: string) => {
      tally.bad++
      ctx.p.log(`spool ${name}: skipped a line (${why}): ${raw.slice(0, 120)}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      skip("it doesn't parse")
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      skip('not a JSON object')
      continue
    }
    const merged = await withBlob(ctx.p, ctx.litterDir, parsed as Record<string, unknown>)
    if ('error' in merged) {
      skip(merged.error)
      continue
    }
    const problem = lineProblem(merged.line)
    if (problem !== null) {
      skip(problem)
      continue
    }
    if (merged.blob) tally.blobs.push(merged.blob)
    const line = merged.line as SpoolLine
    for (const consumer of consumers) {
      try {
        await consumer(ctx, line)
      } catch (err) {
        ctx.p.log(`spool ${name}: a consumer failed on ${line.ev} (${'agent_id' in line ? line.agent_id : '-'}): ${errText(err)}`)
      }
    }
  }
}

/**
 * Drains one spool file already renamed aside, then removes it and the blobs
 * it named. A hook that opened the spool just before the rename can still
 * append to the aside file, so it's read again until it stops growing. A line
 * can be delivered twice only after a crash between delivery and removal, so
 * every consumer is idempotent.
 */
async function drainAside(
  p: Ports,
  litterDir: string,
  sessionId: string,
  aside: string,
  consumers: readonly SpoolConsumer[],
): Promise<{ lines: number; bad: number }> {
  const ctx: SpoolCtx = { p, litterDir, sessionId }
  const name = aside.slice(aside.lastIndexOf('/') + 1)
  const tally = { lines: 0, bad: 0, blobs: [] as string[] }
  let text = ''
  let done = 0
  for (let pass = 0; pass < 20; pass++) {
    const now = await p.fs.read(aside)
    if (pass > 0 && now.length === text.length) break
    text = now
    done = await deliver(ctx, consumers, name, text, done, false, tally)
  }
  // A last line without its newline is read as it is: nothing appends to it any more.
  if (done < text.length) await deliver(ctx, consumers, name, text, done, true, tally)
  await remove(p, aside)
  for (const blob of tally.blobs) await remove(p, blob).catch(err => p.log(`spool blob not removed: ${errText(err)}`))
  return { lines: tally.lines, bad: tally.bad }
}

/** Unserialised: renames one session's live spool aside and drains it. */
async function drainLive(ctx: SpoolCtx, consumers: readonly SpoolConsumer[]): Promise<{ lines: number; bad: number }> {
  const live = spoolPath(ctx.litterDir, ctx.sessionId)
  if (!(await ctx.p.fs.exists(live))) return { lines: 0, bad: 0 }
  // New appends start a new file from here on (section 9, "Draining").
  const aside = `${live}.draining-${randomId()}`
  await rename(ctx.p, live, aside)
  return drainAside(ctx.p, ctx.litterDir, ctx.sessionId, aside, consumers)
}

/** Drains one session's spool into the consumers, once, in order. */
export function drainSpool(ctx: SpoolCtx, consumers: readonly SpoolConsumer[]): Promise<{ lines: number; bad: number }> {
  return serial(spoolKey(ctx.litterDir), () => drainLive(ctx, consumers))
}

/**
 * The session ids this module instance has run under. /clear changes the id
 * without a session.start, so a policy naming one of these is this session's
 * own after a /clear, not another live session's.
 */
const mySessions = new Set<string>()

/** The current session id, remembered as one of this instance's own. */
async function currentSession(p: Ports): Promise<string> {
  const sid = await p.sessionId()
  mySessions.add(sid)
  return sid
}

/**
 * The session that owns the active run, when it's another live session's:
 * its spool is that session's to drain. Null when the run is this session's,
 * or nothing is active.
 */
async function foreignOwner(p: Ports, litterDir: string, sid: string): Promise<string | null> {
  const policy = await readPolicy(p, litterDir).catch(() => undefined)
  if (!policy || policy.run === null || policy.session === sid || mySessions.has(policy.session)) return null
  return (await p.fs.exists(activePath(litterDir))) ? policy.session : null
}

/**
 * At session.start: drains every spool under hooks/spool/, earlier session ids
 * too, before reconcile (section 9, "Draining"): first the files an earlier
 * drain renamed aside and never finished, then each live spool, oldest first.
 * The spool of a run another live session owns is left to that session.
 */
export async function drainAllSpools(p: Ports, litterDir: string, consumers: readonly SpoolConsumer[]): Promise<void> {
  const sid = await currentSession(p)
  await serial(spoolKey(litterDir), async () => {
    const dir = spoolDir(litterDir)
    if (!(await p.fs.exists(dir))) return
    const owner = await foreignOwner(p, litterDir, sid)
    const files: { name: string; session: string; aside: boolean; mtime: number }[] = []
    for (const e of await p.fs.list(dir)) {
      if (e.kind !== 'file') continue
      const m = ASIDE.exec(e.name) ?? LIVE.exec(e.name)
      if (!m || m[1] === owner) continue
      const mtime = (await p.fs.stat(`${dir}/${e.name}`).catch(() => null))?.mtimeMs ?? 0
      files.push({ name: e.name, session: m[1]!, aside: ASIDE.test(e.name), mtime })
    }
    files.sort((a, b) => Number(b.aside) - Number(a.aside) || a.mtime - b.mtime || a.name.localeCompare(b.name))
    for (const f of files) {
      try {
        const r = f.aside
          ? await drainAside(p, litterDir, f.session, `${dir}/${f.name}`, consumers)
          : await drainLive({ p, litterDir, sessionId: f.session }, consumers)
        if (r.bad > 0) p.log(`spool ${f.name}: ${r.bad} of ${r.lines} lines skipped`)
      } catch (err) {
        p.log(`spool ${f.name} not drained: ${errText(err)}`)
      }
    }
  })
}

/**
 * Drains this session's spools: at a record call, the Workflow hook and the
 * task notification, and on every timer tick (section 9, "Draining"). After a
 * /clear the policy still names the session this instance ran under before, so
 * it's rewritten to name the current one first (section 12: "policy.json names
 * the owning session again after a /clear"), and both sessions' spools are
 * drained. A run another live session owns is left alone.
 */
export async function drainOwnSpools(p: Ports, litterDir: string, consumers: readonly SpoolConsumer[]): Promise<void> {
  const sid = await currentSession(p)
  const policy = await readPolicy(p, litterDir)
  if (policy && policy.session !== sid && mySessions.has(policy.session)) {
    await updatePolicy(p, litterDir, cur => (cur.session !== sid && mySessions.has(cur.session) ? { ...cur, session: sid } : null))
  }
  await serial(spoolKey(litterDir), async () => {
    for (const s of mySessions) {
      try {
        await drainLive({ p, litterDir, sessionId: s }, consumers)
      } catch (err) {
        p.log(`spool ${s} not drained: ${errText(err)}`)
      }
    }
  })
}

let timer: { cancel(): void } | null = null
let ticking = false

/**
 * Starts the drain timer for this module instance (p.every, so it ends when
 * the module unloads). A session.start after a reload replaces the old timer.
 * A tick does one `exists` while nothing is active, and skips while the last
 * tick is still draining.
 */
export function startDrainTimer(p: Ports, consumers: readonly SpoolConsumer[]): void {
  timer?.cancel()
  timer = p.every(2000, () => {
    if (ticking) return
    ticking = true
    void tick(p, consumers)
      .catch(err => p.log(`drain timer: ${errText(err)}`))
      .finally(() => {
        ticking = false
      })
  })
}

async function tick(p: Ports, consumers: readonly SpoolConsumer[]): Promise<void> {
  const litterDir = session().litterDir
  if (!litterDir || !(await p.fs.exists(activePath(litterDir)))) return
  await drainOwnSpools(p, litterDir, consumers)
}

// The agent map: who each agent is, from its spooled start and stop, kept in
// $.store so it outlives a reload. The record tool and the land check read it
// for the caller's role and run; nothing here trusts bind/ files.

export type AgentInfo = {
  agentId: string
  agentType: string
  /** The `litter:` role, when it's one. */
  role: string | null
  run: string | null
  cwd: string
  started: number
  stopped: number | null
  /** The session whose spool carried the start. */
  sessionId?: string
  transcriptPath?: string
}

const agentKey = (agentId: string) => `litter.agent.${agentId}`
const runAgentsKey = (run: string) => `litter.agents.${run}`

/** The role an agent type names, when it's a litter role (`litter:<role>`). */
export function roleOf(agentType: string): string | null {
  const name = agentType.startsWith('litter:') ? agentType.slice('litter:'.length) : null
  return name !== null && isRoleName(name) ? name : null
}

/** The agent map's entry for an agentId, or undefined when no start was spooled for it. */
export async function agentInfo(p: Ports, agentId: string): Promise<AgentInfo | undefined> {
  const info = (await p.store.get(agentKey(agentId))) as AgentInfo | undefined
  return info && typeof info === 'object' && info.agentId === agentId ? info : undefined
}

/** The agent ids started in a run, in start order. */
export async function runAgents(p: Ports, run: string): Promise<string[]> {
  const ids = await p.store.get(runAgentsKey(run))
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
}

/** Drops a run's agents from the store, once nothing reads them (after its run.end), so the map doesn't grow without end. */
export async function forgetRunAgents(p: Ports, run: string): Promise<void> {
  for (const id of await runAgents(p, run)) await p.store.delete(agentKey(id))
  await p.store.delete(runAgentsKey(run))
}

/**
 * Spool consumer: start and stop lines build the agent map. A start for a
 * litter role while a run is active belongs to that run (drains run before
 * reconcile, so the policy still names the run its lines came from). A line
 * that contradicts the map, or a stop for an agent it doesn't know, changes
 * nothing and is logged (section 12).
 */
export const consumeAgents: SpoolConsumer = async (ctx, line) => {
  if (line.ev === 'start') {
    const cwd = line.cwd.normalize('NFC')
    const known = await agentInfo(ctx.p, line.agent_id)
    if (known) {
      if (known.agentType !== line.agent_type || known.cwd !== cwd) {
        ctx.p.log(`agent ${line.agent_id}: a start as ${line.agent_type} in ${cwd} contradicts ${known.agentType} in ${known.cwd}; ignored`)
      } else if (known.stopped !== null) {
        // A stopped agent that's messaged again starts again with the same id.
        await ctx.p.store.set(agentKey(line.agent_id), { ...known, stopped: null } satisfies AgentInfo)
      }
      return
    }
    const role = roleOf(line.agent_type)
    const run = role ? ((await readPolicy(ctx.p, ctx.litterDir))?.run?.run ?? null) : null
    const info: AgentInfo = {
      agentId: line.agent_id,
      agentType: line.agent_type,
      role,
      run,
      cwd,
      started: Math.round(line.ts * 1000),
      stopped: null,
      sessionId: line.session_id,
      transcriptPath: line.transcript_path,
    }
    await ctx.p.store.set(agentKey(line.agent_id), info)
    if (run) {
      const ids = await runAgents(ctx.p, run)
      if (!ids.includes(line.agent_id)) await ctx.p.store.set(runAgentsKey(run), [...ids, line.agent_id])
    }
    return
  }
  if (line.ev === 'stop') {
    const known = await agentInfo(ctx.p, line.agent_id)
    if (!known) {
      ctx.p.log(`agent ${line.agent_id}: a stop for an agent with no start; ignored`)
      return
    }
    if (known.agentType !== line.agent_type) {
      ctx.p.log(`agent ${line.agent_id}: a stop as ${line.agent_type} contradicts ${known.agentType}; ignored`)
      return
    }
    if (known.stopped === null) await ctx.p.store.set(agentKey(line.agent_id), { ...known, stopped: Math.round(line.ts * 1000) } satisfies AgentInfo)
  }
}

/**
 * The stop of an agent whose loop was interrupted, which no SubagentStop
 * reports: the engine marks the loop done before it checks the abort, so
 * runAgent's SubagentStop for an interrupted query returns at once (2.1.288
 * `:739409`, `:739446`; 2.1.287 the same). A TaskStop'd workflow's agents end
 * that way, and a stopping run would never settle. The agent's aborted
 * turn.complete stands in: the consumers get the stop line identity.sh would
 * have spooled, after a drain, so its start is in the map. An agent the map
 * doesn't know, or has seen stop, changes nothing.
 */
export async function stopInterrupted(p: Ports, litterDir: string, agentId: string, consumers: readonly SpoolConsumer[]): Promise<boolean> {
  await drainOwnSpools(p, litterDir, consumers)
  const sessionId = await currentSession(p)
  const ts = (await p.now()) / 1000
  return serial(spoolKey(litterDir), async () => {
    const known = await agentInfo(p, agentId)
    if (!known || known.stopped !== null) return false
    const line: SpoolLine = {
      v: 1,
      ev: 'stop',
      ts,
      session_id: known.sessionId ?? sessionId,
      agent_id: agentId,
      agent_type: known.agentType,
      transcript_path: known.transcriptPath ?? '',
      stop_hook_active: false,
      background_tasks: 0,
    }
    for (const consumer of consumers) {
      try {
        await consumer({ p, litterDir, sessionId }, line)
      } catch (err) {
        p.log(`interrupted agent ${agentId}: a consumer failed on its stop: ${errText(err)}`)
      }
    }
    return true
  })
}
