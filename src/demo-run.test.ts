/**
 * Runs the default preset end to end with the demo provider and asserts the SHAPE of what a visitor
 * reads on their first click: who speaks, in which round, in character.
 *
 * This is the test I could not do by eye — there is no browser on this machine — so it prints the
 * transcript as well, which is how the scenario was actually proof-read.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { runSwarm, type RunnerCallbacks } from './engine/runner'
import { DEFAULT_SPEC } from './presets'

test('the default swarm reads as one speaker, then two at once, then a verdict', { timeout: 20_000 }, async () => {
  const rows: Array<{ round: number; who: string; text: string }> = []
  const byEntry = new Map<string, { round: number; who: string; text: string }>()
  const nameOf = (id: string) => DEFAULT_SPEC.agents.find((a) => a.id === id)?.name ?? id

  const cb: RunnerCallbacks = {
    onPhase: () => {},
    onRound: () => {},
    onAgentStatus: () => {},
    onMessageStart: (entry) => {
      const row = { round: entry.round, who: nameOf(entry.agentId), text: '' }
      byEntry.set(entry.id, row)
      rows.push(row)
    },
    onMessageDelta: (id, delta) => {
      const row = byEntry.get(id)
      if (row) row.text += delta
    },
    onMessageEnd: () => {},
    onTransit: () => {},
  }

  await runSwarm(DEFAULT_SPEC, {}, cb, new AbortController().signal)

  for (const row of rows) console.log(`\n[round ${row.round}] ${row.who}: ${row.text}`)

  const inRound = (n: number) => rows.filter((r) => r.round === n).map((r) => r.who).sort()
  assert.deepEqual(inRound(1), ['The Cat'], 'round 1: one voice, so the fan-out is legible')
  assert.deepEqual(inRound(2), ['The Door', 'The Human'], 'round 2: two at once')
  assert.deepEqual(inRound(3), ['The Narrator'], 'round 3: the merge')
  assert.equal(rows.length, 4, 'four messages, then it stops on its own')

  // In character, not filler: each line has to be the one written for that agent.
  assert.match(rows[0].text, /third person|cat (requires|does not)/i)
  const door = rows.find((r) => r.who === 'The Door')!
  assert.match(door.text, /forty-one|millimetres|hinge/i, 'the door reports facts')
  const human = rows.find((r) => r.who === 'The Human')!
  assert.match(human.text, /circled back|uplift|aligned/i, 'the human speaks deck')
  assert.match(rows[3].text, /threshold|magnificent|documentary|rain/i, 'the narrator lands the joke')

  // And nobody fell back to the generic filler.
  for (const row of rows) {
    assert.doesNotMatch(row.text, /hand-off between steps|throughput, not correctness/, `${row.who} spoke filler`)
  }
})
