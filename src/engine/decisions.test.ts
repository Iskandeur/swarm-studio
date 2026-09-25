/**
 * Decision models: the request we send, the strict reader of what comes back, the network call, and
 * the deterministic demo decider. The parser must never invent an answer: a silent 0.5 would route a
 * message as if the model had been unsure, when it said nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DecisionNode, DecisionQuestion } from '../types.ts'
import { PRESETS } from '../presets.ts'
import {
  DECISION_PROVIDERS,
  buildDecisionBody,
  callDecision,
  decisionKey,
  demoDecision,
  errorDetail,
  parseDecisionResponse,
  questionProblems,
  resolveDecisionEndpoint,
  summarizeDecision,
} from './decisions.ts'

const QUESTIONS: DecisionQuestion[] = [
  {
    name: 'route',
    type: 'choice',
    instructions: 'Which desk?',
    options: [
      { label: 'billing', criterion: 'payments' },
      { label: 'technical', criterion: 'bugs' },
      { label: 'other', criterion: '' },
    ],
  },
  { name: 'urgent', type: 'noul', instructions: 'Urgent?' },
  { name: 'anger', type: 'score', instructions: 'How angry?', levels: ['calm', 'annoyed', 'furious'] },
]

/** Captured from OpenRouter /api/alpha/decisions, model typesafe/jev-1.13. */
const REAL = {
  model: 'typesafe/jev-1.13-20260917',
  answers: {
    route: { type: 'choice', choice: 'billing', probabilities: { technical: 0, other: 0, billing: 1 }, confidence: 1 },
    urgent: { type: 'noul', noul: 0.42 },
    anger: {
      type: 'score',
      score: 0.12,
      legend: { '0': 'calm', '1': 'annoyed', '2': 'furious' },
      probabilities: { '0': 0.88, '1': 0.12, '2': 0 },
      confidence: 0.82,
    },
  },
  usage: { input_tokens: 404, output_tokens: 68, cost: 0.000016968 },
  id: 'gen-dec-x',
  provider: 'TypeSafe',
}

/**
 * Captured from laya-serve 0.3.20 (tools/laya-serve-cors.py, CPU), sent the Triage preset's two
 * questions and its task. Laya adds `answer_confidence`, `action` and `routing`, which the reader
 * ignores: guards read `confidence`, the same field as Jev's.
 */
const REAL_LAYA = {
  model: 'laya-rl-agent',
  answers: {
    route: {
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.9403, technical: 0.0518, account: 0.0079 },
      confidence: 0.773,
      answer_confidence: 0.9403,
      action: { act_probability: 1 },
    },
    blocked: { type: 'noul', noul: 0.623, confidence: 0.623, answer_confidence: 0.623, action: { act_probability: 1 } },
  },
  usage: { input_tokens: 139, output_tokens: 0 },
  routing: { model: 'english', repo: 'convaiinnovations/laya', reason: 'English Latin text' },
}

const clone = <T>(v: T): T => structuredClone(v)
const signal = () => new AbortController().signal

describe('buildDecisionBody', () => {
  it('sends choice criteria as an object, an empty criterion as null', () => {
    const body = buildDecisionBody({ model: '  typesafe/jev-1.13 ', questions: QUESTIONS }, 'state')
    expect(body.model).toBe('typesafe/jev-1.13')
    expect(body.state).toBe('state')
    expect(body.questions.route).toEqual({
      type: 'choice',
      instructions: 'Which desk?',
      criteria: { billing: 'payments', technical: 'bugs', other: null },
    })
  })

  it('sends noul criteria only when true/false are described', () => {
    const bare = buildDecisionBody({ model: 'm', questions: [{ name: 'q', type: 'noul', instructions: 'x' }] }, 's')
    expect(bare.questions.q).toEqual({ type: 'noul', instructions: 'x' })
    expect('criteria' in bare.questions.q).toBe(false)

    const described = buildDecisionBody(
      {
        model: 'm',
        questions: [
          {
            name: 'q',
            type: 'noul',
            instructions: 'x',
            options: [
              { label: 'true', criterion: ' it is ' },
              { label: 'false', criterion: 'it is not' },
              { label: 'maybe', criterion: 'ignored' },
            ],
          },
        ],
      },
      's',
    )
    expect(described.questions.q.criteria).toEqual({ true: 'it is', false: 'it is not' })

    const emptyDescriptions = buildDecisionBody(
      { model: 'm', questions: [{ name: 'q', type: 'noul', instructions: 'x', options: [{ label: 'true', criterion: '  ' }] }] },
      's',
    )
    expect('criteria' in emptyDescriptions.questions.q).toBe(false)

    // One side described: both are sent. OpenRouter's validator answered 400 on `criteria.false`
    // when only `true` was there (live call, 21/09), although TypeSafe's SDK types both as optional.
    const oneSide = buildDecisionBody(
      { model: 'm', questions: [{ name: 'q', type: 'noul', instructions: 'x', options: [{ label: 'true', criterion: 'blocked' }] }] },
      's',
    )
    expect(oneSide.questions.q.criteria).toEqual({ true: 'blocked', false: 'no' })
  })

  it('turns a list of validation issues into one readable line', () => {
    const issues = [{ code: 'invalid_union', path: ['questions', 'blocked', 'criteria', 'false'], message: 'Invalid input' }]
    expect(errorDetail(issues)).toBe('questions.blocked.criteria.false: Invalid input')
    expect(errorDetail({ error: { message: 'No auth credentials found' } })).toBe('No auth credentials found')
    expect(errorDetail('nope')).toBeUndefined()
  })

  it('sends score criteria as the array of levels', () => {
    const body = buildDecisionBody(
      { model: 'm', questions: [{ name: 'lvl', type: 'score', instructions: '', levels: [' low ', '', 'high'] }] },
      's',
    )
    expect(body.questions.lvl).toEqual({ type: 'score', criteria: ['low', 'high'] })
  })

  it('omits empty instructions', () => {
    const body = buildDecisionBody(
      { model: 'm', questions: [{ name: 'q', type: 'noul', instructions: '   ' }] },
      's',
    )
    expect('instructions' in body.questions.q).toBe(false)
  })
})

describe('parseDecisionResponse', () => {
  it('reads the real OpenRouter response into typed answers', () => {
    const answers = parseDecisionResponse(REAL, QUESTIONS)
    expect(answers.route).toEqual({
      type: 'choice',
      choice: 'billing',
      confidence: 1,
      probabilities: { technical: 0, other: 0, billing: 1 },
    })
    expect(answers.urgent).toEqual({ type: 'noul', noul: 0.42, yes: false })
    expect(answers.anger).toEqual({
      type: 'score',
      score: 0.12,
      confidence: 0.82,
      probabilities: { '0': 0.88, '1': 0.12, '2': 0 },
      level: 'calm',
    })
    expect(Object.keys(answers).sort()).toEqual(['anger', 'route', 'urgent'])
  })

  const broken: Array<[string, (j: typeof REAL & Record<string, unknown>) => unknown, RegExp]> = [
    ['choice absent', (j) => { delete (j.answers.route as Record<string, unknown>).choice; return j }, /"route".*no usable choice/],
    ['choice not among labels', (j) => { (j.answers.route as Record<string, unknown>).choice = 'refunds'; return j }, /"route".*no usable choice.*"refunds"/],
    ['confidence missing', (j) => { delete (j.answers.route as Record<string, unknown>).confidence; return j }, /"route".*confidence/],
    ['confidence above 1', (j) => { j.answers.route.confidence = 1.5; return j }, /"route".*confidence/],
    ['confidence below 0', (j) => { j.answers.route.confidence = -0.1; return j }, /"route".*confidence/],
    ['noul missing', (j) => { delete (j.answers.urgent as Record<string, unknown>).noul; return j }, /"urgent"/],
    ['noul out of range', (j) => { j.answers.urgent.noul = 2; return j }, /"urgent"/],
    ['score above the top level', (j) => { j.answers.anger.score = 2.5; return j }, /"anger".*score between 0 and 2/],
    ['score negative', (j) => { j.answers.anger.score = -1; return j }, /"anger"/],
    ['score confidence missing', (j) => { delete (j.answers.anger as Record<string, unknown>).confidence; return j }, /"anger".*confidence/],
    ['a missing answer', (j) => { delete (j.answers as Record<string, unknown>).urgent; return j }, /did not answer "urgent"/],
    ['no answers at all', (j) => { delete (j as Record<string, unknown>).answers; return j }, /returned no answers/],
    ['answers is an array', (j) => ({ ...j, answers: [] }), /returned no answers/],
  ]

  for (const [what, mutate, message] of broken) {
    it(`throws, naming the question, on ${what}`, () => {
      const json = mutate(clone(REAL) as typeof REAL & Record<string, unknown>)
      expect(() => parseDecisionResponse(json, QUESTIONS)).toThrow(message)
    })
  }

  it('surfaces an {error:{message}} body', () => {
    expect(() => parseDecisionResponse({ error: { message: 'model overloaded' } }, QUESTIONS)).toThrow('model overloaded')
  })

  it('throws on null and on a non-object', () => {
    expect(() => parseDecisionResponse(null, QUESTIONS)).toThrow(/no answers/)
    expect(() => parseDecisionResponse('nope', QUESTIONS)).toThrow(/no answers/)
  })

  it('never falls back to a default like 0.5', () => {
    for (const [, mutate] of broken) {
      let result: unknown
      try {
        result = parseDecisionResponse(mutate(clone(REAL) as typeof REAL & Record<string, unknown>), QUESTIONS)
      } catch {
        result = undefined
      }
      expect(result).toBeUndefined()
    }
    // A choice with no confidence would be the classic place for a silent 0.5.
    const json = clone(REAL) as Record<string, unknown>
    ;(json.answers as Record<string, Record<string, unknown>>).route.confidence = null
    expect(() => parseDecisionResponse(json, QUESTIONS)).toThrow()
    ;(json.answers as Record<string, Record<string, unknown>>).route.confidence = ''
    expect(() => parseDecisionResponse(json, QUESTIONS)).toThrow()
  })

  it('returns only answers to questions that were asked', () => {
    const answers = parseDecisionResponse(REAL, [QUESTIONS[1]])
    expect(Object.keys(answers)).toEqual(['urgent'])
  })

  it('summarises answers one line each', () => {
    const text = summarizeDecision(parseDecisionResponse(REAL, QUESTIONS))
    expect(text.split('\n')).toEqual([
      'route → billing (confidence 100%)',
      'urgent → no (p(yes) 42%)',
      'anger → 0.12 "calm" (confidence 82%)',
    ])
  })
})

describe('questionProblems', () => {
  const choice = (options: string[]): DecisionQuestion => ({
    name: 'route',
    type: 'choice',
    instructions: '',
    options: options.map((label) => ({ label, criterion: '' })),
  })

  it('accepts a valid set', () => {
    expect(questionProblems(QUESTIONS)).toEqual([])
  })

  it('refuses no questions', () => {
    expect(questionProblems([])).toEqual(['Add at least one question.'])
  })

  it('refuses a name with a space or a dot', () => {
    for (const name of ['my route', 'route.choice', '', '9lives']) {
      const problems = questionProblems([{ ...choice(['a', 'b']), name }])
      expect(problems.some((p) => p.includes('single word')), name).toBe(true)
    }
  })

  it('refuses duplicate names', () => {
    const problems = questionProblems([choice(['a', 'b']), choice(['c', 'd'])])
    expect(problems).toEqual(['"route": two questions share this name.'])
  })

  it('refuses a choice with fewer than two options', () => {
    expect(questionProblems([choice(['a'])])).toEqual(['"route": a choice needs at least two options.'])
    expect(questionProblems([choice(['a', '  '])])).toEqual(['"route": a choice needs at least two options.'])
  })

  it('refuses duplicate labels', () => {
    expect(questionProblems([choice(['a', 'a '])])).toEqual(['"route": two options share a label.'])
  })

  it('refuses a score with fewer than two levels', () => {
    const problems = questionProblems([{ name: 's', type: 'score', instructions: '', levels: ['only', ' '] }])
    expect(problems).toEqual(['"s": a score needs at least two levels, lowest first.'])
  })
})

describe('callDecision', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const node = (provider: DecisionNode['provider']) => ({ provider, model: 'typesafe/jev-1.13', questions: QUESTIONS })
  const reply = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : 'OK',
    text: async () => JSON.stringify(body),
  })

  it('posts the body to the endpoint with the key and OpenRouter headers, and maps usage', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => reply(200, REAL))
    vi.stubGlobal('fetch', fetchMock)
    const result = await callDecision({
      node: node('openrouter'),
      state: 'I was charged twice',
      apiKey: 'sk-or-test',
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
      signal: signal(),
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-or-test')
    expect(headers['content-type']).toBe('application/json')
    expect(headers['X-Title']).toBe('Swarm Studio')
    expect(headers['HTTP-Referer']).toBeTruthy()
    expect(JSON.parse(init.body as string)).toEqual(buildDecisionBody(node('openrouter'), 'I was charged twice'))
    expect(result.tokensIn).toBe(404)
    expect(result.tokensOut).toBe(68)
    expect(result.cost).toBe(0.000016968)
    expect(result.answers.route).toMatchObject({ choice: 'billing', confidence: 1 })
  })

  it('a Laya call that never reached the server says how to start it, from the published page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    vi.stubGlobal('location', new URL('https://iskandeur.github.io/swarm-studio/'))
    vi.stubGlobal('navigator', { permissions: { query: vi.fn(async () => ({ state: 'prompt' })) } })
    await expect(
      callDecision({ node: { ...node('laya'), model: 'auto' }, state: 's', apiKey: '', endpoint: 'http://127.0.0.1:8000/v1/systemone', signal: signal() }),
    ).rejects.toThrow(/Failed to fetch: the call to http:\/\/127\.0\.0\.1:8000 failed before any answer\. Is tools\/laya-serve-cors\.py running\?/)
  })

  it('sends no OpenRouter headers to TypeSafe', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => reply(200, REAL))
    vi.stubGlobal('fetch', fetchMock)
    await callDecision({ node: node('typesafe'), state: 's', apiKey: 'ts-key', endpoint: 'https://relay.example/v1', signal: signal() })
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer ts-key')
    expect('HTTP-Referer' in headers).toBe(false)
    expect('X-Title' in headers).toBe(false)
  })

  it('calls a local Laya server with no key and no Authorization header, and reads its answers', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => reply(200, REAL_LAYA))
    vi.stubGlobal('fetch', fetchMock)
    const triage = PRESETS.find((p) => p.name === 'Triage (System 1 → System 2)')!
    const questions = triage.nodes!.find((n): n is DecisionNode => n.kind === 'decision')!.questions
    const result = await callDecision({
      node: { provider: 'laya', model: 'auto', questions },
      state: triage.task,
      apiKey: '',
      endpoint: resolveDecisionEndpoint('laya'),
      signal: signal(),
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8000/v1/systemone')
    const headers = init.headers as Record<string, string>
    expect('authorization' in headers).toBe(false)
    expect('X-Title' in headers).toBe(false)
    expect(result.answers.route).toEqual({
      type: 'choice',
      choice: 'billing',
      confidence: 0.773,
      probabilities: { billing: 0.9403, technical: 0.0518, account: 0.0079 },
    })
    expect(result.answers.blocked).toEqual({ type: 'noul', noul: 0.623, yes: true })
    expect(result.tokensIn).toBe(139)
    expect(result.cost).toBeUndefined()
  })

  it('sends a Laya key only when one is set', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => reply(200, REAL))
    vi.stubGlobal('fetch', fetchMock)
    await callDecision({ node: node('laya'), state: 's', apiKey: 'lk', endpoint: 'http://127.0.0.1:8000/v1/systemone', signal: signal() })
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>).authorization).toBe('Bearer lk')
  })

  it('reports HTTP 401 with the API message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(401, { error: { message: 'No auth credentials found' } })))
    await expect(
      callDecision({ node: node('openrouter'), state: 's', apiKey: 'bad', endpoint: 'https://x.test', signal: signal() }),
    ).rejects.toThrow(/HTTP 401.*No auth credentials found/)
  })

  it('fails before fetching when the key is missing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      callDecision({ node: node('openrouter'), state: 's', apiKey: '', endpoint: 'https://x.test', signal: signal() }),
    ).rejects.toThrow(/key/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails before fetching when the questions are invalid', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      callDecision({ node: { ...node('openrouter'), questions: [] }, state: 's', apiKey: 'k', endpoint: 'https://x.test', signal: signal() }),
    ).rejects.toThrow('Add at least one question.')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('restores fetch afterwards', () => {
    expect(vi.isMockFunction(globalThis.fetch)).toBe(false)
  })
})

describe('demoDecision', () => {
  const triage = PRESETS.find((p) => p.name === 'Triage (System 1 → System 2)')!
  const triageNode = triage.nodes!.find((n): n is DecisionNode => n.kind === 'decision')!

  it('is deterministic', async () => {
    const a = await demoDecision({ node: triageNode, state: triage.task, signal: signal() })
    const b = await demoDecision({ node: triageNode, state: triage.task, signal: signal() })
    expect(a).toEqual(b)
  })

  it('hesitates on the Triage preset task, so the preset escalates', async () => {
    const { answers } = await demoDecision({ node: triageNode, state: triage.task, signal: signal() })
    expect(answers.route.type).toBe('choice')
    if (answers.route.type !== 'choice') throw new Error('unreachable')
    expect(answers.route.confidence).toBeLessThan(0.6)
    expect(answers.blocked).toMatchObject({ type: 'noul' })
  })

  it('routes a billing message to billing', async () => {
    const { answers } = await demoDecision({ node: triageNode, state: 'I was charged twice, please refund the invoice', signal: signal() })
    expect(answers.route).toMatchObject({ type: 'choice', choice: 'billing' })
  })

  it('answers a score question with a level', async () => {
    const { answers } = await demoDecision({
      node: { provider: 'mock', model: 'demo-decider', questions: [QUESTIONS[2]] },
      state: 'I am furious',
      signal: signal(),
    })
    expect(answers.anger).toMatchObject({ type: 'score' })
  })

  it('rejects when aborted', async () => {
    const controller = new AbortController()
    const pending = demoDecision({ node: triageNode, state: triage.task, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow(/abort/i)
  })

  it('callDecision uses it for the mock provider, with no key and no fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const result = await callDecision({ node: triageNode, state: triage.task, apiKey: '', endpoint: '', signal: signal() })
      expect(result.answers.route).toBeDefined()
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('keys and endpoints', () => {
  const keys = { openrouter: ' or-key ', typesafe: 'ts-key', openai: 'oa' }

  it('decisionKey reuses the OpenRouter slot, TypeSafe its own, mock none', () => {
    expect(decisionKey('openrouter', keys)).toBe('or-key')
    expect(decisionKey('typesafe', keys)).toBe('ts-key')
    expect(decisionKey('mock', keys)).toBe('')
    expect(decisionKey('typesafe', {})).toBe('')
    expect(decisionKey('laya', { laya: ' lk ' })).toBe('lk')
    expect(decisionKey('laya', keys)).toBe('')
  })

  it('only Laya works without a key', () => {
    expect(DECISION_PROVIDERS.filter((p) => p.keyOptional).map((p) => p.id)).toEqual(['laya'])
  })

  it('resolveDecisionEndpoint prefers an override, else the default', () => {
    expect(resolveDecisionEndpoint('openrouter')).toBe('https://openrouter.ai/api/alpha/decisions')
    expect(resolveDecisionEndpoint('typesafe', { typesafe: ' https://relay.example ' })).toBe('https://relay.example')
    expect(resolveDecisionEndpoint('typesafe', { typesafe: '  ' })).toBe('https://api.typesafe.ai/v1/systemone')
    expect(resolveDecisionEndpoint('mock')).toBe('')
    expect(resolveDecisionEndpoint('laya')).toBe('http://127.0.0.1:8000/v1/systemone')
  })
})
