// Observed fields for StructuredOutput (plan section 9, "Observed facts beat
// claimed ones"). Owner: phase 1b, work package B.
//
// A handler that observed something an agent will return (a verify's exit code,
// a land's commit, a proposal's text) calls writeOut before it answers, so
// output.sh finds out/<agent_id>.json when the agent returns. consumeOutput
// records each spooled StructuredOutput result in the ledger, so a verdict
// needn't be recorded twice.

import type { Ports } from './ports'
import type { OutFile, SpoolConsumer } from './hookfiles'

export async function writeOut(_p: Ports, _litterDir: string, _out: OutFile): Promise<void> {
  throw new Error('output.writeOut: not built yet (phase 1b, B)')
}

export const consumeOutput: SpoolConsumer = async () => {}
