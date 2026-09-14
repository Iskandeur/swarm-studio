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
import { setViewport } from './test-setup'

beforeEach(() => setViewport(1280))
afterEach(() => {
  // The store is a module singleton: a run left in flight by one test would still be streaming
  // into the next one, and the Run button would read "Stop".
  useStore.getState().stop()
  useStore.getState().reset()
  cleanup()
  localStorage.clear()
})

test('the app mounts and shows the default swarm', async () => {
  render(<App />)

  assert.ok(screen.getByText('Swarm Studio'))
  // Agents from the default preset, in the roster and on the canvas.
  assert.ok(screen.getAllByText('Proposer').length > 0)
  assert.ok(screen.getAllByText('Skeptic').length > 0)
  assert.ok(screen.getAllByText('Synthesist').length > 0)
  assert.ok(screen.getByRole('button', { name: /run swarm/i }))
})

test('selecting an agent opens its prompt for editing', async () => {
  render(<App />)

  fireEvent.click(screen.getAllByText('Skeptic')[0])
  const prompt = await waitFor(() => screen.getByLabelText(/system prompt/i))
  assert.match((prompt as HTMLTextAreaElement).value, /objection/i)
})

test('running the demo swarm streams a message into the transcript', async () => {
  render(<App />)

  fireEvent.click(screen.getByRole('button', { name: /run swarm/i }))
  await waitFor(() => assert.ok(screen.getByText(/round 1/i)), { timeout: 6000 })
  await waitFor(() => assert.ok(screen.getByRole('button', { name: /stop/i })))
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
