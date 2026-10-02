// The static allowlist (plan section 12): reads `claude plugin validate --json`
// on stdin and fails unless every tool.call hook the mod registers has a
// literal `tool` matcher naming Workflow, TaskStop or one of litter's own
// mcp__litter__* tools. A broad, glob or RegExp tool.call hook would break
// every isolated agent it matches, so this runs in CI on every change.
//
//   claude plugin validate --json plugins/litter | bun plugins/litter/tests/unit/allowlist.ts

export {}

const ALLOWED = /^(Workflow|TaskStop|mcp__litter__[a-z_]+)$/

type Validate = { contents?: { type?: string; notes?: string[] }[] }

const input = (await Bun.stdin.text()).trim()
const report = JSON.parse(input) as Validate
const problems: string[] = []
let seen = 0

for (const content of report.contents ?? []) {
  if (content.type !== 'hooks') continue
  for (const note of content.notes ?? []) {
    const m = /^(\S+) hooks: (.*)$/.exec(note)
    if (!m) continue
    seen++
    // Split on the commas between entries, not inside a matcher's braces.
    const hooks = m[2]!.split(/,\s*(?![^{]*\})/).map(h => h.trim())
    for (const hook of hooks) {
      if (hook === '*' || /\.\*$/.test(hook)) problems.push(`${m[1]}: a glob hook (${hook})`)
      if (!hook.startsWith('tool.call')) continue
      const tool = /^tool\.call\{tool=([^}]*)\}$/.exec(hook)?.[1]
      if (tool === undefined) problems.push(`${m[1]}: a tool.call hook without a literal tool matcher (${hook})`)
      else if (!ALLOWED.test(tool)) problems.push(`${m[1]}: tool.call on ${tool}, which isn't in the allowlist`)
    }
  }
}

if (seen === 0) problems.push('no "hooks:" note in the validate report: has its format changed?')
if (problems.length > 0) {
  for (const p of problems) console.error(`allowlist: ${p}`)
  process.exit(1)
}
console.log(`allowlist: ok (${seen} module${seen === 1 ? '' : 's'})`)
