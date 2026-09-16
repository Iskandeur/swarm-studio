/**
 * Version 2 of the engine: conditions, joins, gates, memory, blocks, spawn.
 *
 * All on the demo provider. Each character below is given lines in `DEMO_VOICES`, which is how a
 * test decides what an agent "says" — tags included — without a network or a key.
 */
import assert from 'node:assert/strict'
import { afterAll, describe, test } from 'vitest'
import { runSwarm, type BranchEvent, type MemoryWriteEvent, type OutputEvent, type RunnerCallbacks, type SpawnEvent, type TransitPacket } from './runner.ts'
import { createRunSession, type PendingGate, type RunSession } from './session.ts'
import { DEMO_VOICES } from './providers.ts'
import { PRESETS } from '../presets.ts'
import type { Agent, BlockDef, FlowNode, SwarmSpec, TranscriptEntry } from '../types.ts'

const added: string[] = []
function voice(name: string, lines: string[]) {
  DEMO_VOICES[name] = lines
  added.push(name)
}
afterAll(() => {
  for (const name of added) delete DEMO_VOICES[name]
})

function agent(id: string, name: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name,
    provider: 'mock',
    model: 'demo-fast',
    systemPrompt: `You are ${name}.`,
    temperature: 0.5,
    hue: 200,
    position: { x: 0, y: 0 },
    ...overrides,
  }
}

function swarm(partial: Partial<SwarmSpec>): SwarmSpec {
  return {
    name: 'test',
    task: 'Decide.',
    agents: [],
    nodes: [],
    links: [],
    topology: 'broadcast',
    maxRounds: 10,
    entryIds: [],
    ...partial,
  }
}

interface Collected {
  transcript: TranscriptEntry[]
  transit: TransitPacket[]
  notices: string[]
  spawns: SpawnEvent[]
  outputs: OutputEvent[]
  writes: MemoryWriteEvent[]
  branches: BranchEvent[]
  gates: PendingGate[]
  rounds: number[]
  phase: string
  error?: string
  session: RunSession
}

async function collect(
  spec: SwarmSpec,
  options: { onGate?: (gate: PendingGate, session: RunSession) => void; library?: BlockDef[] } = {},
): Promise<Collected> {
  const session = createRunSession()
  const entries = new Map<string, TranscriptEntry>()
  const out: Collected = {
    transcript: [],
    transit: [],
    notices: [],
    spawns: [],
    outputs: [],
    writes: [],
    branches: [],
    gates: [],
    rounds: [],
    phase: '',
    session,
  }
  const cb: RunnerCallbacks = {
    onPhase: (p, detail) => {
      out.phase = p
      if (detail) out.error = detail
    },
    onRound: (r) => out.rounds.push(r),
    onAgentStatus: () => {},
    onMessageStart: (entry) => entries.set(entry.id, { ...entry }),
    onMessageDelta: (id, delta) => {
      const entry = entries.get(id)!
      entry.text += delta
    },
    onMessageEnd: (id, patch) => entries.set(id, { ...entries.get(id)!, ...patch }),
    onTransit: (packets) => out.transit.push(...packets),
    onNotice: (n) => out.notices.push(n),
    onSpawn: (e) => out.spawns.push(e),
    onOutput: (e) => out.outputs.push(e),
    onMemoryWrite: (e) => out.writes.push(e),
    onBranch: (e) => out.branches.push(e),
    onHumanGate: (gate) => {
      out.gates.push(gate)
      options.onGate?.(gate, session)
    },
  }
  await runSwarm(spec, {}, cb, new AbortController().signal, { session, library: options.library })
  out.transcript = [...entries.values()]
  return out
}

const speakers = (c: Collected, round?: number) =>
  c.transcript.filter((e) => round === undefined || e.round === round).filter((e) => !e.path).map((e) => e.agentId).sort()

const heard = (c: Collected, agentId: string) =>
  (c.session.memory.get(agentId) ?? []).filter((m) => m.role === 'user').map((m) => m.content)

describe('the existing presets run exactly as before', () => {
  /**
   * Captured from the version-1 engine (main at ce507cb) before a line of version 2 was written:
   * who spoke in which round, to whom, and which links lit up in which direction.
   */
  const BEFORE: Record<string, { rounds: number; turns: string[]; transit: string[] }> = {
    'The Cat Council': {
      rounds: 3,
      turns: ['1:cat->door,human', '2:door->narrator', '2:human->narrator', '3:narrator->'],
      transit: ['l1>', 'l2>', 'l3>', 'l4>'],
    },
    'The Best Man Speech': {
      rounds: 4,
      turns: [
        '1:bestman->historian,lawyer,sibling',
        '2:historian->bestman',
        '2:lawyer->bestman',
        '2:sibling->bestman',
        '3:bestman->historian,lawyer,sibling',
        '4:historian->bestman',
        '4:lawyer->bestman',
        '4:sibling->bestman',
      ],
      transit: ['l1<', 'l1<', 'l1>', 'l1>', 'l2<', 'l2<', 'l2>', 'l2>', 'l3<', 'l3<', 'l3>', 'l3>'],
    },
    'The Dignity Pipeline': {
      rounds: 3,
      turns: ['1:checker->writer', '2:writer->editor', '3:editor->'],
      transit: ['l1>', 'l2>'],
    },
  }

  for (const [name, expected] of Object.entries(BEFORE)) {
    test(name, { timeout: 30_000 }, async () => {
      const preset = PRESETS.find((p) => p.name === name)
      assert.ok(preset, `preset ${name} still ships`)
      const c = await collect(preset)
      assert.equal(c.phase, 'done')
      assert.equal(c.rounds.at(-1), expected.rounds)
      assert.deepEqual(
        c.transcript.map((e) => `${e.round}:${e.agentId}->${[...e.to].sort().join(',')}`).sort(),
        expected.turns,
      )
      assert.deepEqual(c.transit.map((p) => `${p.id}${p.reversed ? '<' : '>'}`).sort(), expected.transit)
    })
  }
})

describe('conditional links', () => {
  test('a guard lets through only the message that satisfies it', { timeout: 20_000 }, async () => {
    voice('Judge Guard', ['The defendant is guilty, obviously.'])
    const c = await collect(
      swarm({
        agents: [agent('j', 'Judge Guard'), agent('jail', 'JAIL'), agent('home', 'HOME')],
        links: [
          { id: 'toJail', source: 'j', target: 'jail', guard: { op: 'contains', value: 'guilty' } },
          { id: 'toHome', source: 'j', target: 'home', guard: { op: 'not', of: { op: 'contains', value: 'guilty' } } },
        ],
      }),
    )
    assert.deepEqual(speakers(c, 2), ['jail'])
    assert.deepEqual(c.transcript.find((e) => e.agentId === 'j')!.to, ['jail'])
    assert.ok(c.branches.some((b) => b.nodeId === 'j' && b.skipped.includes('toHome')))
  })

  test('a condition node routes to its true or false side and costs no round', { timeout: 20_000 }, async () => {
    voice('Oracle Yes', ['Yes. The answer is yes.'])
    const c = await collect(
      swarm({
        agents: [agent('o', 'Oracle Yes'), agent('t', 'TRUE SIDE'), agent('f', 'FALSE SIDE')],
        nodes: [{ id: 'cond', kind: 'condition', name: 'Said yes?', position: { x: 0, y: 0 }, predicate: { op: 'matches', pattern: '^yes', flags: 'i' } }],
        links: [
          { id: 'oc', source: 'o', target: 'cond' },
          { id: 'ct', source: 'cond', target: 't', label: 'true' },
          { id: 'cf', source: 'cond', target: 'f', label: 'false' },
        ],
      }),
    )
    // Round 2, not 3: the diamond acted inside round 1's delivery.
    assert.deepEqual(speakers(c, 2), ['t'])
    assert.ok(!speakers(c).includes('f'))
    assert.deepEqual(c.transit.map((p) => p.id), ['oc', 'ct'])
  })

  test('a condition reads a JSON field of the message', { timeout: 20_000 }, async () => {
    voice('Scorer', ['Verdict follows. ```json\n{"verdict": {"score": 4}}\n```'])
    const c = await collect(
      swarm({
        agents: [agent('s', 'Scorer'), agent('good', 'GOOD'), agent('redo', 'REDO')],
        nodes: [{ id: 'q', kind: 'condition', name: 'Good enough?', position: { x: 0, y: 0 }, predicate: { op: 'json', path: 'verdict.score', cmp: 'gte', value: 7 } }],
        links: [
          { id: 'sq', source: 's', target: 'q' },
          { id: 'qg', source: 'q', target: 'good', label: 'true' },
          { id: 'qr', source: 'q', target: 'redo', label: 'false' },
        ],
      }),
    )
    assert.deepEqual(speakers(c, 2), ['redo'])
  })

  test('an agent that chooses its branch sends the message only there, and the tag is not shown', { timeout: 20_000 }, async () => {
    voice('Chooser', ['Left is a trap. <route to="right"/>'])
    const c = await collect(
      swarm({
        agents: [agent('c', 'Chooser', { dispatch: 'choose' }), agent('l', 'LEFT'), agent('r', 'RIGHT')],
        links: [
          { id: 'cl', source: 'c', target: 'l', label: 'left' },
          { id: 'cr', source: 'c', target: 'r', label: 'right' },
        ],
      }),
    )
    const said = c.transcript.find((e) => e.agentId === 'c')!
    assert.deepEqual(said.to, ['r'])
    assert.equal(said.text, 'Left is a trap.')
    assert.ok(said.actions?.some((a) => a.type === 'route' && a.text.includes('right')))
    assert.deepEqual(speakers(c, 2), ['r'])
    // What the recipient reads is the prose: a tag would teach it the syntax of someone else's branches.
    assert.ok(heard(c, 'r').every((m) => !m.includes('<route')))
  })

  test('a chooser that names no valid branch falls back to the default, and says so', { timeout: 20_000 }, async () => {
    voice('Vague Chooser', ['Somewhere, probably. <route to="up"/>'])
    const c = await collect(
      swarm({
        agents: [agent('c', 'Vague Chooser', { dispatch: 'choose' }), agent('l', 'LEFT'), agent('r', 'RIGHT')],
        links: [
          { id: 'cl', source: 'c', target: 'l', label: 'left', isDefault: true },
          { id: 'cr', source: 'c', target: 'r', label: 'right' },
        ],
      }),
    )
    assert.deepEqual(speakers(c, 2), ['l'])
    assert.ok(c.notices.some((n) => /default branch "left"/.test(n)))
  })

  test('a loop budget closes a link after N messages', { timeout: 30_000 }, async () => {
    const c = await collect(
      swarm({
        maxRounds: 30,
        entryIds: ['w'],
        agents: [agent('w', 'WRITER'), agent('k', 'CRITIC')],
        links: [
          { id: 'wk', source: 'w', target: 'k' },
          { id: 'kw', source: 'k', target: 'w', maxTraversals: 2 },
        ],
      }),
    )
    assert.equal(c.phase, 'done')
    assert.deepEqual(c.transcript.map((e) => e.agentId), ['w', 'k', 'w', 'k', 'w', 'k'])
    assert.ok(c.notices.some((n) => /closed/.test(n)))
  })

  test('a visits guard does the same from inside the condition language', { timeout: 30_000 }, async () => {
    const c = await collect(
      swarm({
        maxRounds: 30,
        entryIds: ['w'],
        agents: [agent('w', 'WRITER'), agent('k', 'CRITIC')],
        links: [
          { id: 'wk', source: 'w', target: 'k' },
          { id: 'kw', source: 'k', target: 'w', guard: { op: 'visits', cmp: 'lt', value: 1 } },
        ],
      }),
    )
    assert.deepEqual(c.transcript.map((e) => e.agentId), ['w', 'k', 'w', 'k'])
  })

  test('a cycle made only of zero-token nodes fails with a message naming them', { timeout: 20_000 }, async () => {
    const c = await collect(
      swarm({
        agents: [agent('a', 'A')],
        nodes: [
          { id: 'x', kind: 'condition', name: 'Ping', position: { x: 0, y: 0 }, predicate: { op: 'always' } },
          { id: 'y', kind: 'condition', name: 'Pong', position: { x: 0, y: 0 }, predicate: { op: 'always' } },
        ],
        links: [
          { id: 'ax', source: 'a', target: 'x' },
          { id: 'xy', source: 'x', target: 'y' },
          { id: 'yx', source: 'y', target: 'x' },
        ],
      }),
    )
    assert.equal(c.phase, 'error')
    assert.match(c.error ?? '', /zero-token/)
    assert.match(c.error ?? '', /Ping/)
  })
})

describe('joins, outputs and human gates', () => {
  test('a join waits for every branch, even the slower one, and hands on both', { timeout: 30_000 }, async () => {
    const c = await collect(
      swarm({
        entryIds: ['a'],
        agents: [agent('a', 'A'), agent('b', 'B'), agent('c', 'C'), agent('d', 'D'), agent('e', 'E')],
        nodes: [{ id: 'j', kind: 'join', name: 'Both', position: { x: 0, y: 0 }, mode: 'all' }],
        links: [
          { id: 'ab', source: 'a', target: 'b' },
          { id: 'ac', source: 'a', target: 'c' },
          { id: 'cd', source: 'c', target: 'd' },
          { id: 'bj', source: 'b', target: 'j' },
          { id: 'dj', source: 'd', target: 'j' },
          { id: 'je', source: 'j', target: 'e' },
        ],
      }),
    )
    const e = c.transcript.filter((x) => x.agentId === 'e')
    assert.equal(e.length, 1, 'E speaks once')
    assert.equal(e[0].round, 4, 'after D, which is one round behind B')
    const inbox = heard(c, 'e')
    assert.ok(inbox.some((m) => m.includes('B said')) && inbox.some((m) => m.includes('D said')))
  })

  test('a join whose other branch never runs releases when nothing else is left', { timeout: 20_000 }, async () => {
    voice('Only Yes', ['yes'])
    const c = await collect(
      swarm({
        entryIds: ['a'],
        agents: [agent('a', 'Only Yes'), agent('never', 'NEVER'), agent('e', 'E')],
        nodes: [
          { id: 'q', kind: 'condition', name: 'q', position: { x: 0, y: 0 }, predicate: { op: 'contains', value: 'yes' } },
          { id: 'j', kind: 'join', name: 'Waiter', position: { x: 0, y: 0 }, mode: 'all' },
        ],
        links: [
          { id: 'aq', source: 'a', target: 'q' },
          { id: 'qj', source: 'q', target: 'j', label: 'true' },
          { id: 'qn', source: 'q', target: 'never', label: 'false' },
          { id: 'nj', source: 'never', target: 'j' },
          { id: 'je', source: 'j', target: 'e' },
        ],
      }),
    )
    assert.ok(speakers(c).includes('e'))
    assert.ok(c.notices.some((n) => /Waiter.*released/.test(n)))
  })

  test('an output node records the result and forwards nothing', { timeout: 20_000 }, async () => {
    voice('Finisher', ['The final answer is 42.'])
    const c = await collect(
      swarm({
        agents: [agent('f', 'Finisher')],
        nodes: [{ id: 'out', kind: 'output', name: 'Result', position: { x: 0, y: 0 } }],
        links: [{ id: 'fo', source: 'f', target: 'out' }],
      }),
    )
    assert.deepEqual(c.outputs.map((o) => o.text), ['The final answer is 42.'])
    assert.equal(c.phase, 'done')
  })

  const gated = (): SwarmSpec =>
    swarm({
      agents: [agent('p', 'Proposer'), agent('ok', 'APPROVED'), agent('no', 'REJECTED')],
      nodes: [{ id: 'g', kind: 'human', name: 'Sign-off', position: { x: 0, y: 0 }, prompt: 'Ship it?' }],
      links: [
        { id: 'pg', source: 'p', target: 'g' },
        { id: 'ga', source: 'g', target: 'ok', label: 'approved' },
        { id: 'gr', source: 'g', target: 'no', label: 'rejected' },
      ],
    })

  test('a human gate holds the flow until approved', { timeout: 20_000 }, async () => {
    voice('Proposer', ['Let us ship on a Friday.'])
    const c = await collect(gated(), {
      onGate: (gate, session) => setTimeout(() => session.decideGate(gate.id, { approved: true, text: gate.text }), 300),
    })
    assert.equal(c.gates.length, 1)
    assert.equal(c.gates[0].prompt, 'Ship it?')
    assert.deepEqual(speakers(c, 2), ['ok'])
  })

  test('a rejection takes the rejected side, and an edit replaces the text', { timeout: 20_000 }, async () => {
    voice('Proposer', ['Let us ship on a Friday.'])
    const c = await collect(gated(), {
      onGate: (gate, session) => session.decideGate(gate.id, { approved: false, text: 'Not on a Friday.' }),
    })
    assert.deepEqual(speakers(c, 2), ['no'])
    assert.ok(heard(c, 'no').some((m) => m.includes('The human said:\nNot on a Friday.')))
  })

  test('stopping while a gate waits ends the run instead of hanging', { timeout: 20_000 }, async () => {
    voice('Proposer', ['Let us ship on a Friday.'])
    const controller = new AbortController()
    const phases: string[] = []
    const run = runSwarm(
      gated(),
      {},
      {
        onPhase: (p) => phases.push(p),
        onRound: () => {},
        onAgentStatus: () => {},
        onMessageStart: () => {},
        onMessageDelta: () => {},
        onMessageEnd: () => {},
        onTransit: () => {},
        onHumanGate: () => setTimeout(() => controller.abort(), 50),
      },
      controller.signal,
    )
    await run
    assert.equal(phases.at(-1), 'stopped')
  })
})

describe('shared memory', () => {
  const board = (overrides: Partial<Extract<FlowNode, { kind: 'memory' }>> = {}): FlowNode => ({
    id: 'mem',
    kind: 'memory',
    name: 'Evidence',
    position: { x: 0, y: 0 },
    mode: 'blackboard',
    wakeReaders: false,
    seed: [],
    maxChars: 2400,
    ...overrides,
  })

  test('a writer sets a key, and a guard in the same round already sees it', { timeout: 20_000 }, async () => {
    voice('Detective', ['I have a name. <write memory="Evidence" key="suspect">the toaster</write>'])
    const c = await collect(
      swarm({
        agents: [agent('d', 'Detective'), agent('arrest', 'ARREST'), agent('wait', 'WAIT')],
        nodes: [board()],
        links: [
          { id: 'dm', source: 'd', target: 'mem', kind: 'access' },
          { id: 'da', source: 'd', target: 'arrest', guard: { op: 'memory', memory: 'evidence', key: 'suspect', cmp: 'exists' } },
          { id: 'dw', source: 'd', target: 'wait', guard: { op: 'not', of: { op: 'memory', memory: 'Evidence', key: 'suspect', cmp: 'exists' } } },
        ],
      }),
    )
    assert.equal(c.writes.length, 1)
    assert.equal(c.writes[0].entry.value, 'the toaster')
    assert.equal(c.writes[0].entry.author, 'Detective')
    assert.deepEqual(speakers(c, 2), ['arrest'])
    const said = c.transcript.find((e) => e.agentId === 'd')!
    assert.equal(said.text, 'I have a name.')
    assert.ok(said.actions?.some((a) => a.type === 'write' && a.text === '→ Evidence.suspect'))
  })

  test('a write without a write link is refused, and the memory is untouched', { timeout: 20_000 }, async () => {
    voice('Intruder', ['Planting evidence. <write memory="Evidence" key="suspect">the butler</write>'])
    const c = await collect(
      swarm({
        agents: [agent('i', 'Intruder')],
        nodes: [board()],
        // Read-only: the memory is the source.
        links: [{ id: 'mi', source: 'mem', target: 'i', kind: 'access' }],
      }),
    )
    assert.equal(c.writes.length, 0)
    assert.ok(c.notices.some((n) => /may not write/.test(n)))
    assert.ok(c.transcript[0].actions?.some((a) => a.type === 'refused'))
    assert.equal(c.session.graph.memories.get('mem')!.entries.length, 0)
  })

  test('a bus wakes readers that no message link connects', { timeout: 20_000 }, async () => {
    voice('Reporter', ['Filing now. <write memory="Newsroom">The toaster denies everything.</write>'])
    const c = await collect(
      swarm({
        entryIds: ['r'],
        agents: [agent('r', 'Reporter'), agent('reader', 'READER')],
        nodes: [board({ name: 'Newsroom', mode: 'log', wakeReaders: true })],
        links: [
          { id: 'rm', source: 'r', target: 'mem', kind: 'access' },
          { id: 'mr', source: 'mem', target: 'reader', kind: 'access' },
        ],
      }),
    )
    assert.deepEqual(speakers(c, 2), ['reader'])
    assert.ok(heard(c, 'reader').some((m) => m.includes('[memory Newsroom] Reporter wrote: The toaster denies everything.')))
  })

  test('a reader never hears about a write to a memory it cannot read', { timeout: 20_000 }, async () => {
    voice('Reporter', ['Filing now. <write memory="Newsroom">Scoop.</write>'])
    const c = await collect(
      swarm({
        entryIds: ['r'],
        agents: [agent('r', 'Reporter'), agent('outsider', 'OUTSIDER')],
        nodes: [board({ name: 'Newsroom', mode: 'log', wakeReaders: true })],
        links: [{ id: 'rm', source: 'r', target: 'mem', kind: 'access' }],
      }),
    )
    assert.deepEqual(speakers(c), ['r'])
  })
})

describe('blocks', () => {
  const critic: BlockDef = {
    id: 'critic',
    name: 'Critic',
    description: 'Reads a draft and scores it.',
    graph: {
      agents: [agent('inner', 'Inner Critic')],
      nodes: [],
      links: [],
      entryIds: [],
    },
  }

  test('a block runs its graph on what it received, and hands on the result', { timeout: 30_000 }, async () => {
    voice('Inner Critic', ['Seven out of ten, the ending drags.'])
    const c = await collect(
      swarm({
        entryIds: ['a'],
        blocks: [critic],
        agents: [agent('a', 'AUTHOR'), agent('b', 'EDITOR')],
        nodes: [{ id: 'blk', kind: 'block', name: 'Review', position: { x: 0, y: 0 }, blockId: 'critic' }],
        links: [
          { id: 'ab', source: 'a', target: 'blk' },
          { id: 'bb', source: 'blk', target: 'b' },
        ],
      }),
    )
    assert.equal(c.phase, 'done')
    const nested = c.transcript.filter((e) => e.path?.length)
    assert.deepEqual(nested.map((e) => [e.agentId, e.path]), [['inner', ['blk']]])
    const result = c.transcript.find((e) => e.agentId === 'blk')!
    assert.equal(result.text, 'Seven out of ten, the ending drags.')
    assert.ok(heard(c, 'b').some((m) => m.includes('Review said:\nSeven out of ten')))
    // The block's inner rounds are not top-level rounds.
    assert.deepEqual(c.rounds, [1, 2, 3])
  })

  test('a recursive block with no exit stops at the depth limit, and not before', { timeout: 60_000 }, async () => {
    const recursive: BlockDef = {
      id: 'rec',
      name: 'Recurse',
      description: '',
      graph: {
        agents: [agent('x', 'Layer')],
        nodes: [{ id: 'self', kind: 'block', name: 'Deeper', position: { x: 0, y: 0 }, blockId: 'rec' }],
        links: [{ id: 'xs', source: 'x', target: 'self' }],
        entryIds: ['x'],
      },
    }
    const c = await collect(
      swarm({
        maxRounds: 40,
        maxDepth: 3,
        blocks: [recursive],
        nodes: [{ id: 'root', kind: 'block', name: 'Root', position: { x: 0, y: 0 }, blockId: 'rec' }],
      }),
    )
    assert.equal(c.phase, 'done')
    const depths = c.transcript.filter((e) => e.agentId === 'x').map((e) => e.path!.length)
    assert.deepEqual(depths, [1, 2, 3])
    assert.ok(c.transcript.some((e) => /depth limit 3 reached/.test(e.text)))
  })

  test('nested rounds are charged to the swarm step budget', { timeout: 30_000 }, async () => {
    const recursive: BlockDef = {
      id: 'rec',
      name: 'Recurse',
      description: '',
      graph: {
        agents: [agent('x', 'Layer')],
        nodes: [{ id: 'self', kind: 'block', name: 'Deeper', position: { x: 0, y: 0 }, blockId: 'rec' }],
        links: [{ id: 'xs', source: 'x', target: 'self' }],
        entryIds: ['x'],
      },
    }
    const c = await collect(
      swarm({
        maxRounds: 4,
        maxDepth: 8,
        blocks: [recursive],
        nodes: [{ id: 'root', kind: 'block', name: 'Root', position: { x: 0, y: 0 }, blockId: 'rec' }],
      }),
    )
    assert.equal(c.phase, 'done')
    assert.ok(c.transcript.filter((e) => e.agentId === 'x').length < 4)
    assert.ok(c.notices.some((n) => /step budget/.test(n)))
  })

  test('an Output node inside a block decides what the block returns', { timeout: 30_000 }, async () => {
    voice('Drafter', ['A rough draft about bees.'])
    voice('Polisher', ['A polished paragraph about bees.'])
    const c = await collect(
      swarm({
        blocks: [
          {
            id: 'pipe',
            name: 'Pipe',
            description: '',
            graph: {
              agents: [agent('d', 'Drafter'), agent('p', 'Polisher')],
              nodes: [{ id: 'o', kind: 'output', name: 'Out', position: { x: 0, y: 0 } }],
              links: [
                { id: 'dp', source: 'd', target: 'p' },
                { id: 'po', source: 'p', target: 'o' },
                { id: 'do', source: 'd', target: 'o', guard: { op: 'contains', value: 'never' } },
              ],
              entryIds: ['d'],
            },
          },
        ],
        nodes: [{ id: 'b', kind: 'block', name: 'Pipe', position: { x: 0, y: 0 }, blockId: 'pipe' }],
      }),
    )
    assert.equal(c.transcript.find((e) => e.agentId === 'b')!.text, 'A polished paragraph about bees.')
  })
})

describe('spawn', () => {
  test('an agent spawns a helper, the helper answers it, and it speaks again', { timeout: 30_000 }, async () => {
    voice('Queen', ['Someone count the bees. <spawn name="Counter Bee">Count the bees in the hive.</spawn>', 'Noted: 4 012 bees.'])
    voice('Counter Bee', ['Four thousand and twelve.'])
    const c = await collect(swarm({ agents: [agent('q', 'Queen', { canSpawn: true })] }))
    assert.equal(c.phase, 'done')
    assert.equal(c.spawns.length, 1)
    const helper = c.spawns[0].node
    assert.equal(helper.name, 'Counter Bee')
    assert.equal(c.spawns[0].parentId, 'q')
    assert.deepEqual(
      c.transcript.map((e) => `${e.round}:${e.speaker ?? e.agentId}`),
      ['1:q', '2:Counter Bee', '3:q'],
    )
    assert.ok(heard(c, helper.id).some((m) => m.includes('[Queen delegates this subtask to you] Count the bees in the hive.')))
    assert.ok(heard(c, 'q').some((m) => m.includes('Counter Bee said:\nFour thousand and twelve.')))
    const reply = c.transit.find((p) => p.id === c.spawns[0].link.id && p.reversed)
    assert.ok(reply, 'the answer climbs back up the spawn link')
    assert.ok(c.transcript[0].actions?.some((a) => a.type === 'spawn'))
  })

  test('an agent without the permission is refused and told so', { timeout: 30_000 }, async () => {
    voice('Pretender', ['Summoning help. <spawn name="Minion">Do my work.</spawn>', 'Fine, I will do it myself.'])
    const c = await collect(swarm({ maxRounds: 2, agents: [agent('p', 'Pretender')] }))
    assert.equal(c.spawns.length, 0)
    assert.ok(c.notices.some((n) => /not allowed to spawn/.test(n)))
    assert.ok(heard(c, 'p').some((m) => m.includes('[system] spawn refused')))
  })

  test('the spawn limit counts across the whole run', { timeout: 30_000 }, async () => {
    voice('Greedy', ['Two helpers. <spawn name="One">a</spawn> <spawn name="Two">b</spawn>', 'Done.'])
    const c = await collect(swarm({ maxSpawns: 1, maxRounds: 3, agents: [agent('g', 'Greedy', { canSpawn: true })] }))
    assert.equal(c.spawns.length, 1)
    assert.ok(c.notices.some((n) => /spawn limit \(1\)/.test(n)))
  })

  test('helpers that spawn helpers stop at the depth limit', { timeout: 60_000 }, async () => {
    voice('Delegator', ['Not my job. <spawn name="Delegator">Handle it.</spawn>', 'Fine.'])
    // Round 1: the top agent spawns (depth 1). Round 2: that helper spawns (depth 2). Round 3: the
    // depth-2 helper tries, and is refused.
    const c = await collect(swarm({ maxDepth: 2, maxRounds: 3, agents: [agent('d', 'Delegator', { canSpawn: true })] }))
    assert.equal(c.spawns.length, 2)
    assert.ok(c.notices.some((n) => /depth limit \(2\)/.test(n)))
  })

  test('an agent can spawn a saved block', { timeout: 30_000 }, async () => {
    voice('Boss', ['Get this reviewed. <spawn block="Critic">The draft.</spawn>', 'Thanks.'])
    voice('Library Critic', ['Too long.'])
    const c = await collect(swarm({ maxRounds: 6, agents: [agent('boss', 'Boss', { canSpawn: true })] }), {
      library: [
        {
          id: 'lib-critic',
          name: 'Critic',
          description: 'Scores a draft.',
          graph: { agents: [agent('lc', 'Library Critic')], nodes: [], links: [], entryIds: [] },
        },
      ],
    })
    assert.equal(c.spawns.length, 1)
    assert.ok('kind' in c.spawns[0].node && c.spawns[0].node.kind === 'block')
    assert.ok(c.transcript.some((e) => e.agentId === 'lc' && e.path?.length === 1))
    assert.ok(heard(c, 'boss').some((m) => m.includes('Critic said:\nToo long.')))
  })
})
