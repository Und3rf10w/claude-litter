// Tier 2: the rules ledgers (decision 17), one chain per store through
// ledgercore: the repository's under litterDir, yours under the config dir.
// An edited, an inserted and a removed record each break the chain, and a
// broken chain stops every step on its store: no append, no acceptance in
// it counts, and its proposals aren't listed.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { LedgerTampered } from '../../hooks/ledgercore'
import { RULES_LEDGER_RUN } from '../../hooks/layout'
import { appendRuleRecord, readRuleLedger, ruleLedgerDir } from '../../hooks/rules/ledger'
import { acceptRule, dismissRule, loadRules, proposalsOf } from '../../hooks/rules/store'
import { fakePatterns, propose, ruleDoc, rulesWorld, writeRuleFile, type RulesWorld } from './rules-harness'

let w: RulesWorld
let restore: () => void
beforeEach(async () => {
  restore = fakePatterns()
  w = await rulesWorld()
})
afterEach(() => {
  restore()
  w.cleanup()
})

const mod = { source: 'mod' } as const
const repoFiles = () => readdirSync(`${w.litterDir}/rules-ledger/ledger`).sort()
const repoFile = (name: string) => `${w.litterDir}/rules-ledger/ledger/${name}`

/** Three records in the repository's chain. */
async function three(): Promise<void> {
  await appendRuleRecord(w.p, w.litterDir, 'repo', 'rule.propose', mod, { rule: 'one', source: 'user' })
  await appendRuleRecord(w.p, w.litterDir, 'repo', 'rule.propose', mod, { rule: 'two', source: 'user' })
  await appendRuleRecord(w.p, w.litterDir, 'repo', 'rule.open', mod, { proposal: { store: 'repo', seq: 2 } })
}

describe('the two chains', () => {
  test("the repository's is litterDir/rules-ledger/ledger, with the run name rules", async () => {
    await three()
    expect(repoFiles()).toEqual(['000001-rule.propose.json', '000002-rule.propose.json', '000003-rule.open.json'])
    const { records, tampered } = await readRuleLedger(w.p, w.litterDir, 'repo')
    expect(tampered).toBeNull()
    expect(records.map(r => [r.seq, r.kind, r.run])).toEqual([
      [1, 'rule.propose', RULES_LEDGER_RUN],
      [2, 'rule.propose', RULES_LEDGER_RUN],
      [3, 'rule.open', RULES_LEDGER_RUN],
    ])
    expect(records[1]!.prev).toMatch(/^[0-9a-f]{64}$/)
    expect(await ruleLedgerDir(w.p, w.litterDir, 'repo')).toBe(`${w.litterDir}/rules-ledger`)
  })

  test("yours is under the config dir, its own chain, shared by every repository", async () => {
    await three()
    const rec = await appendRuleRecord(w.p, w.litterDir, 'user', 'rule.retire', mod, { id: 'U-x', version: 1, via: 'ui' })
    expect(rec.seq).toBe(1)
    expect(existsSync(`${w.config}/litter/rules-ledger/ledger/000001-rule.retire.json`)).toBe(true)
    // Another repository's litterDir reads the same chain.
    const other = await readRuleLedger(w.p, `${w.repo}-elsewhere/.claude/litter`, 'user')
    expect(other.records.map(r => r.kind)).toEqual(['rule.retire'])
    expect((await readRuleLedger(w.p, w.litterDir, 'repo')).records).toHaveLength(3)
  })

  test('without a config dir, your chain is refused and the repository keeps working', async () => {
    w.p.configDirValue = null
    await expect(appendRuleRecord(w.p, w.litterDir, 'user', 'rule.retire', mod, { id: 'U-x', version: 1, via: 'ui' })).rejects.toThrow()
    await three()
    const { problems } = await loadRules(w.p, w.litterDir)
    expect(problems.some(x => x.startsWith("your user rules aren't read:"))).toBe(true)
  })
})

describe('a broken chain', () => {
  test('an edited record breaks it at the record that chains to it', async () => {
    await three()
    const second = repoFile('000002-rule.propose.json')
    writeFileSync(second, `${JSON.stringify({ ...JSON.parse(readFileSync(second, 'utf8')), body: { rule: 'forged', source: 'user' } })}\n`)
    expect((await readRuleLedger(w.p, w.litterDir, 'repo')).tampered).toEqual({ seq: 3, reason: "record 000003-rule.open.json doesn't chain to the record before it" })
  })

  test('the head itself edited breaks it at its seq', async () => {
    await three()
    const last = repoFile('000003-rule.open.json')
    writeFileSync(last, `${JSON.stringify({ ...JSON.parse(readFileSync(last, 'utf8')), body: { id: 'P-forged' } })}\n`)
    expect((await readRuleLedger(w.p, w.litterDir, 'repo')).tampered).toEqual({ seq: 3, reason: "record 000003-rule.open.json isn't the record the head names" })
  })

  test('an inserted record breaks it where the records stop matching their places', async () => {
    await three()
    // A forged accept copied from record 2, so it chains to record 1 and takes seq 2's place.
    const copy = { ...JSON.parse(readFileSync(repoFile('000002-rule.propose.json'), 'utf8')), kind: 'rule.accept', body: { id: 'P-forged', version: 1, via: 'ui' } }
    writeFileSync(repoFile('000002-rule.accept.json'), `${JSON.stringify(copy)}\n`)
    expect((await readRuleLedger(w.p, w.litterDir, 'repo')).tampered).toEqual({ seq: 3, reason: "record 000002-rule.propose.json doesn't match its place in the ledger" })
  })

  test('a removed record breaks it at its seq, in the middle or at the end', async () => {
    await three()
    const third = readFileSync(repoFile('000003-rule.open.json'), 'utf8')
    unlinkSync(repoFile('000003-rule.open.json'))
    expect((await readRuleLedger(w.p, w.litterDir, 'repo')).tampered).toEqual({ seq: 3, reason: 'the ledger ends at 2, but its head is 3' })
    writeFileSync(repoFile('000003-rule.open.json'), third)
    unlinkSync(repoFile('000002-rule.propose.json'))
    expect((await readRuleLedger(w.p, w.litterDir, 'repo')).tampered?.seq).toBe(2)
  })

  test('stops every step on its store: no append, no accept or dismiss, no proposals listed, no acceptance counted', async () => {
    const ref = await propose(w, { rule: 'Keep each test beside the code it covers.', scope: 'local' })
    const accepted = await acceptRule(w.p, w.litterDir, { proposal: ref })
    expect(accepted.ok).toBe(true)
    const pending = await propose(w, { rule: 'Name fixtures after what they hold.', scope: 'local' })
    expect((await loadRules(w.p, w.litterDir)).rules.map(r => r.standing)).toEqual(['accepted'])

    const first = repoFile('000001-rule.propose.json')
    writeFileSync(first, readFileSync(first, 'utf8').replace('beside', 'near'))
    await expect(appendRuleRecord(w.p, w.litterDir, 'repo', 'rule.open', mod, { id: 'L-x' })).rejects.toBeInstanceOf(LedgerTampered)
    const { rules, problems } = await loadRules(w.p, w.litterDir)
    expect(rules.map(r => [r.standing, r.delivered])).toEqual([['unverified', null]])
    expect(rules[0]!.why).toStartWith('the rules ledger is tampered at record 2')
    expect(problems.some(x => x.startsWith("the repository's rules ledger is tampered at record 2"))).toBe(true)
    expect(await proposalsOf(w.p, w.litterDir, {})).toEqual([])
    expect(await dismissRule(w.p, w.litterDir, pending)).toEqual({ ok: false, reason: expect.stringContaining('the repo rules ledger is tampered at record 2') })
    expect(await acceptRule(w.p, w.litterDir, { proposal: pending })).toEqual({ ok: false, reason: expect.stringContaining('tampered') })
  })

  test("a committed project rule doesn't depend on the chain, so it stays accepted (committed)", async () => {
    await writeRuleFile(w, 'project', ruleDoc('P-committed', 'Run tier 3 before touching a hook script.'))
    await w.git('add', '.litter')
    await w.git('commit', '-q', '-m', 'a rule')
    await three()
    const second = repoFile('000002-rule.propose.json')
    writeFileSync(second, readFileSync(second, 'utf8').replace('two', 'forged'))
    const { rules } = await loadRules(w.p, w.litterDir)
    expect(rules.map(r => [r.doc.id, r.standing])).toEqual([['P-committed', 'accepted (committed)']])
  })
})
