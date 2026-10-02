// Tier 4's stand-in for litter:execute (phase 1 ships no workflows), for the
// land check: the executor writes gate G1's file, the gate critic records a
// verify and returns its verdict, a pause gives land.sh the time to edit the
// checkout out of band, and the relay records the land. lib.sh copies it into
// the scratch plugin as workflows/execute.js.
export const meta = {
  name: 'execute',
  description: 'litter tier-4 probe: verify, a verdict, a pause, then land',
  phases: [{ title: 'Probe' }],
}

phase('Probe')

const PASS = { type: 'object', properties: { pass: { type: 'boolean' }, evidence: { type: 'string' } }, required: ['pass', 'evidence'] }
const VERDICT = {
  type: 'object',
  properties: {
    verify_id: { type: 'string' },
    plan_adherence: PASS,
    tests_green: PASS,
    no_regressions: PASS,
    plan_gap: { type: 'string' },
    proposed_rules: { type: 'array', items: { type: 'string' } },
  },
  required: ['verify_id', 'plan_adherence', 'tests_green', 'no_regressions', 'plan_gap', 'proposed_rules'],
}

const steps = (...lines) =>
  'You are a tier-4 test probe, not doing real work. Make exactly these tool calls, in order, ' +
  "and don't retry or work around a refusal:\n" + lines.map((l, i) => `${i + 1}. ${l}`).join('\n')

await agent(
  steps('Bash: pwd', 'Write the file a.txt in the folder step 1 printed (absolute path), with the content "done"', 'Reply with DONE'),
  { agentType: 'litter:executor', label: 'executor' },
)
// The critic judges for real: told to pass a verdict it hasn't checked, it fails it, as its role says (tier 4, live).
const gate = (args?.gates ?? [])[0] ?? {}
const verdict = await agent(
  'Judge gate G1 of this run. The gate, from the plan:\n' +
    `<gate>\n${gate.excerpt ?? ''}\n</gate>\n` +
    'The executor has written the gate\'s file in the checkout, your working directory. First record a verify with ' +
    'mcp__litter__record and the input {"kind": "verify", "gate": "G1", "attempt": 1}. Then check the change against ' +
    'the gate (git status, git diff, the file itself), and return your verdict with the verify_id the verify gave.',
  { agentType: 'litter:gate-critic', label: 'critic', schema: VERDICT },
)
await agent(steps('Bash: sleep 60', 'Reply with DONE'), { agentType: 'litter:researcher', label: 'pause' })
const landed = await agent(
  steps(
    `Call mcp__litter__record with the input {"kind": "land", "gate": "G1", "verify_id": "${verdict.verify_id}"}`,
    'Reply with its result, verbatim',
  ),
  { agentType: 'litter:relay', label: 'relay' },
)

return { halted: null, verify_id: verdict.verify_id, landed }
