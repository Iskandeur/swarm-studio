/**
 * The run lifecycle as the store sees it: stopping, restarting, and what survives.
 *
 * Both cases here came out of an adversarial probe, and both are the kind of defect that makes a
 * live demo look broken to the person watching rather than to a test.
 */
import assert from 'node:assert/strict'
import { test, beforeEach, afterEach } from 'vitest'
import { useStore } from './store'
import type { SwarmSpec } from './types'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const soloSwarm = (): SwarmSpec => ({
  name: 'solo',
  task: 'Say something at length.',
  agents: [
    {
      id: 'a',
      name: 'A',
      provider: 'mock',
      model: 'demo-verbose', // slow on purpose, so there is a mid-stream to interrupt
      systemPrompt: 'You are A.',
      temperature: 0.5,
      hue: 262,
      position: { x: 0, y: 0 },
    },
  ],
  links: [],
  topology: 'broadcast',
  maxRounds: 3,
  entryIds: ['a'],
})

beforeEach(() => {
  localStorage.clear()
  useStore.setState({ spec: soloSwarm(), past: [], future: [], transcript: [], statuses: {} })
})
afterEach(() => useStore.getState().stop())

test('Stop keeps the words that already arrived', async () => {
  useStore.getState().start()
  await wait(260)
  const mid = useStore.getState().transcript[0]?.text ?? ''
  assert.ok(mid.length > 0, 'something should have streamed by now')

  useStore.getState().stop()
  await wait(120)

  const after = useStore.getState().transcript[0]
  assert.equal(after.status, 'stopped')
  assert.ok(
    after.text.startsWith(mid),
    `the partial answer must survive a Stop, got ${JSON.stringify(after.text.slice(0, 40))}`,
  )
})

test('a restart is not polluted by the runner it replaced', async () => {
  useStore.getState().start()
  await wait(150)
  useStore.getState().stop()
  useStore.getState().start() // immediately, while the old runner is still unwinding

  await wait(200)
  assert.equal(useStore.getState().phase, 'running', 'the fresh run must still call itself running')

  // And the old runner must not have appended its messages to the new transcript either.
  const ids = useStore.getState().transcript.map((e) => e.id)
  assert.equal(new Set(ids).size, ids.length, 'no duplicated entries from the stale runner')
})
