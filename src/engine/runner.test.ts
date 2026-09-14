/**
 * Engine tests. Run with: npm test
 *
 * They use the demo provider, so they need no key and no network. The point is the propagation
 * rules: they are the only part of this app that can be wrong without anything looking broken.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { resolveEntryIds, runSwarm, type RunnerCallbacks, type TransitPacket } from './runner.ts'
import type { Agent, SwarmSpec, Topology, TranscriptEntry } from '../types.ts'

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

function spec(partial: Partial<SwarmSpec> = {}): SwarmSpec {
  return {
    name: 'test',
    task: 'Say something.',
    agents: [agent('a'), agent('b'), agent('c')],
    links: [
      { id: 'ab', source: 'a', target: 'b' },
      { id: 'ac', source: 'a', target: 'c' },
    ],
    topology: 'broadcast' as Topology,
    maxRounds: 3,
    entryIds: [],
    ...partial,
  }
}

/** Runs a swarm to completion and returns the transcript plus the links that lit up. */
async function collect(s: SwarmSpec) {
  const entries = new Map<string, TranscriptEntry>()
  const transit: TransitPacket[] = []
  let phase = ''
  let error: string | undefined
  const cb: RunnerCallbacks = {
    onPhase: (p, detail) => {
      phase = p
      if (detail) error = detail
    },
    onRound: () => {},
    onAgentStatus: () => {},
    onMessageStart: (entry) => entries.set(entry.id, { ...entry }),
    onMessageDelta: (id, delta) => {
      const entry = entries.get(id)!
      entry.text += delta
    },
    onMessageEnd: (id, patch) => entries.set(id, { ...entries.get(id)!, ...patch }),
    onTransit: (links) => transit.push(...links),
  }
  await runSwarm(s, {}, cb, new AbortController().signal)
  return { transcript: [...entries.values()], transit, phase, error }
}

test('entry agents default to the roots of the graph', () => {
  assert.deepEqual(resolveEntryIds(spec()), ['a'])
  assert.deepEqual(resolveEntryIds(spec({ entryIds: ['b'] })), ['b'])
})

test('a graph with no root still runs, starting from the first agent', () => {
  const cyclic = spec({
    links: [
      { id: 'ab', source: 'a', target: 'b' },
      { id: 'ba', source: 'b', target: 'a' },
    ],
    agents: [agent('a'), agent('b')],
  })
  assert.deepEqual(resolveEntryIds(cyclic), ['a'])
})

test('broadcast hands the message to every outgoing link', async () => {
  const { transcript, phase } = await collect(spec({ maxRounds: 2 }))
  assert.equal(phase, 'done')
  const round1 = transcript.filter((e) => e.round === 1)
  const round2 = transcript.filter((e) => e.round === 2)
  assert.deepEqual(
    round1.map((e) => e.agentId),
    ['a'],
  )
  assert.deepEqual(
    round2.map((e) => e.agentId).sort(),
    ['b', 'c'],
  )
  assert.ok(transcript.every((e) => e.status === 'complete' && e.text.length > 0))
})

test('round-robin hands the message to one link per turn, rotating', async () => {
  const cyclic = spec({
    topology: 'round-robin',
    maxRounds: 4,
    links: [
      { id: 'ab', source: 'a', target: 'b' },
      { id: 'ac', source: 'a', target: 'c' },
      { id: 'ba', source: 'b', target: 'a' },
      { id: 'ca', source: 'c', target: 'a' },
    ],
  })
  const { transcript } = await collect(cyclic)
  // a → b → a → c: never more than one speaker per round.
  for (const round of [1, 2, 3, 4]) {
    assert.equal(transcript.filter((e) => e.round === round).length, 1, `round ${round}`)
  }
  assert.deepEqual(
    transcript.map((e) => e.agentId),
    ['a', 'b', 'a', 'c'],
  )
})

test('manager mode sends workers down then collects them back up', async () => {
  const { transcript } = await collect(spec({ topology: 'manager', maxRounds: 3 }))
  assert.deepEqual(
    transcript.filter((e) => e.round === 1).map((e) => e.agentId),
    ['a'],
  )
  assert.deepEqual(
    transcript.filter((e) => e.round === 2).map((e) => e.agentId).sort(),
    ['b', 'c'],
  )
  // Both workers report to the manager, so it speaks once more with two replies in hand.
  assert.deepEqual(
    transcript.filter((e) => e.round === 3).map((e) => e.agentId),
    ['a'],
  )
})

test('a manager-mode reply is marked as travelling backwards along its link', async () => {
  // Found by the adversarial review: the reply round reused the same link ids as the delegation
  // round, so the animation drew manager→worker both times while the transcript said the opposite.
  const { transit } = await collect(spec({ topology: 'manager', maxRounds: 2 }))

  const down = transit.filter((p) => !p.reversed).map((p) => p.id).sort()
  const up = transit.filter((p) => p.reversed).map((p) => p.id).sort()
  assert.deepEqual(down, ['ab', 'ac'], 'round 1 delegates along the links as drawn')
  assert.deepEqual(up, ['ab', 'ac'], 'round 2 climbs the same links, and says so')
})

test('a leaf ends the run before maxRounds', async () => {
  const chain = spec({
    maxRounds: 10,
    agents: [agent('a'), agent('b')],
    links: [{ id: 'ab', source: 'a', target: 'b' }],
  })
  const { transcript, phase } = await collect(chain)
  assert.equal(phase, 'done')
  assert.equal(transcript.length, 2)
  assert.deepEqual(transcript.at(-1)!.to, [])
})

test('an empty swarm reports an error instead of hanging', async () => {
  const { phase, error } = await collect(spec({ agents: [], links: [] }))
  assert.equal(phase, 'error')
  assert.match(error ?? '', /at least one agent/i)
})

test('one agent failing stops its siblings instead of letting them stream on', async () => {
  // Found by an adversarial probe: the run went to "error" while the healthy sibling kept writing
  // text into the transcript — a failed run that goes on talking.
  const broken = agent('x', { provider: 'custom', model: 'nowhere' }) // no endpoint => throws at once
  const healthy = agent('a', { model: 'demo-verbose' }) // slow on purpose
  const s = spec({ agents: [healthy, broken], links: [], entryIds: ['a', 'x'], maxRounds: 3 })

  const texts = new Map<string, string>()
  let phase = ''
  let detail: string | undefined
  const cb: RunnerCallbacks = {
    onPhase: (p, d) => {
      phase = p
      if (d) detail = d
    },
    onRound: () => {},
    onAgentStatus: () => {},
    onMessageStart: (entry) => texts.set(entry.id, ''),
    onMessageDelta: (id, delta) => texts.set(id, (texts.get(id) ?? '') + delta),
    onMessageEnd: () => {},
    onTransit: () => {},
  }

  await runSwarm(s, {}, cb, new AbortController().signal)
  assert.equal(phase, 'error', 'the phase reports the breakage, not a clean stop')
  assert.match(detail ?? '', /endpoint/i)

  // The run has returned. Nothing may still be writing.
  const snapshot = JSON.stringify([...texts.entries()])
  await new Promise((r) => setTimeout(r, 250))
  assert.equal(JSON.stringify([...texts.entries()]), snapshot, 'no sibling is still streaming')
})

test('stopping mid-run leaves the phase stopped', async () => {
  const controller = new AbortController()
  const phases: string[] = []
  const run = runSwarm(
    spec({ maxRounds: 6, agents: [agent('a', { model: 'demo-verbose' })], links: [] }),
    {},
    {
      onPhase: (p) => phases.push(p),
      onRound: () => {},
      onAgentStatus: () => {},
      onMessageStart: () => {},
      onMessageDelta: () => {},
      onMessageEnd: () => {},
      onTransit: () => {},
    },
    controller.signal,
  )
  setTimeout(() => controller.abort(), 40)
  await run
  assert.deepEqual(phases, ['running', 'stopped'])
})
