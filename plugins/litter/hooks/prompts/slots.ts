// The swarm prompts' slot filler (litter-prompts.md, "Swarm prompts": "How the
// mod renders them"). Plain string replacement, never a template literal, so
// the prompts' sources keep the no-backtick, no-dollar-brace rule.
//
// Contract owner: phase 2b-1, package C.

/** A slot's value: a string or number is inserted as it is; null, undefined or '' drops the slot's whole line. */
export type SlotValues = Readonly<Record<string, string | number | null | undefined>>

/** A slot: `{name}`, lowercase letters, digits and underscores. */
const SLOT = /\{([a-z][a-z0-9_]*)\}/g

/**
 * Fills each `{name}` slot of `template` from `values`.
 *  - A value is data: inserted as it is, never read for slots or patterns of its own.
 *  - A slot whose value is null, undefined or empty drops its whole line (an unset field renders as nothing, with its line).
 *  - A slot `values` doesn't name is an error, thrown before anything is rendered, so a missed slot can't reach a model.
 */
export function renderSlots(template: string, values: SlotValues): string {
  for (const m of template.matchAll(SLOT)) {
    if (!Object.hasOwn(values, m[1]!)) throw new Error(`litter: the prompt's slot {${m[1]}} has no value`)
  }
  const out: string[] = []
  for (const line of template.split('\n')) {
    let unset = false
    const rendered = line.replace(SLOT, (_slot, name: string) => {
      const v = values[name]
      if (v === null || v === undefined || v === '') {
        unset = true
        return ''
      }
      return String(v)
    })
    if (!unset) out.push(rendered)
  }
  return out.join('\n')
}
