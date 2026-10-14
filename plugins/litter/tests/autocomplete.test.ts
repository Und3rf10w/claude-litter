// Tier 1 (WP-EC): `/litter`'s sections in the prompt box's typeahead, as the
// engine runs the mod's prompt.autocomplete hook. While the command's first
// argument is typed, the sections it starts come after the rows of the
// plugins beneath; any other prompt (another command, a later argument, text
// that only mentions /litter) reaches the hook beneath as it came, and
// litter adds nothing. The words and the matching are tier 2's
// (uicommands.spec.ts).

import type { PromptAutocompleteInput, PromptAutocompleteResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, test } from 'claude-code/testing'

/** The prompt box with the cursor at the end of `text`, its token the last word, as the engine raises it. */
const box = (text: string): PromptAutocompleteInput => {
  const start = text.search(/\S+$/)
  return { text, cursor: text.length, token: text.slice(start), start }
}

/**
 * The prompt box asking for its typeahead. The kit's `$.prompt` raises
 * prompt.autocomplete, though 2.1.299's d.ts lists it in no noun's calls (a
 * plugin's `$` can't raise it).
 */
const autocomplete = ($: Engine, e: PromptAutocompleteInput): Promise<PromptAutocompleteResult> =>
  ($.prompt as unknown as { autocomplete: (e: PromptAutocompleteInput) => Promise<PromptAutocompleteResult> }).autocomplete(e)

describe("/litter's typeahead", () => {
  test("the sections its first argument starts, after the rows beneath", async ($, on) => {
    on('prompt.autocomplete', async () => ({ suggestions: [{ text: 'beneath' }] }))
    expect(await autocomplete($, box('/litter r'))).toEqual({
      suggestions: [
        { text: 'beneath' },
        { text: 'runs', description: "Open litter's pane on Runs" },
        { text: 'rules', description: "Open litter's pane on Rules" },
      ],
    })
    expect((await autocomplete($, box('/litter St'))).suggestions.map(s => s.text)).toEqual(['beneath', 'stats'])
  })

  test('any other prompt passes on as it came, and litter adds nothing', async ($, on) => {
    const seen: unknown[] = []
    on('prompt.autocomplete', async (_$, e) => {
      seen.push({ ...e })
      return { suggestions: [{ text: '#123' }] }
    })
    const others = ['#12', '/clear r', '/litter runs e', '/litter runs', '/litter:execute r', 'see /litter r']
    for (const text of others) expect(await autocomplete($, box(text))).toEqual({ suggestions: [{ text: '#123' }] })
    expect(seen).toEqual(others.map(box))
  })
})
