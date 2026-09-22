/**
 * "Prompt the graph", end to end in jsdom: the hero card on the first screen, the docked bar once
 * it is closed, the generator, the reader, the store. The model is either the demo generator (no
 * key) or a stubbed OpenAI stream, so the repair loop runs through the real provider adapter, SSE
 * parsing included.
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '../App'
import { useStore } from '../store'
import { PRESETS } from '../presets'
import { exportSwarm } from '../engine/portable'
import { setViewport } from '../test-setup'
import { useComposer } from './useGraphComposer'
import { HERO_TITLE } from './PromptComposer'

const START = PRESETS[0]

beforeEach(() => {
  setViewport(1280)
  localStorage.clear()
  useStore.setState({ keys: {}, endpoints: {} })
  useStore.getState().loadPreset(START)
})

afterEach(() => {
  vi.unstubAllGlobals()
  useStore.getState().stop()
  useStore.getState().reset()
  useStore.setState({ keys: {}, notice: undefined })
  // The composer is a module singleton too: what one test typed must not be the next one's ask.
  useComposer.getState().cancel()
  useComposer.setState({ instruction: '', mode: 'replace', provider: 'mock', model: 'demo-fast', problem: null, raw: '', progress: null })
  cleanup()
  localStorage.clear()
})

/** An OpenAI-style SSE body that streams `text` in a few chunks. */
function sse(text: string): Response {
  const chunks = text.match(/[\s\S]{1,400}/g) ?? ['']
  const body = [
    ...chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`),
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 300 } })}\n\n`,
    'data: [DONE]\n\n',
  ].join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/**
 * Whether the hero card is on the page, as a BOOLEAN. `assert.equal(element, null)` looks harmless
 * and is not: when it fails, node's assert inspects the jsdom element to print it, walks React's
 * fibers and the whole document, and the test file never finishes (it cost an afternoon to find).
 */
const heroOpen = () => document.querySelector('[data-hero]') !== null

function describe(text: string) {
  fireEvent.change(screen.getByLabelText(/describe the graph/i), { target: { value: text } })
}

test('the first screen is the prompt: the card is up, over the default swarm, with Run still in reach', () => {
  render(<App />)
  assert.ok(heroOpen(), 'the hero is open on load')
  assert.ok(screen.getByRole('heading', { name: HERO_TITLE }))
  assert.ok(screen.getByRole('button', { name: /^generate$/i }))
  // The canvas behind it is the default swarm, and the run controls are not hidden by the card.
  assert.ok(screen.getByRole('button', { name: /run swarm/i }))
  // A one-click start for each example.
  assert.ok(screen.getAllByRole('button', { name: /support triage|writer and a critic|research team/i }).length >= 3)
})

test('with no key, the demo generator loads a preset as ONE undo step, closes the card, and says it is a demo', async () => {
  render(<App />)
  assert.ok(screen.getByText(/the demo generator has no model behind it/i))
  describe('A support triage where unsure answers escalate to a senior agent')
  const before = useStore.getState().past.length
  fireEvent.click(screen.getByRole('button', { name: /^generate$/i }))

  await waitFor(() => assert.equal(useStore.getState().spec.name, 'Demo: Triage (System 1 → System 2)'), { timeout: 5000 })
  await waitFor(() => assert.equal(heroOpen(), false), { timeout: 5000 })
  assert.equal(useStore.getState().past.length, before + 1, 'the load is exactly one undo step')
  assert.match(useStore.getState().notice ?? '', /demo generator/i)
  assert.ok(useStore.getState().spec.nodes?.some((n) => n.kind === 'decision'), 'the triage decision node is on the canvas')
  // The card gave way to the docked bar, empty and ready for the next ask.
  assert.equal((screen.getByLabelText(/describe the graph/i) as HTMLTextAreaElement).value, '')

  useStore.getState().undo()
  assert.equal(useStore.getState().spec.name, START.name, 'one undo brings the previous swarm back')
}, 20000)

test('a real provider that answers invalid JSON first is repaired once, then loaded', async () => {
  useStore.setState({ keys: { openai: 'sk-test-0000000000' } })
  // The generator used last time, which is picked again while its key is there.
  localStorage.setItem('swarm-studio.generator.v1', JSON.stringify({ provider: 'openai', model: 'gpt-test' }))
  const good = JSON.parse(exportSwarm(PRESETS[2]))
  good.name = 'Generated pipeline'
  const answers = [
    // Missing a brace, wrapped in chatter: exactly what a model does on a bad day.
    'Sure! Here is your swarm:\n```json\n{"format":"swarm-studio","version":2,"kind":"swarm","agents":[\n```',
    `\`\`\`json\n${JSON.stringify(good)}\n\`\`\``,
  ]
  const bodies: string[] = []
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body))
    return sse(answers[bodies.length - 1] ?? '')
  })
  vi.stubGlobal('fetch', fetchMock)

  render(<App />)
  describe('A writer, a fact-checker and an editor in a line')
  fireEvent.click(screen.getByRole('button', { name: /^generate$/i }))

  await waitFor(() => assert.equal(useStore.getState().spec.name, 'Generated pipeline'), { timeout: 5000 })
  assert.equal(fetchMock.mock.calls.length, 2, 'one call, one repair')
  const repair = JSON.parse(bodies[1]) as { messages: Array<{ role: string; content: string }> }
  assert.match(repair.messages.at(-1)!.content, /could not be loaded/i, 'the repair request quotes the problem')
  assert.ok(bodies.every((b) => !b.includes('sk-test')), 'the key travels in a header, never in the prompt')
  assert.match(useStore.getState().notice ?? '', /automatic repair/i)
  assert.equal(JSON.parse(bodies[0]).model, 'gpt-test', 'the remembered model is the one called')
}, 20000)

test('an answer that is still invalid after the repair loads nothing and says why', async () => {
  useStore.setState({ keys: { openai: 'sk-test-0000000000' } })
  localStorage.setItem('swarm-studio.generator.v1', JSON.stringify({ provider: 'openai', model: 'gpt-test' }))
  const broken = { format: 'swarm-studio', version: 2, kind: 'swarm', name: 'Broken', task: 't', topology: 'broadcast', maxRounds: 3, entryIds: [], agents: [{ id: 'a', name: 'A', provider: 'mock', model: 'demo-fast', systemPrompt: 'x', temperature: 0.5, hue: 10, position: { x: 0, y: 0 } }], nodes: [], links: [{ id: 'l1', source: 'a', target: 'ghost' }], blocks: [] }
  vi.stubGlobal('fetch', vi.fn(async () => sse(JSON.stringify(broken))))

  render(<App />)
  describe('Something with a ghost')
  const past = useStore.getState().past.length
  fireEvent.click(screen.getByRole('button', { name: /^generate$/i }))

  await waitFor(() => assert.ok(screen.getByText(/nothing was loaded/i)), { timeout: 5000 })
  assert.ok(screen.getByText(/a → ghost: an end is not an existing id/i), 'the error names the dropped link, and why')
  assert.equal(useStore.getState().spec.name, START.name, 'the canvas is untouched')
  assert.equal(useStore.getState().past.length, past, 'and so is the undo history')
  assert.ok(heroOpen(), 'the card stays up to show it')
  assert.ok(screen.getByRole('button', { name: /copy the answer/i }), 'the raw answer can be copied out')
}, 20000)

test('edit mode on the demo generator keeps every id and changes one thing', async () => {
  useStore.getState().loadPreset(PRESETS.find((p) => p.name === 'The Fridge Tribunal')!)
  const ids = [...useStore.getState().spec.agents.map((a) => a.id), ...(useStore.getState().spec.nodes ?? []).map((n) => n.id)]
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: /edit current/i }))
  describe('add a human gate before the output')
  fireEvent.click(screen.getByRole('button', { name: /apply change/i }))

  await waitFor(() => assert.equal(heroOpen(), false), { timeout: 5000 })
  const spec = useStore.getState().spec
  const after = new Set([...spec.agents.map((a) => a.id), ...(spec.nodes ?? []).map((n) => n.id)])
  for (const id of ids) assert.ok(after.has(id), `${id} kept`)
  assert.equal((spec.nodes ?? []).filter((n) => n.kind === 'human').length, 2, 'one more human gate')
}, 20000)

test('once the card is closed, the docked bar takes the same ask and Enter sends it', async () => {
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: /close the prompt/i }))
  assert.equal(heroOpen(), false)

  const bar = screen.getByLabelText(/describe the graph/i)
  fireEvent.change(bar, { target: { value: 'A support triage where unsure answers escalate' } })
  fireEvent.keyDown(bar, { key: 'Enter' })

  await waitFor(() => assert.equal(useStore.getState().spec.name, 'Demo: Triage (System 1 → System 2)'), { timeout: 5000 })
  assert.equal(heroOpen(), false, 'the bar does not bring the card back')
}, 20000)

test('Ctrl/⌘ + K and the expand button bring the card back', () => {
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: /close the prompt/i }))
  assert.equal(heroOpen(), false)

  fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
  assert.ok(heroOpen(), 'the shortcut opens it')

  fireEvent.click(screen.getByRole('button', { name: /close the prompt/i }))
  fireEvent.click(screen.getByRole('button', { name: /open the full prompt/i }))
  assert.ok(heroOpen(), 'so does the button on the bar')
})

test('starting a run, or picking a starter swarm from the card, gets the card out of the way', async () => {
  render(<App />)
  assert.ok(heroOpen())
  // The exact name: the swarm's name in the top bar opens the same menu and says so in its label.
  fireEvent.click(screen.getByRole('button', { name: /^open a starter swarm$/i }))
  fireEvent.click(await waitFor(() => screen.getByRole('menuitem', { name: new RegExp(PRESETS[1].name) })))
  await waitFor(() => assert.equal(heroOpen(), false))
  assert.equal(useStore.getState().spec.name, PRESETS[1].name)

  fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
  assert.ok(heroOpen())
  fireEvent.click(screen.getByRole('button', { name: /run swarm/i }))
  await waitFor(() => assert.equal(heroOpen(), false))
})

test('on a phone the card is the first screen too, and the strip above the navigation reopens it', () => {
  setViewport(390)
  render(<App />)
  assert.ok(heroOpen())
  assert.ok(screen.getByRole('button', { name: /^run$/i }), 'Run stays one tap away under the card')

  fireEvent.click(screen.getByRole('button', { name: /close the prompt/i }))
  assert.equal(heroOpen(), false)
  fireEvent.click(screen.getByRole('button', { name: /prompt the graph/i }))
  assert.ok(heroOpen())
})
