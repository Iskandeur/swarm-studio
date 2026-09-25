/**
 * Provider adapters. Every one of them exposes the same shape: given a system prompt,
 * a list of messages and a sink for text deltas, stream an answer back.
 *
 * Keys never leave the browser: requests go straight from the page to the provider.
 * There is no backend in this project, on purpose — nothing to host, nothing to trust.
 */
import type { ProviderId } from '../types.ts'
import { fetchLocalAware } from './localServer.ts'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  model: string
  system: string
  messages: ChatMessage[]
  temperature: number
  /** Hard ceiling on the answer. Prose asking for brevity is a suggestion; this is not. */
  maxTokens: number
  apiKey: string
  /** Full chat endpoint URL. Defaults per provider; required for `custom`. */
  endpoint: string
  signal: AbortSignal
  /** Called with each chunk of text as it arrives. */
  onDelta: (text: string) => void
  /** Something the user should know that is not a failure (e.g. a parameter the model refused). */
  onNotice?: (message: string) => void
  /** Throw away what has already been streamed: the answer is being fetched again. */
  onDiscard?: () => void
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
  /** Whether the endpoint URL is the user's to supply (no sensible default exists). */
  needsEndpoint?: boolean
  hint?: string
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
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    keyLabel: 'API key',
    models: [],
    needsEndpoint: true,
    hint: 'Any gateway that speaks /chat/completions: vLLM, Ollama, LM Studio, LiteLLM, a company gateway…',
  },
]

export function providerInfo(id: ProviderId): ProviderInfo {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]
}

/** The demo provider's model ids, which mean nothing to any real endpoint. */
const DEMO_MODELS = new Set(providerInfo('mock').models)

/**
 * The model to carry over when an agent changes provider.
 *
 * Switching Demo → OpenAI used to keep `demo-fast`, and the first real call 404'd on a model id
 * that only ever existed locally. An empty string is better: the field then says "no model set" in
 * red instead of looking configured and failing at run time.
 */
export function modelForProvider(nextProvider: ProviderId, currentModel: string): string {
  const suggested = providerInfo(nextProvider).models[0]
  if (suggested) return suggested
  return DEMO_MODELS.has(currentModel) ? '' : currentModel
}

/**
 * Where each provider is called. Every one of them is overridable, so pointing an agent at a
 * self-hosted or corporate gateway never needs a code change — the URL is yours, typed at runtime
 * and kept in this browser.
 */
export const DEFAULT_ENDPOINTS: Record<ProviderId, string> = {
  mock: '',
  anthropic: 'https://api.anthropic.com/v1/messages',
  openai: 'https://api.openai.com/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  custom: '',
}

export type Endpoints = Partial<Record<ProviderId, string>>

export function resolveEndpoint(provider: ProviderId, endpoints: Endpoints = {}): string {
  return (endpoints[provider] ?? '').trim() || DEFAULT_ENDPOINTS[provider]
}

/** `…/v1/chat/completions` → `…/v1/models`. Used to offer a model list instead of blind typing. */
export function modelsUrlFrom(chatUrl: string): string {
  const trimmed = chatUrl.trim().replace(/\/+$/, '')
  if (/\/chat\/completions$/.test(trimmed)) return trimmed.replace(/\/chat\/completions$/, '/models')
  if (/\/messages$/.test(trimmed)) return trimmed.replace(/\/messages$/, '/models')
  return trimmed + '/models'
}

/**
 * Pull model ids out of a `/models` response. Three shapes are accepted because gateways disagree:
 * OpenAI's `{data:[{id}]}`, a bare `[{id}]`, and the "list of upstreams" shape some relays use,
 * `[{host, models:[{id}]}]`.
 */
export function parseModelList(payload: unknown): string[] {
  const ids = new Set<string>()
  const take = (entry: unknown) => {
    if (typeof entry === 'string') return ids.add(entry)
    if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>
      // The first *string* among these, not the first defined one: some gateways number their
      // models (`id: 169`) and put the callable slug in `name`. With `??` the number wins and
      // every model silently disappears.
      const slug = [record.id, record.name, record.model].find((v) => typeof v === 'string' && v !== '')
      if (typeof slug === 'string') ids.add(slug)
      if (Array.isArray(record.models)) record.models.forEach(take)
    }
  }
  if (Array.isArray(payload)) payload.forEach(take)
  else if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    for (const key of ['data', 'models', 'result']) {
      if (Array.isArray(record[key])) record[key].forEach(take)
    }
  }
  return [...ids].sort()
}

/** Lists the models an endpoint serves. Doubles as the "does my key and URL work?" check. */
export async function listModels(
  provider: ProviderId,
  opts: { endpoint: string; apiKey: string; signal?: AbortSignal },
): Promise<string[]> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (provider === 'anthropic') {
    headers['x-api-key'] = opts.apiKey
    headers['anthropic-version'] = '2023-06-01'
    headers['anthropic-dangerous-direct-browser-access'] = 'true'
  } else if (opts.apiKey) {
    headers.authorization = `Bearer ${opts.apiKey}`
  }
  const res = await fetchLocalAware(modelsUrlFrom(opts.endpoint), { headers, signal: opts.signal })
  if (!res.ok) await failure(res)
  return parseModelList(await res.json())
}

/** A rough token count, good enough for a live gauge. Not a billing figure. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4))
}

/** Reads an SSE body line by line and yields the payload of each `data:` line. */
async function* sseLines(res: Response, onRaw?: (chunk: string) => void): AsyncGenerator<string> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error('response has no body to stream')
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const decoded = decoder.decode(value, { stream: true })
    // Kept for the error path: once the body is read it cannot be read again, and a 200 carrying a
    // JSON error instead of a stream has to be quotable.
    onRaw?.(decoded)
    buffer += decoded
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('data:')) yield trimmed.slice(5).trim()
    }
  }
}

async function failure(res: Response): Promise<never> {
  return failureFromBody(res, await res.text().catch(() => ''))
}

/** Split out because a retry path has already consumed the body — a Response can only be read once. */
function failureFromBody(res: Response, body: string): never {
  let detail = body.slice(0, 400)
  try {
    const parsed = JSON.parse(body)
    detail = parsed?.error?.message ?? detail
  } catch {
    /* keep the raw body */
  }
  throw new Error(`HTTP ${res.status} — ${detail || res.statusText}`)
}

/**
 * Models that reject `temperature` outright, keyed `provider:model`.
 *
 * Reasoning models (the o-series and the GPT-5 family, and whatever a gateway fronts them with)
 * answer `400 Unsupported parameter: 'temperature'`. There is no way to know from the model id —
 * gateways rename freely — so the fact is learned from the refusal and remembered for the session
 * instead of being hardcoded into a list that would rot.
 */
const REJECTS_TEMPERATURE = new Set<string>()

/** Does this error body say "I will not accept temperature"? */
export function isTemperatureRefusal(message: string): boolean {
  const lower = message.toLowerCase()
  if (!lower.includes('temperature')) return false
  return (
    lower.includes('unsupported') ||
    lower.includes('not supported') ||
    lower.includes('does not support') ||
    lower.includes('unknown parameter') ||
    lower.includes('unrecognized')
  )
}

/**
 * Is this streamed text an error report rather than an answer?
 *
 * Stricter than `isTemperatureRefusal` on purpose. That one reads an HTTP error body, where anything
 * goes; this one reads what a model *said*, and a model is allowed to write the words "temperature"
 * and "not supported" in a sentence. Tested against exactly that: *"The temperature outside is not
 * supported by the cat…"* must be delivered as the answer it is, not silently re-fetched. So the text
 * has to both mention the refusal AND wear the clothes of an error: an error-ish opening, or a
 * machine-readable error type.
 */
export function looksLikeStreamedParameterError(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length > 400 || !isTemperatureRefusal(trimmed)) return false
  return (
    /^(\{|unsupported parameter|unknown parameter|unrecognized|invalid|error)/i.test(trimmed) ||
    /invalid_request_error|"?param(eter)?"?\s*[:=]/i.test(trimmed)
  )
}

/** OpenAI-compatible /chat/completions streaming: OpenAI, OpenRouter and any custom gateway. */
async function chatCompletions(
  req: ChatRequest,
  extraHeaders: Record<string, string> = {},
  providerId = 'openai',
): Promise<ChatResult> {
  if (!req.endpoint) throw new Error('no endpoint URL set for this provider — open Settings')
  const memo = `${providerId}:${req.model}`
  const sendTemperature = !REJECTS_TEMPERATURE.has(memo)

  const res = await fetchLocalAware(req.endpoint, {
    method: 'POST',
    signal: req.signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${req.apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model: req.model,
      ...(sendTemperature ? { temperature: req.temperature } : {}),
      // Both spellings: the newer OpenAI-compatible gateways rejected max_tokens for the completion
      // models, the older ones do not know max_completion_tokens. Sending both is accepted by both.
      max_tokens: req.maxTokens,
      max_completion_tokens: req.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'system', content: req.system }, ...req.messages],
    }),
  })

  // Learn the refusal, then retry once without the parameter rather than making the user find out.
  if (!res.ok && sendTemperature) {
    const body = await res.text().catch(() => '')
    if (isTemperatureRefusal(body)) {
      REJECTS_TEMPERATURE.add(memo)
      req.onNotice?.(`${req.model} does not accept a temperature — retrying without it, and the slider is ignored for this model.`)
      return chatCompletions(req, extraHeaders, providerId)
    }
    await failureFromBody(res, body)
  }
  if (!res.ok) await failure(res)

  let text = ''
  let tokensIn = 0
  let tokensOut = 0
  /** Did this look like a stream at all? A 200 carrying a JSON error has no `data:` line. */
  let sawStream = false
  let raw = ''
  for await (const data of sseLines(res, (chunk) => (raw += chunk))) {
    sawStream = true
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
    if (event?.error) throw new Error(String(event.error?.message ?? event.error))
  }

  // A 200 that was never a stream is an error wearing a success code. Reporting it as an empty
  // message let a misconfigured endpoint look like a laconic model.
  if (!sawStream) failureFromBody(res, raw || 'the endpoint answered 200 but sent no stream')

  /**
   * ⚠️ Some gateways deliver a parameter refusal as **streamed assistant content**, with HTTP 200 and
   * a well-formed SSE body. Measured on a real one: every agent's answer was the single line
   * *"Unsupported parameter: 'temperature' is not supported with this model."* and the run reported
   * `done`. So the retry cannot hang off `res.ok` alone — the refusal has to be recognised in the
   * TEXT too. Guarded by `sendTemperature` and by the answer being short and nothing else, so a model
   * legitimately discussing the word "temperature" is never retried behind the user's back.
   */
  if (sendTemperature && looksLikeStreamedParameterError(text)) {
    REJECTS_TEMPERATURE.add(memo)
    // The refusal was already streamed into the transcript; it must not survive the retry.
    req.onDiscard?.()
    req.onNotice?.(`${req.model} does not accept a temperature — retrying without it, and the slider is ignored for this model.`)
    return chatCompletions(req, extraHeaders, providerId)
  }

  return {
    text,
    tokensIn: tokensIn || estimateTokens(req.system + req.messages.map((m) => m.content).join('')),
    tokensOut: tokensOut || estimateTokens(text),
  }
}

/** Anthropic Messages API, streamed straight from the browser. */
async function anthropic(req: ChatRequest): Promise<ChatResult> {
  const res = await fetch(req.endpoint, {
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
      max_tokens: req.maxTokens,
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

/**
 * Lines the demo provider speaks for the characters shipped in the presets, keyed by agent name.
 *
 * Why this exists: the point of a preset is that pressing Run with no API key shows you FOUR
 * visibly different voices reacting to the same input. Generic filler text defeats that — it makes
 * the swarm look like it ignored both the task and the prompts, which is exactly how a first-time
 * visitor concludes the product is broken. Unknown agents fall back to `LOREM`, and every demo
 * message is badged "demo" in the transcript, so nothing here pretends to be a model.
 */
export const DEMO_VOICES: Record<string, string[]> = {
  'The Cat': [
    'The cat requires the door. The cat does not negotiate with meteorology.',
    'The cat has reconsidered nothing. The door remains the issue.',
  ],
  'The Human': [
    "Reframing the ask: we're looking at a 40% uplift in perceived autonomy against a modest exposure to precipitation. I've circled back with myself and I'm aligned.",
    'Taking that away as an action. My action. I am the action.',
  ],
  'The Door': [
    'The door was opened forty-one times yesterday. Hinge temperature nominal. Four millimetres of rain in the last hour. The door has no preference. The door remembers every single one.',
    'The door is ajar by nine centimetres. This was not the door\'s decision.',
  ],
  'The Narrator': [
    'Here, at the threshold, one of nature\'s oldest negotiations. The human folds, as humans do. The door swings. The cat steps out, considers the rain for two entire seconds, and comes back in. Magnificent.',
    'And so the council disperses, each member convinced it won.',
  ],
  'The Best Man': [
    'Right. One anecdote from you, one redaction from you, one feeling from you. I am assembling, not writing. Go.',
    'Approved: the sibling\'s ending, the historian\'s first half, none of the lawyer\'s. We ride in three hours.',
  ],
  'The Historian': [
    'On 14 March 2009 the groom introduced himself to his future wife as "basically a pilot". He was not. He was between jobs. I have the photographs.',
    'There is also the matter of the kayak. I assume we are including the kayak.',
  ],
  'The Lawyer': [
    'Strike the kayak. Strike "basically a pilot". Retain the word "radiant", which is unfalsifiable.',
    'Counsel notes the room contains both families and advises against the word "finally".',
  ],
  'The Sibling': [
    'ok but what if you just say he cried at the dog film and then sit down. that\'s the whole speech. everyone will lose it.',
    'you\'re overthinking the middle bit. the middle bit is that he\'s happy. say that.',
  ],
  'The Fact-Checker': [
    'Established: the cat opens the door. Asserted without evidence: that any high ground was ever held. Unverifiable: the author\'s tone of voice throughout.',
    'Still outstanding: which of them installed the handle.',
  ],
  'The Writer': [
    'For eleven years the arrangement was clear: I opened the door, and in exchange I was in charge. On Tuesday the cat learned the handle, and the arrangement became a courtesy. Nothing has been said about it. Nothing needs to be.',
    'Trimmed the second clause. It was doing the work of a sigh.',
  ],
  'The Editor': [
    'Cut to: "I used to open the door. Now I am simply present when it opens." Better. Shorter. Sadder.',
    'Two words gone. You will not miss them.',
  ],

  // The Fridge Tribunal: a blackboard, a join, a condition, a human gate. The tags below are what a
  // model would write; the demo writes them so every mechanism moves with no key.
  'The Detective': [
    'Spoon in the sink, still warm. Lid licked clean. The label says it all, in 36-point Comic Sans. <write memory="Evidence" key="suspect">Gary from Accounts</write><write memory="Evidence" key="motive">skipped lunch to finish a spreadsheet nobody asked for</write>',
    'Fresh angle: the bite radius on the spoon is Gary-sized. <write memory="Evidence" key="spoon">bite radius consistent with Gary</write>',
  ],
  'Witness: Denise': [
    'I labelled it PROPERTY OF DENISE, DO NOT. There was no ambiguity. There was only Gary.',
    'I would like it on record that it was the peach one.',
  ],
  'Witness: Gary': [
    'I was in a meeting that could have been an email. The email could have been silence. I have no memory of yoghurt.',
    'Define "ate".',
  ],
  'The Prosecutor': [
    'The evidence board names Gary, the motive is a spreadsheet, and the spoon is warm. The prosecution rests, mainly out of tiredness.',
    'The prosecution rests again, more tired.',
  ],
  'The Judge': [
    'Gary is guilty of yoghurt in the first degree. Sentence: he buys the next pack and labels it himself, in Comic Sans, as a gesture.',
    'The court is adjourned until someone touches the hummus.',
  ],

  // The Delegation Spiral: spawn, all the way down to the depth limit. Each delegator's first turn is
  // only the tag, so nothing but the final answer climbs back up.
  'The CEO': [
    '<spawn name="VP of Summaries">I need a one-page summary of why the coffee machine is broken. I will not be reading it.</spawn>',
    'Perfect. Nobody tell me what it says. Put it in the board deck.',
  ],
  'VP of Summaries': [
    '<spawn name="Director of Brevity">Great ask from the top: one-page summary on the coffee machine. Cascade as needed.</spawn>',
    'Summary attached. I added a slide about synergy and removed the word "unplugged", which tested badly.',
  ],
  'Director of Brevity': [
    '<spawn name="Senior Manager">Coffee machine summary, one page, CEO-grade. Delegate for bandwidth.</spawn>',
    'Reviewed. Shortened it to "coffee: resolved". Escalating upward with a sense of momentum.',
  ],
  'Senior Manager': [
    '<spawn name="The Intern">Please write a one-page summary of why the coffee machine is broken.</spawn>',
    'The intern is above my delegation limit, so I walked to the kitchen myself. The coffee machine is unplugged. It has always been unplugged.',
  ],

  // The Recursive Excuse, and the built-in blocks it and the library use.
  'Recursive Solver': [
    'Too big to explain in one go. The smaller question: why is the FIRST half of the report late? <route to="split"/>',
    'Small enough to answer: the printer asked for a firmware update, and nobody felt emotionally ready. <route to="direct"/>',
  ],
  'Merger': [
    'Scaling that back up one level: the same reason, twice as long, with a meeting about it in between.',
  ],
  'Loop Writer': [
    'Draft 1: The meeting is cancelled. Nobody knows why. Everyone is relieved.',
    'Draft 2: The meeting is cancelled. Relief spreads quietly, like a rumour about free cake.',
  ],
  'Loop Critic': [
    '```json\n{"score": 5, "note": "funny, but the second sentence is doing nothing"}\n```',
    '```json\n{"score": 8, "note": "ship it"}\n```\nThe meeting is cancelled. Relief spreads quietly, like a rumour about free cake.',
  ],
  'Debate Pro': [
    'In favour, obviously: it is bold, it is cheap, and nobody has tried it, which I choose to read as a gap in the market.',
  ],
  'Debate Con': [
    'Against: nobody has tried it because the three people who did are now consultants who will not discuss it.',
  ],
  'Debate Judge': [
    'Both sides made one good point and one confident one. Ruling: do a small version on Tuesday and pretend it was always the plan.',
  ],
  'Splitter': [
    'Three parts, three helpers. <spawn name="Part One Worker">Handle the first third.</spawn><spawn name="Part Two Worker">Handle the second third.</spawn><spawn name="Part Three Worker">Handle the last third.</spawn>',
    'MERGE: part one is done and shorter than it looked, part two found a typo in part one, part three is fine and would like that noted.',
  ],
  'Part One Worker': ['First third: done, and shorter than it looked.'],
  'Part Two Worker': ['Second third: done. Also, there is a typo in the first third.'],
  'Part Three Worker': ['Last third: fine. Please note that it is fine.'],
  'Reducer': ['Merged: three thirds make a whole, which surprised nobody except the second worker.'],

  // Triage (System 1 → System 2): only the desk the decision picks ever speaks.
  'Billing Desk': [
    'I can see the double charge and I am refunding the second one now; it will be back on your card within five days.',
    'The refund has gone through on our side. Your next invoice will show it as a credit line.',
  ],
  'Tech Desk': [
    'That crash is a known issue in the billing screen on older app versions: update the app and it opens again.',
    'If it still crashes after the update, send me the version number from Settings → About and I will take it from there.',
  ],
  'Account Desk': [
    'I have sent a reset link to the address on file; it expires in an hour.',
    'Once you are back in, turn on two-step sign-in under Profile; it takes a minute.',
  ],
  'Senior Agent (System 2)': [
    'Two separate problems here, and one probably caused the other. First, the double charge: the second payment is a retry that went through after a timeout, so I am refunding it now. Second, the crash: the billing screen fails to load an invoice with two payments on it, which is exactly your case; it is fixed in the latest app version. Update the app, and your billing page will open and show one charge and one refund.',
    'Following up: the refund is issued and the fix is live. If either one does not show on your side by tomorrow, reply here and it comes straight back to me.',
  ],
}

/** The agent's name as `buildSystem` writes it — the only stable handle the mock has. */
export function demoVoiceFor(system: string): string[] {
  const named = /You are "([^"]+)"/.exec(system)
  const voice = named ? DEMO_VOICES[named[1]] : undefined
  return voice ?? LOREM
}

/** Deterministic-ish local answers so the whole app is demoable with no key at all. */
async function mock(req: ChatRequest): Promise<ChatResult> {
  const voice = demoVoiceFor(req.system)
  const inCharacter = voice !== LOREM
  // At the deepest level of a recursive block, a character answers with its LAST line: the demo's
  // stand-in for a model reading "at the limit, answer directly" in its prompt.
  const nesting = /at nesting depth (\d+) \(the limit is (\d+)\)/.exec(req.system)
  const deepest = Boolean(nesting && Number(nesting[1]) >= Number(nesting[2]))
  const seed = req.system.length + req.messages.length * 7 + req.model.length
  // In character, one line IS the answer; the generic filler needs a few to look like a paragraph.
  const sentences = inCharacter ? 1 : req.model === 'demo-terse' ? 1 : req.model === 'demo-verbose' ? 4 : 2
  const parts: string[] = []
  // The turn number picks the line, so an agent that speaks twice does not repeat itself.
  const turn = req.messages.filter((m) => m.role === 'assistant').length
  for (let i = 0; i < sentences; i++) {
    const line = deepest ? voice.length - 1 : (turn + i) % voice.length
    parts.push(inCharacter ? voice[line] : voice[(seed + i * 3) % voice.length])
  }
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
    case 'custom':
      return chatCompletions(req, {}, provider)
    case 'openrouter':
      return chatCompletions(
        req,
        // Guarded: the engine must also run where there is no page (a server, one day).
        { 'HTTP-Referer': typeof location !== 'undefined' ? location.origin : 'https://github.com/Iskandeur/swarm-studio', 'X-Title': 'Swarm Studio' },
        provider,
      )
  }
}
