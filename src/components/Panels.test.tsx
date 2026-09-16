/**
 * Mount tests for the graph-engineering panels: memory, human gate, block library, node palette.
 *
 * Each one renders a panel on its own against the real store, drives it the way a person would, and
 * checks the store — not the markup — for the outcome. What the engine does with a gate decision or a
 * write is tested in `src/engine`; here the question is whether the UI shows what the store holds and
 * hands the store what the person chose.
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useStore } from '../store'
import { BUILTIN_BLOCKS } from '../blocks'
import { nodesOf } from '../engine/graph'
import { setViewport } from '../test-setup'
import type { Agent, MemoryEntry, MemoryNode, SwarmSpec } from '../types'
import type { PendingGate } from '../engine/session'
import { MemoryPanel } from './MemoryPanel'
import { GateDialog } from './GateDialog'
import { BlockLibrary } from './BlockLibrary'
import { NodePalette } from './NodePalette'

// Tests replace these with spies. The store is a module singleton, so a spy left in place would
// swallow the real action in every later test of this file.
const ORIGINAL = (({ decideGate, keepSpawned, openBlock }) => ({ decideGate, keepSpawned, openBlock }))(useStore.getState())

const agent = (id: string, name: string, hue: number): Agent => ({
  id,
  name,
  provider: 'mock',
  model: 'demo-fast',
  systemPrompt: 'Be brief.',
  temperature: 0.7,
  hue,
  position: { x: 0, y: 0 },
})

const entry = (key: string, value: string, author: string, round: number, version: number): MemoryEntry => ({
  key,
  value,
  author,
  round,
  version,
})

const memory = (patch: Pick<MemoryNode, 'id' | 'name' | 'mode'> & Partial<MemoryNode>): MemoryNode => ({
  kind: 'memory',
  position: { x: 0, y: 200 },
  wakeReaders: false,
  seed: [],
  maxChars: 2400,
  ...patch,
})

/** A swarm built here rather than a preset: presets are content, and they get rewritten. */
function swarm(extra: Partial<SwarmSpec> = {}): SwarmSpec {
  return {
    name: 'The toaster affair',
    task: 'Who ate the crumbs?',
    topology: 'broadcast',
    maxRounds: 4,
    agents: [agent('det', 'Detective', 210), agent('cat', 'Cat', 4)],
    nodes: [],
    links: [{ id: 'l1', source: 'det', target: 'cat' }],
    entryIds: [],
    ...extra,
  }
}

const load = (spec: SwarmSpec) => act(() => useStore.getState().replaceSwarm(spec))
// Typed on the state, not on `setState`'s parameters: those resolve to its replace-everything overload.
const set = (patch: Partial<ReturnType<typeof useStore.getState>>) => act(() => useStore.setState(patch))
/*
 * "Absent" is asserted as `queryAll…().length === 0`, never as `queryBy…() === null`. When the latter
 * FAILS, the assertion error carries a jsdom element as `actual`, and building its diff walks the
 * whole window object graph: measured, the worker froze past a 100 s cap instead of failing — a
 * regression would show up as a hung suite, not as a red test.
 */
const before = (a: HTMLElement, b: HTMLElement) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

beforeEach(() => {
  setViewport(1280)
  localStorage.clear()
  // `replaceSwarm` resets the run and the selection, but not the browser library: that is per test here.
  useStore.setState({ library: [] })
  useStore.getState().replaceSwarm(swarm())
})

afterEach(() => {
  cleanup()
  useStore.setState(ORIGINAL)
  localStorage.clear()
})

// ─── Memory panel ────────────────────────────────────────────────────────────────────────────────

test('with no memory in the graph, the panel explains what one is and how to add it', () => {
  render(<MemoryPanel />)
  assert.ok(screen.getByText(/a memory is knowledge the agents share/i))
  assert.ok(screen.getByText(/add a memory node from the palette, then draw agent → memory to write and memory → agent to read/i))
})

test('a memory shows its seed before the run, then the live entries once a run has written', async () => {
  load(
    swarm({
      nodes: [memory({ id: 'ev', name: 'Evidence', mode: 'blackboard', seed: [entry('crumbs', 'on the sofa', 'seed', 0, 1)] })],
    }),
  )
  render(<MemoryPanel />)

  assert.ok(screen.getByText('Evidence'))
  assert.ok(screen.getByText('blackboard'), 'the mode is shown')
  assert.ok(screen.getByText('seed — before the run'))
  assert.ok(screen.getByText('on the sofa'))
  assert.equal(document.querySelectorAll('[data-fresh]').length, 0, 'what was there on mount does not flash')

  set({ memoryEntries: { ev: [entry('suspect', 'the toaster', 'Detective', 2, 1)] } })

  await waitFor(() => assert.ok(screen.getByText('the toaster')))
  assert.equal(screen.queryAllByText('seed — before the run').length, 0, 'no longer labelled as the seed')
  // The engine starts every memory from its seed and reports only writes, so a seeded key a reader
  // still sees must not vanish from the panel the moment someone writes another key.
  assert.ok(screen.getByText('on the sofa'))
  const fresh = [...document.querySelectorAll<HTMLElement>('[data-fresh]')]
  assert.equal(fresh.length, 1, 'exactly the new write is highlighted')
  assert.match(fresh[0].textContent ?? '', /the toaster/)
})

test('a blackboard shows the latest value per key, newest first, and the overwritten ones on demand', async () => {
  load(swarm({ nodes: [memory({ id: 'ev', name: 'Evidence', mode: 'blackboard' })] }))
  set({
    memoryEntries: {
      ev: [
        entry('suspect', 'the cat', 'Detective', 1, 1),
        entry('motive', 'crumbs everywhere', 'Cat', 1, 1),
        entry('suspect', 'the toaster', 'Cat', 2, 2),
      ],
    },
  })
  render(<MemoryPanel />)

  assert.ok(screen.getByText('the toaster'))
  assert.equal(screen.queryAllByText('the cat').length, 0, 'an overwritten value is not the current state')
  assert.ok(screen.getByText('v2'))
  assert.ok(screen.getByText('round 2'))
  assert.ok(before(screen.getByText('the toaster'), screen.getByText('crumbs everywhere')), 'newest update first')

  fireEvent.click(screen.getByLabelText(/show history/i))
  await waitFor(() => assert.ok(screen.getByText('the cat')))
  assert.ok(screen.getByText('the toaster'))
})

test('a log lists every entry newest first, with its author and round', () => {
  load(swarm({ nodes: [memory({ id: 'news', name: 'Newsroom', mode: 'log', wakeReaders: true })] }))
  set({
    memoryEntries: {
      news: [entry('', 'The toaster denies it', 'Detective', 1, 1), entry('', 'The cat saw everything', 'Cat', 2, 2)],
    },
  })
  render(<MemoryPanel />)

  assert.ok(before(screen.getByText('The cat saw everything'), screen.getByText('The toaster denies it')))
  assert.ok(screen.getByText(/round 2/))
  assert.ok(screen.getByRole('img', { name: /bus/i }), 'a bus says so')
})

test('a document shows its latest version and who wrote it, and a slider reaches the earlier ones', async () => {
  load(swarm({ nodes: [memory({ id: 'dr', name: 'Draft', mode: 'document' })] }))
  set({
    memoryEntries: {
      dr: [entry('', 'First draft of the apology', 'Detective', 1, 1), entry('', 'Second draft, now with remorse', 'Cat', 2, 2)],
    },
  })
  render(<MemoryPanel />)

  assert.ok(screen.getByText('Second draft, now with remorse'))
  assert.equal(screen.queryAllByText('First draft of the apology').length, 0)
  assert.match(screen.getByText(/version 2, last edited by/i).textContent ?? '', /version 2, last edited by Cat/)

  fireEvent.change(screen.getByRole('slider', { name: /document version/i }), { target: { value: 0 } })
  await waitFor(() => assert.ok(screen.getByText('First draft of the apology')))
  assert.match(screen.getByText(/version 1, last edited by/i).textContent ?? '', /Detective/)
})

test('several memories get one tab each', async () => {
  load(
    swarm({
      nodes: [
        memory({ id: 'ev', name: 'Evidence', mode: 'blackboard', seed: [entry('crumbs', 'on the sofa', 'seed', 0, 1)] }),
        memory({ id: 'dr', name: 'Draft', mode: 'document', seed: [entry('', 'Dear office,', 'seed', 0, 1)] }),
      ],
    }),
  )
  render(<MemoryPanel />)

  assert.ok(screen.getByText('on the sofa'))
  fireEvent.click(screen.getByRole('tab', { name: 'Draft' }))
  await waitFor(() => assert.ok(screen.getByText('Dear office,')))
  assert.equal(screen.queryAllByText('on the sofa').length, 0)
})

// ─── Human gate ──────────────────────────────────────────────────────────────────────────────────

const gate = (id: string, text: string): PendingGate => ({
  id,
  nodeId: `node-${id}`,
  path: [],
  name: 'Editor in chief',
  prompt: 'Publish the accusation?',
  text,
})

test('with no gate waiting, the gate dialog is not there', () => {
  render(<GateDialog />)
  assert.equal(screen.queryAllByRole('dialog').length, 0)
})

test('a waiting gate shows its question and the text, and Approve sends the edited text', async () => {
  const decideGate = vi.fn()
  set({ decideGate, gates: [gate('g1', 'The toaster did it.'), gate('g2', 'Second thoughts.')] })
  render(<GateDialog />)

  assert.ok(screen.getByRole('dialog'))
  assert.ok(screen.getByText('Editor in chief'))
  assert.ok(screen.getByText('Publish the accusation?'))
  assert.ok(screen.getByText(/the run is holding here until you decide/i))
  assert.ok(screen.getByText('1 more waiting'))
  const box = screen.getByLabelText(/incoming text/i) as HTMLTextAreaElement
  assert.equal(box.value, 'The toaster did it.')

  fireEvent.change(box, { target: { value: 'The toaster allegedly did it.' } })
  fireEvent.click(screen.getByRole('button', { name: /^approve$/i }))

  assert.deepEqual(decideGate.mock.calls, [['g1', { approved: true, text: 'The toaster allegedly did it.' }]])
})

test('Reject sends approved: false', () => {
  const decideGate = vi.fn()
  set({ decideGate, gates: [gate('g1', 'The toaster did it.')] })
  render(<GateDialog />)

  assert.equal(screen.queryAllByText(/more waiting/i).length, 0, 'nothing else is waiting')
  fireEvent.click(screen.getByRole('button', { name: /^reject$/i }))
  assert.deepEqual(decideGate.mock.calls, [['g1', { approved: false, text: 'The toaster did it.' }]])
})

test('on a phone the gate dialog takes the whole screen', () => {
  setViewport(390)
  set({ gates: [gate('g1', 'The toaster did it.')] })
  render(<GateDialog />)
  assert.match(screen.getByRole('dialog').className, /MuiDialog-paperFullScreen/)
})

// ─── Block library ───────────────────────────────────────────────────────────────────────────────

test('the library lists the built-in blocks with a summary, and search narrows them', async () => {
  render(<BlockLibrary open onClose={() => {}} />)

  const builtIn = within(screen.getByRole('region', { name: 'Built in' }))
  for (const def of BUILTIN_BLOCKS) assert.ok(builtIn.getByRole('article', { name: def.name }), def.name)

  // Derived from the fixture: whichever built-in points at itself must say it is recursive.
  const recursive = BUILTIN_BLOCKS.find((b) => nodesOf(b.graph).some((n) => n.kind === 'block' && n.blockId === b.id))
  assert.ok(recursive, 'the fixture is only meaningful with a recursive built-in')
  assert.ok(within(screen.getByRole('article', { name: recursive.name })).getByText(/\d+ agents? · .* · recursive$/))
  // …and one that does not, must not.
  const plain = BUILTIN_BLOCKS.find((b) => b !== recursive)!
  assert.equal(within(screen.getByRole('article', { name: plain.name })).queryAllByText(/recursive$/).length, 0)

  const query = BUILTIN_BLOCKS[0].name
  const hidden = BUILTIN_BLOCKS.filter((b) => !`${b.name}\n${b.description}`.toLowerCase().includes(query.toLowerCase()))
  assert.ok(hidden.length > 0, 'the search must leave something out to prove anything')
  fireEvent.change(screen.getByLabelText(/search blocks/i), { target: { value: query } })

  await waitFor(() => assert.equal(screen.queryAllByRole('article', { name: hidden[0].name }).length, 0))
  assert.ok(screen.getByRole('article', { name: query }))
})

test('Insert drops a block node and copies the definition, untouched, into the swarm', () => {
  const onClose = vi.fn()
  const def = BUILTIN_BLOCKS[0]
  render(<BlockLibrary open onClose={onClose} />)

  fireEvent.click(screen.getByRole('button', { name: `Insert ${def.name}` }))

  const spec = useStore.getState().spec
  assert.ok(nodesOf(spec).some((n) => n.kind === 'block' && n.blockId === def.id), 'a block node is on the canvas')
  // Deep equality, so the `source` tag the library adds to each entry cannot leak into a saved swarm.
  assert.deepEqual(
    spec.blocks?.find((b) => b.id === def.id),
    def,
  )
  assert.equal(onClose.mock.calls.length, 1)
})

test('Open inside opens the definition and closes the library', () => {
  const onClose = vi.fn()
  const openBlock = vi.fn()
  set({ openBlock })
  const def = BUILTIN_BLOCKS[1]
  render(<BlockLibrary open onClose={onClose} />)

  fireEvent.click(screen.getByRole('button', { name: `Open inside ${def.name}` }))
  assert.deepEqual(openBlock.mock.calls, [[def.id]])
  assert.equal(onClose.mock.calls.length, 1)
})

test('saving the selection creates a block in this browser and in this swarm', async () => {
  // A ticked agent, the selected one, and an id that is not in the graph: only the first two count.
  set({ multiIds: ['cat', 'ghost'], selectedId: 'det' })
  render(<BlockLibrary open onClose={() => {}} />)

  assert.ok(screen.getByText(/takes 2 nodes/i))
  fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'Interrogation' } })
  fireEvent.change(screen.getByLabelText(/^description$/i), { target: { value: 'Detective questions the cat.' } })
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

  const { library, spec } = useStore.getState()
  assert.equal(library.length, 1)
  assert.equal(library[0].name, 'Interrogation')
  assert.deepEqual(library[0].graph.agents.map((a) => a.id).sort(), ['cat', 'det'])
  assert.equal(library[0].graph.links.length, 1, 'the link between them comes along')
  assert.ok(spec.blocks?.some((b) => b.id === library[0].id))
  await waitFor(() => assert.ok(screen.getByText(/saved “interrogation”/i)))
})

test('with nothing selected, Save is disabled and says what to select', () => {
  set({ multiIds: [], selectedId: undefined })
  render(<BlockLibrary open onClose={() => {}} />)

  assert.equal((screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement).disabled, true)
  assert.ok(screen.getByText(/tick agents in the roster, or select a node on the canvas/i))
})

test('a block saved in this browser can be deleted from the library', async () => {
  const saved = { ...structuredClone(BUILTIN_BLOCKS[0]), id: 'blk-mine', name: 'My loop' }
  set({ library: [saved] })
  render(<BlockLibrary open onClose={() => {}} />)

  assert.ok(within(screen.getByRole('region', { name: 'Saved in this browser' })).getByRole('article', { name: 'My loop' }))
  assert.equal(screen.queryAllByRole('button', { name: `Delete ${BUILTIN_BLOCKS[0].name}` }).length, 0, 'a built-in has no Delete')
  fireEvent.click(screen.getByRole('button', { name: 'Delete My loop' }))

  assert.deepEqual(useStore.getState().library, [])
  await waitFor(() => assert.equal(screen.queryAllByRole('article', { name: 'My loop' }).length, 0))
})

// ─── Node palette ────────────────────────────────────────────────────────────────────────────────

test('the palette adds nodes, in both layouts, and Block opens the library', () => {
  const onOpenLibrary = vi.fn()
  const { rerender } = render(<NodePalette onOpenLibrary={onOpenLibrary} />)

  fireEvent.click(screen.getByRole('button', { name: 'Add a condition' }))
  assert.ok(nodesOf(useStore.getState().spec).some((n) => n.kind === 'condition'))

  rerender(<NodePalette onOpenLibrary={onOpenLibrary} compact />)
  const agentsBefore = useStore.getState().spec.agents.length
  fireEvent.click(screen.getByRole('button', { name: 'Add an agent' }))
  fireEvent.click(screen.getByRole('button', { name: 'Add a memory' }))
  assert.equal(useStore.getState().spec.agents.length, agentsBefore + 1)
  assert.ok(nodesOf(useStore.getState().spec).some((n) => n.kind === 'memory'))

  fireEvent.click(screen.getByRole('button', { name: 'Add a block' }))
  assert.equal(onOpenLibrary.mock.calls.length, 1)
})

test('Keep spawned appears only after a run that spawned something, and keeps them', async () => {
  const keepSpawned = vi.fn(() => 1)
  set({ keepSpawned })
  render(<NodePalette onOpenLibrary={() => {}} />)
  assert.equal(screen.queryAllByRole('button', { name: /keep \d+ spawned/i }).length, 0, 'nothing spawned, nothing to keep')

  set({ runGraph: { agents: [agent('det~s1', 'Forensic Accountant', 48)], nodes: [], links: [] }, phase: 'running' })
  assert.equal(screen.queryAllByRole('button', { name: /keep \d+ spawned/i }).length, 0, 'not while the run is still growing')

  set({ phase: 'done' })
  const keep = await waitFor(() => screen.getByRole('button', { name: /keep 1 spawned/i }))
  fireEvent.click(keep)
  assert.equal(keepSpawned.mock.calls.length, 1)
})

test('inside a block, a banner says edits reach every instance, and Back returns to the swarm', async () => {
  const def = structuredClone(BUILTIN_BLOCKS[0])
  load(swarm({ blocks: [def] }))
  const openBlock = vi.fn()
  render(<NodePalette onOpenLibrary={() => {}} />)
  assert.equal(screen.queryAllByText(/editing a block/i).length, 0)

  set({ openBlock, editingBlockId: def.id })
  await waitFor(() => assert.ok(screen.getByText(/editing a block — changes apply to every instance/i)))
  assert.ok(screen.getByText(def.name))

  fireEvent.click(screen.getByRole('button', { name: /back to swarm/i }))
  assert.deepEqual(openBlock.mock.calls, [[undefined]])
})
