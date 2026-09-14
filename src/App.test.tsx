/**
 * Mount smoke tests: the whole app, with the default preset, in jsdom — at desktop width and at
 * phone width.
 *
 * They exist because a graph editor fails in a way unit tests never see (an import-time throw, a
 * hook order change, a missing browser API) and that failure is a white page. The phone case gets
 * its own test because the layout it exercises shares almost no container with the desktop one.
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

test('the app mounts and shows the default swarm', async () => {
  render(<App />)

  assert.ok(screen.getByText('Swarm Studio'))
  // Every agent of the default preset shows up, in the roster and on the canvas.
  for (const agent of AGENTS) {
    assert.ok(screen.getAllByText(agent.name).length > 0, `${agent.name} is on screen`)
  }
  assert.ok(screen.getByRole('button', { name: /run swarm/i }))
})

test('selecting an agent opens its prompt for editing', async () => {
  render(<App />)

  const second = AGENTS[1]
  fireEvent.click(screen.getAllByText(second.name)[0])
  const prompt = await waitFor(() => screen.getByLabelText(/system prompt/i))
  assert.equal((prompt as HTMLTextAreaElement).value, second.systemPrompt)
})

test('running the demo swarm streams a message into the transcript', async () => {
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
test('the model field is reachable without hunting: an agent is already selected', async () => {
  render(<App />)

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

test('the topologies explain themselves in a popover', async () => {
  render(<App />)

  fireEvent.click(screen.getByRole('button', { name: /explain the topologies/i }))
  await waitFor(() => assert.ok(screen.getByText(/how a turn is handed on/i)))
  // All three are described, not just the current one.
  assert.ok(screen.getByText(/widens/i))
  assert.ok(screen.getByText(/in rotation/i))
  assert.ok(screen.getByText(/replies upward/i))
})

test('transcript output is formatted, not dumped as one blob', async () => {
  render(<App />)
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

test('at phone width the panels become sheets and Run is one tap away', async () => {
  setViewport(390)
  render(<App />)

  // No desktop side panels: the transcript header only exists once a sheet is opened.
  assert.equal(screen.queryByText(/TRANSCRIPT/i), null)
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

  // Topology lives in the app bar on desktop; on a phone it moves into the Task sheet.
  assert.equal(screen.queryByLabelText(/topology/i), null)
  fireEvent.click(screen.getByRole('button', { name: /task/i }))
  await waitFor(() => assert.ok(screen.getByLabelText(/topology/i)))
  assert.ok(screen.getByLabelText(/max rounds/i))
  assert.ok(screen.getByLabelText(/task given to the entry agents/i))
})
