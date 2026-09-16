/**
 * Shared memory, without the runner: what a write changes, and what a reader is shown.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { applyWrite, createMemoryState, readValue, renderMemory } from './memory.ts'
import type { MemoryNode } from '../types.ts'

function memory(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: 'm',
    kind: 'memory',
    name: 'Board',
    position: { x: 0, y: 0 },
    mode: 'blackboard',
    wakeReaders: false,
    seed: [],
    maxChars: 2400,
    ...overrides,
  }
}

describe('writes', () => {
  test('a blackboard keeps the latest value per key, with a version per key', () => {
    const state = createMemoryState(memory())
    applyWrite(state, { key: 'suspect', value: 'the butler' }, 'A', 1)
    applyWrite(state, { key: 'motive', value: 'jam' }, 'B', 1)
    const third = applyWrite(state, { key: 'suspect', value: 'the toaster' }, 'C', 2)
    assert.equal(readValue(state, 'suspect'), 'the toaster')
    assert.equal(readValue(state, 'SUSPECT'), 'the toaster', 'keys are read case-insensitively')
    assert.equal(third.entry?.version, 2)
    assert.equal(readValue(state, 'nothing'), undefined)
  })

  test('a blackboard refuses a write with no key, rather than losing it', () => {
    const state = createMemoryState(memory())
    const result = applyWrite(state, { value: 'floating fact' }, 'A', 1)
    assert.equal(result.ok, false)
    assert.match(result.problem ?? '', /needs key/)
    assert.equal(state.entries.length, 0)
  })

  test('a document is replaced whole, and counts its versions', () => {
    const state = createMemoryState(memory({ mode: 'document' }))
    applyWrite(state, { value: 'Draft one.' }, 'Writer', 1)
    const second = applyWrite(state, { value: 'Draft two, shorter.' }, 'Editor', 2)
    assert.equal(second.entry?.version, 2)
    assert.equal(readValue(state, 'anything'), 'Draft two, shorter.')
    assert.match(renderMemory(state, ''), /version 2, last edited by Editor/)
  })

  test('an empty write is refused', () => {
    const state = createMemoryState(memory({ mode: 'log' }))
    assert.equal(applyWrite(state, { value: '   ' }, 'A', 1).ok, false)
  })

  test('seed entries are there before the first round', () => {
    const state = createMemoryState(
      memory({ seed: [{ key: 'rule', value: 'No cats on the table.', author: 'seed', round: 0, version: 1 }] }),
    )
    assert.equal(readValue(state, 'rule'), 'No cats on the table.')
  })
})

describe('what a reader sees', () => {
  test('a small log is shown whole, newest first', () => {
    const state = createMemoryState(memory({ mode: 'log' }))
    applyWrite(state, { value: 'first' }, 'A', 1)
    applyWrite(state, { value: 'second' }, 'B', 2)
    assert.equal(renderMemory(state, ''), '- B (round 2): second\n- A (round 1): first')
  })

  test('an empty memory says so', () => {
    assert.equal(renderMemory(createMemoryState(memory()), ''), '(empty)')
    assert.equal(renderMemory(createMemoryState(memory({ mode: 'document' })), ''), '(empty document)')
  })

  test('over budget, the entries that concern the question get through, and the rest is counted', () => {
    const seed = Array.from({ length: 40 }, (_, i) => ({
      key: `fact-${i}`,
      value: i === 7 ? 'The lighthouse keeper feeds the seagulls at dawn.' : `Unrelated filler number ${i} about spreadsheets and quarterly budgets.`,
      author: 'seed',
      round: 0,
      version: 1,
    }))
    const state = createMemoryState(memory({ seed, maxChars: 400 }))
    const view = renderMemory(state, 'Who feeds the seagulls near the lighthouse?')
    assert.ok(view.length <= 400, `within budget (${view.length})`)
    assert.match(view, /lighthouse keeper feeds the seagulls/)
    assert.match(view, /more entries not shown/)
  })

  test('a document longer than the budget is cut, and says it was', () => {
    const state = createMemoryState(memory({ mode: 'document', maxChars: 200 }))
    applyWrite(state, { value: 'word '.repeat(200) }, 'A', 1)
    const view = renderMemory(state, '')
    assert.ok(view.length <= 200 + '… (truncated)'.length)
    assert.match(view, /truncated/)
  })
})
