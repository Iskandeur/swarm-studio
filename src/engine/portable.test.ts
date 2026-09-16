/**
 * The interchange format. Its whole promise is "paste this and your friend gets your config", so the
 * reader is tested against what people actually paste: a full export, a clipping, a bare agent, an
 * older shape, and several kinds of mangled JSON.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { exportAgents, exportSwarm, parsePortable, portableToSpec, rekey, PORTABLE_VERSION } from './portable.ts'
import type { SwarmSpec } from '../types.ts'
import { PRESETS } from '../presets.ts'

const spec = PRESETS[0]

test('a swarm survives a round trip', () => {
  const result = parsePortable(exportSwarm(spec))
  assert.ok(result.ok, result.ok ? '' : result.error)
  if (!result.ok || result.value.kind !== 'swarm') throw new Error('expected a swarm')
  assert.equal(result.value.name, spec.name)
  assert.equal(result.value.task, spec.task)
  assert.equal(result.value.topology, spec.topology)
  assert.equal(result.value.maxRounds, spec.maxRounds)
  assert.deepEqual(result.value.entryIds, spec.entryIds)
  assert.deepEqual(result.value.agents, spec.agents)
  assert.deepEqual(result.value.links, spec.links)
})

test('a clipping keeps only the links whose two ends came along', () => {
  const two = [spec.agents[0].id, spec.agents[1].id]
  const json = exportAgents(spec, two)
  const result = parsePortable(json)
  assert.ok(result.ok)
  if (!result.ok || result.value.kind !== 'agents') throw new Error('expected agents')
  assert.deepEqual(result.value.agents.map((a) => a.id), two)
  for (const link of result.value.links) {
    assert.ok(two.includes(link.source) && two.includes(link.target), 'no link points outside the clipping')
  }
})

test('keys and endpoints are NEVER in the payload', () => {
  // The format is meant to be pasted into a chat. A key travelling with it would be a leak by design.
  const json = exportSwarm(spec) + exportAgents(spec, [spec.agents[0].id])
  for (const forbidden of ['apiKey', 'api_key', 'endpoint', 'authorization', 'Bearer', 'sk-']) {
    assert.equal(json.includes(forbidden), false, `${forbidden} must not travel`)
  }
})

test('a single agent object pasted on its own is accepted', () => {
  const result = parsePortable(JSON.stringify(spec.agents[2]))
  assert.ok(result.ok, result.ok ? '' : result.error)
  if (!result.ok || result.value.kind !== 'agents') throw new Error('expected agents')
  assert.equal(result.value.agents.length, 1)
  assert.equal(result.value.agents[0].name, spec.agents[2].name)
})

test('a bare array of agents is accepted', () => {
  const result = parsePortable(JSON.stringify([spec.agents[0], spec.agents[1]]))
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.value.agents.length, 2)
})

test('an older bare spec, with no format field, still reads', () => {
  // What the previous Export button produced. Refusing it would break every JSON already shared.
  const legacy = JSON.stringify({
    name: 'Old',
    task: 'do a thing',
    topology: 'manager',
    maxRounds: 5,
    entryIds: [spec.agents[0].id],
    agents: spec.agents,
    links: spec.links,
  })
  const result = parsePortable(legacy)
  assert.ok(result.ok, result.ok ? '' : result.error)
  if (!result.ok || result.value.kind !== 'swarm') throw new Error('expected a swarm')
  assert.equal(result.value.topology, 'manager')
  assert.equal(result.value.maxRounds, 5)
})

test('every refusal says something a human can act on', () => {
  const cases: Array<[string, RegExp]> = [
    ['', /paste some JSON/i],
    ['   ', /paste some JSON/i],
    ['not json at all', /does not look like JSON/i],
    ['{ "a": 1, }', /not valid JSON/i],
    ['42', /object or array/i],
    ['{"format":"langgraph","agents":[]}', /not a Swarm Studio export/i],
    [`{"format":"swarm-studio","version":${PORTABLE_VERSION + 5},"kind":"swarm","agents":[]}`, /Update the app/i],
    ['{"kind":"agents","agents":[]}', /no agents/i],
    ['{"kind":"agents","agents":[{"model":"x"}]}', /has no name/i],
    ['{"somethingElse":true}', /Unrecognised JSON/i],
  ]
  for (const [input, pattern] of cases) {
    const result = parsePortable(input)
    assert.equal(result.ok, false, `${JSON.stringify(input)} should be refused`)
    if (!result.ok) assert.match(result.error, pattern, JSON.stringify(input))
  }
})

test('hostile or lazy values are repaired rather than trusted', () => {
  const result = parsePortable(
    JSON.stringify({
      kind: 'agents',
      agents: [
        { name: 'Wild', provider: 'not-a-provider', temperature: 99, hue: 'purple', position: { x: 'left' } },
      ],
      links: [{ id: 'x', source: 'ghost', target: 'Wild' }],
    }),
  )
  assert.ok(result.ok, result.ok ? '' : result.error)
  if (!result.ok) return
  const agent = result.value.agents[0]
  assert.equal(agent.provider, 'mock', 'an unknown provider falls back to the one that needs no key')
  assert.equal(agent.temperature, 2, 'temperature is clamped, not passed through')
  assert.ok(Number.isFinite(agent.hue))
  assert.ok(Number.isFinite(agent.position.x))
  assert.deepEqual(result.value.links, [], 'a link to an agent that is not here is dropped')
})

test('a duplicated link and a self-loop are dropped', () => {
  const result = parsePortable(
    JSON.stringify({
      kind: 'agents',
      agents: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      links: [
        { id: '1', source: 'a', target: 'b' },
        { id: '2', source: 'a', target: 'b' },
        { id: '3', source: 'a', target: 'a' },
      ],
    }),
  )
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.value.links.length, 1)
})

test('rekey renames only what collides, and rewires the links to match', () => {
  const incoming = {
    agents: [
      { ...spec.agents[0], id: 'keep' },
      { ...spec.agents[1], id: 'clash' },
    ],
    links: [{ id: 'l', source: 'keep', target: 'clash' }],
  }
  const { agents, links } = rekey(incoming, new Set(['clash']), (i) => `new${i}`)

  assert.equal(agents[0].id, 'keep', 'a free id is left alone')
  assert.equal(agents[1].id, 'new1', 'a colliding id is minted afresh')
  assert.deepEqual(agents[0].position, incoming.agents[0].position, 'and its position is untouched')
  assert.notDeepEqual(agents[1].position, incoming.agents[1].position, 'the moved one is offset')
  assert.deepEqual(
    links.map((l) => [l.source, l.target]),
    [['keep', 'new1']],
    'the link follows the rename',
  )
})

const v2: SwarmSpec = {
  name: 'Graph',
  task: 'Find the missing biscuit.',
  topology: 'broadcast',
  maxRounds: 9,
  maxDepth: 2,
  maxSpawns: 5,
  entryIds: ['det'],
  agents: [
    { id: 'det', name: 'Detective', provider: 'mock', model: 'demo-fast', systemPrompt: 'Investigate.', temperature: 0.4, hue: 30, position: { x: 0, y: 0 }, dispatch: 'choose', canSpawn: true, maxTokens: 300 },
    { id: 'jury', name: 'Jury', provider: 'mock', model: 'demo-fast', systemPrompt: 'Decide.', temperature: 0.4, hue: 90, position: { x: 200, y: 0 } },
  ],
  nodes: [
    { id: 'ev', kind: 'memory', name: 'Evidence', position: { x: 0, y: 200 }, mode: 'blackboard', wakeReaders: true, seed: [{ key: 'crumbs', value: 'on the sofa', author: 'seed', round: 0, version: 1 }], maxChars: 1200 },
    { id: 'q', kind: 'condition', name: 'Enough?', position: { x: 100, y: 0 }, predicate: { op: 'all', of: [{ op: 'contains', value: 'guilty' }, { op: 'visits', cmp: 'lt', value: 3 }] } },
    { id: 'gate', kind: 'human', name: 'Sign-off', position: { x: 150, y: 0 }, prompt: 'Arrest?' },
    { id: 'j', kind: 'join', name: 'Both', position: { x: 160, y: 0 }, mode: 'all', timeoutRounds: 2 },
    { id: 'out', kind: 'output', name: 'Verdict', position: { x: 300, y: 0 } },
    { id: 'blk', kind: 'block', name: 'Second opinion', position: { x: 300, y: 100 }, blockId: 'critic', overrides: { model: 'demo-verbose' } },
  ],
  links: [
    { id: 'l1', source: 'det', target: 'q', label: 'accuse', isDefault: true, maxTraversals: 3 },
    { id: 'l2', source: 'q', target: 'jury', label: 'true', guard: { op: 'matches', pattern: 'biscuit', flags: 'i' } },
    { id: 'l3', source: 'det', target: 'ev', kind: 'access', access: 'readwrite' },
    { id: 'l4', source: 'jury', target: 'out' },
  ],
  blocks: [
    {
      id: 'critic',
      name: 'Critic',
      description: 'A second look.',
      graph: {
        agents: [{ id: 'c', name: 'Critic', provider: 'mock', model: 'demo-fast', systemPrompt: 'Doubt.', temperature: 0.7, hue: 10, position: { x: 0, y: 0 } }],
        nodes: [],
        links: [],
        entryIds: [],
      },
    },
  ],
}

test('a version-2 swarm survives a round trip with nothing lost', () => {
  const result = parsePortable(exportSwarm(v2))
  assert.ok(result.ok, result.ok ? '' : result.error)
  if (!result.ok || result.value.kind !== 'swarm') throw new Error('expected a swarm')
  assert.deepEqual(portableToSpec(result.value), v2)
})

test('an access link must join one memory and one agent, and a message link may not touch a memory', () => {
  const result = parsePortable(
    exportSwarm({
      ...v2,
      links: [
        { id: 'ok', source: 'ev', target: 'jury', kind: 'access' },
        { id: 'bad-access', source: 'det', target: 'jury', kind: 'access' },
        { id: 'bad-message', source: 'det', target: 'ev' },
      ],
    }),
  )
  assert.ok(result.ok)
  if (!result.ok) return
  assert.deepEqual(result.value.links.map((l) => l.id), ['ok'])
})

test('a malformed condition is repaired, and unusable nodes are dropped', () => {
  const result = parsePortable(
    JSON.stringify({
      kind: 'swarm',
      task: 't',
      agents: [{ id: 'a', name: 'A' }],
      nodes: [
        { id: 'c', kind: 'condition', predicate: { op: 'launch-missiles' } },
        { id: 'b', kind: 'block' },
        { id: 'a', kind: 'output', name: 'steals an agent id' },
        { id: 'z', kind: 'teleporter' },
      ],
    }),
  )
  assert.ok(result.ok, result.ok ? '' : result.error)
  if (!result.ok) return
  assert.deepEqual(result.value.nodes.map((n) => n.id), ['c'])
  const condition = result.value.nodes[0]
  assert.ok(condition.kind === 'condition' && condition.predicate.op === 'always')
})

test('a clipping carries the definitions of the blocks it uses', () => {
  const result = parsePortable(exportAgents(v2, ['jury', 'blk']))
  assert.ok(result.ok)
  if (!result.ok || result.value.kind !== 'agents') throw new Error('expected a clipping')
  assert.deepEqual(result.value.blocks.map((b) => b.id), ['critic'])
  assert.deepEqual(result.value.nodes.map((n) => n.id), ['blk'])
})

test('a clipping of nodes only is accepted', () => {
  const result = parsePortable(exportAgents(v2, ['ev', 'q']))
  assert.ok(result.ok, result.ok ? '' : result.error)
})

test('rekey renames colliding nodes and rewires links to them', () => {
  const { nodes, links } = rekey(
    { agents: [v2.agents[1]], nodes: [v2.nodes![4]], links: [{ id: 'x', source: 'jury', target: 'out' }] },
    new Set(['out']),
    (i) => `n${i}`,
  )
  assert.equal(nodes[0].id, 'n1')
  assert.deepEqual([links[0].source, links[0].target], ['jury', 'n1'])
})
