/**
 * The graph-engineering presets and the built-in blocks, run end to end on the demo provider.
 *
 * A visitor presses Run with no key. If a tag is misspelt in a demo voice, or a guard does not match
 * its line, nothing crashes: the swarm just stops halfway and looks broken. These tests are the only
 * thing that would notice.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { runSwarm, type OutputEvent, type RunnerCallbacks, type SpawnEvent } from './engine/runner'
import { createRunSession } from './engine/session'
import { PRESETS } from './presets'
import { BUILTIN_BLOCKS } from './blocks'
import type { SwarmSpec, TranscriptEntry } from './types'

async function run(spec: SwarmSpec) {
  const session = createRunSession()
  const entries = new Map<string, TranscriptEntry>()
  const outputs: OutputEvent[] = []
  const spawns: SpawnEvent[] = []
  const notices: string[] = []
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
      entries.get(id)!.text += delta
    },
    onMessageEnd: (id, patch) => entries.set(id, { ...entries.get(id)!, ...patch }),
    onTransit: () => {},
    onOutput: (e) => outputs.push(e),
    onSpawn: (e) => spawns.push(e),
    onNotice: (n) => notices.push(n),
    // The visitor approves: that is the path the demo is written for.
    onHumanGate: (gate) => setTimeout(() => session.decideGate(gate.id, { approved: true, text: gate.text }), 50),
  }
  await runSwarm(spec, {}, cb, new AbortController().signal, { session })
  return { phase, error, outputs, spawns, notices, transcript: [...entries.values()] }
}

const preset = (name: string) => {
  const found = PRESETS.find((p) => p.name === name)
  assert.ok(found, name)
  return found
}

describe('graph-engineering presets', () => {
  test('The Fridge Tribunal reaches a verdict through the board, the join, the condition and the gate', { timeout: 60_000 }, async () => {
    const r = await run(preset('The Fridge Tribunal'))
    assert.equal(r.phase, 'done', r.error ?? '')
    assert.equal(r.outputs.length, 1)
    assert.match(r.outputs[0].text, /guilty of yoghurt/)
    const detective = r.transcript.find((e) => e.agentId === 'detective')!
    assert.ok(detective.actions?.some((a) => a.text === '→ Evidence.suspect'))
    assert.ok(!detective.text.includes('<write'), 'the tags never reach the transcript')
    // The prosecutor speaks once, with both testimonies in hand.
    assert.equal(r.transcript.filter((e) => e.agentId === 'prosecutor').length, 1)
  })

  test('The Delegation Spiral grows three levels, is refused the intern, and the answer climbs back', { timeout: 60_000 }, async () => {
    const r = await run(preset('The Delegation Spiral'))
    assert.equal(r.phase, 'done', r.error ?? '')
    assert.deepEqual(
      r.spawns.map((s) => s.node.name),
      ['VP of Summaries', 'Director of Brevity', 'Senior Manager'],
    )
    assert.ok(r.notices.some((n) => /The Intern.*depth limit/.test(n)))
    assert.equal(r.outputs.length, 1)
    assert.match(r.outputs[0].text, /board deck/)
    assert.ok(r.transcript.some((e) => /unplugged/.test(e.text)), 'the truth was found, down there')
  })

  test('The Recursive Excuse recurses to the depth limit and merges back up', { timeout: 60_000 }, async () => {
    const r = await run(preset('The Recursive Excuse'))
    assert.equal(r.phase, 'done', r.error ?? '')
    const solverDepths = r.transcript.filter((e) => e.agentId === 'solver').map((e) => e.path?.length)
    assert.deepEqual(solverDepths, [1, 2, 3])
    const top = r.outputs.filter((o) => o.path.length === 0)
    assert.equal(top.length, 1)
    assert.match(top[0].text, /Scaling that back up/)
  })
})

describe('built-in blocks, each dropped alone into a swarm', () => {
  const alone = (blockId: string): SwarmSpec => {
    const def = BUILTIN_BLOCKS.find((b) => b.id === blockId)!
    return {
      name: def.name,
      task: 'Write a one-line memo cancelling the Friday meeting.',
      topology: 'broadcast',
      maxRounds: 30,
      agents: [],
      nodes: [
        { id: 'b', kind: 'block', name: def.name, blockId, position: { x: 0, y: 0 } },
        { id: 'o', kind: 'output', name: 'Out', position: { x: 300, y: 0 } },
      ],
      links: [{ id: 'bo', source: 'b', target: 'o' }],
      entryIds: ['b'],
      blocks: [def],
    }
  }
  const topOutput = (r: Awaited<ReturnType<typeof run>>) => r.outputs.filter((o) => o.path.length === 0).map((o) => o.text)

  test('Critic loop rewrites until the score passes', { timeout: 60_000 }, async () => {
    const r = await run(alone('builtin-critic-loop'))
    assert.equal(r.phase, 'done', r.error ?? '')
    assert.equal(r.transcript.filter((e) => e.agentId === 'writer').length, 2)
    assert.match(topOutput(r)[0], /free cake/)
  })

  test('Debate joins both sides before the judge', { timeout: 60_000 }, async () => {
    const r = await run(alone('builtin-debate'))
    assert.equal(r.phase, 'done', r.error ?? '')
    assert.equal(r.transcript.filter((e) => e.agentId === 'judge').length, 1)
    assert.match(topOutput(r)[0], /Ruling/)
  })

  test('Map-reduce spawns its workers, then merges once they are all back', { timeout: 60_000 }, async () => {
    const r = await run(alone('builtin-map-reduce'))
    assert.equal(r.phase, 'done', r.error ?? '')
    assert.equal(r.spawns.length, 3)
    assert.equal(r.transcript.filter((e) => e.agentId === 'reducer').length, 1)
    assert.match(topOutput(r)[0], /three thirds/)
  })

  test('Recursive solver terminates on its own', { timeout: 60_000 }, async () => {
    const r = await run({ ...alone('builtin-recursive-solver'), maxDepth: 2 })
    assert.equal(r.phase, 'done', r.error ?? '')
    assert.deepEqual(r.transcript.filter((e) => e.agentId === 'solver').map((e) => e.path?.length), [1, 2])
    assert.equal(topOutput(r).length, 1)
  })
})
