/**
 * The presets are the product's first impression, and a broken one fails silently: a link pointing
 * at a deleted agent, an entry id that does not exist, a character with no demo voice. Nothing
 * crashes — the swarm just quietly does less than it looks like it does.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { PRESETS, DEFAULT_SPEC } from './presets'
import { DEMO_VOICES, demoVoiceFor } from './engine/providers'
import { resolveEntryIds } from './engine/runner'
import { BUILTIN_BLOCKS } from './blocks'

test('every preset is internally consistent', () => {
  for (const preset of PRESETS) {
    const nodes = preset.nodes ?? []
    const ids = new Set([...preset.agents.map((a) => a.id), ...nodes.map((n) => n.id)])
    assert.equal(ids.size, preset.agents.length + nodes.length, `${preset.name}: duplicate node ids`)
    // Two is enough when the shape grows at run time (spawn) or lives inside a block.
    assert.ok(ids.size >= 2, `${preset.name}: too small to show a shape`)

    for (const link of preset.links) {
      assert.ok(ids.has(link.source), `${preset.name}: link ${link.id} comes from nowhere`)
      assert.ok(ids.has(link.target), `${preset.name}: link ${link.id} goes nowhere`)
      assert.notEqual(link.source, link.target, `${preset.name}: link ${link.id} is a self-loop`)
    }
    assert.equal(
      new Set(preset.links.map((l) => l.id)).size,
      preset.links.length,
      `${preset.name}: duplicate link ids`,
    )
    for (const entry of preset.entryIds) {
      assert.ok(ids.has(entry), `${preset.name}: entry ${entry} is not on the graph`)
    }
    for (const node of nodes) {
      if (node.kind === 'block') {
        assert.ok(
          preset.blocks?.some((b) => b.id === node.blockId),
          `${preset.name}: block ${node.name} must carry its definition, or a pasted copy would not run`,
        )
      }
    }
    assert.deepEqual(resolveEntryIds(preset), preset.entryIds, `${preset.name}: entry points resolve`)
    assert.ok(preset.task.trim().length > 20, `${preset.name}: the task has to say something`)
    assert.ok(preset.maxRounds >= 3, `${preset.name}: too few rounds to reach the end`)
  }
})

test('every built-in block runs with no key: each of its characters has a demo voice', () => {
  for (const block of BUILTIN_BLOCKS) {
    for (const agent of block.graph.agents) {
      assert.equal(agent.provider, 'mock', `${block.name}/${agent.name}: blocks must need no key`)
      assert.ok(DEMO_VOICES[agent.name], `${block.name}/${agent.name} has no demo voice`)
    }
  }
})

test('every agent has a prompt with an actual instruction in it', () => {
  for (const preset of PRESETS) {
    for (const agent of preset.agents) {
      assert.ok(agent.systemPrompt.trim().length > 40, `${preset.name}/${agent.name}: thin prompt`)
      assert.ok(agent.model.trim().length > 0, `${preset.name}/${agent.name}: no model`)
      assert.equal(agent.provider, 'mock', `${preset.name}/${agent.name}: presets must need no key`)
    }
  }
})

test('every preset character has a demo voice, so pressing Run says something', () => {
  // The whole point of a shipped preset is that it works with no key. A character falling back to
  // the generic filler reads as "the swarm ignored my task", which is how a visitor leaves.
  for (const preset of PRESETS) {
    for (const agent of preset.agents) {
      assert.ok(
        DEMO_VOICES[agent.name],
        `${preset.name}/${agent.name} has no demo voice — it would speak generic filler`,
      )
      assert.ok(DEMO_VOICES[agent.name].length >= 2, `${agent.name}: needs a second line for a second turn`)
    }
  }
})

test('the demo voice is found from the system prompt the engine actually builds', () => {
  // `buildSystem` writes: You are "The Cat", one agent in a multi-agent swarm…
  const system = 'Be brief.\n\nYou are "The Cat", one agent in a multi-agent swarm working on a shared task.'
  assert.deepEqual(demoVoiceFor(system), DEMO_VOICES['The Cat'])
})

test('an unknown agent falls back to the generic lines instead of crashing', () => {
  const lines = demoVoiceFor('You are "Someone Nobody Wrote", one agent in a swarm.')
  assert.ok(Array.isArray(lines) && lines.length > 0)
  assert.notDeepEqual(lines, DEMO_VOICES['The Cat'])
  assert.deepEqual(demoVoiceFor('no name at all here'), lines, 'and so does a prompt with no name')
})

test('the default preset is the fan-out then fan-in one, and it ends on its own', () => {
  assert.equal(DEFAULT_SPEC, PRESETS[0])
  assert.deepEqual(DEFAULT_SPEC.entryIds, ['cat'])
  // One speaks, two speak at once, one merges: three rounds, and the last agent has no outgoing link
  // so the run stops by itself instead of hitting the round ceiling.
  const outgoing = (id: string) => DEFAULT_SPEC.links.filter((l) => l.source === id)
  assert.equal(outgoing('cat').length, 2, 'the entry agent fans out')
  assert.equal(outgoing('narrator').length, 0, 'the last agent is a leaf')
  assert.equal(DEFAULT_SPEC.links.filter((l) => l.target === 'narrator').length, 2, 'and it fans in')
})
