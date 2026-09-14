/**
 * The refusal that arrives as CONTENT.
 *
 * Found by firing the app at a real gateway. It answers `200 OK` with a well-formed SSE stream whose
 * only content is *"Unsupported parameter: 'temperature' is not supported with this model."* — so the
 * retry, which hung off `res.ok`, never ran: every agent's answer became that sentence and the run
 * reported `done`. Nothing in the unit tests could see it, because they all tested the HTTP paths.
 */
import assert from 'node:assert/strict'
import { test, afterEach } from 'vitest'
import { callProvider } from './providers.ts'

const REFUSAL = "Unsupported parameter: 'temperature' is not supported with this model."
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** A 200 response whose SSE body streams `chunks` as assistant content. */
function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encode = (s: string) => controller.enqueue(new TextEncoder().encode(s))
      for (const chunk of chunks) {
        encode(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`)
      }
      encode('data: [DONE]\n\n')
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

test('a refusal streamed as content triggers a retry without temperature', async () => {
  const sent: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>
    sent.push(payload)
    // First call carries a temperature and is refused in-band; the retry gets a real answer.
    return 'temperature' in payload ? sseResponse([REFUSAL]) : sseResponse(['The cat ', 'requires the door.'])
  }) as typeof fetch

  const streamed: string[] = []
  let discarded = 0
  let notice = ''
  const result = await callProvider('custom', {
    model: 'a-model-that-refuses',
    system: 'You are "The Cat".',
    messages: [{ role: 'user', content: 'go' }],
    temperature: 0.7,
    maxTokens: 220,
    apiKey: 'k',
    endpoint: 'https://example.invalid/v1/chat/completions',
    signal: new AbortController().signal,
    onDelta: (delta) => streamed.push(delta),
    onNotice: (message) => (notice = message),
    onDiscard: () => discarded++,
  })

  assert.equal(sent.length, 2, 'it tried again')
  assert.ok('temperature' in sent[0], 'the first attempt carried a temperature')
  assert.equal('temperature' in sent[1], false, 'the retry did not')
  assert.equal(result.text, 'The cat requires the door.', 'the answer is the real one')
  assert.match(notice, /does not accept a temperature/i, 'and the user is told the slider is ignored')
  assert.equal(discarded, 1, 'what had been streamed is thrown away')
  // The refusal WAS streamed before the retry; the caller is told to drop it, and does.
  assert.ok(streamed.includes(REFUSAL))
})

test('the memo means a second agent on the same model never sends temperature again', async () => {
  const sent: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>
    sent.push(payload)
    return 'temperature' in payload ? sseResponse([REFUSAL]) : sseResponse(['fine'])
  }) as typeof fetch

  const call = () =>
    callProvider('custom', {
      model: 'memoised-model',
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
      temperature: 0.7,
      maxTokens: 220,
      apiKey: 'k',
      endpoint: 'https://example.invalid/v1/chat/completions',
      signal: new AbortController().signal,
      onDelta: () => {},
    })

  await call()
  await call()
  // First agent: refused, then retried. Second: straight to the retry shape. Three calls, not four.
  assert.equal(sent.length, 3)
  assert.equal('temperature' in sent[2], false)
})

test('a model that merely mentions temperature is NOT retried', async () => {
  // The guard that keeps this from firing on innocent prose: an answer about the weather is an answer.
  const sent: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)))
    return sseResponse(['The temperature outside is not supported by the cat, who finds it unsupported and damp.'])
  }) as typeof fetch

  const result = await callProvider('custom', {
    model: 'chatty',
    system: 's',
    messages: [{ role: 'user', content: 'go' }],
    temperature: 0.7,
    maxTokens: 220,
    apiKey: 'k',
    endpoint: 'https://example.invalid/v1/chat/completions',
    signal: new AbortController().signal,
    onDelta: () => {},
  })

  assert.equal(sent.length, 1, 'no retry')
  assert.match(result.text, /^The temperature outside/)
})

test('max_tokens is sent on the OpenAI-compatible path, under both spellings', async () => {
  let payload: Record<string, unknown> = {}
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    payload = JSON.parse(String(init.body))
    return sseResponse(['ok'])
  }) as typeof fetch

  await callProvider('custom', {
    model: 'm',
    system: 's',
    messages: [{ role: 'user', content: 'go' }],
    temperature: 0.4,
    maxTokens: 123,
    apiKey: 'k',
    endpoint: 'https://example.invalid/v1/chat/completions',
    signal: new AbortController().signal,
    onDelta: () => {},
  })

  assert.equal(payload.max_tokens, 123)
  assert.equal(payload.max_completion_tokens, 123, 'newer gateways only know this one')
})
