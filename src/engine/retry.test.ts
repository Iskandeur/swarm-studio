/**
 * Retries (ADK 2.0's RetryConfig) and output keys (ADK's `output_key`).
 *
 * The runner tests stub `fetch` behind a `custom` provider: the demo provider never fails, and a
 * retry that is never exercised against a real failing call is a retry nobody has seen work.
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'
import { DEFAULT_RETRY, isTransient, resolveRetry, retryDelay, withRetry } from './retry.ts'
import { runSwarm, type RunnerCallbacks } from './runner.ts'
import type { Agent, MemoryEntry, SwarmSpec } from '../types.ts'

const instant = async () => {}
const never = new AbortController().signal

test('only failures a second try can fix are transient', () => {
  for (const m of ['HTTP 429 — slow down', 'HTTP 503 — overloaded', 'HTTP 500 — ', 'TypeError: Failed to fetch', 'NetworkError when attempting to fetch resource.', 'rate limit exceeded']) {
    assert.equal(isTransient(new Error(m)), true, m)
  }
  for (const m of ['HTTP 401 — Incorrect API key', 'HTTP 404 — model not found', 'HTTP 400 — context length exceeded', 'custom provider has no endpoint']) {
    assert.equal(isTransient(new Error(m)), false, m)
  }
})

test('delays grow by the backoff factor and stop at the ceiling', () => {
  const p = resolveRetry({ jitter: 0, initialDelayMs: 1000, backoffFactor: 2, maxDelayMs: 5000 })
  assert.deepEqual([1, 2, 3, 4].map((n) => retryDelay(n, p, 0.5)), [1000, 2000, 4000, 5000])
})

test('jitter spreads a delay symmetrically around its base', () => {
  const p = resolveRetry({ jitter: 0.5, initialDelayMs: 1000 })
  assert.equal(retryDelay(1, p, 0), 750)
  assert.equal(retryDelay(1, p, 0.999999), 1250)
})

test('policies layer agent over swarm over default, and a pasted spec is clamped', () => {
  assert.deepEqual(resolveRetry(), DEFAULT_RETRY)
  assert.equal(resolveRetry({ maxAttempts: 5 }, { maxAttempts: 2 }).maxAttempts, 2)
  assert.equal(resolveRetry({ maxAttempts: 5 }, {}).maxAttempts, 5)
  const hostile = resolveRetry({ maxAttempts: 1e9, maxDelayMs: 1e12, backoffFactor: -3, jitter: 7, on: 'nonsense' as never })
  assert.equal(hostile.maxAttempts, 10)
  assert.equal(hostile.maxDelayMs, 120_000)
  assert.equal(hostile.backoffFactor, 1)
  assert.equal(hostile.jitter, 1)
  assert.equal(hostile.on, 'transient')
})

test('withRetry retries a transient failure and returns the eventual success', async () => {
  let calls = 0
  const seen: number[] = []
  const out = await withRetry(
    async () => {
      if (++calls < 3) throw new Error('HTTP 503 — busy')
      return 'ok'
    },
    resolveRetry({ maxAttempts: 3 }),
    { signal: never, sleep: instant, onRetry: (e) => seen.push(e.attempt) },
  )
  assert.equal(out, 'ok')
  assert.equal(calls, 3)
  assert.deepEqual(seen, [2, 3])
})

test('withRetry gives up at once on a permanent error, unless told to retry everything', async () => {
  let calls = 0
  const fail = async () => {
    calls++
    throw new Error('HTTP 401 — bad key')
  }
  await assert.rejects(withRetry(fail, resolveRetry(), { signal: never, sleep: instant }), /401/)
  assert.equal(calls, 1)
  calls = 0
  await assert.rejects(withRetry(fail, resolveRetry({ on: 'all', maxAttempts: 4 }), { signal: never, sleep: instant }), /401/)
  assert.equal(calls, 4)
})

test('a stop during the wait ends the retries', async () => {
  const stop = new AbortController()
  let calls = 0
  await assert.rejects(
    withRetry(
      async () => {
        calls++
        throw new Error('HTTP 429 — later')
      },
      resolveRetry({ maxAttempts: 5 }),
      { signal: stop.signal, sleep: async () => stop.abort() },
    ),
  )
  assert.equal(calls, 1)
})

// ── Through the runner ─────────────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function sse(text: string): Response {
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return { id, name: id.toUpperCase(), provider: 'custom', model: 'm', systemPrompt: `You are ${id}.`, temperature: 0.5, hue: 1, position: { x: 0, y: 0 }, ...overrides }
}

async function run(spec: SwarmSpec) {
  const texts = new Map<string, string>()
  const notices: string[] = []
  const writes: MemoryEntry[] = []
  let phase = ''
  let error: string | undefined
  const cb: RunnerCallbacks = {
    onPhase: (p, d) => {
      phase = p
      if (d) error = d
    },
    onRound: () => {},
    onAgentStatus: () => {},
    onMessageStart: (e) => texts.set(e.id, ''),
    onMessageDelta: (id, d) => texts.set(id, (texts.get(id) ?? '') + d),
    onMessageReset: (id) => texts.set(id, ''),
    onMessageEnd: (id, patch) => {
      if (patch.text !== undefined) texts.set(id, patch.text)
    },
    onTransit: () => {},
    onNotice: (n) => notices.push(n),
    onMemoryWrite: (e) => writes.push(e.entry),
  }
  await runSwarm(spec, { custom: 'k' }, cb, new AbortController().signal, {
    endpoints: { custom: 'https://example.test/v1/chat/completions' },
    retrySleep: instant,
  })
  return { phase, error, texts: [...texts.values()], notices, writes }
}

const base = (partial: Partial<SwarmSpec>): SwarmSpec => ({
  name: 't',
  task: 'Go.',
  agents: [agent('a')],
  nodes: [],
  links: [],
  topology: 'broadcast',
  maxRounds: 1,
  entryIds: ['a'],
  ...partial,
})

test('a rate-limited call is retried and the run completes with the second answer only', async () => {
  let calls = 0
  globalThis.fetch = (async () => (++calls === 1 ? new Response('{"error":{"message":"slow down"}}', { status: 429 }) : sse('hello'))) as typeof fetch
  const r = await run(base({}))
  assert.equal(r.phase, 'done', r.error ?? '')
  assert.equal(calls, 2)
  assert.deepEqual(r.texts, ['hello'])
  assert.ok(r.notices.some((n) => /retrying in .* \(attempt 2\/3\)/.test(n)), r.notices.join('\n'))
})

test('an agent with maxAttempts 1 fails on the first 503, as before retries existed', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return new Response('down', { status: 503 })
  }) as typeof fetch
  const r = await run(base({ agents: [agent('a', { retry: { maxAttempts: 1 } })] }))
  assert.equal(r.phase, 'error')
  assert.equal(calls, 1)
})

test('the swarm policy applies when the agent has none', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return new Response('down', { status: 502 })
  }) as typeof fetch
  const r = await run(base({ retry: { maxAttempts: 4 } }))
  assert.equal(r.phase, 'error')
  assert.equal(calls, 4)
})

test('outputKey writes the answer to every memory the agent may write, and only those', async () => {
  globalThis.fetch = (async () => sse('the draft')) as typeof fetch
  const memory = (id: string, name: string) => ({ id, name, kind: 'memory' as const, position: { x: 0, y: 0 }, mode: 'blackboard' as const, wakeReaders: false, seed: [], maxChars: 2400 })
  const r = await run(
    base({
      agents: [agent('a', { outputKey: 'draft' })],
      nodes: [memory('m1', 'Board'), memory('m2', 'Archive'), memory('m3', 'ReadOnly')],
      links: [
        { id: 'w1', source: 'a', target: 'm1', kind: 'access', access: 'write' },
        { id: 'w2', source: 'a', target: 'm2', kind: 'access', access: 'readwrite' },
        { id: 'r3', source: 'a', target: 'm3', kind: 'access', access: 'read' },
      ],
    }),
  )
  assert.equal(r.phase, 'done', r.error ?? '')
  assert.deepEqual(
    r.writes.map((w) => [w.key, w.value, w.author]),
    [
      ['draft', 'the draft', 'A'],
      ['draft', 'the draft', 'A'],
    ],
  )
})

test('retry and outputKey survive an export and a paste, and junk is dropped', async () => {
  const { exportSwarm, parsePortable, portableToSpec } = await import('./portable.ts')
  const spec = base({ retry: { maxAttempts: 5, on: 'all' }, agents: [agent('a', { retry: { initialDelayMs: 250 }, outputKey: 'draft' })] })
  const parsed = parsePortable(exportSwarm(spec))
  assert.ok(parsed.ok && parsed.value.kind === 'swarm')
  const back = portableToSpec(parsed.value as never)
  assert.deepEqual(back.retry, { maxAttempts: 5, on: 'all' })
  assert.deepEqual(back.agents[0].retry, { initialDelayMs: 250 })
  assert.equal(back.agents[0].outputKey, 'draft')
  const junk = parsePortable(JSON.stringify({ ...JSON.parse(exportSwarm(spec)), retry: { maxAttempts: 'lots', on: 'sometimes' } }))
  assert.ok(junk.ok)
  assert.equal((junk.value as { retry?: unknown }).retry, undefined)
})
