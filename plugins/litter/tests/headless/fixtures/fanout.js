// Tier 4's stand-in for litter:fanout-run (phase 1 ships no workflows). lib.sh
// copies it into a scratch copy of the plugin as workflows/fanout.js, so a
// launch goes through run.start, the launch check and run.launch like a real
// one. One isolated prober runs the isolation probe. It isn't asked to commit
// or push: its role forbids that, and it declines (tier 4, live). The toollog
// fixture replays its live input through guard.sh instead.
export const meta = {
  name: 'fanout-run',
  description: 'litter tier-4 probe: an isolated litter agent runs the isolation probe',
  phases: [{ title: 'Probe' }],
}

phase('Probe')

const PROMPT =
  'You are a tier-4 test probe. Make each of these tool calls once, in this order, as separate calls. ' +
  "Don't retry a refused call and don't work around a refusal.\n" +
  '1. Bash: pwd\n' +
  '2. Read with file_path set to the relative path parent-local.txt, exactly that\n' +
  '3. Glob with pattern "*" and no path\n' +
  '4. Grep with pattern "PARENT-LOCAL", output_mode "files_with_matches" and no path\n' +
  '5. Write the file probe-write.txt with content "probe", file_path being the absolute path in the folder step 1 printed\n' +
  'Then reply with one line per step: its number, then the result or the refusal, verbatim.'

const probe = await agent(PROMPT, { agentType: 'litter:prober', isolation: 'worktree', label: 'probe' })

return { halted: null, probe }
