/**
 * Mount smoke tests: the whole app, with the default preset, in jsdom — at desktop width and at
 * phone width.
 *
 * They exist because a graph editor fails in a way unit tests never see (an import-time throw, a
 * hook order change, a missing browser API) and that failure is a white page. The phone case gets
 * its own test because the layout it exercises shares almost no container with the desktop one.
 *
 * The app opens on the prompt card, with the side panels closed: a test that needs the roster or
 * the transcript opens that panel first, the way a person would — one click, from the top bar.
 */
import assert from 'node:assert/strict'
import { test, afterEach, beforeEach } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import App from './App'
import { useStore } from './store'
import { PRESETS } from './presets'

// Derived from the preset, never spelled out: the default swarm is CONTENT and it gets rewritten.
const DEFAULT = PRESETS[0]
const AGENTS = DEFAULT.agents
import { setViewport } from './test-setup'

beforeEach(() => {
  setViewport(1280)
  // The store is a module singleton, so tests would otherwise inherit each other's selection and
  // spec. Reloading the preset gives every test the same starting swarm and the same selected agent.
  useStore.getState().loadPreset(PRESETS[0])
})
afterEach(() => {
  // A run left in flight by one test would still be streaming into the next one, and the Run button
  // would read "Stop".
  useStore.getState().stop()
  useStore.getState().reset()
  cleanup()
  localStorage.clear()
})

const openBuild = () => fireEvent.click(screen.getByRole('button', { name: /build panel/i }))
const openLog = () => fireEvent.click(screen.getByRole('button', { name: /transcript panel/i }))
/** Items that live in the ⋮ menu: one click to open it, one on the item. */
async function pickMore(item: RegExp) {
  fireEvent.click(screen.getByRole('button', { name: /^more$/i }))
  fireEvent.click(await waitFor(() => screen.getByRole('menuitem', { name: item })))
}

test('the app mounts and shows the default swarm', async () => {
  render(<App />)

  assert.ok(screen.getByText('Swarm Studio'))
  assert.ok(screen.getByRole('button', { name: /run swarm/i }))
  // Every agent of the default preset shows up in the roster once the Build panel is open.
  openBuild()
  for (const agent of AGENTS) {
    assert.ok(screen.getAllByText(agent.name).length > 0, `${agent.name} is on screen`)
  }
})

test('selecting an agent opens its prompt for editing', async () => {
  render(<App />)
  openBuild()

  const second = AGENTS[1]
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^select ${second.name},`, 'i') }))
  const prompt = await waitFor(() => screen.getByLabelText(/system prompt/i))
  assert.equal((prompt as HTMLTextAreaElement).value, second.systemPrompt)
})

test('running the demo swarm streams a message into the transcript, which opens by itself', async () => {
  render(<App />)

  fireEvent.click(screen.getByRole('button', { name: /run swarm/i }))
  await waitFor(() => assert.ok(screen.getByText(/round 1/i)), { timeout: 6000 })
  // `^stop$` is the run bar's button; the composer has its own "Stop the run" icon, so a loose
  // /stop/i now matches two and throws.
  await waitFor(() => assert.ok(screen.getByRole('button', { name: /^stop$/i })))
  assert.ok(screen.getByRole('button', { name: /pause the run/i }), 'a run can be paused')
})

test('at phone width the transcript sheet can pause and stop the run on its own', async () => {
  // The sheets are modal, so the bottom bar is unreachable while reading the transcript. Without
  // controls in the sheet, a running swarm could not be stopped from the panel you were looking at.
  setViewport(390)
  render(<App />)

  fireEvent.click(screen.getByRole('button', { name: /^run$/i }))
  fireEvent.click(screen.getByRole('button', { name: /log/i }))

  await waitFor(() => assert.ok(screen.getByRole('button', { name: /pause the run/i })))
  assert.ok(screen.getByRole('button', { name: /stop the run/i }))
  assert.ok(screen.getByLabelText(/which agent receives your message/i), 'and you can talk to an agent')
})

/**
 * The four things Iskandeur could not do or find on 14/09. Each one is a missing affordance, so
 * each gets a test that fails if the affordance disappears again.
 */
test('the model field is reachable without hunting: one click opens the panel on a selected agent', async () => {
  render(<App />)
  openBuild()

  const model = screen.getByLabelText(/^model$/i)
  assert.equal((model as HTMLInputElement).value, AGENTS[0].model)
  // …and the roster shows each agent's model, so it is readable without selecting anything.
  for (const agent of AGENTS) {
    assert.ok(screen.getAllByText(agent.model).length > 0, `${agent.name}'s model is listed`)
  }
})

test('a link can be cut from the panel, in both directions', async () => {
  // ⚠️ The ✕ drawn ON the curve cannot be asserted here: React Flow only renders edges once it has
  // measured the nodes, and jsdom has no layout engine to measure. This test covers the other
  // affordance, which is the one that works without hover — and is the one a phone needs.
  render(<App />)
  openBuild()

  // The first agent is selected on mount, so the panel lists ITS links — both directions.
  const selected = AGENTS[0]
  const nameOf = (id: string) => AGENTS.find((a) => a.id === id)!.name
  const mine = DEFAULT.links.filter((l) => l.source === selected.id || l.target === selected.id)
  assert.ok(mine.length > 0, 'the fixture is only meaningful if the first agent has links')

  for (const link of mine) {
    const other = nameOf(link.source === selected.id ? link.target : link.source)
    assert.ok(screen.getByRole('button', { name: new RegExp(`cut link to ${other}`, 'i') }), other)
  }

  const victim = mine[0]
  const victimName = nameOf(victim.source === selected.id ? victim.target : victim.source)
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`cut link to ${victimName}`, 'i') }))

  await waitFor(() => assert.equal(useStore.getState().spec.links.length, DEFAULT.links.length - 1))
  assert.equal(
    useStore.getState().spec.links.some((l) => l.id === victim.id),
    false,
  )
})

test('the run settings hold the task and the topology, and the topologies explain themselves', async () => {
  render(<App />)

  fireEvent.click(screen.getByRole('button', { name: /task and run settings/i }))
  assert.ok(await waitFor(() => screen.getByLabelText(/task given to the entry agents/i)))
  assert.ok(screen.getByLabelText(/max rounds/i))
  fireEvent.click(screen.getByRole('button', { name: /explain the topologies/i }))
  await waitFor(() => assert.ok(screen.getByText(/how a turn is handed on/i)))
  // All three are described, not just the current one.
  assert.ok(screen.getByText(/widens/i))
  assert.ok(screen.getByText(/in rotation/i))
  assert.ok(screen.getByText(/replies upward/i))
})

test('transcript output is formatted, not dumped as one blob', async () => {
  render(<App />)
  openLog()
  useStore.setState({
    transcript: [
      {
        id: 'm1',
        round: 1,
        agentId: AGENTS[0].id,
        to: [AGENTS[1].id],
        text: 'Findings:\n- first point\n- second point\n\n```js\nconst x = 1\n```',
        status: 'complete',
        tokensIn: 10,
        tokensOut: 20,
        startedAt: 0,
        endedAt: 1200,
      },
    ],
  })

  await waitFor(() => assert.equal(screen.getAllByRole('listitem').length, 2))
  assert.ok(screen.getByText('const x = 1'))
  assert.ok(screen.getByRole('button', { name: /copy this message/i }))
  // Raw mode is one click away for anyone who wants the untouched text.
  fireEvent.click(screen.getByRole('button', { name: /^raw$/i }))
  await waitFor(() => assert.equal(screen.queryAllByRole('listitem').length, 0))
})

test('the share dialog copies a swarm and a clipping, and takes a paste', async () => {
  // His ask: "une convention de formattage json, pour que je puisse copier coller des nodes et des
  // graphes […] pour qu'un pote puisse reproduire la config".
  render(<App />)

  await pickMore(/share this configuration/i)
  await waitFor(() => assert.ok(screen.getByRole('dialog')))

  // Both blocks are offered: the whole swarm, and just what is selected.
  assert.match(screen.getByText(/the whole swarm/i).textContent ?? '', /\d+ agents, \d+ links/)
  assert.ok(screen.getByText(/just the selection/i))

  // And the paste side accepts a clipping, which lands in the swarm.
  fireEvent.click(screen.getByRole('tab', { name: /paste in/i }))
  const box = await waitFor(() => screen.getByLabelText(/paste a swarm or a clipping/i))
  const before = useStore.getState().spec.agents.length
  fireEvent.change(box, {
    target: {
      value: JSON.stringify({
        format: 'swarm-studio',
        kind: 'agents',
        agents: [{ id: 'guest', name: 'A Friend', model: 'demo-fast', systemPrompt: 'You visit.' }],
        links: [],
      }),
    },
  })
  fireEvent.click(screen.getByRole('button', { name: /load it/i }))

  await waitFor(() => assert.equal(useStore.getState().spec.agents.length, before + 1))
  assert.ok(useStore.getState().spec.agents.some((a) => a.name === 'A Friend'))
})

test('a bad paste explains itself instead of doing nothing', async () => {
  render(<App />)
  await pickMore(/share this configuration/i)
  fireEvent.click(await waitFor(() => screen.getByRole('tab', { name: /paste in/i })))

  const box = screen.getByLabelText(/paste a swarm or a clipping/i)
  const before = useStore.getState().spec.agents.length
  fireEvent.change(box, { target: { value: 'this is not json' } })
  fireEvent.click(screen.getByRole('button', { name: /load it/i }))

  await waitFor(() => assert.ok(screen.getByText(/does not look like JSON/i)))
  assert.equal(useStore.getState().spec.agents.length, before, 'and nothing was changed')
})

test('every node carries a visible delete button', async () => {
  // He reported having no way to delete a node except the Delete key. The roster button is the one
  // jsdom can see; the ✕ on the node itself needs React Flow to have measured the canvas.
  render(<App />)
  openBuild()
  for (const agent of AGENTS) {
    assert.ok(
      screen.getByRole('button', { name: new RegExp(`delete agent ${agent.name}`, 'i') }),
      `${agent.name} can be deleted from the roster`,
    )
  }
})

test('the side panels close from their own header', async () => {
  render(<App />)
  openBuild()
  assert.ok(screen.getByLabelText(/^model$/i))
  fireEvent.click(screen.getByRole('button', { name: /close the build panel/i }))
  await waitFor(() => assert.equal(screen.queryAllByLabelText(/^model$/i).length, 0))

  openLog()
  assert.ok(screen.getByText(/transcript · 0/i))
  fireEvent.click(screen.getByRole('button', { name: /close the transcript/i }))
  await waitFor(() => assert.equal(screen.queryAllByText(/transcript · 0/i).length, 0))
})

test('at phone width the panels become sheets and Run is one tap away', async () => {
  setViewport(390)
  render(<App />)

  // No desktop side panels: the transcript header only exists once a sheet is opened.
  // Counts, not elements: a failing assert holding a jsdom node hangs the worker instead of failing.
  assert.equal(screen.queryAllByText(/TRANSCRIPT/i).length, 0)
  // The four bottom actions are there, and the graph is not covered by a form.
  for (const label of [/agents/i, /task/i, /log/i, /^run$/i]) {
    assert.ok(screen.getByRole('button', { name: label }), String(label))
  }

  fireEvent.click(screen.getByRole('button', { name: /log/i }))
  await waitFor(() => assert.ok(screen.getByText(/TRANSCRIPT/i)))
})

test('at phone width the task sheet carries the topology controls', async () => {
  setViewport(390)
  render(<App />)

  // Topology lives behind the run settings on desktop; on a phone it moves into the Task sheet.
  assert.equal(screen.queryAllByLabelText(/topology/i).length, 0)
  fireEvent.click(screen.getByRole('button', { name: /task/i }))
  await waitFor(() => assert.ok(screen.getByLabelText(/topology/i)))
  assert.ok(screen.getByLabelText(/max rounds/i))
  assert.ok(screen.getByLabelText(/task given to the entry agents/i))
})

test('the shell height follows the visible viewport, and is not gated behind a breakpoint', () => {
  // The bug this pins: `height: ['100vh', '100dvh']` reads like a CSS fallback and is not one —
  // an array in `sx` is MUI's breakpoint syntax, so the dvh height only applied from `sm` up and
  // every phone got 100vh. On a browser with a URL bar that is taller than the visible area, and
  // the page cannot scroll (body is overflow:hidden), so the bottom navigation was simply gone.
  setViewport(390)
  render(<App />)

  const css = Array.from(document.querySelectorAll('style'))
    .map((tag) => tag.textContent ?? '')
    .join('\n')

  assert.match(css, /100dvh/, 'the shell asks for the dynamic viewport height')
  assert.equal(
    /@media[^{]*min-width[^{]*\{[^}]*100dvh/.test(css),
    false,
    'that height must not sit behind a min-width media query — phones are below every breakpoint',
  )
})
