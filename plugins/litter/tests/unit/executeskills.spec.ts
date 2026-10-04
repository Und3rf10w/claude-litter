// Tier 2: skills/execute/SKILL.md and skills/amend/SKILL.md (litter-prompts.md
// :738-834 and :1011-1093, with PLAN-EDITS R1-R4), checked the way
// prompts.spec.ts checks the fanout skill: the frontmatter, the record tool
// loaded first, $ARGUMENTS and the plugin options' placement, and the
// decisions the text carries (the repair words, the halt routes, an amend
// that doesn't bridge).

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIRM_AUTO, CONFIRM_OFF } from '../../hooks/prompts/swarm-plan'

const PLUGIN = join(import.meta.dir, '..', '..')
const read = (name: string) => readFileSync(join(PLUGIN, 'skills', name, 'SKILL.md'), 'utf8')
const EXECUTE = read('execute')
const AMEND = read('amend')

function frontmatter(text: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!m) throw new Error('SKILL.md has no frontmatter')
  return Bun.YAML.parse(m[1]!) as Record<string, unknown>
}
const shellParts = (text: string): string[] => [
  ...[...text.matchAll(/^```[\s\S]*?^```/gm)].map(m => m[0]),
  ...[...text.matchAll(/!`[^`]*`/g)].map(m => m[0]),
  ...text.split('\n').filter(l => l.startsWith('!')),
]
const section = (text: string, from: string, to: string) => text.slice(text.indexOf(from), to ? text.indexOf(to) : undefined)

for (const [name, text] of [['execute', EXECUTE], ['amend', AMEND]] as const) {
  describe(`skills/${name}/SKILL.md, as every skill`, () => {
    test('stays well under the 5K tokens CC re-attaches whole after compaction', () => {
      expect(text.length).toBeLessThan(16_000)
    })

    test('its frontmatter names the skill, pre-approves only read-only tools, and pins no model', () => {
      const fm = frontmatter(text)
      expect(fm.name).toBe(name)
      expect(typeof fm.description).toBe('string')
      expect(typeof fm.when_to_use).toBe('string')
      expect(fm.model).toBeUndefined()
      expect(fm.effort).toBeUndefined()
      for (const t of fm['allowed-tools'] as string[]) expect(t).toMatch(/^(Read|Grep|Glob|Bash\(git (status|log|diff):\*\))$/)
      expect(text).not.toMatch(/\b(opus|sonnet|haiku)\b/i)
    })

    test('loads the record tool with ToolSearch before it records anything, and stops without it', () => {
      const at = text.indexOf('select:mcp__litter__record')
      expect(at).toBeGreaterThan(0)
      expect(text.slice(0, at)).toContain('ToolSearch')
      expect(text).toContain("If it isn't found, stop")
      expect(at).toBeLessThan(text.indexOf("kind: 'run.find'"))
      expect(at).toBeLessThan(text.indexOf("kind: 'run.start'"))
    })

    test('$ARGUMENTS appears once, in <request>, never in a shell block', () => {
      expect(text.split('$ARGUMENTS').length - 1).toBe(1)
      expect(text).toContain('<request>\n$ARGUMENTS\n</request>')
      for (const part of shellParts(text)) expect(part).not.toContain('$ARGUMENTS')
    })

    test('uses ${user_config.*} only to show a configured value, never in a record or a shell block', () => {
      for (const l of text.split('\n').filter(x => x.includes('${user_config.'))) {
        expect(l).not.toContain('kind:')
        expect(l).toMatch(/configured/)
      }
      for (const part of shellParts(text)) expect(part).not.toContain('${user_config.')
    })

    test('launches litter:execute-run by name with the args run.start returned, and never commits or pushes itself', () => {
      expect(text).toContain("`name: 'litter:execute-run'`")
      expect(text).toContain("Don't commit, push or open a pull request yourself")
      expect(text).toContain('Never start another run on your own.')
    })
  })
}

describe('skills/execute/SKILL.md', () => {
  const settings = section(EXECUTE, '## 3. Settings', '## 4. Launch')

  test("the confirmation states the repair setting in AC's words, slots filled as N, M and A, with the configured values and the override", () => {
    const auto = CONFIRM_AUTO.replace('{rounds}', 'N').replace('{attempts}', 'M').replace('{agents}', 'A')
    expect(auto).not.toContain('{')
    expect(settings).toContain(`\`auto\`: "${auto}".`)
    expect(settings).toContain(`\`off\`: "${CONFIRM_OFF}".`)
    expect(settings).toContain('The configured setting is `${user_config.repair}` with `${user_config.repairRounds}` rounds and `${user_config.repairAgents}` agents')
    expect(settings).toContain('`repair off`')
    expect(settings).toContain('with N the rounds, M the max attempts per gate and A the agents')
  })

  test('the launch passes a one-run override as repair, repairRounds and repairAgents', () => {
    const launch = section(EXECUTE, '## 4. Launch', '## 5. While it runs')
    expect(launch).toContain("{ kind: 'run.start', workflow: 'execute', planPath, verify, authorized, maxAttempts, adversary, runRules }")
    expect(launch).toContain('and `repair`, `repairRounds` or `repairAgents` when the user changed them for this run')
  })

  test("the rules shown before Launch come from rule.find's applicable, and a refusal says there's no rule selection yet", () => {
    expect(settings).toContain("{ kind: 'rule.find', applicable: { workflow: 'execute', planPath } }")
    expect(settings).toContain('say "no rule selection yet" and go on')
    expect(settings.indexOf('**Rules.**')).toBeLessThan(settings.indexOf('ask for an explicit "Launch"'))
  })

  // T4-1: a decision left in the interview was asked again mid-run, and its gate halted on it.
  test("a decision on a plan problem goes into runRules; one that changes a gate's Files doesn't, and is a plan edit or an amend", () => {
    const decisions = section(settings, '**Problems you found in the plan.**', '**If a gate halts.**')
    expect(decisions).toContain('add that decision to `runRules` in their words, naming the gate and what they chose')
    expect(decisions).toContain("isn't a run rule: the critic still holds each gate to its `Files:`")
    expect(decisions).toContain('/litter:amend')
    expect(section(EXECUTE, '## 4. Launch', '## 5. While it runs')).toContain('the constraints and plan decisions the user stated for this run (section 3)')
  })

  // WP-AO: only the user's answer in the mod's dialog adds files to a gate.
  test("a file outside a gate's Files goes into widenings, which the mod confirms itself; the widen setting is stated in the mod's words", () => {
    const decisions = section(settings, '**Problems you found in the plan.**', '**If a gate halts.**')
    expect(decisions).toContain('put them in `widenings` as `{ gate, files, why }`')
    expect(decisions).toContain("a yes given to you here doesn't add them by itself")
    expect(decisions).toContain('`${user_config.widen}`')
    expect(decisions).toContain('"only you add files to a gate\'s Files during this run, in a dialog litter shows you"')
    expect(section(EXECUTE, '## 4. Launch', '## 5. While it runs')).toContain('`widen` when they changed it, and `widenings` when they asked for any')
    const routes = section(EXECUTE, '## 7. When the run finishes', '')
    expect(routes).toContain("{ kind: 'gate.widen', run, gate, files, why }")
    expect(routes).toContain("don't take a yes in this conversation as the widening")
    expect(AMEND).toContain("If the only change is letting the gate change files outside its `Files:`, an amendment isn't needed")
  })

  test('goal mode plans in litter:plan-run, then writes the approved gates with plan.write', () => {
    const goal = section(EXECUTE, '## 6. Goal mode', '## 7. When the run finishes')
    expect(goal).toContain("workflow: 'plan'")
    expect(goal).toContain('`litter:plan-run`')
    expect(goal).toContain("{ kind: 'plan.write', run, gates }")
  })

  test('a halt follows decision 5: under auto it reports the swarm; under off it offers the swarm, amend or stop, in that order; a re-split only when asked', () => {
    const end = section(EXECUTE, '## 7. When the run finishes', '')
    const took = end.slice(end.indexOf('**A gate halted, and a repair swarm took over**'))
    expect(took).toContain('/litter-swarm `<name>` shows it. Don\'t start it yourself or offer other routes.')
    const routes = end.slice(end.indexOf('**A gate halted, and nothing took over**'))
    expect(routes).toContain('offer with AskUserQuestion')
    const order = ["{ kind: 'repair.start', run }", 'amend that gate with /litter:amend', 'stop and leave the last attempt in the tree'].map(s => routes.indexOf(s))
    expect(order.every(i => i > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(routes).toContain('recommended when the Repair part says so')
    expect(routes).toContain('If two gates of this plan have already been amended, recommend /litter:design instead.')
    expect(routes).toContain('If the user asks to re-split the remaining gates')
    expect(end).toContain('Quote the critic\'s evidence from its verdict file')
  })
})

describe('skills/amend/SKILL.md', () => {
  test("the settings say an amend's halt stops and keeps everything (decision 13)", () => {
    const settings = section(AMEND, '## 6. Settings', '## 7. Launch')
    expect(settings).toContain('Show the settings, with "if it halts, it stops and keeps everything", confirm them, and ask for an explicit "Launch".')
    expect(AMEND).not.toContain('repair.start')
  })

  test('records gate.amend, then run.start with amendOf, and recommends /litter:design when the gate halts again', () => {
    const launch = section(AMEND, '## 7. Launch', '## 8. While it runs')
    const amend = launch.indexOf("{ kind: 'gate.amend', run: <original run>, gate, before, after, reason }")
    const start = launch.indexOf("{ kind: 'run.start', workflow: 'execute', amendOf: { run, gate }, carryOver, verify, authorized, maxAttempts, adversary }")
    expect(amend).toBeGreaterThan(0)
    expect(start).toBeGreaterThan(amend)
    expect(AMEND).toContain('**The gate halted again:** recommend /litter:design over another amendment of the same gate.')
  })
})
