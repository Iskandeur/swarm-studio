/**
 * Store mechanics: bulk edits, deletion, undo/redo. These are the operations that can quietly
 * corrupt a swarm — a link pointing at a deleted agent, or an undo that loses a step — so they are
 * tested at the store level rather than through the UI.
 */
import assert from 'node:assert/strict'
import { test, beforeEach } from 'vitest'
import { allBlocks, useStore } from './store'
import { PRESETS } from './presets'

// Derived, never hardcoded. A preset is CONTENT and it gets rewritten; a store test that names
// `a1` then fails for a reason that says nothing about the store.
const [FIRST, SECOND, THIRD] = PRESETS[0].agents.map((a) => a.id)

beforeEach(() => {
  localStorage.clear()
  useStore.getState().loadPreset(PRESETS[0])
})

const spec = () => useStore.getState().spec

test('deleting an agent takes its links and its entry flag with it', () => {
  useStore.getState().toggleEntry(SECOND)
  useStore.getState().select(SECOND)
  assert.ok(spec().entryIds.includes(SECOND))

  useStore.getState().removeAgent(SECOND)

  assert.equal(spec().agents.some((a) => a.id === SECOND), false)
  assert.equal(spec().links.some((l) => l.source === SECOND || l.target === SECOND), false)
  assert.equal(spec().entryIds.includes(SECOND), false)
  assert.equal(useStore.getState().selectedId, undefined, 'the deleted agent stops being selected')
})

test('deleting several at once leaves no dangling link either', () => {
  const doomed = [FIRST, THIRD]
  useStore.getState().setMulti(doomed)
  useStore.getState().removeAgents(doomed)

  const survivors = new Set(spec().agents.map((a) => a.id))
  for (const id of doomed) assert.equal(survivors.has(id), false, `${id} is gone`)
  assert.equal(survivors.size, PRESETS[0].agents.length - doomed.length)
  // The property that matters: every remaining link points at two agents that still exist.
  for (const link of spec().links) {
    assert.ok(survivors.has(link.source) && survivors.has(link.target), `dangling link ${link.id}`)
  }
  assert.deepEqual(useStore.getState().multiIds, [], 'the bulk selection drops the dead ids')
})

test('a bulk patch reaches every ticked agent and nobody else', () => {
  const untouched = spec().agents.find((a) => a.id === SECOND)!
  const before = { model: untouched.model, provider: untouched.provider }

  useStore.getState().applyToAgents([FIRST, THIRD], { model: 'shared-model', provider: 'openai' })

  const byId = Object.fromEntries(spec().agents.map((a) => [a.id, a]))
  assert.equal(byId[FIRST].model, 'shared-model')
  assert.equal(byId[THIRD].model, 'shared-model')
  assert.equal(byId[FIRST].provider, 'openai')
  assert.equal(byId[SECOND].model, before.model, 'the unticked agent is untouched')
  assert.equal(byId[SECOND].provider, before.provider)
})

test('an empty bulk selection is a no-op, not a wipe', () => {
  const before = JSON.stringify(spec())
  useStore.getState().applyToAgents([], { model: 'nope' })
  useStore.getState().removeAgents([])
  assert.equal(JSON.stringify(spec()), before)
})

test('undo restores the previous spec, redo puts it back', () => {
  const before = spec().agents.length
  useStore.getState().addAgent()
  assert.equal(spec().agents.length, before + 1)

  useStore.getState().undo()
  assert.equal(spec().agents.length, before)
  useStore.getState().redo()
  assert.equal(spec().agents.length, before + 1)
})

test('undo with nothing to undo does nothing', () => {
  const before = JSON.stringify(spec())
  useStore.getState().undo()
  useStore.getState().undo()
  assert.equal(JSON.stringify(spec()), before)
})

test('typing the task does NOT enter the undo stack', () => {
  // Otherwise one undo per character buries the structural change the user wants back.
  useStore.getState().addAgent()
  useStore.getState().setSpec({ task: 'a' })
  useStore.getState().setSpec({ task: 'ab' })
  useStore.getState().setSpec({ task: 'abc' })

  useStore.getState().undo()
  assert.equal(spec().task, 'abc', 'the text survives')
  assert.equal(spec().agents.length, PRESETS[0].agents.length, 'the added agent is what got undone')
})

test('a new edit clears the redo branch', () => {
  useStore.getState().addAgent()
  useStore.getState().undo()
  assert.equal(useStore.getState().future.length, 1)
  useStore.getState().addAgent()
  assert.equal(useStore.getState().future.length, 0)
})

test('duplicating an agent copies its settings but not its identity', () => {
  useStore.getState().applyToAgents([FIRST], { model: 'peculiar-model', systemPrompt: 'be odd' })
  useStore.getState().duplicateAgent(FIRST)

  const copy = spec().agents.at(-1)!
  assert.notEqual(copy.id, FIRST)
  assert.equal(copy.model, 'peculiar-model')
  assert.equal(copy.systemPrompt, 'be odd')
  assert.match(copy.name, /copy/i)
  // Offset, so it does not hide under the original.
  assert.notDeepEqual(copy.position, spec().agents.find((a) => a.id === FIRST)!.position)
  assert.deepEqual(spec().links.filter((l) => l.source === copy.id || l.target === copy.id), [])
})

test('max rounds accepts a value above the old hardcoded ceiling', () => {
  useStore.getState().setSpec({ maxRounds: 200 })
  assert.equal(spec().maxRounds, 200)
})

test('typing a long prompt does not push the structural step out of the undo stack', () => {
  // Found by an adversarial probe: with text edits recorded, 60 keystrokes filled a 50-deep stack
  // and the deleted agent became unrecoverable — undo looked like it worked, and lost the thing.
  const victim = spec().agents[2].id
  useStore.getState().removeAgent(victim)
  const depthAfterStructuralStep = useStore.getState().past.length

  const target = spec().agents[0].id
  const prompt = 'You are a careful specialist who answers in one short paragraph and never bluffs.'
  for (let i = 1; i <= 60; i++) useStore.getState().updateAgent(target, { systemPrompt: prompt.slice(0, i) })

  assert.equal(useStore.getState().past.length, depthAfterStructuralStep, 'text edits add no history')
  useStore.getState().undo()
  assert.ok(spec().agents.some((a) => a.id === victim), 'the deleted agent comes back')
  // 60 keystrokes typed 60 characters, and all 60 must survive the undo.
  assert.equal(
    spec().agents.find((a) => a.id === target)!.systemPrompt,
    prompt.slice(0, 60),
    'the typed text survives',
  )
})

test('a bulk model apply is undoable, provider and model together', () => {
  // Found by an adversarial probe. `model` used to be carried across an undo like prose, so a bulk
  // model change appeared to survive its own undo — and undoing a provider switch left the provider
  // restored while the model stayed from the other provider, a pairing that cannot work.
  const before = spec().agents.map((a) => ({ id: a.id, provider: a.provider, model: a.model }))

  useStore.getState().applyToAgents([FIRST, SECOND], { provider: 'anthropic', model: 'claude-sonnet-5' })
  assert.equal(spec().agents.find((a) => a.id === FIRST)!.model, 'claude-sonnet-5')

  useStore.getState().undo()
  for (const original of before) {
    const now = spec().agents.find((a) => a.id === original.id)!
    assert.equal(now.provider, original.provider, `${original.id} provider`)
    assert.equal(now.model, original.model, `${original.id} model`)
  }
})

test('a non-text field on the same agent IS undoable', () => {
  // The rule is "text typing is not history, structure is" — temperature must stay recoverable.
  const target = spec().agents[0].id
  const before = spec().agents[0].temperature
  useStore.getState().updateAgent(target, { temperature: 1.4 })
  assert.equal(spec().agents.find((a) => a.id === target)!.temperature, 1.4)
  useStore.getState().undo()
  assert.equal(spec().agents.find((a) => a.id === target)!.temperature, before)
})

// ——— Version 2: nodes, typed links, blocks, spawned helpers ———

const nodes = () => spec().nodes ?? []

test('a link touching a memory becomes an access link, and only an agent may sit at the other end', () => {
  const memory = useStore.getState().addNode('memory')
  const condition = useStore.getState().addNode('condition')

  useStore.getState().addLink(FIRST, memory)
  const access = spec().links.find((l) => l.target === memory)!
  assert.equal(access.kind, 'access')

  useStore.getState().addLink(condition, memory)
  assert.equal(spec().links.some((l) => l.source === condition && l.target === memory), false)
  assert.match(useStore.getState().notice ?? '', /agents only/)

  // Drawing the other direction too means read AND write, on the same link.
  useStore.getState().addLink(memory, FIRST)
  const links = spec().links.filter((l) => l.kind === 'access')
  assert.equal(links.length, 1)
  assert.equal(links[0].access, 'readwrite')
})

test('a condition labels its first two links true and false, a gate approved and rejected', () => {
  const condition = useStore.getState().addNode('condition')
  const gate = useStore.getState().addNode('human')
  useStore.getState().addLink(condition, FIRST)
  useStore.getState().addLink(condition, SECOND)
  useStore.getState().addLink(gate, FIRST)
  useStore.getState().addLink(gate, THIRD)
  const labels = (source: string) => spec().links.filter((l) => l.source === source).map((l) => l.label)
  assert.deepEqual(labels(condition), ['true', 'false'])
  assert.deepEqual(labels(gate), ['approved', 'rejected'])
})

test('nothing leaves an output', () => {
  const output = useStore.getState().addNode('output')
  const before = spec().links.length
  useStore.getState().addLink(output, FIRST)
  assert.equal(spec().links.length, before)
})

test('clearing a link field removes the key instead of storing undefined', () => {
  const link = spec().links[0]
  useStore.getState().updateLink(link.id, { maxTraversals: 3, guard: { op: 'contains', value: 'x' } })
  useStore.getState().updateLink(link.id, { maxTraversals: undefined, guard: undefined })
  const now = spec().links.find((l) => l.id === link.id)!
  assert.equal('maxTraversals' in now, false)
  assert.equal('guard' in now, false)
})

test('deleting a node takes its links and its entry flag with it', () => {
  const join = useStore.getState().addNode('join')
  useStore.getState().addLink(FIRST, join)
  useStore.getState().toggleEntry(join)
  useStore.getState().removeAgents([join])
  assert.equal(nodes().some((n) => n.id === join), false)
  assert.equal(spec().links.some((l) => l.source === join || l.target === join), false)
  assert.equal(spec().entryIds.includes(join), false)
})

test('inserting a built-in block copies its definition into the swarm, once', () => {
  const def = allBlocks(spec(), []).find((b) => b.id === 'builtin-debate')!
  useStore.getState().insertBlock(def)
  useStore.getState().insertBlock(def)
  assert.equal(nodes().filter((n) => n.kind === 'block').length, 2)
  assert.equal((spec().blocks ?? []).filter((b) => b.id === 'builtin-debate').length, 1)
})

test('editing inside a block edits its definition, and the swarm itself is untouched', () => {
  const def = allBlocks(spec(), []).find((b) => b.id === 'builtin-debate')!
  useStore.getState().insertBlock(def)
  const agentsBefore = spec().agents.length
  useStore.getState().openBlock('builtin-debate')
  useStore.getState().addAgent()
  assert.equal(spec().agents.length, agentsBefore, 'the swarm did not grow')
  const inside = spec().blocks!.find((b) => b.id === 'builtin-debate')!.graph.agents
  assert.equal(inside.length, def.graph.agents.length + 1, 'the block did')
  useStore.getState().openBlock(undefined)
  assert.equal(useStore.getState().editingBlockId, undefined)
})

test('saving a selection as a block keeps the links between the chosen nodes only', () => {
  const saved = useStore.getState().saveBlock([FIRST, SECOND], 'Duo', 'two of them')!
  assert.ok(saved)
  assert.deepEqual(saved.graph.agents.map((a) => a.id).sort(), [FIRST, SECOND].sort())
  for (const link of saved.graph.links) {
    assert.ok([FIRST, SECOND].includes(link.source) && [FIRST, SECOND].includes(link.target))
  }
  assert.ok(useStore.getState().library.some((b) => b.id === saved.id), 'in this browser')
  assert.ok(spec().blocks?.some((b) => b.id === saved.id), 'and in the swarm')
  assert.equal(JSON.parse(localStorage.getItem('swarm-studio.blocks.v1') ?? '[]').length, 1)
})

test('detaching a block puts its agents inline and rewires what went in and out', () => {
  const def = allBlocks(spec(), []).find((b) => b.id === 'builtin-debate')!
  const block = useStore.getState().insertBlock(def)
  useStore.getState().addLink(FIRST, block)
  useStore.getState().addLink(block, SECOND)
  const agentsBefore = spec().agents.length

  useStore.getState().detachBlock(block)

  assert.equal(nodes().some((n) => n.id === block), false)
  assert.equal(spec().agents.length, agentsBefore + def.graph.agents.length)
  const ids = new Set([...spec().agents.map((a) => a.id), ...nodes().map((n) => n.id)])
  for (const link of spec().links) assert.ok(ids.has(link.source) && ids.has(link.target), `dangling ${link.id}`)
  // Into the two debaters, out of the judge (the block's Output node is gone, its source takes over).
  const into = spec().links.filter((l) => l.source === FIRST && spec().agents.some((a) => a.id === l.target && a.name.startsWith('Debate')))
  assert.equal(into.length, 2)
  const outOf = spec().links.filter((l) => l.target === SECOND && spec().agents.find((a) => a.id === l.source)?.name === 'Debate Judge')
  assert.equal(outOf.length, 1)
  assert.equal(nodes().some((n) => n.kind === 'output'), false)
})

test('keeping spawned helpers turns them into ordinary agents with a plain link', () => {
  const parent = spec().agents[0]
  useStore.setState({
    runGraph: {
      agents: [{ ...parent, id: `${parent.id}~s1`, name: 'Helper', position: { x: 1, y: 1 } }],
      nodes: [],
      links: [{ id: `${parent.id}~l1`, source: parent.id, target: `${parent.id}~s1`, label: 'spawned' }],
    },
  })
  const kept = useStore.getState().keepSpawned()
  assert.equal(kept, 1)
  const helper = spec().agents.find((a) => a.name === 'Helper')!
  assert.ok(!helper.id.includes('~'))
  const link = spec().links.find((l) => l.target === helper.id)!
  assert.equal(link.source, parent.id)
  assert.equal('label' in link, false)
  assert.equal(useStore.getState().runGraph.agents.length, 0)
})

test('undo brings a deleted node back', () => {
  const memory = useStore.getState().addNode('memory')
  useStore.getState().removeAgents([memory])
  useStore.getState().undo()
  assert.ok(nodes().some((n) => n.id === memory))
})

test('typing a link budget is one undo step, not one per keystroke', () => {
  const link = spec().links[0]
  const depth = useStore.getState().past.length
  for (const value of [1, 12, 120]) useStore.getState().updateLink(link.id, { maxTraversals: value })
  assert.equal(useStore.getState().past.length, depth + 1, 'the burst is one step')
  useStore.getState().undo()
  assert.equal('maxTraversals' in spec().links.find((l) => l.id === link.id)!, false, 'and undo takes all of it back')
})

test('clearing a node field removes the key', () => {
  const join = useStore.getState().addNode('join')
  useStore.getState().updateNode(join, { timeoutRounds: 3 } as never)
  useStore.getState().updateNode(join, { timeoutRounds: undefined } as never)
  assert.equal('timeoutRounds' in nodes().find((n) => n.id === join)!, false)
})

