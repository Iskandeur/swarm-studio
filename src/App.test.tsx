/**
 * Mount smoke test: the whole app, with the default preset, in jsdom.
 *
 * It exists because a graph editor fails in a way unit tests never see — an import-time throw,
 * a hook order change, a missing browser API — and that failure is a white page.
 */
import assert from 'node:assert/strict'
import { test, afterEach } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import App from './App'

afterEach(cleanup)

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
