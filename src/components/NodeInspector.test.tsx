/**
 * The inspectors for conditions, joins, gates, memories, blocks, links and an agent's graph settings,
 * driven the way a person drives them: through labelled fields, selects and buttons, never by
 * calling the store directly. Each assertion reads the store back, because what matters is what a
 * run (or a shared swarm) will see, not what the form happens to display.
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useStore } from '../store'
import type { Agent, FlowNode, Link, SwarmSpec } from '../types'
import { AgentGraphSettings, LinkInspector, NodeInspector } from './NodeInspector'

function agent(id: string, name: string): Agent {
  return {
    id,
    name,
    provider: 'mock',
    model: 'demo-fast',
    systemPrompt: `You are ${name}.`,
    temperature: 0.7,
    hue: 262,
    position: { x: 0, y: 0 },
  }
}

const at = { x: 0, y: 0 }

/** One node of every kind, an access link, a guarded message link, and a block definition. */
const SPEC: SwarmSpec = {
  name: 'Inspector fixture',
  task: 'Find out who ate the cake.',
  topology: 'broadcast',
  maxRounds: 8,
  entryIds: [],
  agents: [agent('sleuth', 'Sleuth'), agent('judge', 'Judge')],
  nodes: [
    { id: 'cond', kind: 'condition', name: 'Guilty?', position: at, predicate: { op: 'always' } },
    { id: 'join', kind: 'join', name: 'Gather', position: at, mode: 'all' },
    { id: 'out', kind: 'output', name: 'Verdict', position: at },
    { id: 'gate', kind: 'human', name: 'Sign-off', position: at, prompt: 'Publish the verdict?' },
    {
      id: 'mem',
      kind: 'memory',
      name: 'Evidence',
      position: at,
      mode: 'blackboard',
      wakeReaders: false,
      seed: [],
      maxChars: 2400,
    },
    { id: 'blk', kind: 'block', name: 'Review', position: at, blockId: 'blk-review' },
  ],
  links: [
    // agent → memory: a write, by direction.
    { id: 'acc', source: 'sleuth', target: 'mem', kind: 'access' },
    // Unlabelled on purpose: the `choose` warning depends on it.
    { id: 'msg', source: 'sleuth', target: 'judge', guard: { op: 'contains', value: 'guilty' } },
    { id: 'c-out', source: 'cond', target: 'out', label: 'true' },
  ],
  blocks: [
    {
      id: 'blk-review',
      name: 'Review loop',
      description: 'A reviewer reads the verdict twice.',
      graph: { agents: [agent('rev', 'Reviewer')], nodes: [], links: [], entryIds: [] },
    },
  ],
}

beforeEach(() => {
  localStorage.clear()
  useStore.getState().replaceSwarm(SPEC)
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const spec = () => useStore.getState().spec
function node<K extends FlowNode['kind']>(id: string): Extract<FlowNode, { kind: K }> {
  const found = (spec().nodes ?? []).find((n) => n.id === id)
  assert.ok(found, `node ${id} exists`)
  return found as Extract<FlowNode, { kind: K }>
}
function link(id: string): Link {
  const found = spec().links.find((l) => l.id === id)
  assert.ok(found, `link ${id} exists`)
  return found
}

/** Opens a MUI select by its accessible name and clicks one of its options. */
function pick(select: RegExp, option: RegExp, scope: Pick<typeof screen, 'getByRole'> = screen) {
  fireEvent.mouseDown(scope.getByRole('combobox', { name: select }))
  // The menu is a portal on <body>, and a menu that just closed may still be fading out: the newest one is ours.
  const listbox = screen.getAllByRole('listbox').at(-1)!
  fireEvent.click(within(listbox).getByRole('option', { name: option }))
}

const preview = () => screen.getByRole('status').textContent ?? ''

test('every node kind mounts with its own controls', () => {
  const expected: Record<string, RegExp> = {
    cond: /links out of a condition are labelled true \/ false/i,
    join: /stop waiting after n rounds/i,
    out: /what a block returns to its parent/i,
    gate: /unlabelled link counts as approved/i,
    mem: /wake readers on every write/i,
    blk: /a block can contain itself/i,
  }
  for (const [id, marker] of Object.entries(expected)) {
    render(<NodeInspector nodeId={id} />)
    assert.ok(screen.getAllByText(marker).length > 0, `${id} shows ${marker}`)
    cleanup()
  }
  // An id that is not on the graph renders nothing rather than throwing.
  const { container } = render(<NodeInspector nodeId="nope" />)
  assert.equal(container.innerHTML, '')
})

test('renaming a condition updates the store', () => {
  render(<NodeInspector nodeId="cond" />)
  fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'Did they do it?' } })
  assert.equal(node('cond').name, 'Did they do it?')
})

test('switching the operator to "message contains" and typing a value writes the predicate', () => {
  render(<NodeInspector nodeId="cond" />)
  pick(/^condition/i, /^message contains/i)
  assert.deepEqual(node<'condition'>('cond').predicate, { op: 'contains', value: '' })

  fireEvent.change(screen.getByLabelText(/^text$/i), { target: { value: 'guilty' } })
  assert.deepEqual(node<'condition'>('cond').predicate, { op: 'contains', value: 'guilty' })

  fireEvent.click(screen.getByLabelText(/case-sensitive/i))
  assert.deepEqual(node<'condition'>('cond').predicate, { op: 'contains', value: 'guilty', caseSensitive: true })
})

test('a bad regex shows an error, and a fixed one clears it', () => {
  render(<NodeInspector nodeId="cond" />)
  pick(/^condition/i, /^message matches/i)
  const pattern = screen.getByLabelText(/^pattern$/i)

  fireEvent.change(pattern, { target: { value: '[unclosed' } })
  assert.ok(screen.getByText(/is not a valid pattern/i))

  // The catastrophic-backtracking shape is refused before it can run.
  fireEvent.change(pattern, { target: { value: '(a+)+b' } })
  assert.ok(screen.getByText(/repeats a repetition/i))

  fireEvent.change(pattern, { target: { value: 'guilty|innocent' } })
  assert.equal(screen.queryByText(/not a valid pattern|repeats a repetition/i), null)

  // `g` would make the test stateful; the form keeps only the flags the engine keeps.
  fireEvent.change(screen.getByLabelText(/^flags$/i), { target: { value: 'gi' } })
  assert.deepEqual(node<'condition'>('cond').predicate, { op: 'matches', pattern: 'guilty|innocent', flags: 'i' })
})

test('the preview line says the predicate in words, groups included', () => {
  render(<NodeInspector nodeId="cond" />)
  assert.equal(preview(), 'In words: always')

  pick(/^condition/i, /^all of/i)
  assert.match(preview(), /^In words: all of \(message contains ""\)$/)

  fireEvent.click(screen.getByRole('button', { name: /^add condition$/i }))
  pick(/^condition 2/i, /^round number/i, within(screen.getByRole('group', { name: 'Condition 2' })))
  fireEvent.change(within(screen.getByRole('group', { name: 'Condition 1' })).getByLabelText(/^text$/i), {
    target: { value: 'cake' },
  })
  assert.equal(preview(), 'In words: all of (message contains "cake" and round ≤ 5)')

  fireEvent.click(screen.getByRole('button', { name: /remove condition 1/i }))
  assert.equal(preview(), 'In words: all of (round ≤ 5)')
  assert.deepEqual(node<'condition'>('cond').predicate, { op: 'all', of: [{ op: 'round', cmp: 'lte', value: 5 }] })
})

test('a JSON value typed as a number is stored as a number, and "exists" drops the value', () => {
  render(<NodeInspector nodeId="cond" />)
  pick(/^condition/i, /^json field/i)
  fireEvent.change(screen.getByLabelText(/^field path$/i), { target: { value: 'verdict.score' } })
  pick(/^comparison/i, /at least/i)
  fireEvent.change(screen.getByLabelText(/^value$/i), { target: { value: '7' } })
  assert.deepEqual(node<'condition'>('cond').predicate, { op: 'json', path: 'verdict.score', cmp: 'gte', value: 7 })

  pick(/^comparison/i, /^exists/i)
  assert.equal('value' in node<'condition'>('cond').predicate, false)
})

test('clearing the link guard removes the key from the link', () => {
  render(<LinkInspector linkId="msg" />)
  assert.ok(screen.getByText('Sleuth → Judge'))
  assert.equal(preview(), 'In words: message contains "guilty"')

  pick(/^condition/i, /no condition/i)
  assert.equal('guard' in link('msg'), false)
  assert.equal(preview(), 'In words: always')
})

test('a message link field set then emptied is removed, not left blank', () => {
  render(<LinkInspector linkId="msg" />)

  const budget = screen.getByLabelText(/carry at most n messages/i)
  fireEvent.change(budget, { target: { value: '3' } })
  assert.equal(link('msg').maxTraversals, 3)
  fireEvent.change(budget, { target: { value: '' } })
  assert.equal('maxTraversals' in link('msg'), false)

  const label = screen.getByLabelText(/^label$/i)
  fireEvent.change(label, { target: { value: 'guilty' } })
  assert.equal(link('msg').label, 'guilty')
  fireEvent.change(label, { target: { value: '' } })
  assert.equal('label' in link('msg'), false)

  fireEvent.click(screen.getByLabelText(/default branch/i))
  assert.equal(link('msg').isDefault, true)
  fireEvent.click(screen.getByLabelText(/default branch/i))
  assert.equal('isDefault' in link('msg'), false)
})

test('the access select writes access, and an access link shows nothing else', () => {
  render(<LinkInspector linkId="acc" />)
  // Drawn agent → memory with no explicit access: the select shows what the engine grants.
  assert.match(screen.getByRole('combobox', { name: /^access/i }).textContent ?? '', /^write/i)
  assert.equal(screen.queryByLabelText(/^label$/i), null)
  assert.equal(screen.queryByRole('combobox', { name: /^condition/i }), null)

  pick(/^access/i, /read & write/i)
  assert.equal(link('acc').access, 'readwrite')

  fireEvent.click(screen.getByRole('button', { name: /cut link/i }))
  assert.equal(spec().links.some((l) => l.id === 'acc'), false)
})

test('the memory mode select writes mode, and the panel lists who reaches it', () => {
  render(<NodeInspector nodeId="mem" />)
  const row = screen.getByText('Sleuth').parentElement!
  assert.ok(within(row).getByText('writes'))

  pick(/^mode/i, /^document/i)
  assert.equal(node<'memory'>('mem').mode, 'document')

  // A document is one text, with no key.
  fireEvent.change(screen.getByLabelText(/^seed text$/i), { target: { value: 'The toaster was in the kitchen.' } })
  assert.deepEqual(
    node<'memory'>('mem').seed.map(({ key, value }) => ({ key, value })),
    [{ key: '', value: 'The toaster was in the kitchen.' }],
  )
})

test('adding a seed entry writes seed', () => {
  render(<NodeInspector nodeId="mem" />)
  fireEvent.click(screen.getByRole('button', { name: /add entry/i }))
  assert.equal(node<'memory'>('mem').seed.length, 1)

  fireEvent.change(screen.getByLabelText(/seed entry 1 key/i), { target: { value: 'suspect' } })
  fireEvent.change(screen.getByLabelText(/seed entry 1 value/i), { target: { value: 'The toaster' } })
  assert.deepEqual(node<'memory'>('mem').seed, [
    { key: 'suspect', value: 'The toaster', author: 'seed', round: 0, version: 1 },
  ])

  fireEvent.click(screen.getByRole('button', { name: /remove seed entry 1/i }))
  assert.deepEqual(node<'memory'>('mem').seed, [])
})

test('a memory reader cannot be starved below 200 characters', () => {
  render(<NodeInspector nodeId="mem" />)
  fireEvent.change(screen.getByLabelText(/characters a reader sees per turn/i), { target: { value: '12' } })
  assert.equal(node<'memory'>('mem').maxChars, 200)
})

test('dispatch "choose" is written, and warns while no outgoing link has a label', () => {
  render(<AgentGraphSettings agentId="sleuth" />)
  const warning = /none of its outgoing links has a label/i
  assert.equal(screen.queryByText(warning), null)

  pick(/^dispatch/i, /choose its branch/i)
  assert.equal(spec().agents.find((a) => a.id === 'sleuth')!.dispatch, 'choose')
  assert.ok(screen.getByText(warning))

  // Label the link from elsewhere (the canvas, say): the warning goes, the branch is listed.
  act(() => useStore.getState().updateLink('msg', { label: 'guilty' }))
  assert.equal(screen.queryByText(warning), null)
  assert.ok(screen.getByText(/branches: guilty → judge/i))

  // Back to inherit stores no choice at all.
  pick(/^dispatch/i, /follow the swarm topology/i)
  assert.equal(spec().agents.find((a) => a.id === 'sleuth')!.dispatch, undefined)
})

test('an agent lists its memories and may be allowed to spawn', () => {
  render(<AgentGraphSettings agentId="sleuth" />)
  const row = screen.getByText('Evidence').parentElement!
  assert.ok(within(row).getByText('writes'))

  fireEvent.click(screen.getByLabelText(/may spawn helpers/i))
  assert.equal(spec().agents.find((a) => a.id === 'sleuth')!.canSpawn, true)

  cleanup()
  render(<AgentGraphSettings agentId="judge" />)
  assert.ok(screen.getByText(/not connected to any memory/i))
})

test('the block shows its definition and the Detach button calls detachBlock', () => {
  const original = useStore.getState().detachBlock
  const detach = vi.fn()
  useStore.setState({ detachBlock: detach })
  try {
    render(<NodeInspector nodeId="blk" />)
    assert.ok(screen.getByText('Review loop'))
    assert.ok(screen.getByText('A reviewer reads the verdict twice.'))

    fireEvent.click(screen.getByRole('button', { name: /detach into agents/i }))
    assert.deepEqual(detach.mock.calls, [['blk']])
  } finally {
    useStore.setState({ detachBlock: original })
  }
})

test('block overrides are written while they override something, and dropped after', () => {
  render(<NodeInspector nodeId="blk" />)
  pick(/^provider for every agent inside/i, /^anthropic$/i)
  const filled = node<'block'>('blk').overrides
  assert.equal(filled?.provider, 'anthropic')
  assert.ok(filled?.model, 'an empty model override is filled with a model that exists on the provider')

  pick(/^provider for every agent inside/i, /^inherit/i)
  fireEvent.change(screen.getByLabelText(/^model for every agent inside$/i), { target: { value: '' } })
  // `updateNode` merges, so the key can only be set to undefined — which JSON drops on save.
  assert.equal(node<'block'>('blk').overrides, undefined)
  assert.equal(JSON.stringify(node('blk')).includes('overrides'), false)
})

test('Open inside switches the canvas to the block definition', () => {
  render(<NodeInspector nodeId="blk" />)
  fireEvent.click(screen.getByRole('button', { name: /open inside/i }))
  assert.equal(useStore.getState().editingBlockId, 'blk-review')
})

test('the join and the gate write their own fields', () => {
  render(<NodeInspector nodeId="join" />)
  const timeout = screen.getByLabelText(/stop waiting after n rounds/i)
  fireEvent.change(timeout, { target: { value: '2' } })
  assert.equal(node<'join'>('join').timeoutRounds, 2)
  fireEvent.change(timeout, { target: { value: '' } })
  assert.equal(node<'join'>('join').timeoutRounds, undefined)

  pick(/^mode/i, /^any/i)
  assert.equal(node<'join'>('join').mode, 'any')
  cleanup()

  render(<NodeInspector nodeId="gate" />)
  fireEvent.change(screen.getByLabelText(/^prompt$/i), { target: { value: 'Is this fair?' } })
  assert.equal(node<'human'>('gate').prompt, 'Is this fair?')
})

test('a condition can be marked to receive the task, and deleted', () => {
  render(<NodeInspector nodeId="cond" />)
  fireEvent.click(screen.getByText(/make it receive the task/i))
  assert.deepEqual(spec().entryIds, ['cond'])

  fireEvent.click(screen.getByRole('button', { name: /delete condition guilty\?/i }))
  assert.equal((spec().nodes ?? []).some((n) => n.id === 'cond'), false)
  assert.equal(spec().links.some((l) => l.source === 'cond'), false, 'its links go with it')
})
