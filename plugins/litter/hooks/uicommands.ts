// litter's one command (phase 5b, WP-DA): `/litter [section] [arg]`, which
// opens the `litter` pane on a section (ui/hub.ts, litterCommand). It
// replaces phase 3's and phase 5's six pane commands. Registered at
// session.start and again after a /clear (clear.ts), served by the
// command.run hook in register.tsx. Its sections are offered in the prompt
// box's typeahead while one is typed (WP-EC), by the prompt.autocomplete hook
// there.

import type { Hook, PromptAutocompleteInput, PromptAutocompleteSuggestion } from 'claude-code'
import type { Ports } from './ports'
import type { PortHook } from './hooktypes'
import { ARGUMENT_HINT, LABEL, SECTIONS } from './ui/hub'

export async function registerLitterCommand(p: Ports): Promise<void> {
  await p.registerCommand({
    name: 'litter',
    description: "Open litter's pane: Home, Runs, Swarms, Rules, Tasks, Agents, Stats or Doctor",
    argumentHint: ARGUMENT_HINT,
    immediate: true,
  })
}

type AutocompleteHook = Hook<'prompt.autocomplete'>

/** What stands before `/litter`'s first argument: the command and its spaces. */
const BEFORE_SECTION = /^\/litter\s+$/

/**
 * The sections `/litter` takes (ui/hub.ts's litterCommand) whose names start
 * with the token, when the token is the command's first argument, as a
 * section's name is typed; none for any other token or prompt, nor for a name
 * already typed in full.
 */
export function litterSuggestions(e: Readonly<PromptAutocompleteInput>): PromptAutocompleteSuggestion[] {
  if (!BEFORE_SECTION.test(e.text.slice(0, e.start))) return []
  const typed = e.token.toLowerCase()
  return SECTIONS.filter(id => id.startsWith(typed) && id !== typed).map(id => ({ text: id, description: `Open litter's pane on ${LABEL[id]}` }))
}

/**
 * prompt.autocomplete for a prompt litterSuggestions has rows for (register.tsx
 * passes every other on at once): the rows the plugins beneath gave, then
 * litter's.
 */
export const litterAutocomplete: PortHook<AutocompleteHook> = async (_p, e, next) => {
  const mine = litterSuggestions(e)
  return { suggestions: [...(await next(e)).suggestions, ...mine] }
}
