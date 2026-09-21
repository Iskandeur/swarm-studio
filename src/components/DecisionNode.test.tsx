/**
 * The Decision node in the interface: its card on the canvas (questions before a run, the chosen
 * answer and a probability bar per option after one), its inspector, and the condition editor's
 * "Decision answer" operator. The engine side is in engine/decisions.test.ts and decision-routing.test.ts.
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ReactFlowProvider, type NodeProps } from '@xyflow/react'
import { ThemeProvider } from '@mui/material/styles'
import { FlowNodeView, type FlowFlowNode, type FlowNodeData } from './FlowNodes'
import { LinkInspector, NodeInspector } from './NodeInspector'
import { buildTheme } from '../theme'
import { useStore } from '../store'
import { PRESETS } from '../presets'
import type { DecisionNode, SwarmSpec } from '../types'

const TRIAGE = PRESETS.find((p) => p.name.startsWith('Triage')) as SwarmSpec
const decisionNode = () => (useStore.getState().spec.nodes ?? []).find((n) => n.kind === 'decision') as DecisionNode

beforeEach(() => {
  localStorage.clear()
  useStore.setState({ keys: {} })
  useStore.getState().replaceSwarm(TRIAGE)
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

function mount(data: FlowNodeData) {
  const props = {
    id: data.node.id,
    type: 'flow',
    data,
    selected: false,
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
    <ThemeProvider theme={buildTheme('dark')}>
      <ReactFlowProvider>
        <FlowNodeView {...props} />
      </ReactFlowProvider>
    </ThemeProvider>,
  )
}

test('before a run the card lists its questions and says it writes no text', () => {
  mount({ node: decisionNode() })
  const card = screen.getByRole('group', { name: 'Decision: Triage' })
  assert.match(card.textContent ?? '', /demo decider · no text generated/)
  assert.ok(within(card).getByTestId('decision-route'))
  assert.ok(within(card).getByTestId('decision-blocked'))
  assert.ok(card.querySelector('.react-flow__handle.source') && card.querySelector('.react-flow__handle.target'), 'it links both ways')
})

test('after a call it shows the choice, its confidence, and a bar per option sized by probability', () => {
  mount({
    node: decisionNode(),
    status: 'done',
    answers: {
      route: { type: 'choice', choice: 'billing', confidence: 0.92, probabilities: { billing: 0.9, technical: 0.08, account: 0.02 } },
      blocked: { type: 'noul', noul: 0.31, yes: false },
    },
  })
  const route = screen.getByTestId('decision-route')
  assert.match(route.textContent ?? '', /billing · 92%/)
  // Emotion writes the width into a class, not the style attribute: it is read from the computed style.
  const widths = [...route.querySelectorAll('div[aria-hidden] > div > div')].map((bar) => getComputedStyle(bar).width)
  assert.deepEqual(widths, ['90%', '8%', '2%'], 'one bar per option, sized by its probability')
  assert.match(screen.getByTestId('decision-blocked').textContent ?? '', /no · p 0\.31/)
})

test('the inspector edits questions, switches types, and says what is wrong before the run', () => {
  const id = decisionNode().id
  render(<NodeInspector nodeId={id} />)
  assert.ok(screen.getByText('DECISION'))

  // A new question arrives as a two-option choice with a free name.
  fireEvent.click(screen.getByRole('button', { name: /add question/i }))
  assert.equal(decisionNode().questions.length, 3)
  const added = decisionNode().questions[2]
  assert.equal(added.type, 'choice')
  assert.equal(added.options?.length, 2)

  // Turned into a score, it gets levels instead of options.
  const third = screen.getByRole('group', { name: 'Question 3' })
  fireEvent.mouseDown(within(third).getByRole('combobox'))
  fireEvent.click(screen.getByRole('option', { name: 'Score' }))
  assert.equal(decisionNode().questions[2].type, 'score')
  assert.deepEqual(decisionNode().questions[2].levels, ['low', 'medium', 'high'])
  assert.equal(decisionNode().questions[2].options, undefined)

  // A name with a space is not a path segment: it is rewritten as one word as it is typed.
  fireEvent.change(within(third).getByLabelText('Question 3 name'), { target: { value: 'how bad' } })
  assert.equal(decisionNode().questions[2].name, 'how_bad')

  // Down to one option, a choice cannot be asked: the inspector says so.
  const first = screen.getByRole('group', { name: 'Question 1' })
  fireEvent.click(within(first).getByRole('button', { name: 'Remove option 3 of question 1' }))
  fireEvent.click(within(first).getByRole('button', { name: 'Remove option 2 of question 1' }))
  assert.ok(screen.getByText(/"route": a choice needs at least two options/))
})

test('switching to OpenRouter picks its model, and warns while the key is missing', () => {
  const id = decisionNode().id
  render(<NodeInspector nodeId={id} />)
  fireEvent.mouseDown(screen.getByRole('combobox', { name: /decision provider/i }))
  fireEvent.click(screen.getByRole('option', { name: 'OpenRouter decisions' }))
  assert.equal(decisionNode().provider, 'openrouter')
  assert.equal(decisionNode().model, 'typesafe/jev-1.13')
  assert.ok(screen.getByText(/add it in settings/i))
})

test('a link out of a decision offers its answers as condition paths, and explains the default branch', () => {
  render(<LinkInspector linkId="d4" />)
  assert.ok(screen.getByText(/taken only when no other link out of this decision node matches/i))
  fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Condition' }))
  fireEvent.click(screen.getByRole('option', { name: 'Decision answer' }))
  const guard = useStore.getState().spec.links.find((l) => l.id === 'd4')!.guard
  assert.deepEqual(guard, { op: 'decision', path: 'route.choice', cmp: 'eq', value: '' })
  assert.ok(screen.getByText(/In words: decision route\.choice/))
})
