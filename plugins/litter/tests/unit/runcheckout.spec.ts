// Tier 2: decision 10's exception (phase 3, WP-AC step 8), against real git:
// while an execute run is open for its repair, only the swarm its open
// generation's run.repair names may work in the run's checkout. spec.ts's
// activeRunsRepair reads that from the mod's own files (policy.json's run,
// and the run's ledger); J's validateSpec skips its "the active run's
// checkout" refusal only for that swarm, and launch.ts's planLaunch only for
// that swarm, with grants, launched for that run (`forRun`). Every other
// swarm is refused as before. The reopen is lifecycle.ts's real one.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { RepairSpecResult } from '../../hooks/repair'
import type { SavedSwarm, SwarmSpec } from '../../hooks/swarm/types'
import { appendRecord } from '../../hooks/ledgercore'
import { MOD } from '../../hooks/verify'
import { newLaunchId } from '../../hooks/records/swarm'
import { endRepairGeneration, reopenForRepair } from '../../hooks/lifecycle'
import { activeRunsRepair, validateCtxFor, validateSpec } from '../../hooks/swarm/spec'
import { deps as launchDeps, planLaunch } from '../../hooks/swarm/launch'
import { liveSwarm, setInteractive } from '../../hooks/swarm/state'
import { continueAsRepair, repairSpec, resetRepairForTests } from '../../hooks/repair'
import { world, type World } from './swarmlaunch-harness'
import { RUN, declinedReason, executeRun, type Exec } from './execbridge-harness'

setDefaultTimeout(120_000)

const launchOriginals = { ...launchDeps }
const CHECKOUT_REFUSAL = "is the active litter run's checkout; a node can't work there while the run is active"

let w: World
beforeEach(async () => {
  w = await world('sess-a')
  resetRepairForTests()
  setInteractive(true)
})
afterEach(async () => {
  Object.assign(launchDeps, launchOriginals)
  resetRepairForTests()
  await w.done()
})

type Made = { x: Exec; r: Extract<RepairSpecResult, { ok: true }> }

/** The halted run and the plan template's spec for it, under the name the bridge gives it. */
async function made(): Promise<Made> {
  const x = await executeRun(w)
  const r = await repairSpec(w.p, x.runDir)
  if (!r.ok) throw new Error(r.reason)
  return { x, r }
}

/** The run reopened for swarm `swarm` (the bridge's name unless given): run.repair, the lock, and policy.json's run again. */
async function reopened(m: Made, swarm = m.x.name): Promise<void> {
  const launch = await newLaunchId(w.p, w.litterDir, swarm)
  const open = await reopenForRepair(w.p, m.x.runDir, { swarm, launch, budget: { rounds: 3, agents: 6 } })
  if (!open.ok) throw new Error(open.reason)
}

const renamed = (spec: SwarmSpec, name: string): SwarmSpec => ({ ...spec, name })
const saved = (m: Made, spec: SwarmSpec = m.r.spec): SavedSwarm => ({ spec, revision: 0, briefs: m.r.briefs })

async function checked(m: Made, spec: SwarmSpec) {
  const ctx = await validateCtxFor(w.p, w.litterDir, async node => m.r.briefs[node] ?? null)
  return { ctx, check: await validateSpec(w.p, spec, ctx) }
}

describe('activeRunsRepair', () => {
  test("true only for the swarm the open generation's run.repair names, in the active run's checkout", async () => {
    const m = await made()
    // Ended: no active run, so no exception (and no refusal) at all.
    expect(await activeRunsRepair(w.p, w.litterDir, w.dir, m.x.name)).toBe(false)
    await reopened(m)
    expect(await activeRunsRepair(w.p, w.litterDir, w.dir, m.x.name)).toBe(true)
    expect(await activeRunsRepair(w.p, w.litterDir, w.dir, 'repair-other')).toBe(false)
    expect(await activeRunsRepair(w.p, w.litterDir, `${w.dir}/elsewhere`, m.x.name)).toBe(false)
    expect(await activeRunsRepair(w.p, w.litterDir, null, m.x.name)).toBe(false)
    // A stop after the reopen closes it.
    await appendRecord(w.p, m.x.runDir, { run: RUN, kind: 'run.stopping', by: MOD, body: { taskId: '', generation: 2 } })
    expect(await activeRunsRepair(w.p, w.litterDir, w.dir, m.x.name)).toBe(false)
  })

  test("a reopen for another swarm is that swarm's exception, not this one's; once the generation ends, no one's", async () => {
    const m = await made()
    await reopened(m, 'repair-other')
    expect(await activeRunsRepair(w.p, w.litterDir, w.dir, m.x.name)).toBe(false)
    expect(await activeRunsRepair(w.p, w.litterDir, w.dir, 'repair-other')).toBe(true)
    await endRepairGeneration(w.p, m.x.runDir, { status: 'halted', reason: 'never went live' })
    expect(await activeRunsRepair(w.p, w.litterDir, w.dir, 'repair-other')).toBe(false)
  })
})

describe("J's validateSpec", () => {
  test("the run's own repair swarm may name the active run's checkout as existing; any other swarm is refused", async () => {
    const m = await made()
    await reopened(m)
    const own = await checked(m, m.r.spec)
    expect(own.ctx.activeRunCheckout).toBe(w.dir)
    expect(own.check.errors).toEqual([])
    const other = await checked(m, renamed(m.r.spec, 'repair-other'))
    expect(other.check.errors).toEqual([
      expect.objectContaining({ field: 'nodes.runner.worktree.existing', node: 'runner', error: `${w.dir} ${CHECKOUT_REFUSAL}` }),
    ])
  })

  test('with no active run there is nothing to except: both pass', async () => {
    const m = await made()
    expect((await checked(m, m.r.spec)).check.errors).toEqual([])
    expect((await checked(m, renamed(m.r.spec, 'repair-other'))).check.errors).toEqual([])
  })
})

describe("launch.ts's planLaunch", () => {
  test("the bridge's call (grants, forRun) passes in the run's checkout; without forRun, for another run, without grants, or for another swarm, it's refused", async () => {
    const m = await made()
    await reopened(m)
    const name = m.x.name
    const ok = await planLaunch(w.p, name, { saved: saved(m), grants: true, forRun: RUN })
    if (!ok.ok) throw new Error(ok.reason)
    expect(ok.plan.dirs.runner).toEqual({ dir: w.dir, branch: null, created: false })

    const refusal = `nodes.runner: it would work in ${w.dir}, the active litter run's checkout`
    const reasonOf = async (n: string, opts: Parameters<typeof planLaunch>[2]) => {
      const r = await planLaunch(w.p, n, opts)
      expect(r.ok).toBe(false)
      return (r as { reason: string }).reason
    }
    expect(await reasonOf(name, { saved: saved(m), grants: true })).toContain(refusal)
    expect(await reasonOf(name, { saved: saved(m), grants: true, forRun: '20261003-other' })).toContain(refusal)
    const ungranted = await reasonOf(name, { saved: saved(m), grants: false, forRun: RUN })
    expect(ungranted).toContain('nodes.runner.authority.verify: only a repair swarm a run starts may verify or land')
    expect(await reasonOf('repair-other', { saved: saved(m, renamed(m.r.spec, 'repair-other')), grants: true, forRun: RUN })).toContain(refusal)
  })

  test("the bridge's own launch passes J's real validateSpec in the active run's checkout", async () => {
    const m = await made()
    launchDeps.validateSpec = validateSpec
    await continueAsRepair(w.p, m.x.runDir)
    expect(await declinedReason(m.x)).toBeNull()
    const s = liveSwarm(m.x.name)
    expect(s?.run).toEqual({ runDir: m.x.runDir, run: RUN, generation: 2 })
    expect(s?.dirs.runner?.dir).toBe(w.dir)
  })
})
