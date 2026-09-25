/**
 * Decision models: typed questions in, typed answers out, no text generated.
 *
 * TypeSafe's Jev is the first of these ("System One" models). You send a `state` and named questions;
 * each question has a type and comes back as a typed answer your code can branch on directly:
 *
 *   POST { model, state, questions: { route: { type: "choice", instructions, criteria: { billing: "…" } } } }
 *   →    { answers: { route: { type: "choice", choice: "billing", confidence: 0.93, probabilities: {…} } }, usage }
 *
 * Three question types, shapes checked against TypeSafe's SDK reference and a live call:
 *  · `choice` — criteria `{label: description}` → `{choice, confidence, probabilities}`
 *  · `noul`   — optional criteria `{true, false}` → `{noul}`, the probability of yes
 *  · `score`  — criteria `[level0, level1, …]` (≥ 2) → `{score, confidence, probabilities, legend}`,
 *               where `score` is an expectation and may fall between two levels
 *
 * The same request works against OpenRouter's `/api/alpha/decisions` (an OpenRouter key, and CORS open
 * to any origin — verified with a preflight from the Pages origin) and against TypeSafe's own
 * `/v1/systemone`, which refuses browser origins: it needs a relay of your own in the endpoint field.
 *
 * Laya (ConvAI Innovations, Apache-2.0) is an open-weight model of the same kind. Its server,
 * laya-serve, answers the same `/v1/systemone` request on your own machine, with no key unless you
 * set one, but sends no CORS headers: `tools/laya-serve-cors.py` runs it with them. Its `model`
 * field names a checkpoint (`english`, `multilingual`, `typed-decisions`); anything else, `auto`
 * included, lets its router pick by language.
 *
 * The parser is strict on purpose. An answer with no usable choice is an ERROR the run reports, never a
 * default: a silent 0.5 would route a message as if the model had been unsure, when it said nothing.
 */
import type {
  DecisionAnswer,
  DecisionAnswers,
  DecisionNode,
  DecisionProviderId,
  DecisionQuestion,
  DecisionQuestionType,
  KeyId,
} from '../types.ts'
import { fetchLocalAware } from './localServer.ts'

export interface DecisionProviderInfo {
  id: DecisionProviderId
  label: string
  /** Which key slot the call uses. OpenRouter's is shared with the chat provider of the same name. */
  keyId?: KeyId
  keyLabel: string
  keyUrl?: string
  /** The call works without a key (a local server with no auth); the key is sent only when set. */
  keyOptional?: boolean
  models: string[]
  hint?: string
}

export const DECISION_TYPES: DecisionQuestionType[] = ['choice', 'noul', 'score']
export const DECISION_PROVIDER_IDS: DecisionProviderId[] = ['mock', 'openrouter', 'typesafe', 'laya']

export const DECISION_PROVIDERS: DecisionProviderInfo[] = [
  {
    id: 'mock',
    label: 'Demo decider (no key)',
    keyLabel: '',
    models: ['demo-decider'],
    hint: 'Scores each option by the words it shares with the message. Deterministic, and labelled demo.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter decisions',
    keyId: 'openrouter',
    keyLabel: 'OpenRouter API key (shared with the chat provider)',
    keyUrl: 'https://openrouter.ai/keys',
    models: ['typesafe/jev-1.13'],
    hint: 'Calls /api/alpha/decisions with your OpenRouter key. Works straight from the browser.',
  },
  {
    id: 'typesafe',
    label: 'TypeSafe (native)',
    keyId: 'typesafe',
    keyLabel: 'TypeSafe API key',
    keyUrl: 'https://typesafe.ai',
    models: ['jev-latest'],
    hint: 'TypeSafe refuses calls from a web page (CORS). Put a relay of your own in the endpoint field, or use OpenRouter.',
  },
  {
    id: 'laya',
    label: 'Laya (local, open weights)',
    keyId: 'laya',
    keyLabel: 'Laya server key (only if you set LAYA_API_KEY)',
    keyOptional: true,
    models: ['auto', 'english', 'multilingual', 'typed-decisions'],
    hint: 'Runs on your own machine: $0 a call, and the message never leaves it. Start it with tools/laya-serve-cors.py; on the first call your browser asks to let this page access apps on this device: Allow (Safari cannot, run Swarm Studio locally there). Its confidence is not the chance of being right: pick escalation thresholds from your own messages.',
  },
]

export const DEFAULT_DECISION_ENDPOINTS: Record<DecisionProviderId, string> = {
  mock: '',
  openrouter: 'https://openrouter.ai/api/alpha/decisions',
  typesafe: 'https://api.typesafe.ai/v1/systemone',
  laya: 'http://127.0.0.1:8000/v1/systemone',
}

export type DecisionEndpoints = Partial<Record<DecisionProviderId, string>>

export function decisionProviderInfo(id: DecisionProviderId): DecisionProviderInfo {
  return DECISION_PROVIDERS.find((p) => p.id === id) ?? DECISION_PROVIDERS[0]
}

export function resolveDecisionEndpoint(provider: DecisionProviderId, endpoints: DecisionEndpoints = {}): string {
  return (endpoints[provider] ?? '').trim() || DEFAULT_DECISION_ENDPOINTS[provider]
}

/** The key a Decision node's call uses, read from the one keyring. */
export function decisionKey(provider: DecisionProviderId, keys: Partial<Record<string, string>>): string {
  const slot = decisionProviderInfo(provider).keyId
  return slot ? (keys[slot] ?? '').trim() : ''
}

/** A question name becomes a key in a guard path (`route.choice`), so it must be one path segment. */
export const QUESTION_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,39}$/

/**
 * Everything wrong with a node's questions, as sentences. Empty = callable. The inspector shows the
 * same list the runner refuses on, so a node that will fail says so before the run.
 */
export function questionProblems(questions: DecisionQuestion[]): string[] {
  const problems: string[] = []
  if (questions.length === 0) problems.push('Add at least one question.')
  const seen = new Set<string>()
  for (const [index, q] of questions.entries()) {
    const who = q.name ? `"${q.name}"` : `question ${index + 1}`
    if (!QUESTION_NAME.test(q.name)) problems.push(`${who}: the name must be a single word (letters, digits, - or _).`)
    else if (seen.has(q.name)) problems.push(`${who}: two questions share this name.`)
    seen.add(q.name)
    if (!DECISION_TYPES.includes(q.type)) problems.push(`${who}: unknown type "${String(q.type)}".`)
    if (q.type === 'choice') {
      const labels = (q.options ?? []).map((o) => o.label.trim()).filter(Boolean)
      if (labels.length < 2) problems.push(`${who}: a choice needs at least two options.`)
      if (new Set(labels).size !== labels.length) problems.push(`${who}: two options share a label.`)
    }
    if (q.type === 'score' && (q.levels ?? []).filter((l) => l.trim()).length < 2) {
      problems.push(`${who}: a score needs at least two levels, lowest first.`)
    }
  }
  return problems
}

/** The request body. Shared by the real call and by tests, so what is tested is what is sent. */
export function buildDecisionBody(node: Pick<DecisionNode, 'model' | 'questions'>, state: string) {
  const questions: Record<string, Record<string, unknown>> = {}
  for (const q of node.questions) {
    const question: Record<string, unknown> = { type: q.type }
    if (q.instructions.trim()) question.instructions = q.instructions.trim()
    if (q.type === 'choice') {
      // An empty description is sent as null: the API reads that as "a label with no description".
      question.criteria = Object.fromEntries(
        (q.options ?? []).filter((o) => o.label.trim()).map((o) => [o.label.trim(), o.criterion.trim() || null]),
      )
    } else if (q.type === 'noul') {
      // Both sides or neither: OpenRouter's validator refuses `criteria` with only `true` described
      // (a live call answered 400 on `criteria.false`), though TypeSafe's SDK types both as optional.
      const side = (label: 'true' | 'false') => (q.options ?? []).find((o) => o.label === label)?.criterion.trim() ?? ''
      const yes = side('true')
      const no = side('false')
      if (yes || no) question.criteria = { true: yes || 'yes', false: no || 'no' }
    } else {
      question.criteria = (q.levels ?? []).map((l) => l.trim()).filter(Boolean)
    }
    questions[q.name] = question
  }
  return { model: node.model.trim(), state, questions }
}

function finite(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  if (typeof value === 'string' && value.trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function probabilitiesOf(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw)) {
    const n = finite(value)
    if (n !== undefined) out[key] = Math.round(Math.min(1, Math.max(0, n)) * 1e4) / 1e4
  }
  return out
}

function unit(value: unknown): number | undefined {
  const n = finite(value)
  return n !== undefined && n >= 0 && n <= 1 ? n : undefined
}

function quoteBody(json: unknown): string {
  let text: string
  try {
    text = JSON.stringify(json)
  } catch {
    text = String(json)
  }
  return text.length > 240 ? `${text.slice(0, 239)}…` : text
}

/**
 * Reads a response against the questions that were asked. Throws a sentence naming the question at
 * fault; returns only answers to questions that were asked, each fully typed.
 */
export function parseDecisionResponse(json: unknown, questions: DecisionQuestion[]): DecisionAnswers {
  const answers = (json as { answers?: unknown } | null)?.answers
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    const error = (json as { error?: { message?: unknown } } | null)?.error?.message
    throw new Error(typeof error === 'string' ? error : `the decision model returned no answers: ${quoteBody(json)}`)
  }
  const out: DecisionAnswers = {}
  for (const q of questions) {
    const raw = (answers as Record<string, unknown>)[q.name] as Record<string, unknown> | undefined
    if (!raw || typeof raw !== 'object') throw new Error(`the decision model did not answer "${q.name}"`)
    out[q.name] = parseAnswer(q, raw)
  }
  return out
}

function parseAnswer(q: DecisionQuestion, raw: Record<string, unknown>): DecisionAnswer {
  if (q.type === 'choice') {
    const labels = (q.options ?? []).map((o) => o.label.trim())
    const choice = typeof raw.choice === 'string' ? raw.choice : undefined
    if (!choice || !labels.includes(choice)) {
      throw new Error(`"${q.name}" came back with no usable choice (${choice === undefined ? 'none' : `"${choice}"`}; expected one of ${labels.join(', ')})`)
    }
    const confidence = unit(raw.confidence)
    if (confidence === undefined) throw new Error(`"${q.name}" came back without a confidence between 0 and 1`)
    return { type: 'choice', choice, confidence, probabilities: probabilitiesOf(raw.probabilities) }
  }
  if (q.type === 'noul') {
    const noul = unit(raw.noul)
    if (noul === undefined) throw new Error(`"${q.name}" came back without a yes-probability between 0 and 1`)
    return { type: 'noul', noul, yes: noul >= 0.5 }
  }
  const levels = (q.levels ?? []).map((l) => l.trim()).filter(Boolean)
  const score = finite(raw.score)
  if (score === undefined || score < 0 || score > levels.length - 1) {
    throw new Error(`"${q.name}" came back without a score between 0 and ${levels.length - 1}`)
  }
  const confidence = unit(raw.confidence)
  if (confidence === undefined) throw new Error(`"${q.name}" came back without a confidence between 0 and 1`)
  return {
    type: 'score',
    score: Math.round(score * 1e4) / 1e4,
    confidence,
    probabilities: probabilitiesOf(raw.probabilities),
    level: levels[Math.round(score)] ?? '',
  }
}

/** One line per answer, for the transcript and for the message the node passes on. */
export function summarizeDecision(answers: DecisionAnswers): string {
  return Object.entries(answers)
    .map(([name, a]) => {
      if (a.type === 'choice') return `${name} → ${a.choice} (confidence ${pct(a.confidence)})`
      if (a.type === 'noul') return `${name} → ${a.yes ? 'yes' : 'no'} (p(yes) ${pct(a.noul)})`
      return `${name} → ${a.score.toFixed(2)}${a.level ? ` "${a.level}"` : ''} (confidence ${pct(a.confidence)})`
    })
    .join('\n')
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}

export interface DecisionCall {
  node: Pick<DecisionNode, 'provider' | 'model' | 'questions'>
  state: string
  apiKey: string
  endpoint: string
  signal: AbortSignal
}

export interface DecisionResult {
  answers: DecisionAnswers
  tokensIn: number
  tokensOut: number
  cost?: number
}

/**
 * A sentence out of an error body. Two shapes seen: `{error: {message}}`, and a bare list of
 * validation issues `[{path: [...], message}]`, which is what a malformed question gets back.
 */
export function errorDetail(json: unknown): string | undefined {
  const message = (json as { error?: { message?: unknown } } | undefined)?.error?.message
  if (typeof message === 'string') return message
  if (Array.isArray(json)) {
    const issues = json
      .filter((i): i is { path?: unknown; message?: unknown } => Boolean(i) && typeof i === 'object')
      .map((i) => `${Array.isArray(i.path) ? i.path.join('.') : '?'}: ${typeof i.message === 'string' ? i.message : 'invalid'}`)
    if (issues.length > 0) return issues.slice(0, 3).join('; ')
  }
  return undefined
}

export async function callDecision(call: DecisionCall): Promise<DecisionResult> {
  const problems = questionProblems(call.node.questions)
  if (problems.length > 0) throw new Error(problems[0])
  if (call.node.provider === 'mock') return demoDecision(call)
  if (!call.node.model.trim()) throw new Error('no decision model set')
  if (!call.endpoint) throw new Error('no endpoint URL set for this decision provider — open Settings')
  const info = decisionProviderInfo(call.node.provider)
  if (!call.apiKey && !info.keyOptional) throw new Error(`no ${info.label} key — open Settings`)

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (call.apiKey) headers.authorization = `Bearer ${call.apiKey}`
  if (call.node.provider === 'openrouter') {
    // Both are in OpenRouter's CORS allow-list; they attribute the traffic to the app.
    headers['HTTP-Referer'] = typeof location !== 'undefined' ? location.origin : 'https://github.com/Iskandeur/swarm-studio'
    headers['X-Title'] = 'Swarm Studio'
  }
  const res = await fetchLocalAware(
    call.endpoint,
    { method: 'POST', signal: call.signal, headers, body: JSON.stringify(buildDecisionBody(call.node, call.state)) },
    call.node.provider === 'laya' ? 'tools/laya-serve-cors.py' : undefined,
  )
  const text = await res.text().catch(() => '')
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${errorDetail(json) ?? (text.slice(0, 300) || res.statusText)}`)
  if (json === undefined) throw new Error(`the decision endpoint did not answer JSON: ${text.slice(0, 200)}`)
  const answers = parseDecisionResponse(json, call.node.questions)
  const usage = (json as { usage?: Record<string, unknown> }).usage ?? {}
  return {
    answers,
    tokensIn: finite(usage.input_tokens) ?? finite(usage.prompt_tokens) ?? 0,
    tokensOut: finite(usage.output_tokens) ?? finite(usage.completion_tokens) ?? 0,
    ...(finite(usage.cost) !== undefined ? { cost: finite(usage.cost) } : {}),
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* The demo decider                                                                                  */
/* ------------------------------------------------------------------------------------------------ */

const STOP = new Set(['this', 'that', 'with', 'from', 'about', 'anything', 'else', 'what', 'which', 'your', 'have', 'does', 'into', 'than', 'they', 'their'])

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w))
}

/** How many of the description's words the message contains, with a crude stem so "refunds" meets "refund". */
function overlap(description: string, state: string): number {
  const haystack = new Set(words(state).map(stem))
  return [...new Set(words(description).map(stem))].filter((w) => haystack.has(w)).length
}

function stem(word: string): string {
  return word.replace(/(ing|ed|es|s|e)$/, '')
}

function normalise(weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0)
  return weights.map((w) => w / total)
}

/** 1 − normalised entropy: 1 when all the mass is on one option, 0 when it is spread evenly. */
function concentration(probabilities: number[]): number {
  if (probabilities.length < 2) return 1
  const entropy = -probabilities.reduce((sum, p) => (p > 0 ? sum + p * Math.log(p) : sum), 0)
  return Math.round((1 - entropy / Math.log(probabilities.length)) * 1000) / 1000
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4
}

/**
 * Deterministic answers with no key: each option is weighted by the words it shares with the state.
 * Good enough to route "I was charged twice" to billing and to be unsure about "hello?", which is all a
 * demo of confidence-gated routing needs. The model id says demo, and so does the transcript.
 */
export async function demoDecision(call: Pick<DecisionCall, 'node' | 'state' | 'signal'>): Promise<DecisionResult> {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 420)
    call.signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }, { once: true })
  })
  if (call.signal.aborted) throw new DOMException('aborted', 'AbortError')
  const answers: DecisionAnswers = {}
  for (const q of call.node.questions) {
    if (q.type === 'choice') {
      const options = (q.options ?? []).filter((o) => o.label.trim())
      const weights = normalise(options.map((o) => 0.35 + 2 * overlap(`${o.label} ${o.criterion}`, call.state)))
      const best = weights.indexOf(Math.max(...weights))
      answers[q.name] = {
        type: 'choice',
        choice: options[best].label.trim(),
        confidence: concentration(weights),
        probabilities: Object.fromEntries(options.map((o, i) => [o.label.trim(), round4(weights[i])])),
      }
    } else if (q.type === 'noul') {
      const yes = overlap(`${q.instructions} ${q.options?.find((o) => o.label === 'true')?.criterion ?? ''}`, call.state)
      const no = overlap(q.options?.find((o) => o.label === 'false')?.criterion ?? '', call.state)
      const noul = round4((yes + 0.5) / (yes + no + 1.5))
      answers[q.name] = { type: 'noul', noul, yes: noul >= 0.5 }
    } else {
      const levels = (q.levels ?? []).map((l) => l.trim()).filter(Boolean)
      const weights = normalise(levels.map((l) => 0.35 + 2 * overlap(l, call.state)))
      const score = round4(weights.reduce((sum, p, i) => sum + p * i, 0))
      answers[q.name] = {
        type: 'score',
        score,
        confidence: concentration(weights),
        probabilities: Object.fromEntries(levels.map((_, i) => [String(i), round4(weights[i])])),
        level: levels[Math.round(score)] ?? '',
      }
    }
  }
  const tokensIn = Math.max(1, Math.round(call.state.length / 4))
  return { answers, tokensIn, tokensOut: 8 * call.node.questions.length }
}
