/**
 * Store mechanics: bulk edits, deletion, undo/redo. These are the operations that can quietly
 * corrupt a swarm — a link pointing at a deleted agent, or an undo that loses a step — so they are
 * tested at the store level rather than through the UI.
 */
import assert from 'node:assert/strict'
import { test, beforeEach } from 'vitest'
import { useStore } from './store'
import { PRESETS } from './presets'

beforeEach(() => {
  localStorage.clear()
  useStore.getState().loadPreset(PRESETS[0])
})

const spec = () => useStore.getState().spec

test('deleting an agent takes its links and its entry flag with it', () => {
  useStore.getState().toggleEntry('a2')
  useStore.getState().select('a2')
  assert.ok(spec().entryIds.includes('a2'))

  useStore.getState().removeAgent('a2')

  assert.equal(spec().agents.some((a) => a.id === 'a2'), false)
  assert.equal(spec().links.some((l) => l.source === 'a2' || l.target === 'a2'), false)
  assert.equal(spec().entryIds.includes('a2'), false)
  assert.equal(useStore.getState().selectedId, undefined, 'the deleted agent stops being selected')
})

test('deleting several at once leaves no dangling link either', () => {
  useStore.getState().setMulti(['a1', 'a3'])
  useStore.getState().removeAgents(['a1', 'a3'])

  assert.deepEqual(spec().agents.map((a) => a.id), ['a2'])
  assert.deepEqual(spec().links, [])
  assert.deepEqual(useStore.getState().multiIds, [], 'the bulk selection drops the dead ids')
})

test('a bulk patch reaches every ticked agent and nobody else', () => {
  useStore.getState().applyToAgents(['a1', 'a3'], { model: 'shared-model', provider: 'openai' })

  const byId = Object.fromEntries(spec().agents.map((a) => [a.id, a]))
  assert.equal(byId.a1.model, 'shared-model')
  assert.equal(byId.a3.model, 'shared-model')
  assert.equal(byId.a1.provider, 'openai')
  assert.equal(byId.a2.model, 'demo-terse', 'the unticked agent is untouched')
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
  useStore.getState().applyToAgents(['a1'], { model: 'peculiar-model', systemPrompt: 'be odd' })
  useStore.getState().duplicateAgent('a1')

  const copy = spec().agents.at(-1)!
  assert.notEqual(copy.id, 'a1')
  assert.equal(copy.model, 'peculiar-model')
  assert.equal(copy.systemPrompt, 'be odd')
  assert.match(copy.name, /copy/i)
  // Offset, so it does not hide under the original.
  assert.notDeepEqual(copy.position, spec().agents.find((a) => a.id === 'a1')!.position)
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

  useStore.getState().applyToAgents(['a1', 'a2'], { provider: 'anthropic', model: 'claude-sonnet-5' })
  assert.equal(spec().agents.find((a) => a.id === 'a1')!.model, 'claude-sonnet-5')

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
