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
import type { Policy, SpoolConsumer, SpoolCtx } from './hookfiles'
import { activePath, policyPath } from './layout'
import { atomicWrite, atomicWriteJson, readJson, remove } from './fsx'

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

/** Creates or removes `hooks/active`. Create it after policy.json is written, and remove it before. */
export async function setActive(p: Ports, litterDir: string, on: boolean): Promise<void> {
  if (on) await atomicWrite(p, activePath(litterDir), '')
  else await remove(p, activePath(litterDir))
}

/** Drains one session's spool into the consumers, once, in order. */
export async function drainSpool(_ctx: SpoolCtx, _consumers: readonly SpoolConsumer[]): Promise<{ lines: number; bad: number }> {
  return { lines: 0, bad: 0 }
}

/** At session.start: drains every spool under hooks/spool/, earlier session ids too, before reconcile. */
export async function drainAllSpools(_p: Ports, _litterDir: string, _consumers: readonly SpoolConsumer[]): Promise<void> {}

/** Starts the drain timer for this module instance (p.every, so it ends when the module unloads). */
export function startDrainTimer(_p: Ports, _consumers: readonly SpoolConsumer[]): void {}

export type AgentInfo = {
  agentId: string
  agentType: string
  /** The `litter:` role, when it's one. */
  role: string | null
  run: string | null
  cwd: string
  started: number
  stopped: number | null
}

/** Spool consumer: start and stop lines build the agent map. */
export const consumeAgents: SpoolConsumer = async () => {}

/** The agent map's entry for an agentId, or undefined when no start was spooled for it. */
export async function agentInfo(_p: Ports, _agentId: string): Promise<AgentInfo | undefined> {
  return undefined
}
