/**
 * The interchange format. Its whole promise is "paste this and your friend gets your config", so the
 * reader is tested against what people actually paste: a full export, a clipping, a bare agent, an
 * older shape, and several kinds of mangled JSON.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { exportAgents, exportSwarm, parsePortable, rekey, PORTABLE_VERSION } from './portable.ts'
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
