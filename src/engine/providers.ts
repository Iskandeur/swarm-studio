/**
 * Provider adapters. Every one of them exposes the same shape: given a system prompt,
 * a list of messages and a sink for text deltas, stream an answer back.
 *
 * Keys never leave the browser: requests go straight from the page to the provider.
 * There is no backend in this project, on purpose — nothing to host, nothing to trust.
 */
import type { ProviderId } from '../types.ts'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  model: string
  system: string
  messages: ChatMessage[]
  temperature: number
  apiKey: string
  signal: AbortSignal
  /** Called with each chunk of text as it arrives. */
  onDelta: (text: string) => void
}

export interface ChatResult {
  text: string
  tokensIn: number
  tokensOut: number
}

export interface ProviderInfo {
  id: ProviderId
  label: string
  /** Empty for the mock provider — it needs no key. */
  keyLabel: string
  keyUrl?: string
  /** Suggestions only. The model field is free text, so a new release needs no code change. */
  models: string[]
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'mock',
    label: 'Demo (no key)',
    keyLabel: '',
    models: ['demo-fast', 'demo-verbose', 'demo-terse'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    keyLabel: 'Anthropic API key',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    keyLabel: 'OpenAI API key',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: [],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    keyLabel: 'OpenRouter API key',
    keyUrl: 'https://openrouter.ai/keys',
    models: [],
  },
]

export function providerInfo(id: ProviderId): ProviderInfo {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]
}

/** A rough token count, good enough for a live gauge. Not a billing figure. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4))
}

/** Reads an SSE body line by line and yields the payload of each `data:` line. */
async function* sseLines(res: Response): AsyncGenerator<string> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error('response has no body to stream')
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('data:')) yield trimmed.slice(5).trim()
    }
  }
}

async function failure(res: Response): Promise<never> {
  const body = await res.text().catch(() => '')
  let detail = body.slice(0, 400)
  try {
    const parsed = JSON.parse(body)
    detail = parsed?.error?.message ?? detail
  } catch {
    /* keep the raw body */
  }
  throw new Error(`HTTP ${res.status} — ${detail || res.statusText}`)
}

/** OpenAI-compatible /chat/completions streaming, shared by OpenAI and OpenRouter. */
async function chatCompletions(url: string, req: ChatRequest, extraHeaders: Record<string, string> = {}): Promise<ChatResult> {
  const res = await fetch(url, {
    method: 'POST',
    signal: req.signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${req.apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model: req.model,
      temperature: req.temperature,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'system', content: req.system }, ...req.messages],
    }),
  })
  if (!res.ok) await failure(res)

  let text = ''
  let tokensIn = 0
  let tokensOut = 0
  for await (const data of sseLines(res)) {
    if (data === '[DONE]') break
    let event: any
    try {
      event = JSON.parse(data)
    } catch {
      continue
    }
    const delta: string | undefined = event?.choices?.[0]?.delta?.content
    if (delta) {
      text += delta
      req.onDelta(delta)
    }
    if (event?.usage) {
      tokensIn = event.usage.prompt_tokens ?? tokensIn
      tokensOut = event.usage.completion_tokens ?? tokensOut
    }
  }
  return {
    text,
    tokensIn: tokensIn || estimateTokens(req.system + req.messages.map((m) => m.content).join('')),
    tokensOut: tokensOut || estimateTokens(text),
  }
}

/** Anthropic Messages API, streamed straight from the browser. */
async function anthropic(req: ChatRequest): Promise<ChatResult> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: req.signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': req.apiKey,
      'anthropic-version': '2023-06-01',
      // Opt-in header required for direct browser calls; without it the request is refused.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: 1024,
      temperature: req.temperature,
      system: req.system,
      stream: true,
      messages: req.messages,
    }),
  })
  if (!res.ok) await failure(res)

  let text = ''
  let tokensIn = 0
  let tokensOut = 0
  for await (const data of sseLines(res)) {
    let event: any
    try {
      event = JSON.parse(data)
    } catch {
      continue
    }
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      text += event.delta.text
      req.onDelta(event.delta.text)
    }
    if (event.type === 'message_start') tokensIn = event.message?.usage?.input_tokens ?? tokensIn
    if (event.type === 'message_delta') tokensOut = event.usage?.output_tokens ?? tokensOut
    if (event.type === 'error') throw new Error(event.error?.message ?? 'stream error')
  }
  return { text, tokensIn: tokensIn || estimateTokens(req.system), tokensOut: tokensOut || estimateTokens(text) }
}

const LOREM = [
  'Taking the task apart, the part that actually carries risk is the hand-off between steps.',
  'I disagree with the previous point: the constraint is throughput, not correctness.',
  'Concretely: pick the smallest version that can fail visibly, ship it, measure.',
  'Two unknowns remain, and only one of them is cheap to resolve first.',
  'Summarising what the group converged on, minus the parts nobody verified.',
  'A counter-example: if the input arrives out of order, the whole assumption drops.',
  'Holding the line here — the earlier estimate was off by roughly a factor of three.',
  'What we have not answered yet is who owns the step after this one.',
]

/** Deterministic-ish local answers so the whole app is demoable with no key at all. */
async function mock(req: ChatRequest): Promise<ChatResult> {
  const seed = req.system.length + req.messages.length * 7 + req.model.length
  const sentences = req.model === 'demo-terse' ? 1 : req.model === 'demo-verbose' ? 4 : 2
  const parts: string[] = []
  for (let i = 0; i < sentences; i++) parts.push(LOREM[(seed + i * 3) % LOREM.length])
  const full = parts.join(' ')
  const step = req.model === 'demo-fast' ? 6 : 3
  const pause = req.model === 'demo-fast' ? 8 : 18

  let text = ''
  for (let i = 0; i < full.length; i += step) {
    if (req.signal.aborted) throw new DOMException('aborted', 'AbortError')
    const chunk = full.slice(i, i + step)
    text += chunk
    req.onDelta(chunk)
    await new Promise((r) => setTimeout(r, pause))
  }
  return { text, tokensIn: estimateTokens(req.system + req.messages.map((m) => m.content).join('')), tokensOut: estimateTokens(text) }
}

export function callProvider(provider: ProviderId, req: ChatRequest): Promise<ChatResult> {
  switch (provider) {
    case 'mock':
      return mock(req)
    case 'anthropic':
      return anthropic(req)
    case 'openai':
      return chatCompletions('https://api.openai.com/v1/chat/completions', req)
    case 'openrouter':
      return chatCompletions('https://openrouter.ai/api/v1/chat/completions', req, {
        'HTTP-Referer': window.location.origin,
        'X-Title': 'Swarm Studio',
      })
  }
}
