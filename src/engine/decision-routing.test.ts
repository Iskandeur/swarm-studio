/**
 * Decision nodes inside a run: System 1 routes, System 2 catches what System 1 was unsure about.
 * Demo agents and the demo decider, real time (like the other engine tests), no network — except the
 * two tests that stub fetch to play an OpenRouter answer.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { runSwarm, type ApiKeys, type BranchEvent, type RunnerCallbacks } from './runner.ts'
import { createRunSession, type RunSession } from './session.ts'
import { PRESETS } from '../presets.ts'
import type { Agent, DecisionAnswers, DecisionNode, DecisionQuestion, SwarmSpec, TranscriptEntry } from '../types.ts'

const TRIAGE = PRESETS.find((p) => p.name === 'Triage (System 1 → System 2)')!

function agent(id: string, name: string): Agent {
  return {
    id,
    name,
    provider: 'mock',
    model: 'demo-fast',
    systemPrompt: `You are ${name}.`,
    temperature: 0.5,
    hue: 200,
    position: { x: 0, y: 0 },
  }
}

const ROUTE: DecisionQuestion = {
  name: 'route',
  type: 'choice',
  instructions: 'Which desk?',
  options: [
    { label: 'billing', criterion: 'payments, invoices, charges, refunds' },
    { label: 'technical', criterion: 'bugs, crashes, errors' },
  ],
}

function decisionNode(overrides: Partial<DecisionNode> = {}): DecisionNode {
  return {
    id: 'dec',
    kind: 'decision',
    name: 'Router',
    provider: 'mock',
    model: 'demo-decider',
    position: { x: 0, y: 0 },
    questions: [ROUTE],
    ...overrides,
  }
}

interface Collected {
  transcript: TranscriptEntry[]
  decisions: Array<{ nodeId: string; answers: DecisionAnswers }>
  branches: BranchEvent[]
  notices: string[]
  phase: string
  error?: string
  session: RunSession
}

async function collect(spec: SwarmSpec, keys: ApiKeys = {}): Promise<Collected> {
  const session = createRunSession()
  const entries = new Map<string, TranscriptEntry>()
  const out: Collected = { transcript: [], decisions: [], branches: [], notices: [], phase: '', session }
  const cb: RunnerCallbacks = {
    onPhase: (p, detail) => {
      out.phase = p
      if (detail) out.error = detail
    },
    onRound: () => {},
    onAgentStatus: () => {},
    onMessageStart: (entry) => entries.set(entry.id, { ...entry }),
    onMessageDelta: (id, delta) => {
      const entry = entries.get(id)!
      entry.text += delta
    },
    onMessageEnd: (id, patch) => entries.set(id, { ...entries.get(id)!, ...patch }),
    onTransit: () => {},
    onNotice: (n) => out.notices.push(n),
    onBranch: (e) => out.branches.push(e),
    onDecision: (e) => out.decisions.push({ nodeId: e.nodeId, answers: e.answers }),
  }
  await runSwarm(spec, keys, cb, new AbortController().signal, { session })
  out.transcript = [...entries.values()]
  return out
}

const speakers = (c: Collected) => c.transcript.map((e) => e.agentId)
const heard = (c: Collected, id: string) =>
  (c.session.memory.get(id) ?? []).filter((m) => m.role === 'user').map((m) => m.content).join('\n')

describe('Decision nodes in a run', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('the Triage preset escalates to the Senior agent, and no desk speaks', { timeout: 30_000 }, async () => {
    const c = await collect(structuredClone(TRIAGE))
    expect(c.phase).toBe('done')
    expect(c.error).toBeUndefined()
    const who = speakers(c)
    expect(who[0]).toBe('triage')
    expect(who).toContain('senior')
    for (const desk of ['billing', 'tech', 'account']) expect(who).not.toContain(desk)

    expect(c.decisions).toHaveLength(1)
    expect(c.decisions[0].nodeId).toBe('triage')
    expect(c.decisions[0].answers.route).toMatchObject({ type: 'choice' })
    expect(c.decisions[0].answers.blocked).toMatchObject({ type: 'noul' })

    const entry = c.transcript.find((e) => e.agentId === 'triage')!
    expect(entry.status).toBe('complete')
    expect(entry.decision).toEqual(c.decisions[0].answers)
    expect(entry.text).toMatch(/^route → /)

    // The Senior reads the customer's own words, plus the verdict line.
    const senior = heard(c, 'senior')
    expect(senior).toContain(TRIAGE.task)
    expect(senior).toContain('[Triage] route →')

    const branch = c.branches.find((b) => b.nodeId === 'triage')!
    expect(branch.taken).toEqual(['d4'])
    expect(branch.skipped.sort()).toEqual(['d1', 'd2', 'd3'])
  })

  test('a confident decision reaches the specialist, not the Senior', { timeout: 30_000 }, async () => {
    const spec = { ...structuredClone(TRIAGE), task: 'I was charged twice, please refund my invoice payment' }
    const c = await collect(spec)
    expect(c.phase).toBe('done')
    const answers = c.decisions[0].answers
    expect(answers.route).toMatchObject({ choice: 'billing' })
    if (answers.route.type === 'choice') expect(answers.route.confidence).toBeGreaterThanOrEqual(0.6)
    const who = speakers(c)
    expect(who).toContain('billing')
    expect(who).not.toContain('senior')
    expect(who).not.toContain('tech')
    expect(heard(c, 'billing')).toContain('I was charged twice, please refund my invoice payment')
  })

  test('a decision guard on a Condition node downstream still sees the answers', { timeout: 30_000 }, async () => {
    const build = (task: string): SwarmSpec => ({
      name: 't',
      task,
      topology: 'broadcast',
      maxRounds: 4,
      entryIds: ['dec'],
      agents: [agent('yes', 'BILLING SIDE'), agent('no', 'OTHER SIDE')],
      nodes: [
        decisionNode(),
        {
          id: 'cond',
          kind: 'condition',
          name: 'Billing?',
          position: { x: 0, y: 0 },
          predicate: { op: 'decision', path: 'route.choice', cmp: 'eq', value: 'billing' },
        },
      ],
      links: [
        { id: 'dc', source: 'dec', target: 'cond' },
        { id: 'cy', source: 'cond', target: 'yes', label: 'true' },
        { id: 'cn', source: 'cond', target: 'no', label: 'false' },
      ],
    })
    const billing = await collect(build('Please refund the double charge on my invoice'))
    expect(billing.phase).toBe('done')
    expect(billing.decisions[0].answers.route).toMatchObject({ choice: 'billing' })
    expect(speakers(billing)).toContain('yes')
    expect(speakers(billing)).not.toContain('no')

    const tech = await collect(build('The app crashes with errors and bugs everywhere'))
    expect(tech.phase).toBe('done')
    expect(tech.decisions[0].answers.route).toMatchObject({ choice: 'technical' })
    expect(speakers(tech)).toContain('no')
    expect(speakers(tech)).not.toContain('yes')
    // No "no Decision node answered upstream" problem: the answers crossed the zero-token hop.
    expect(tech.notices.join('\n')).not.toMatch(/no Decision node answered/)
  })

  test('a decision node with no questions fails the run, naming the node', { timeout: 30_000 }, async () => {
    const c = await collect({
      name: 't',
      task: 'Anything',
      topology: 'broadcast',
      maxRounds: 3,
      entryIds: ['dec'],
      agents: [agent('a', 'A'), agent('b', 'B')],
      nodes: [decisionNode({ questions: [] })],
      links: [
        { id: 'da', source: 'dec', target: 'a', isDefault: true },
        { id: 'db', source: 'dec', target: 'b' },
      ],
    })
    expect(c.phase).toBe('error')
    expect(c.error).toContain('Router')
    expect(c.error).toContain('Add at least one question.')
    expect(speakers(c)).not.toContain('a')
    expect(speakers(c)).not.toContain('b')
    expect(c.decisions).toHaveLength(0)
    expect(c.transcript.find((e) => e.agentId === 'dec')!.status).toBe('error')
  })

  test('an OpenRouter decision node with no key fails the run and says so', { timeout: 30_000 }, async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const c = await collect({
      name: 't',
      task: 'Anything',
      topology: 'broadcast',
      maxRounds: 3,
      entryIds: ['dec'],
      agents: [agent('a', 'A')],
      nodes: [decisionNode({ provider: 'openrouter', model: 'typesafe/jev-1.13' })],
      links: [{ id: 'da', source: 'dec', target: 'a', isDefault: true }],
    })
    expect(c.phase).toBe('error')
    expect(c.error).toMatch(/key/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(speakers(c)).not.toContain('a')
  })

  test('an answer with no usable choice fails the run instead of routing', { timeout: 30_000 }, async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({ answers: { route: { type: 'choice', choice: 'refunds', confidence: 0.9, probabilities: {} } }, usage: {} }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const c = await collect(
      {
        name: 't',
        task: 'Anything',
        topology: 'broadcast',
        maxRounds: 3,
        entryIds: ['dec'],
        agents: [agent('a', 'A')],
        nodes: [decisionNode({ provider: 'openrouter', model: 'typesafe/jev-1.13' })],
        links: [{ id: 'da', source: 'dec', target: 'a', isDefault: true }],
      },
      { openrouter: 'test' },
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(c.phase).toBe('error')
    expect(c.error).toContain('no usable choice')
    expect(speakers(c)).not.toContain('a')
  })
})
