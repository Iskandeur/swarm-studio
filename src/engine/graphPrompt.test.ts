/**
 * "Prompt the graph": the gate between a model's text and the canvas, the repair loop, the demo
 * generator — plus the Decision-node pieces of the portable format and of the predicate language the
 * generator is told about.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ChatRequest, ChatResult } from './providers.ts'
import { PROVIDERS } from './providers.ts'
import { PRESETS } from '../presets.ts'
import type { DecisionNode, Predicate, ProviderId, SwarmSpec } from '../types.ts'
import { exportAgents, exportSwarm, parsePortable, portableToSpec, type PortableSwarm } from './portable.ts'
import { describePredicate, evaluate, readPredicate, type PredicateContext } from './predicates.ts'
import {
  buildGeneratorMessage,
  buildGeneratorSystem,
  defaultsFor,
  extractGraphJson,
  GENERATOR_NODE_KINDS,
  GENERATOR_PREDICATE_OPS,
  promptGraph,
  restoreIdentity,
  validateGenerated,
} from './graphPrompt.ts'
import { DECISION_PROVIDER_IDS, DECISION_TYPES } from './decisions.ts'

const preset = (name: string) => structuredClone(PRESETS.find((p) => p.name === name)!)
const CAT = () => preset('The Cat Council')
const FRIDGE = () => preset('The Fridge Tribunal')
const TRIAGE = () => preset('Triage (System 1 → System 2)')

/** A preset as the model would send it, as an object to tamper with. */
const doc = (spec: SwarmSpec) => JSON.parse(exportSwarm(spec)) as Record<string, any>

const signal = () => new AbortController().signal

describe('extractGraphJson', () => {
  it('reads a fenced ```json block with prose around it', () => {
    const r = extractGraphJson('Here is your swarm:\n```json\n{"kind":"swarm","name":"x"}\n```\nEnjoy.')
    expect(r).toEqual({ ok: true, value: { kind: 'swarm', name: 'x' } })
  })

  it('reads bare JSON with text before and after', () => {
    const r = extractGraphJson('Sure! {"kind":"swarm","agents":[]} Let me know.')
    expect(r).toEqual({ ok: true, value: { kind: 'swarm', agents: [] } })
  })

  it('refuses an array', () => {
    const r = extractGraphJson('[{"id":"a"}]')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/array/)
  })

  it('names a cut-off answer as cut off', () => {
    const r = extractGraphJson('{"format":"swarm-studio","kind":"swarm","name":"Half a swa')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/cut off/)
  })

  // A real answer truncated at the token limit already holds complete agents; the inner one must not
  // be mistaken for the graph (it was, before extractGraphJson stopped borrowing the guards' scanner).
  it('names a cut-off answer as cut off even when an inner object is complete', () => {
    const r = extractGraphJson('{"format":"swarm-studio","kind":"swarm","agents":[{"id":"a","name":"A"},{"id":"b","na')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/cut off/)
  })

  it('refuses invalid JSON', () => {
    const r = extractGraphJson('{"kind": "swarm",, "name": "x"}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/does not parse/)
  })

  it('refuses an answer with no JSON', () => {
    const r = extractGraphJson('I would design three agents and a judge.')
    expect(r).toEqual({ ok: false, error: 'The answer contains no JSON object.' })
  })
})

describe('validateGenerated', () => {
  it('accepts a valid exported swarm', () => {
    for (const name of ['The Cat Council', 'The Fridge Tribunal', 'Triage (System 1 → System 2)']) {
      const v = validateGenerated(exportSwarm(preset(name)), { mode: 'replace' })
      expect(v.ok, name).toBe(true)
      expect(v.spec!.name).toBe(name)
    }
  })

  it('refuses a clipping of agents', () => {
    const cat = CAT()
    const v = validateGenerated(exportAgents(cat, ['cat', 'human']), { mode: 'replace' })
    expect(v.ok).toBe(false)
    expect(v.error).toMatch(/"kind":"agents"/)
  })

  it('refuses a link to a missing id, naming the link', () => {
    const d = doc(CAT())
    d.links.push({ id: 'ghost', source: 'cat', target: 'nobody' })
    const v = validateGenerated(JSON.stringify(d), { mode: 'replace' })
    expect(v.ok).toBe(false)
    expect(v.error).toContain('cat → nobody')
    expect(v.error).toMatch(/links that were dropped/)
  })

  it('refuses an invalid guard instead of leaving the link unguarded', () => {
    const d = doc(TRIAGE())
    d.links.find((l: { id: string }) => l.id === 'd1').guard = { op: 'decision', cmp: 'eq', value: 'billing' } // no path
    const v = validateGenerated(JSON.stringify(d), { mode: 'replace' })
    expect(v.ok).toBe(false)
    expect(v.error).toMatch(/guards that are not valid predicates/)
    expect(v.error).toContain('triage → billing')
  })

  it('refuses an invalid condition predicate', () => {
    const d = doc(FRIDGE())
    d.nodes.find((n: { id: string }) => n.id === 'solid').predicate = { op: 'telepathy' }
    const v = validateGenerated(JSON.stringify(d), { mode: 'replace' })
    expect(v.ok).toBe(false)
    expect(v.error).toMatch(/condition solid has a predicate that is not valid/)
  })

  it('refuses a decision question it could not read', () => {
    const d = doc(TRIAGE())
    d.nodes.find((n: { id: string }) => n.id === 'triage').questions.push({ name: 'x', type: 'ranking' })
    const v = validateGenerated(JSON.stringify(d), { mode: 'replace' })
    expect(v.ok).toBe(false)
    expect(v.error).toMatch(/decision triage: 1 question\(s\) could not be read/)
  })

  it('refuses an answer containing a configured secret', () => {
    const d = doc(CAT())
    d.agents[0].systemPrompt += ' Use key sk-live-ABCDEFGH1234.'
    const v = validateGenerated(JSON.stringify(d), { mode: 'replace', secrets: ['sk-live-ABCDEFGH1234'] })
    expect(v.ok).toBe(false)
    expect(v.error).toMatch(/API keys/)
    // Short or blank secrets are not matched: they would refuse every answer.
    expect(validateGenerated(JSON.stringify(doc(CAT())), { mode: 'replace', secrets: ['', 'cat'] }).ok).toBe(true)
  })

  it('refuses a swarm with no agents', () => {
    const d = doc(CAT())
    d.agents = []
    d.nodes = []
    d.links = []
    const v = validateGenerated(JSON.stringify(d), { mode: 'replace' })
    expect(v.ok).toBe(false)
    expect(v.error).toMatch(/no agents/)

    const onlyOutput = { ...d, entryIds: [], nodes: [{ id: 'out', kind: 'output', name: 'Out', position: { x: 0, y: 0 } }] }
    const w = validateGenerated(JSON.stringify(onlyOutput), { mode: 'replace' })
    expect(w.ok).toBe(false)
    expect(w.error).toMatch(/nothing could run/)
  })

  it('lays out nodes the answer gave no position', () => {
    const d = doc(CAT())
    for (const a of d.agents) delete a.position
    const v = validateGenerated(JSON.stringify(d), { mode: 'replace' })
    expect(v.ok).toBe(true)
    const pos = Object.fromEntries(v.spec!.agents.map((a) => [a.id, a.position]))
    expect(pos.cat.x).toBe(0)
    expect(pos.human.x).toBe(320)
    expect(pos.narrator.x).toBe(640)
  })
})

describe('edit mode keeps identity', () => {
  /** The Cat Council, re-keyed by a careless model: `cat` became `the-cat`, the Door was removed. */
  function rekeyed(options: { dropHumanPosition?: boolean } = {}) {
    const d = doc(CAT())
    for (const a of d.agents) if (a.id === 'cat') a.id = 'the-cat'
    d.agents = d.agents.filter((a: { id: string }) => a.id !== 'door')
    d.links = d.links
      .filter((l: { source: string; target: string }) => l.source !== 'door' && l.target !== 'door')
      .map((l: { source: string; target: string }) => ({
        ...l,
        source: l.source === 'cat' ? 'the-cat' : l.source,
        target: l.target === 'cat' ? 'the-cat' : l.target,
      }))
    d.entryIds = ['the-cat']
    if (options.dropHumanPosition) delete d.agents.find((a: { id: string }) => a.id === 'human').position
    return d
  }

  it('restoreIdentity puts the old id back and rewires links', () => {
    const current = CAT()
    const raw = rekeyed()
    const parsed = parsePortable(JSON.stringify(raw))
    expect(parsed.ok).toBe(true)
    const next = portableToSpec((parsed as { ok: true; value: PortableSwarm }).value)
    const spec = restoreIdentity(next, current, raw)
    expect(spec.agents.map((a) => a.id).sort()).toEqual(['cat', 'human', 'narrator'])
    expect(spec.links.find((l) => l.id === 'l1')).toMatchObject({ source: 'cat', target: 'human' })
    expect(spec.entryIds).toEqual(['cat'])
    // The Door stays removed.
    expect(spec.agents.some((a) => a.id === 'door' || a.name === 'The Door')).toBe(false)
    expect(spec.links.some((l) => l.source === 'door' || l.target === 'door')).toBe(false)
  })

  it('restoreIdentity restores a position the answer left out', () => {
    const current = CAT()
    const raw = rekeyed({ dropHumanPosition: true })
    const parsed = parsePortable(JSON.stringify(raw)) as { ok: true; value: PortableSwarm }
    const spec = restoreIdentity(portableToSpec(parsed.value), current, raw)
    expect(spec.agents.find((a) => a.id === 'human')!.position).toEqual(current.agents.find((a) => a.id === 'human')!.position)
  })

  it('validateGenerated in edit mode gives back the old ids', () => {
    const current = CAT()
    const v = validateGenerated(JSON.stringify(rekeyed()), { mode: 'edit', current })
    expect(v.ok).toBe(true)
    expect(v.spec!.agents.map((a) => a.id).sort()).toEqual(['cat', 'human', 'narrator'])
    expect(v.spec!.links.map((l) => `${l.source}>${l.target}`).sort()).toEqual(['cat>human', 'human>narrator'])
  })

  // The auto-layout used to run on the raw answer's ids and undo what restoreIdentity had put back.
  it('validateGenerated in edit mode keeps the old position of a node the answer left unplaced', () => {
    const current = CAT()
    const v = validateGenerated(JSON.stringify(rekeyed({ dropHumanPosition: true })), { mode: 'edit', current })
    expect(v.ok).toBe(true)
    const human = current.agents.find((a) => a.id === 'human')!.position
    const cat = current.agents.find((a) => a.id === 'cat')!.position
    expect(v.spec!.agents.find((a) => a.id === 'human')!.position).toEqual(human)
    expect(v.spec!.agents.find((a) => a.id === 'cat')!.position).toEqual(cat)
  })
})

describe('promptGraph with an injected model', () => {
  const KEY = 'sk-test-SECRETKEY-0001'

  function scripted(answers: string[]) {
    const calls: Array<{ provider: ProviderId; req: ChatRequest }> = []
    const complete = vi.fn(async (provider: ProviderId, req: ChatRequest): Promise<ChatResult> => {
      calls.push({ provider, req })
      const text = answers[Math.min(calls.length - 1, answers.length - 1)]
      return { text, tokensIn: 1, tokensOut: 1 }
    })
    return { complete, calls }
  }

  it('repairs once with the reader’s own error, then loads', async () => {
    const { complete, calls } = scripted(['I think you want three agents.', exportSwarm(CAT())])
    const notices: string[] = []
    const discards = vi.fn()
    const r = await promptGraph({
      instruction: 'a council of cats',
      mode: 'replace',
      provider: 'openai',
      model: 'gpt-test',
      apiKey: KEY,
      signal: signal(),
      complete,
      onNotice: (n) => notices.push(n),
      onDiscard: discards,
    })
    expect(r.ok).toBe(true)
    expect(r.repaired).toBe(true)
    expect(complete).toHaveBeenCalledTimes(2)
    const second = calls[1].req.messages
    expect(second).toHaveLength(3)
    expect(second[1]).toEqual({ role: 'assistant', content: 'I think you want three agents.' })
    expect(second[2].content).toContain('The answer contains no JSON object.')
    expect(notices.some((n) => n.includes('no JSON object'))).toBe(true)
    expect(discards).toHaveBeenCalled()
    if (r.ok) {
      expect(r.demo).toBe(false)
      expect(r.spec.agents.map((a) => a.id)).toEqual(CAT().agents.map((a) => a.id))
    }
  })

  it('gives up after one failed repair with a readable error', async () => {
    const { complete } = scripted(['nope', '{"kind": "swarm",, }'])
    const r = await promptGraph({
      instruction: 'anything',
      mode: 'replace',
      provider: 'anthropic',
      model: 'claude-test',
      apiKey: KEY,
      signal: signal(),
      complete,
    })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(r.ok).toBe(false)
    expect(r.repaired).toBe(true)
    if (!r.ok) {
      expect(r.error).toMatch(/does not parse/)
      expect(r.raw).toBe('{"kind": "swarm",, }')
    }
  })

  it('reports a thrown provider error instead of throwing', async () => {
    const complete = vi.fn(async () => {
      throw new Error('HTTP 429 — slow down')
    })
    const r = await promptGraph({ instruction: 'x', mode: 'replace', provider: 'openai', model: 'm', apiKey: KEY, signal: signal(), complete })
    expect(r).toMatchObject({ ok: false, error: 'HTTP 429 — slow down' })
  })

  it('refuses an empty instruction and an edit with nothing to edit, without calling the model', async () => {
    const { complete } = scripted(['{}'])
    expect(await promptGraph({ instruction: '  ', mode: 'replace', provider: 'openai', model: 'm', apiKey: KEY, signal: signal(), complete })).toMatchObject({ ok: false })
    expect(await promptGraph({ instruction: 'x', mode: 'edit', provider: 'openai', model: 'm', apiKey: KEY, signal: signal(), complete })).toMatchObject({ ok: false })
    expect(complete).not.toHaveBeenCalled()
  })

  it('edit mode keeps every id of the current swarm when the model keeps them', async () => {
    const current = FRIDGE()
    const d = doc(current)
    d.agents.push({ ...d.agents[0], id: 'bailiff', name: 'The Bailiff', position: { x: 1300, y: 60 } })
    d.links.push({ id: 'b1', source: 'judge', target: 'bailiff' })
    const { complete, calls } = scripted([JSON.stringify(d)])
    const r = await promptGraph({
      instruction: 'add a bailiff after the judge',
      mode: 'edit',
      current,
      provider: 'openrouter',
      model: 'some/model',
      apiKey: KEY,
      secrets: [KEY],
      signal: signal(),
      complete,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.repaired).toBe(false)
    const ids = new Set([...r.spec.agents.map((a) => a.id), ...(r.spec.nodes ?? []).map((n) => n.id)])
    for (const a of current.agents) expect(ids.has(a.id)).toBe(true)
    for (const n of current.nodes ?? []) expect(ids.has(n.id)).toBe(true)
    expect(ids.has('bailiff')).toBe(true)
    // The key travels only as the request's apiKey, never in the prompt.
    const req = calls[0].req
    expect(req.apiKey).toBe(KEY)
    expect(req.system).not.toContain(KEY)
    expect(JSON.stringify(req.messages)).not.toContain(KEY)
    expect(req.messages[0].content).toContain(exportSwarm(current))
    expect(req.messages[0].content).not.toContain('apiKey')
  })
})

describe('the generator prompt', () => {
  const defaults = defaultsFor('openai', 'gpt-test')

  it('mentions every node kind, predicate op, provider and decision type', () => {
    for (const mode of ['replace', 'edit'] as const) {
      const system = buildGeneratorSystem(mode, defaults)
      for (const kind of GENERATOR_NODE_KINDS) expect(system, kind).toMatch(new RegExp(`\\b${kind}\\b`))
      for (const op of GENERATOR_PREDICATE_OPS) expect(system, op).toContain(`"${op}"`)
      for (const p of PROVIDERS) expect(system, p.id).toContain(p.id)
      for (const p of DECISION_PROVIDER_IDS) expect(system, p).toContain(p)
      for (const t of DECISION_TYPES) expect(system, t).toContain(`"${t}"`)
    }
    expect(buildGeneratorSystem('edit', defaults)).toContain('MODE: EDIT')
    expect(buildGeneratorSystem('replace', defaults)).toContain('MODE: CREATE')
  })

  it('carries no key it could have been handed', () => {
    const keys = ['sk-ant-AAAA1111', 'sk-or-BBBB2222']
    const system = buildGeneratorSystem('edit', defaultsFor('anthropic', 'claude', { decisionProvider: 'openrouter' }))
    for (const k of keys) expect(system).not.toContain(k)
    expect(system).not.toContain('apiKey')
  })

  it('the edit message carries the current swarm and no apiKey field', () => {
    const current = TRIAGE()
    const message = buildGeneratorMessage('add a refund desk', 'edit', current)
    expect(message).toContain('INSTRUCTION: add a refund desk')
    expect(message).toContain(exportSwarm(current))
    expect(message).not.toContain('apiKey')
    expect(buildGeneratorMessage('x', 'replace', current)).not.toContain('CURRENT SWARM')
  })
})

describe('the demo generator', () => {
  it('picks the Triage preset for a support triage', async () => {
    const r = await promptGraph({ instruction: 'a support triage with escalation', mode: 'replace', provider: 'mock', model: '', apiKey: '', signal: signal() })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.demo).toBe(true)
    expect(r.spec.name).toBe('Demo: Triage (System 1 → System 2)')
    expect(r.note).toMatch(/Demo generator/)
  })

  it('edit mode adds a human gate and keeps every id', async () => {
    const current = FRIDGE()
    const r = await promptGraph({ instruction: 'add a human gate', mode: 'edit', current, provider: 'mock', model: '', apiKey: '', signal: signal() })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const ids = new Set([...r.spec.agents.map((a) => a.id), ...(r.spec.nodes ?? []).map((n) => n.id)])
    for (const a of current.agents) expect(ids.has(a.id)).toBe(true)
    for (const n of current.nodes ?? []) expect(ids.has(n.id)).toBe(true)
    const humans = (r.spec.nodes ?? []).filter((n) => n.kind === 'human')
    expect(humans.length).toBe((current.nodes ?? []).filter((n) => n.kind === 'human').length + 1)
    const gate = humans.find((h) => !(current.nodes ?? []).some((n) => n.id === h.id))!
    expect(r.spec.links.some((l) => l.source === gate.id && l.target === 'verdict' && l.label === 'approved')).toBe(true)
  })

  it('stops when aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const r = await promptGraph({ instruction: 'triage', mode: 'replace', provider: 'mock', model: '', apiKey: '', signal: controller.signal })
    expect(r).toMatchObject({ ok: false, error: 'Stopped.' })
  })
})

describe('Decision nodes in the portable format', () => {
  it('the Triage preset survives export → parse → spec unchanged', () => {
    const original = TRIAGE()
    const parsed = parsePortable(exportSwarm(original))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok || parsed.value.kind !== 'swarm') throw new Error('not a swarm')
    const back = portableToSpec(parsed.value)
    expect(back.agents).toEqual(original.agents)
    expect(back.nodes).toEqual(original.nodes)
    expect(back.links).toEqual(original.links)
    expect(back.entryIds).toEqual(original.entryIds)
    expect(back.task).toBe(original.task)
  })

  it('reads questions in the API’s own shape', () => {
    const pasted = {
      kind: 'swarm',
      task: 't',
      agents: [{ id: 'a', name: 'A' }],
      nodes: [
        {
          id: 'd',
          kind: 'decision',
          name: 'D',
          provider: 'openrouter',
          questions: {
            route: { type: 'choice', criteria: { a: 'x', b: 'y' } },
            lvl: { type: 'score', criteria: ['lo', 'hi'] },
          },
        },
      ],
      links: [{ id: 'l', source: 'd', target: 'a' }],
    }
    const parsed = parsePortable(JSON.stringify(pasted))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const node = parsed.value.nodes[0] as DecisionNode
    expect(node.kind).toBe('decision')
    expect(node.provider).toBe('openrouter')
    expect(node.model).toBe('typesafe/jev-1.13')
    expect(node.questions).toEqual([
      { name: 'route', type: 'choice', instructions: '', options: [{ label: 'a', criterion: 'x' }, { label: 'b', criterion: 'y' }] },
      { name: 'lvl', type: 'score', instructions: '', levels: ['lo', 'hi'] },
    ])
  })

  it('an unknown decision provider falls back to mock with its model', () => {
    const parsed = parsePortable(JSON.stringify({ kind: 'swarm', task: 't', agents: [], nodes: [{ id: 'd', kind: 'decision', provider: 'skynet', questions: [] }] }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.nodes[0]).toMatchObject({ kind: 'decision', provider: 'mock', model: 'demo-decider', questions: [], name: 'Decision' })
  })
})

describe('the decision predicate', () => {
  const answers = {
    route: { type: 'choice', choice: 'billing', confidence: 0.42, probabilities: { billing: 0.6, technical: 0.4 } },
    urgent: { type: 'noul', noul: 0.8, yes: true },
  }
  const ctx = (decision?: Record<string, unknown>): PredicateContext => ({
    text: 'hello',
    visits: 0,
    round: 1,
    readMemory: () => undefined,
    ...(decision ? { decision } : {}),
  })

  it('compares a choice, a confidence and a yes', () => {
    expect(evaluate({ op: 'decision', path: 'route.choice', cmp: 'eq', value: 'billing' }, ctx(answers))).toEqual({ value: true })
    expect(evaluate({ op: 'decision', path: 'route.choice', cmp: 'eq', value: 'technical' }, ctx(answers))).toEqual({ value: false })
    expect(evaluate({ op: 'decision', path: 'route.confidence', cmp: 'lt', value: 0.6 }, ctx(answers))).toEqual({ value: true })
    expect(evaluate({ op: 'decision', path: 'route.confidence', cmp: 'gte', value: 0.6 }, ctx(answers))).toEqual({ value: false })
    expect(evaluate({ op: 'decision', path: 'urgent.yes', cmp: 'eq', value: true }, ctx(answers))).toEqual({ value: true })
    expect(evaluate({ op: 'decision', path: 'route.probabilities.billing', cmp: 'gt', value: 0.5 }, ctx(answers))).toEqual({ value: true })
    expect(evaluate({ op: 'decision', path: 'blocked', cmp: 'exists' }, ctx(answers))).toEqual({ value: false })
  })

  it('is false, with a problem, when no Decision node answered', () => {
    const r = evaluate({ op: 'decision', path: 'route.choice', cmp: 'eq', value: 'billing' }, ctx())
    expect(r.value).toBe(false)
    expect(r.problem).toMatch(/no Decision node answered/)
  })

  it('is false, with a problem, on a malformed path', () => {
    const empty = evaluate({ op: 'decision', path: '', cmp: 'eq', value: 'x' } as Predicate, ctx(answers))
    expect(empty).toMatchObject({ value: false })
    expect(empty.problem).toMatch(/path/)
    const hole = evaluate({ op: 'decision', path: 'route..choice', cmp: 'eq', value: 'x' }, ctx(answers))
    expect(hole.problem).toMatch(/empty segment/)
  })

  it('describes itself', () => {
    expect(describePredicate({ op: 'decision', path: 'route.choice', cmp: 'eq', value: 'billing' })).toBe('decision route.choice = "billing"')
    expect(describePredicate({ op: 'decision', path: 'route.confidence', cmp: 'lt', value: 0.6 })).toBe('decision route.confidence < 0.6')
    expect(describePredicate({ op: 'decision', path: 'urgent', cmp: 'exists' })).toBe('decision urgent exists')
  })

  it('reads back from pasted JSON, and refuses one without a path', () => {
    const p: Predicate = { op: 'decision', path: 'route.choice', cmp: 'eq', value: 'billing' }
    expect(readPredicate(JSON.parse(JSON.stringify(p)))).toEqual(p)
    expect(readPredicate({ op: 'Decision', path: ' urgent.yes ', cmp: 'EQ', value: true })).toEqual({ op: 'decision', path: 'urgent.yes', cmp: 'eq', value: true })
    expect(readPredicate({ op: 'decision', cmp: 'eq', value: 'billing' })).toBeUndefined()
    expect(readPredicate({ op: 'decision', path: '  ', cmp: 'eq', value: 'billing' })).toBeUndefined()
    expect(readPredicate({ op: 'decision', path: 'route.choice', cmp: 'resembles', value: 'billing' })).toBeUndefined()
  })
})
