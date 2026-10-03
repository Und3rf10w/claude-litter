// Tier 2: the swarm's fake ports (tests/unit/support/node-ports.ts; WP-C §1):
// each records its calls and answers as its comment says, a spec can set an
// answer after the ports were made, and they refuse what the real ports
// refuse (a submit outside a timer callback, a settings file that's missing).

import { describe, expect, test } from 'bun:test'
import { fireEvery, nodePorts, runAfters, SUBMIT_REFUSED } from './support/node-ports'

describe('the swarm fakes', () => {
  test('listAgents answers a copy of agents, changed between calls', async () => {
    const p = nodePorts()
    expect(await p.listAgents()).toEqual([])
    p.agents = [{ id: 'a1', description: 'd', type: 'litter:sw-x-y', status: 'running' }]
    const got = await p.listAgents()
    expect(got.map(a => a.id)).toEqual(['a1'])
    got.pop()
    expect(p.agents.length).toBe(1)
    p.agents[0]!.status = 'completed'
    expect((await p.listAgents())[0]!.status).toBe('completed')
  })

  test('send records each call and answers delivered unless sendAnswer says otherwise', async () => {
    const p = nodePorts()
    expect(await p.send('a1', 'hi')).toEqual({ isDelivered: true })
    p.sendAnswer = to => ({ isDelivered: false, reason: `no ${to}` })
    expect(await p.send('a2', 'yo')).toEqual({ isDelivered: false, reason: 'no a2' })
    expect(p.sent).toEqual([
      { to: 'a1', text: 'hi' },
      { to: 'a2', text: 'yo' },
    ])
  })

  test('send goes through sendHook when a spec sets it, with the delivery beneath as its next', async () => {
    const p = nodePorts()
    const seen: string[] = []
    p.sendAnswer = to => ({ isDelivered: false, reason: `no ${to}` })
    p.sendHook = async (to, text, deliver) => {
      seen.push(`${to}: ${text}`)
      if (to === 'node-1') return { isDelivered: false, reason: 'queued' }
      return deliver(to === 'old' ? 'new' : to, text)
    }
    expect(await p.send('node-1', 'hi')).toEqual({ isDelivered: false, reason: 'queued' })
    expect(await p.send('old', 'yo')).toEqual({ isDelivered: false, reason: 'no new' })
    expect(seen).toEqual(['node-1: hi', 'old: yo'])
    expect(p.sent).toEqual([
      { to: 'node-1', text: 'hi' },
      { to: 'old', text: 'yo' },
    ])
    p.sendAnswer = undefined
    expect(await p.send('main', 'up')).toEqual({ isDelivered: true })
  })

  test('appendUserRow and fillPrompt record their texts; fillAnswer can refuse', async () => {
    const p = nodePorts()
    await p.appendUserRow('row')
    expect(await p.fillPrompt('draft')).toBe(true)
    p.fillAnswer = () => false
    expect(await p.fillPrompt('again')).toBe(false)
    expect(p.appended).toEqual(['row'])
    expect(p.filled).toEqual(['draft', 'again'])
  })

  test("submitPrompt is taken only in a timer callback, as the host's is; elsewhere it rejects and isn't recorded", async () => {
    const p = nodePorts()
    await expect(p.submitPrompt('from a hook')).rejects.toThrow(SUBMIT_REFUSED)
    expect(SUBMIT_REFUSED).toStartWith('prompt.submit: called from a tool.call hook')
    // Through an await inside the callback too.
    p.after(0, async () => {
      await Promise.resolve()
      await p.submitPrompt('from after')
    })
    await runAfters(p)
    const tick = async () => {
      await new Promise<void>(r => setTimeout(r, 0))
      await p.submitPrompt('from every')
    }
    p.every(1000, tick)
    expect(await fireEvery(p)).toBe(1)
    // The callback's context ends with it.
    await expect(p.submitPrompt('after the timer')).rejects.toThrow(SUBMIT_REFUSED)
    p.submitAnywhere = true
    await p.submitPrompt('from turn.complete')
    p.submitAnswer = text => {
      throw new Error(`the host refused ${text}`)
    }
    await expect(p.submitPrompt('two')).rejects.toThrow('the host refused two')
    expect(p.submitted).toEqual(['from after', 'from every', 'from turn.complete', 'two'])
  })

  test("messages answers transcripts by agentId, main for the lead's; an unknown agent is null", async () => {
    const p = nodePorts()
    expect(await p.messages()).toEqual([])
    expect(await p.messages('a1')).toBeNull()
    const row = { role: 'assistant', text: 'done', toolUses: [] } as never
    p.transcripts.main = [row]
    p.transcripts.a1 = [row, row]
    expect((await p.messages())?.length).toBe(1)
    expect((await p.messages('a1'))?.length).toBe(2)
  })

  test('complete records the request and rejects unless completeAnswer is set', async () => {
    const p = nodePorts()
    const req = { model: 'm', prompt: 'q', system: 's' }
    await expect(p.complete(req)).rejects.toThrow('no model in tier 2')
    p.completeAnswer = r => ({ isAnswered: true, text: `re: ${r.prompt}`, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) as never
    expect(await p.complete(req)).toEqual(expect.objectContaining({ isAnswered: true, text: 're: q' }))
    expect(p.completions).toEqual([req, req])
  })

  test('callTool records the call and rejects unless toolAnswer is set', async () => {
    const p = nodePorts()
    await expect(p.callTool('TaskStop', { task_id: 'a1' })).rejects.toThrow('no tool in tier 2 (TaskStop)')
    p.toolAnswer = () => ({ result: 'stopped' }) as never
    expect(await p.callTool('TaskStop', { task_id: 'a2' })).toEqual({ result: 'stopped' } as never)
    expect(p.toolCalls).toEqual([
      { tool: 'TaskStop', input: { task_id: 'a1' } },
      { tool: 'TaskStop', input: { task_id: 'a2' } },
    ])
  })

  test('sleep records its ms, advances the fake clock, calls onSleep, and yields a macrotask without waiting', async () => {
    const p = nodePorts()
    p.clock.now = 1000
    const seen: number[] = []
    p.onSleep = ms => seen.push(ms)
    let other = false
    setTimeout(() => (other = true), 0)
    const started = Date.now()
    await p.sleep(60_000)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(other).toBe(true)
    expect(p.clock.now).toBe(61_000)
    expect(p.sleeps).toEqual([60_000])
    expect(seen).toEqual([60_000])
    // Without the fake clock, real time stays as it is.
    const q = nodePorts()
    await q.sleep(5)
    expect(q.clock.now).toBeNull()
  })

  test('after records each timer, and nothing runs until runAfters; cancelled ones never run', async () => {
    const p = nodePorts()
    const ran: string[] = []
    p.after(0, () => void ran.push('a'))
    const b = p.after(10, () => void ran.push('b'))
    p.after(5, async () => {
      await Promise.resolve()
      ran.push('c')
      p.after(0, () => void ran.push('d'))
    })
    b.cancel()
    expect(ran).toEqual([])
    expect(p.afters.map(a => [a.ms, a.state])).toEqual([
      [0, 'pending'],
      [10, 'cancelled'],
      [5, 'pending'],
    ])
    // The real clock: every pending one, in due order.
    expect(await runAfters(p)).toBe(2)
    expect(ran).toEqual(['a', 'c'])
    // One made while running waits for the next call.
    expect(await runAfters(p)).toBe(1)
    expect(ran).toEqual(['a', 'c', 'd'])
    expect(await runAfters(p)).toBe(0)
  })

  test('with the fake clock, runAfters runs only the timers due by clock.now, in due order', async () => {
    const p = nodePorts()
    p.clock.now = 1000
    const ran: string[] = []
    p.after(500, () => void ran.push('late'))
    p.after(100, () => void ran.push('soon'))
    p.after(100, () => void ran.push('soon too'))
    p.clock.now = 1050
    p.after(30, () => void ran.push('made later, due first'))
    expect(await runAfters(p)).toBe(0)
    p.clock.now = 1100
    expect(await runAfters(p)).toBe(3)
    expect(ran).toEqual(['made later, due first', 'soon', 'soon too'])
    p.clock.now = 1499
    expect(await runAfters(p)).toBe(0)
    p.clock.now = 1500
    expect(await runAfters(p)).toBe(1)
    expect(ran.at(-1)).toBe('late')
  })

  test('runAfters with all runs every pending timer, due or not, in the order made', async () => {
    const p = nodePorts()
    p.clock.now = 0
    const ran: string[] = []
    p.after(60_000, () => void ran.push('a'))
    p.after(10, () => void ran.push('b'))
    p.after(30_000, () => void ran.push('c')).cancel()
    expect(await runAfters(p, { all: true })).toBe(2)
    expect(ran).toEqual(['a', 'b'])
  })

  test('fireEvery fires each every timer once, awaiting it', async () => {
    const p = nodePorts()
    const ran: string[] = []
    p.every(1000, async () => {
      await Promise.resolve()
      ran.push('one')
    })
    const t = p.every(5000, () => void ran.push('two'))
    expect(await fireEvery(p)).toBe(2)
    expect(ran).toEqual(['one', 'two'])
    t.cancel()
    expect(await fireEvery(p)).toBe(1)
  })

  test("every keeps working as before: timers hold the callbacks, cancel drops one", () => {
    const p = nodePorts()
    const fn = () => {}
    const t = p.every(1000, fn)
    expect(p.timers.has(fn)).toBe(true)
    t.cancel()
    expect(p.timers.has(fn)).toBe(false)
  })

  test('limits, settingsFrom and configDir answer what the spec set', async () => {
    const p = nodePorts()
    expect(await p.limits()).toEqual({
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: undefined,
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: undefined,
      CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: undefined,
      CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION: undefined,
    })
    p.limitsValue.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = '4'
    expect((await p.limits()).CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH).toBe('4')
    expect(await p.settingsFrom('user')).toBeNull()
    p.sourceSettings.policy = { env: { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '30' } }
    const got = await p.settingsFrom('policy')
    expect(got).toEqual({ env: { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '30' } })
    expect(await p.settingsFrom('project')).toBeNull()
    // The engine answers {} for a missing file; the port reads it as null.
    p.sourceSettings.local = {}
    expect(await p.settingsFrom('local')).toBeNull()
    await expect(p.configDir()).rejects.toThrow('no config dir in tier 2')
    p.configDirValue = '/scratch/config'
    expect(await p.configDir()).toBe('/scratch/config')
  })

  test('commands, panes, toasts, copies and views are recorded', async () => {
    const p = nodePorts()
    await p.registerCommand({ name: 'litter-swarm', description: 'd', argumentHint: '[name]' })
    expect(await p.openPane('litter-swarm', 'litter swarm')).toBe(true)
    await p.closePane('litter-swarm')
    p.toast('saved')
    expect(await p.copy('snippet')).toBe(true)
    const view = { view: 'start', v: 1 }
    await p.setView('swarm', view)
    view.v = 2
    await p.setView('doctor', null)
    expect(p.commands.map(c => c.name)).toEqual(['litter-swarm'])
    expect(p.panes).toEqual({ opened: [{ id: 'litter-swarm', title: 'litter swarm' }], closed: ['litter-swarm'] })
    expect(p.toasts).toEqual(['saved'])
    expect(p.copied).toEqual(['snippet'])
    expect(p.views).toEqual({ swarm: { view: 'start', v: 1 }, doctor: null })
  })

  test('registerAgent and registerTool record each spec and resolve, unless their answer throws', async () => {
    const p = nodePorts()
    await p.registerAgent({ name: 'sw-a-b', description: 'd', prompt: 'p' })
    await p.registerTool({ name: 'swarm_send', description: 'd' })
    p.registerAgentAnswer = spec => {
      throw new Error(`refused ${spec.name}`)
    }
    await expect(p.registerAgent({ name: 'sw-a-c', description: 'd', prompt: 'p' })).rejects.toThrow('refused sw-a-c')
    p.registerToolAnswer = () => {
      throw new Error('allowedMcpServers')
    }
    await expect(p.registerTool({ name: 'swarm_read', description: 'd' })).rejects.toThrow('allowedMcpServers')
    expect(p.registeredAgents.map(s => s.name)).toEqual(['sw-a-b', 'sw-a-c'])
    expect(p.registeredTools.map(s => s.name)).toEqual(['swarm_send', 'swarm_read'])
  })

  test('a spec that replaces a method sees only its own', async () => {
    const p = nodePorts()
    const seen: string[] = []
    p.registerAgent = async spec => void seen.push(spec.name)
    await p.registerAgent({ name: 'x', description: 'd', prompt: 'p' })
    expect(seen).toEqual(['x'])
    expect(p.registeredAgents).toEqual([])
  })
})
