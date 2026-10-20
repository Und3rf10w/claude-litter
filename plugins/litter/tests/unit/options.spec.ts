// Tier 2: the plugin options' normalisation (hooks/options.ts), the repair
// three (phase 2b-2, WP-V): section 10's defaults and ranges, and bad values.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BAND_ENDED_MINUTES, normalizeOptions, REPAIR_AGENTS, REPAIR_ROUNDS } from '../../hooks/options'
import { ENDED_MS } from '../../hooks/band/view'

const manifest = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '.claude-plugin', 'plugin.json'), 'utf8')) as {
  userConfig: Record<string, { type: string; default?: unknown; min?: number; max?: number; options?: string[]; title?: string; description?: string }>
}

describe('the repair options', () => {
  test('unset, and "" (an optional field the user never set): auto, 3 rounds, 6 agents', () => {
    for (const raw of [undefined, {}, { repair: '', repairRounds: '', repairAgents: '' }]) {
      const o = normalizeOptions(raw)
      expect({ repair: o.repair, repairRounds: o.repairRounds, repairAgents: o.repairAgents }).toEqual({ repair: 'auto', repairRounds: 3, repairAgents: 6 })
    }
  })

  test("repair is off only for 'off', in any case and with spaces; anything else is auto", () => {
    expect(normalizeOptions({ repair: 'off' }).repair).toBe('off')
    expect(normalizeOptions({ repair: ' OFF ' }).repair).toBe('off')
    for (const v of ['auto', 'Auto', 'of', 'no', 'false', 0, false, null, ['off'], { off: true }]) {
      expect(normalizeOptions({ repair: v }).repair).toBe('auto')
    }
  })

  test('a number in range is taken, from a number or its string', () => {
    expect(normalizeOptions({ repairRounds: 1, repairAgents: 50 })).toEqual(expect.objectContaining({ repairRounds: 1, repairAgents: 50 }))
    expect(normalizeOptions({ repairRounds: '10', repairAgents: '7' })).toEqual(expect.objectContaining({ repairRounds: 10, repairAgents: 7 }))
  })

  test('out of range is clamped to the nearer end, never the default; a fraction rounds down', () => {
    expect(normalizeOptions({ repairRounds: 0, repairAgents: 0 })).toEqual(expect.objectContaining({ repairRounds: 1, repairAgents: 1 }))
    expect(normalizeOptions({ repairRounds: -4, repairAgents: -1 })).toEqual(expect.objectContaining({ repairRounds: 1, repairAgents: 1 }))
    expect(normalizeOptions({ repairRounds: 11, repairAgents: 51 })).toEqual(expect.objectContaining({ repairRounds: 10, repairAgents: 50 }))
    expect(normalizeOptions({ repairRounds: 1e9, repairAgents: '999' })).toEqual(expect.objectContaining({ repairRounds: 10, repairAgents: 50 }))
    expect(normalizeOptions({ repairRounds: 2.9, repairAgents: 5.5 })).toEqual(expect.objectContaining({ repairRounds: 2, repairAgents: 5 }))
    expect(normalizeOptions({ repairRounds: 0.5 })).toEqual(expect.objectContaining({ repairRounds: 1 }))
  })

  test("what isn't a number is the default", () => {
    for (const v of ['three', 'NaN', NaN, Infinity, -Infinity, true, null, [], {}]) {
      const o = normalizeOptions({ repairRounds: v, repairAgents: v })
      expect({ v, rounds: o.repairRounds, agents: o.repairAgents }).toEqual({ v, rounds: 3, agents: 6 })
    }
  })

  test("the other options are as they were", () => {
    const o = normalizeOptions({ maxAttempts: 5, summaryModel: 'off', verify: ['true'] })
    expect(o).toEqual(expect.objectContaining({ maxAttempts: 5, maxRounds: 4, verify: ['true'], summaryEverySec: 60 }))
    expect(o.summaryModel).toBeUndefined()
  })
})

describe('the manifest', () => {
  test("declares the three with section 10's defaults and ranges, a title and a description each", () => {
    const { repair, repairRounds, repairAgents } = manifest.userConfig
    expect(repair).toEqual(expect.objectContaining({ type: 'string', default: 'auto', options: ['auto', 'off'] }))
    expect(repairRounds).toEqual(expect.objectContaining({ type: 'number', default: REPAIR_ROUNDS.default, min: REPAIR_ROUNDS.min, max: REPAIR_ROUNDS.max }))
    expect(repairAgents).toEqual(expect.objectContaining({ type: 'number', default: REPAIR_AGENTS.default, min: REPAIR_AGENTS.min, max: REPAIR_AGENTS.max }))
    for (const f of [repair, repairRounds, repairAgents]) {
      expect(f?.title).toBeTruthy()
      expect(f?.description).toBeTruthy()
    }
  })

  test("the manifest's defaults are what normalisation gives an unset option", () => {
    const o = normalizeOptions(undefined)
    expect(o.repair).toBe(manifest.userConfig.repair!.default as 'auto')
    expect(o.repairRounds).toBe(manifest.userConfig.repairRounds!.default as number)
    expect(o.repairAgents).toBe(manifest.userConfig.repairAgents!.default as number)
  })
})

// WP-AO: who may add files to a gate's Files.
describe('the widen option', () => {
  test("critic only for 'critic', in any case and with spaces; unset, '' and anything else is ask, the manifest's default", () => {
    expect(normalizeOptions({ widen: 'critic' }).widen).toBe('critic')
    expect(normalizeOptions({ widen: ' Critic ' }).widen).toBe('critic')
    for (const v of [undefined, '', 'ask', 'yes', 1, null]) expect(normalizeOptions({ widen: v }).widen).toBe('ask')
    expect(normalizeOptions(undefined).widen).toBe(manifest.userConfig.widen!.default as 'ask')
    expect(manifest.userConfig.widen).toEqual(expect.objectContaining({ type: 'string', default: 'ask', options: ['ask', 'critic'] }))
  })
})

// WP-CH: how long a run that ended keeps its row in the band.
describe('the bandEndedMinutes option', () => {
  test('unset and "": 10, the band\'s ENDED_MS in minutes', () => {
    for (const raw of [undefined, {}, { bandEndedMinutes: '' }]) expect(normalizeOptions(raw).bandEndedMinutes).toBe(10)
    expect(ENDED_MS).toBe(BAND_ENDED_MINUTES.default * 60_000)
  })

  test('a value in range is taken, from a number or its string, 0 included; a fraction rounds down', () => {
    expect(normalizeOptions({ bandEndedMinutes: 1 }).bandEndedMinutes).toBe(1)
    expect(normalizeOptions({ bandEndedMinutes: 0 }).bandEndedMinutes).toBe(0)
    expect(normalizeOptions({ bandEndedMinutes: '30' }).bandEndedMinutes).toBe(30)
    expect(normalizeOptions({ bandEndedMinutes: 1440 }).bandEndedMinutes).toBe(1440)
    expect(normalizeOptions({ bandEndedMinutes: 2.9 }).bandEndedMinutes).toBe(2)
  })

  test('out of range is clamped to the nearer end, never the default', () => {
    expect(normalizeOptions({ bandEndedMinutes: -5 }).bandEndedMinutes).toBe(0)
    expect(normalizeOptions({ bandEndedMinutes: 1441 }).bandEndedMinutes).toBe(1440)
    expect(normalizeOptions({ bandEndedMinutes: '1e9' }).bandEndedMinutes).toBe(1440)
  })

  test("what isn't a number is the default", () => {
    for (const v of ['ten', 'NaN', NaN, Infinity, true, null, [], {}]) expect({ v, m: normalizeOptions({ bandEndedMinutes: v }).bandEndedMinutes }).toEqual({ v, m: 10 })
  })

  test('the manifest declares it with the same default and range, a title and a description', () => {
    const f = manifest.userConfig.bandEndedMinutes
    expect(f).toEqual(expect.objectContaining({ type: 'number', default: BAND_ENDED_MINUTES.default, min: BAND_ENDED_MINUTES.min, max: BAND_ENDED_MINUTES.max }))
    expect(f?.title).toBeTruthy()
    expect(f?.description).toBeTruthy()
  })
})
