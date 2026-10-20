// The static allowlist (plan section 12): reads `claude plugin validate --json`
// on stdin and fails unless every tool.call hook the mod registers has a
// literal `tool` matcher naming Workflow, TaskStop or one of litter's own
// mcp__litter__* tools. A broad, glob or RegExp tool.call hook would break
// every isolated agent it matches, so this runs in CI on every change.
//
// Phase 5 (WP-CA; COMMON decision 14): the tool.call hooks are exactly the six
// in TOOL_CALL_HOOKS, none new, and every ui.* and command.run hook names a
// matcher (a ui.render, its component). validate cuts each note at 1000
// characters (2.1.289) and register.tsx's hooks note runs past that, so the
// hooks are read from the module's source as well, after a check that the
// source reads as validate's note does as far as the note goes.
//
//   claude plugin validate --json plugins/litter | bun plugins/litter/tests/unit/allowlist.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ALLOWED = /^(Workflow|TaskStop|mcp__litter__[a-z_]+)$/
/** Every tool.call hook the mod has, each once (decision 14): another is a contract change. */
const TOOL_CALL_HOOKS = ['mcp__litter__record', 'mcp__litter__swarm_propose', 'mcp__litter__swarm_read', 'mcp__litter__swarm_send', 'Workflow', 'TaskStop']
/** How validate ends a note it cut. */
const CUT = /…\s*\[\+\d+ chars\]$/
/** hooks.json's folder, which a module's path in the note is relative to. */
const HOOKS_DIR = join(import.meta.dir, '..', '..', 'hooks')

type Validate = { contents?: { type?: string; notes?: string[] }[] }

const input = (await Bun.stdin.text()).trim()
const report = JSON.parse(input) as Validate
const problems: string[] = []
let seen = 0

/** A note's entries: split on the commas between them, not inside a matcher's braces. */
const entriesOf = (list: string): string[] =>
  list
    .split(/,\s*(?![^{]*\})/)
    .map(h => h.trim())
    .filter(h => h !== '')

/**
 * The module's `on(...)` calls in validate's spelling: `event`, or
 * `event{key=value, key=a|b}` for a matcher of string literals and arrays of
 * them. Anything else in a matcher (a RegExp, a name) reads `event{?…}`, which
 * no check below takes as literal. Comment lines are skipped.
 */
function sourceHooks(text: string): string[] {
  const code = text
    .split('\n')
    .filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join('\n')
  const out: string[] = []
  for (const m of code.matchAll(/(?<![.\w])on\(\s*'([^']+)'\s*,\s*(?:(\{[^{}]*\})\s*,)?/g)) {
    const event = m[1]!
    if (m[2] === undefined) {
      out.push(event)
      continue
    }
    const body = m[2].slice(1, -1)
    const parts: string[] = []
    const rest = body.replace(/(\w+)\s*:\s*(?:'([^']*)'|\[([^\]]*)\])/g, (_all, key: string, one?: string, many?: string) => {
      const values = one !== undefined ? [one] : [...many!.matchAll(/'([^']*)'/g)].map(v => v[1]!)
      parts.push(`${key}=${values.join('|')}`)
      return ''
    })
    out.push(rest.replace(/[\s,]/g, '') === '' ? `${event}{${parts.join(', ')}}` : `${event}{?${body.trim()}}`)
  }
  return out
}

/** The checks on one module's hooks, each in validate's spelling. */
function check(module: string, hooks: readonly string[]): void {
  const tools: string[] = []
  for (const hook of hooks) {
    if (hook === '*' || hook.includes('*')) problems.push(`${module}: a glob hook (${hook})`)
    const event = /^[^{]+/.exec(hook)?.[0] ?? hook
    const matcher = /\{(.*)\}$/.exec(hook)?.[1]
    if (event === 'tool.call') {
      const tool = /^tool\.call\{tool=([^}|?]*)\}$/.exec(hook)?.[1]
      if (tool === undefined) problems.push(`${module}: a tool.call hook without a literal tool matcher (${hook})`)
      else if (!ALLOWED.test(tool)) problems.push(`${module}: tool.call on ${tool}, which isn't in the allowlist`)
      else tools.push(tool)
    } else if (event.startsWith('ui.')) {
      // Decision 14: no matcher-less ui hook; a render names its component (Pane with its requestId, AbovePrompt, UserMessage).
      if (matcher === undefined || matcher === '') problems.push(`${module}: a ${event} hook with no matcher (${hook})`)
      else if (event === 'ui.render' && !/(^|, )component=/.test(matcher)) problems.push(`${module}: a ui.render hook that names no component (${hook})`)
      else if (event !== 'ui.render' && !/(^|, )(requestId|component)=/.test(matcher)) problems.push(`${module}: a ${event} hook that names no requestId or component (${hook})`)
    } else if (event === 'command.run' && !/^command\.run\{command=[^,|?]+\}$/.test(hook)) {
      problems.push(`${module}: a command.run hook without one literal command (${hook})`)
    }
  }
  const extra = tools.filter((t, i) => !TOOL_CALL_HOOKS.includes(t) || tools.indexOf(t) !== i)
  const missing = TOOL_CALL_HOOKS.filter(t => !tools.includes(t))
  for (const t of extra) problems.push(`${module}: a new tool.call hook on ${t} (COMMON decision 14: none is added)`)
  for (const t of missing) problems.push(`${module}: no tool.call hook on ${t}: has its matcher changed?`)
}

for (const content of report.contents ?? []) {
  if (content.type !== 'hooks') continue
  for (const note of content.notes ?? []) {
    const m = /^(\S+) hooks: (.*)$/.exec(note)
    if (!m) continue
    seen++
    const module = m[1]!
    const cut = CUT.test(m[2]!)
    const listed = entriesOf(m[2]!.replace(CUT, ''))
    // The entry the cut went through is partial.
    if (cut) listed.pop()
    let text: string
    try {
      text = readFileSync(join(HOOKS_DIR, module), 'utf8')
    } catch (err) {
      problems.push(`${module}: its source can't be read (${err instanceof Error ? err.message : String(err)})`)
      check(module, listed)
      continue
    }
    const found = sourceHooks(text)
    const agrees = cut ? listed.every((h, i) => found[i] === h) && found.length >= listed.length : listed.length === found.length && listed.every((h, i) => found[i] === h)
    if (!agrees) {
      const at = listed.findIndex((h, i) => found[i] !== h)
      const where = at >= 0 ? ` at entry ${at + 1} (${listed[at]} there, ${found[at] ?? 'nothing'} here)` : ` (${listed.length} entries there, ${found.length} here)`
      problems.push(`${module}: its source reads otherwise than validate's note${where}: has its style changed?`)
    }
    check(module, found)
  }
}

if (seen === 0) problems.push('no "hooks:" note in the validate report: has its format changed?')
if (problems.length > 0) {
  for (const p of problems) console.error(`allowlist: ${p}`)
  process.exit(1)
}
console.log(`allowlist: ok (${seen} module${seen === 1 ? '' : 's'})`)
