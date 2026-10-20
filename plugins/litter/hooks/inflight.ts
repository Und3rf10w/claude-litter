// An execute run's in-flight flag (COMMON decision 24): `critique` while a
// gate-critic runs, `land` while a land does, in the run's policy.json through
// lifecycle.ts's patchRunPolicy. Execute runs only; plan-template swarms
// don't set it. Owner: phase 3, package AB.
//
// The guard reads the flag (guard.sh: writes wait, Bash is read-only), and a
// stopping run doesn't settle while it's set (lifecycle.ts, unsettled), so
// every path that sets it has one that clears it: a critic's stop line (or
// the stop policy.ts makes up for an interrupted one), and the land's
// `finally`. The critics the flag is held for are kept in $.store with the
// run, so a reload still knows whose stop clears it.

import type { Ports } from './ports'
import type { SpoolConsumer } from './hookfiles'
import { serial } from './fsx'
import { patchRunPolicy } from './lifecycle'
import { agentInfo, readPolicy } from './policy'

const CRITIC = 'litter:gate-critic'

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** $.store: the gate-critics the `critique` flag is held for, by litter directory (one active run each). */
const criticsKey = (litterDir: string) => `litter.inflight.${litterDir}`
type Critics = { run: string; agents: string[] }

/** Every change to the remembered critics and the flag runs under this key; never across a land. */
const inflightKey = (litterDir: string) => `inflight:${litterDir}`

/** The lands in flight in this module instance, by litter directory and run: two overlapping lands put the flag back once. */
const lands = new Map<string, number>()
const landKey = (litterDir: string, run: string) => `${litterDir}\n${run}`

/** The critics remembered for `run`; another run's entry counts as none. */
async function remembered(p: Ports, litterDir: string, run: string): Promise<string[]> {
  const v = (await p.store.get(criticsKey(litterDir))) as Critics | undefined
  if (!v || typeof v !== 'object' || v.run !== run || !Array.isArray(v.agents)) return []
  return v.agents.filter((a): a is string => typeof a === 'string' && a !== '')
}

async function remember(p: Ports, litterDir: string, run: string, agents: string[]): Promise<void> {
  if (agents.length === 0) await p.store.delete(criticsKey(litterDir))
  else await p.store.set(criticsKey(litterDir), { run, agents } satisfies Critics)
}

/** The remembered critics the agent map doesn't show stopped (one it doesn't know yet counts as running). */
async function running(p: Ports, litterDir: string, run: string): Promise<string[]> {
  const out: string[] = []
  for (const id of await remembered(p, litterDir, run)) {
    const info = await agentInfo(p, id)
    if (!info || info.stopped === null) out.push(id)
  }
  return out
}

/** The active run, when it's an execute run named `run` (or any execute run, without one); else null. */
async function activeExecute(p: Ports, litterDir: string, run?: string): Promise<string | null> {
  const policy = await readPolicy(p, litterDir)
  const r = policy?.run
  if (!r || r.workflow !== 'execute' || (run !== undefined && r.run !== run)) return null
  return r.run
}

/** Sets `critique` and remembers the critic, under the in-flight key. A land in flight keeps `land`; its end puts `critique` back. */
function setCritique(p: Ports, litterDir: string, run: string, agentId: string): Promise<void> {
  return serial(inflightKey(litterDir), async () => {
    // The critic first: if the flag were written and this weren't, no stop would clear it.
    const list = await remembered(p, litterDir, run)
    if (!list.includes(agentId)) await remember(p, litterDir, run, [...list, agentId])
    await patchRunPolicy(p, litterDir, run, r => (r.workflow !== 'execute' || r.inflight === 'land' ? r : { ...r, inflight: 'critique' }))
  })
}

/**
 * A spool consumer (registry.ts, after consumeAgents): a `start` line for a
 * `litter:gate-critic` of the active execute run sets `critique`, as
 * markCritique does; that agent's `stop` line clears it, unless a land holds it.
 */
export const consumeInflight: SpoolConsumer = async (ctx, line) => {
  if ((line.ev !== 'start' && line.ev !== 'stop') || line.agent_type !== CRITIC) return
  const { p, litterDir } = ctx
  if (line.ev === 'start') {
    const run = await activeExecute(p, litterDir)
    if (run === null) return
    // consumeAgents gave it the run that was active at its start; a critic of another run isn't this one's.
    const info = await agentInfo(p, line.agent_id)
    if (info && info.run !== run) return
    await setCritique(p, litterDir, run, line.agent_id)
    return
  }
  await serial(inflightKey(litterDir), async () => {
    const policy = await readPolicy(p, litterDir)
    const run = policy?.run?.run
    if (!run) return
    const list = await remembered(p, litterDir, run)
    const info = await agentInfo(p, line.agent_id)
    if (!list.includes(line.agent_id) && info?.run !== run) return
    const left = list.filter(a => a !== line.agent_id)
    await remember(p, litterDir, run, left)
    if ((await running(p, litterDir, run)).length > 0) return
    await patchRunPolicy(p, litterDir, run, r => (r.inflight === 'critique' ? { ...r, inflight: null } : r))
  })
}

/**
 * Sets `critique` for the run and remembers the critic's agent id, from
 * verify.ts's recordVerify when a `litter:gate-critic` of an execute run
 * records its verify (whichever the mod sees first of that and its start
 * line). A throw fails the verify closed.
 */
export async function markCritique(p: Ports, litterDir: string, run: string, agentId: string): Promise<void> {
  if ((await activeExecute(p, litterDir, run)) === null) return
  await setCritique(p, litterDir, run, agentId)
}

/**
 * Runs `fn` with the run's flag at `what`, then puts back what was there
 * (`critique` while a remembered gate-critic still runs, else null) in a
 * `finally`. From land.ts's recordLand, around an execute land.
 *
 * Setting the flag can throw, and then `fn` doesn't run: the land is refused
 * closed. Putting it back is logged when it fails, never thrown, because the
 * land's answer stands either way, and a flag left at `land` only keeps writes
 * waiting.
 */
export async function withInflight<T>(p: Ports, litterDir: string, run: string, what: 'land', fn: () => Promise<T>): Promise<T> {
  if ((await activeExecute(p, litterDir, run)) === null) return fn()
  const key = landKey(litterDir, run)
  await serial(inflightKey(litterDir), async () => {
    lands.set(key, (lands.get(key) ?? 0) + 1)
    try {
      await patchRunPolicy(p, litterDir, run, r => (r.workflow === 'execute' ? { ...r, inflight: what } : r))
    } catch (err) {
      const n = (lands.get(key) ?? 1) - 1
      if (n > 0) lands.set(key, n)
      else lands.delete(key)
      throw err
    }
  })
  try {
    return await fn()
  } finally {
    await serial(inflightKey(litterDir), async () => {
      const n = (lands.get(key) ?? 1) - 1
      if (n > 0) {
        lands.set(key, n)
        return
      }
      lands.delete(key)
      const back = (await running(p, litterDir, run)).length > 0 ? 'critique' : null
      await patchRunPolicy(p, litterDir, run, r => (r.inflight === what ? { ...r, inflight: back } : r))
    }).catch(err => p.log(`run ${run}: the in-flight flag wasn't put back after the land: ${errText(err)}`))
  }
}
