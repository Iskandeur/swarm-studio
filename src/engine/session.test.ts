/**
 * Pause, resume, and human injection — the two things asked for on 14/09 evening.
 *
 * Tested at the engine level because the interesting parts are timing and delivery, not layout:
 * that a paused loop really stops advancing, that it does not hang for ever when stopped while
 * paused, and that a message reaches an agent the swarm had already moved past.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { runSwarm, type RunnerCallbacks } from './runner.ts'
import { createRunSession } from './session.ts'
import type { Agent, SwarmSpec } from '../types.ts'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Waits for a condition instead of for a duration. A round is a turn plus a 650 ms transit
 * animation, so fixed sleeps in these tests were measuring the animation, not the behaviour.
 */
async function until(what: string, predicate: () => boolean, budgetMs = 8000): Promise<void> {
  const step = 25
  for (let waited = 0; waited < budgetMs; waited += step) {
    if (predicate()) return
    await wait(step)
  }
  throw new Error(`timed out waiting for: ${what}`)
}

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id.toUpperCase(),
    provider: 'mock',
    model: 'demo-fast',
    systemPrompt: `You are ${id}.`,
    temperature: 0.5,
    hue: 262,
    position: { x: 0, y: 0 },
    ...overrides,
  }
}

function chain(maxRounds = 6): SwarmSpec {
  return {
    name: 'chain',
    task: 'Go.',
    agents: [agent('a'), agent('b')],
    links: [
      { id: 'ab', source: 'a', target: 'b' },
      { id: 'ba', source: 'b', target: 'a' },
    ],
    topology: 'broadcast',
    maxRounds,
    entryIds: ['a'],
  }
}

function recorder() {
  const rounds: number[] = []
  const phases: string[] = []
  const injections: Array<{ agentId: string; round: number }> = []
  const said: Array<{ agentId: string; text: string }> = []
  const byId = new Map<string, { agentId: string; text: string }>()
  const cb: RunnerCallbacks = {
    onPhase: (p) => phases.push(p),
    onRound: (r) => rounds.push(r),
    onAgentStatus: () => {},
    onMessageStart: (entry) => {
      const row = { agentId: entry.agentId, text: '' }
      byId.set(entry.id, row)
      said.push(row)
    },
    onMessageDelta: (id, delta) => {
      const row = byId.get(id)
      if (row) row.text += delta
    },
    onMessageEnd: () => {},
    onTransit: () => {},
    onInjection: (i) => injections.push({ agentId: i.agentId, round: i.round }),
  }
  return { cb, rounds, phases, injections, said }
}

test('pausing stops the loop advancing, and resuming continues it', { timeout: 20_000 }, async () => {
  const session = createRunSession()
  const { cb, rounds, phases } = recorder()
  const controller = new AbortController()
  const run = runSwarm(chain(20), {}, cb, controller.signal, { session })

  await until('the first round', () => rounds.length >= 1)
  session.pause()
  await until('the paused phase', () => phases.includes('paused'))

  // Pausing takes effect at a round boundary, so the round in flight may still land. What must not
  // happen is a NEW round starting after the gate has been reached.
  const frozen = rounds.length
  await wait(1200)
  assert.equal(rounds.length, frozen, `no new round while paused (was ${frozen})`)

  session.resume()
  await until('a round after the resume', () => rounds.length > frozen)

  controller.abort()
  session.resume()
  await run
})

test('stopping while paused does not hang the run', async () => {
  const session = createRunSession()
  const { cb, phases } = recorder()
  const controller = new AbortController()
  const run = runSwarm(chain(20), {}, cb, controller.signal, { session })

  await wait(120)
  session.pause()
  await wait(250)
  controller.abort()

  // Without the abort releasing the gate, this await would never settle.
  await Promise.race([run, wait(3000).then(() => Promise.reject(new Error('the run hung while paused')))])
  assert.equal(phases.at(-1), 'stopped')
})

test('an injected message reaches the agent you chose', { timeout: 20_000 }, async () => {
  const session = createRunSession()
  const { cb, injections, said } = recorder()
  session.inject('b', 'be brief')
  await runSwarm(chain(2), {}, cb, new AbortController().signal, { session })

  assert.ok(
    injections.some((i) => i.agentId === 'b'),
    'the injection is reported for b',
  )
  assert.ok(
    said.some((s) => s.agentId === 'b'),
    'b spoke, even though round 1 would only have woken a',
  )
})

test('an injection wakes an agent the swarm had left behind', { timeout: 20_000 }, async () => {
  // `a` is a leaf: once it has spoken the active set is empty and the run would end. Injecting
  // DURING the run must bring it back — that is what "input wherever I want" has to mean.
  const leaf: SwarmSpec = {
    name: 'leaf',
    task: 'Go.',
    agents: [agent('a', { model: 'demo-verbose' })],
    links: [],
    topology: 'broadcast',
    maxRounds: 4,
    entryIds: ['a'],
  }
  const session = createRunSession()
  const { cb, said } = recorder()
  const run = runSwarm(leaf, {}, cb, new AbortController().signal, { session })

  await until('a to speak once', () => said.length >= 1)
  session.inject('a', 'again please')
  await run

  assert.ok(
    said.filter((s) => s.agentId === 'a').length >= 2,
    `a should speak again after the injection, spoke ${said.length} time(s)`,
  )
})

test('injections queued while paused are delivered on resume, exactly once', { timeout: 20_000 }, async () => {
  const session = createRunSession()
  const { cb, injections, phases } = recorder()
  const controller = new AbortController()
  const run = runSwarm(chain(20), {}, cb, controller.signal, { session })

  session.pause()
  await until('the paused phase', () => phases.includes('paused'))
  session.inject('b', 'one')
  session.inject('b', 'two')
  assert.equal(session.pendingInjections(), 2)
  await wait(600)
  assert.equal(injections.length, 0, 'nothing is delivered while paused')

  session.resume()
  await until('both injections delivered', () => injections.length === 2)
  assert.equal(session.pendingInjections(), 0, 'and the queue is empty afterwards')

  controller.abort()
  session.resume()
  await run
})

test('an injection for an agent that no longer exists is dropped, not crashed on', async () => {
  const session = createRunSession()
  const { cb, injections } = recorder()
  session.inject('ghost', 'hello?')
  await runSwarm(chain(2), {}, cb, new AbortController().signal, { session })
  assert.deepEqual(injections, [])
})

test('a continued run keeps what the agents remember', async () => {
  const session = createRunSession()
  const first = recorder()
  await runSwarm(chain(2), {}, first.cb, new AbortController().signal, { session })
  const remembered = session.memory.get('a')?.length ?? 0
  assert.ok(remembered > 0, 'a remembers its first turn')

  const second = recorder()
  await runSwarm(chain(2), {}, second.cb, new AbortController().signal, { session, startFrom: ['a'] })
  assert.ok((session.memory.get('a')?.length ?? 0) > remembered, 'the memory grew instead of restarting')
  // A continued run must not re-deliver the task as if it were new.
  assert.ok(second.said.length > 0)
})
