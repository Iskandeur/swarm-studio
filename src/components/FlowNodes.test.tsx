/**
 * Mount tests for the non-agent node kinds (docs/graph-engineering.md §5, phase 5: "mount tests for
 * each node kind").
 *
 * `FlowNodeView` is rendered on its own, inside the two providers it needs, rather than inside a full
 * `<ReactFlow>`: React Flow only lays nodes out once it has measured them, and jsdom measures nothing.
 * The handles still render — they only need the React Flow store — so the "which side can a link
 * leave from" question is answerable here.
 */
import assert from 'node:assert/strict'
import { test, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import { ThemeProvider } from '@mui/material/styles'
import { FlowNodeView, type FlowFlowNode, type FlowNodeData } from './FlowNodes'
import { buildTheme } from '../theme'
import { useStore } from '../store'
import { describePredicate } from '../engine/predicates'
import type { FlowNode } from '../types'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const POSITION = { x: 0, y: 0 }

/** One of each kind, with the label its group must carry. */
const KINDS: Array<{ node: FlowNode; label: string }> = [
  {
    node: { id: 'c1', kind: 'condition', name: 'Enough evidence?', position: POSITION, predicate: { op: 'contains', value: 'guilty' } },
    label: 'Condition: Enough evidence?',
  },
  { node: { id: 'j1', kind: 'join', name: 'Both sides heard', position: POSITION, mode: 'all' }, label: 'Join: Both sides heard' },
  { node: { id: 'o1', kind: 'output', name: 'Verdict', position: POSITION }, label: 'Output: Verdict' },
  {
    node: { id: 'h1', kind: 'human', name: 'Editor sign-off', position: POSITION, prompt: 'Publish this apology?' },
    label: 'Human gate: Editor sign-off',
  },
  {
    node: { id: 'm1', kind: 'memory', name: 'Evidence', position: POSITION, mode: 'blackboard', wakeReaders: true, seed: [], maxChars: 2400 },
    label: 'Memory: Evidence',
  },
  { node: { id: 'b1', kind: 'block', name: 'Critic loop', position: POSITION, blockId: 'critic-loop' }, label: 'Block: Critic loop' },
]

function mount(data: FlowNodeData, options: { mode?: 'light' | 'dark'; selected?: boolean } = {}) {
  // Only what the component reads is meaningful; the rest satisfies the type React Flow hands a node.
  const props = {
    id: data.node.id,
    type: 'flow',
    data,
    selected: options.selected ?? false,
    dragging: false,
    draggable: true,
    selectable: true,
    deletable: true,
    isConnectable: true,
    zIndex: 0,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  } as NodeProps<FlowFlowNode>
  return render(
    <ThemeProvider theme={buildTheme(options.mode ?? 'light')}>
      <ReactFlowProvider>
        <FlowNodeView {...props} />
      </ReactFlowProvider>
    </ThemeProvider>,
  )
}

/** Swaps one store action for a spy, and always puts the real one back. */
function withSpy<K extends 'openBlock' | 'removeAgents'>(key: K, body: (spy: ReturnType<typeof vi.fn>) => void) {
  const original = useStore.getState()[key]
  const spy = vi.fn()
  useStore.setState({ [key]: spy } as never)
  try {
    body(spy)
  } finally {
    useStore.setState({ [key]: original } as never)
  }
}

test('every kind renders its name and its accessible label, in both themes', () => {
  for (const mode of ['light', 'dark'] as const) {
    for (const { node, label } of KINDS) {
      const { unmount } = mount({ node }, { mode })
      const group = screen.getByRole('group', { name: label })
      assert.ok(group.textContent?.includes(node.name), `${mode}: ${node.kind} shows its name`)
      unmount()
    }
  }
})

test('an output has no source handle; every other kind has both', () => {
  for (const { node } of KINDS) {
    const { container, unmount } = mount({ node })
    const sources = container.querySelectorAll('.react-flow__handle.source')
    const rights = container.querySelectorAll('.react-flow__handle-right')
    const targets = container.querySelectorAll('.react-flow__handle.target.react-flow__handle-left')
    assert.equal(targets.length, 1, `${node.kind} can receive a link`)
    if (node.kind === 'output') {
      // An output never forwards: a link drawn out of it could never carry a message.
      assert.equal(sources.length, 0, 'output has no source handle')
      assert.equal(rights.length, 0, 'output has no right handle')
    } else {
      assert.equal(sources.length, 1, `${node.kind} can start a link`)
      assert.equal(rights.length, 1, `${node.kind} source handle is on the right`)
    }
    unmount()
  }
})

test('the condition caption says the predicate in words', () => {
  const node = KINDS[0].node
  assert.equal(node.kind, 'condition')
  mount({ node })
  const described = describePredicate(node.kind === 'condition' ? node.predicate : undefined)
  assert.ok(screen.getByText(described), 'the short predicate is shown whole')
})

test('a long predicate is clipped to one line, and the whole of it is still reachable', () => {
  const node: FlowNode = {
    id: 'c2',
    kind: 'condition',
    name: 'Ready to ship?',
    position: POSITION,
    predicate: {
      op: 'all',
      of: [
        { op: 'json', path: 'verdict.score', cmp: 'gte', value: 8 },
        { op: 'visits', cmp: 'lt', value: 3 },
      ],
    },
  }
  mount({ node })
  const full = describePredicate(node.predicate)
  assert.ok(full.length > 40, 'the fixture is only meaningful if the predicate is long')
  // The tooltip names its child with the full text, so it is read out even though it is not drawn.
  const caption = screen.getByLabelText(full)
  assert.ok((caption.textContent ?? '').length <= 40, `caption is clipped: ${caption.textContent}`)
  assert.ok(caption.textContent?.endsWith('…'))
})

test('a join shows whether it waits for all branches or any', () => {
  mount({ node: KINDS[1].node })
  assert.ok(screen.getByText('all'))
})

test('a memory shows its entry count and its mode', () => {
  const node = KINDS[4].node
  const { unmount } = mount({ node, memoryCount: 3 })
  assert.ok(screen.getByText('3 entries'))
  assert.ok(screen.getByText('blackboard'))
  assert.ok(screen.getByTitle(/wakes every reader/i), 'a bus says so')
  unmount()

  // Before a run nothing is live yet: the seed is what a reader would receive.
  const seeded: FlowNode = {
    id: 'm2',
    kind: 'memory',
    name: 'Rules',
    position: POSITION,
    mode: 'document',
    wakeReaders: false,
    seed: [{ key: 'rules', value: 'No toasters.', author: 'seed', round: 0, version: 1 }],
    maxChars: 2400,
  }
  mount({ node: seeded })
  assert.ok(screen.getByText('1 entry'))
  assert.ok(screen.getByText('document'))
  assert.equal(screen.queryByTitle(/wakes every reader/i) === null, true, 'not a bus')
})

test('a flash ends on its own, without anything re-rendering the node', () => {
  vi.useFakeTimers()
  const node = KINDS[4].node
  mount({ node, memoryCount: 1, flashAt: Date.now(), lastWriter: { name: 'Detective', hue: 200 } })
  const group = screen.getByRole('group', { name: 'Memory: Evidence' })
  assert.equal(group.dataset.flashing, 'true')
  act(() => {
    vi.advanceTimersByTime(1300)
  })
  assert.equal(group.dataset.flashing, 'false')
})

test('an old flash does not light the node up', () => {
  mount({ node: KINDS[0].node, flashAt: Date.now() - 5000 })
  assert.equal(screen.getByRole('group', { name: 'Condition: Enough evidence?' }).dataset.flashing, 'false')
})

test("the block's open button opens that block", () => {
  const node = KINDS[5].node
  mount({ node })
  withSpy('openBlock', (spy) => {
    fireEvent.click(screen.getByRole('button', { name: 'Open block Critic loop' }))
    assert.deepEqual(spy.mock.calls, [['critic-loop']])
  })
})

test('a running block shows its progress', () => {
  mount({ node: KINDS[5].node, status: 'thinking', blockProgress: { running: 2, done: 1 } })
  assert.ok(screen.getByRole('progressbar'))
  assert.ok(screen.getByText('2 running · 1 done'))
})

test('the delete button removes the node by id, for every kind', () => {
  for (const { node } of KINDS) {
    const { unmount } = mount({ node })
    withSpy('removeAgents', (spy) => {
      fireEvent.click(screen.getByRole('button', { name: `Delete ${node.name}` }))
      assert.deepEqual(spy.mock.calls, [[[node.id]]], node.kind)
    })
    unmount()
  }
})

test('an ephemeral node has no delete button', () => {
  // A spawned node lives in the run state, not in the spec: there is nothing to delete.
  for (const { node } of KINDS) {
    const { unmount } = mount({ node, ephemeral: true })
    // Compared as a boolean: a failing assert holding a jsdom element makes the reporter serialise
    // the whole DOM tree, and the run hangs instead of failing.
    assert.equal(screen.queryByRole('button', { name: /^delete /i }) === null, true, `${node.kind} has no delete button`)
    unmount()
  }
})

test('a human gate that is waiting says so', () => {
  const node = KINDS[3].node
  const { unmount } = mount({ node, status: 'idle' })
  assert.ok(screen.getByText('Publish this apology?'), 'the prompt is the caption')
  assert.equal(screen.queryByText('waiting for you') === null, true, 'an idle gate does not claim to wait')
  unmount()

  mount({ node, status: 'waiting' })
  assert.ok(screen.getByText('waiting for you'))
})

test('an entry node carries the same bolt as an entry agent', () => {
  mount({ node: KINDS[5].node, isEntry: true })
  assert.ok(screen.getByTitle('receives the task'))
})
