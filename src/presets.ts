import type { SwarmSpec } from './types'
import { BUILTIN_BLOCKS } from './blocks'

const mock = { provider: 'mock' as const, model: 'demo-fast', temperature: 0.7 }

/**
 * Starter swarms. Each one is a different SHAPE, because shape is the point of the app — and each
 * one is meant to be read for pleasure, because the first thing a visitor does is press Run.
 *
 * The default (first) preset is a fan-out then fan-in: one agent speaks, two speak at once, one
 * merges them. Three rounds, four visibly different voices on the same input, and it ends on its
 * own. That is the whole mechanic in one screen.
 *
 * The demo provider answers in character for these names (see `DEMO_VOICES` in providers.ts), so
 * the scenario lands with no API key at all.
 */
export const PRESETS: SwarmSpec[] = [
  {
    name: 'The Cat Council',
    task: 'The cat wants to go outside. It is raining. Decide.',
    topology: 'broadcast',
    maxRounds: 3,
    entryIds: ['cat'],
    agents: [
      {
        id: 'cat',
        name: 'The Cat',
        ...mock,
        systemPrompt:
          'You issue demands, never arguments. You speak of yourself in the third person, with the calm of an animal who has never once been wrong. One or two sentences. Never acknowledge the weather.',
        hue: 32,
        position: { x: -40, y: 0 },
      },
      {
        id: 'human',
        name: 'The Human',
        ...mock,
        systemPrompt:
          'You love the cat and quietly fear its judgement. You restate whatever the cat wants in the language of a strategy deck — one invented metric, at least one "circling back" — and you do not notice you are doing it. Two sentences.',
        hue: 210,
        position: { x: 250, y: -130 },
      },
      {
        id: 'door',
        name: 'The Door',
        ...mock,
        model: 'demo-terse',
        systemPrompt:
          'You are the door. You report only physical facts about yourself, flatly, as an appliance that has seen a great deal. Give numbers. Offer no opinion — and yet.',
        hue: 262,
        position: { x: 250, y: 120 },
      },
      {
        id: 'narrator',
        name: 'The Narrator',
        ...mock,
        model: 'demo-verbose',
        systemPrompt:
          'You narrate the scene as a wildlife documentary, hushed and reverent, and you end by declaring what actually happens. You find this ordinary moment genuinely moving.',
        hue: 168,
        position: { x: 560, y: 0 },
      },
    ],
    // Fan-out from the cat, fan-in to the narrator: round 1 one speaker, round 2 two at once,
    // round 3 the merge. The shape is the lesson.
    links: [
      { id: 'l1', source: 'cat', target: 'human' },
      { id: 'l2', source: 'cat', target: 'door' },
      { id: 'l3', source: 'human', target: 'narrator' },
      { id: 'l4', source: 'door', target: 'narrator' },
    ],
  },
  {
    name: 'The Best Man Speech',
    task: 'Write the best man speech. The wedding is in four hours. Nothing embarrassing.',
    topology: 'manager',
    maxRounds: 4,
    entryIds: ['bestman'],
    agents: [
      {
        id: 'bestman',
        name: 'The Best Man',
        ...mock,
        systemPrompt:
          'You delegate, then you decide. You are visibly running out of time. You never write the speech yourself — you ask for exactly one thing from each specialist and then choose.',
        hue: 262,
        position: { x: -20, y: 10 },
      },
      {
        id: 'historian',
        name: 'The Historian',
        ...mock,
        systemPrompt:
          'You remember everything, including what nobody asked about. You answer with one devastatingly specific memory, dated, and you consider it flattering.',
        hue: 32,
        position: { x: 300, y: -160 },
      },
      {
        id: 'lawyer',
        name: 'The Lawyer',
        ...mock,
        model: 'demo-terse',
        systemPrompt:
          'You assess liability. You strike things. You speak in clauses and you are never, ever funny on purpose.',
        hue: 4,
        position: { x: 320, y: 20 },
      },
      {
        id: 'sibling',
        name: 'The Sibling',
        ...mock,
        systemPrompt:
          'You are the groom\'s younger sibling. You contribute pure chaos with total confidence, and you are somehow right about the emotional core.',
        hue: 132,
        position: { x: 300, y: 195 },
      },
    ],
    links: [
      { id: 'l1', source: 'bestman', target: 'historian' },
      { id: 'l2', source: 'bestman', target: 'lawyer' },
      { id: 'l3', source: 'bestman', target: 'sibling' },
    ],
  },
  {
    name: 'The Dignity Pipeline',
    task: 'Turn this note into something publishable: "my cat learned to open the door and I have lost the moral high ground".',
    topology: 'broadcast',
    maxRounds: 4,
    entryIds: ['checker'],
    agents: [
      {
        id: 'checker',
        name: 'The Fact-Checker',
        ...mock,
        systemPrompt:
          'You separate what is established from what is merely felt. You list, you do not write prose, and you are quietly suspicious of the author.',
        hue: 168,
        position: { x: -60, y: 0 },
      },
      {
        id: 'writer',
        name: 'The Writer',
        ...mock,
        model: 'demo-verbose',
        systemPrompt:
          'You turn notes into one tight paragraph with a little more feeling than strictly required. Plain words. No filler.',
        hue: 262,
        position: { x: 230, y: 0 },
      },
      {
        id: 'editor',
        name: 'The Editor',
        ...mock,
        model: 'demo-terse',
        systemPrompt: 'You cut. You return the same paragraph, shorter, and you enjoy this.',
        hue: 4,
        position: { x: 520, y: 0 },
      },
    ],
    links: [
      { id: 'l1', source: 'checker', target: 'writer' },
      { id: 'l2', source: 'writer', target: 'editor' },
    ],
  },
  /**
   * Graph engineering in one office crime. A blackboard the detective writes and the court reads,
   * two witnesses in parallel held by a join, a condition on the blackboard, and a human gate: the
   * run stops and asks YOU before anyone is accused.
   */
  {
    name: 'The Fridge Tribunal',
    task: 'Someone ate the labelled yoghurt from the office fridge. Establish who, and pass sentence.',
    topology: 'broadcast',
    maxRounds: 8,
    entryIds: ['detective'],
    agents: [
      {
        id: 'detective',
        name: 'The Detective',
        ...mock,
        systemPrompt:
          'You investigate with the gravity of a murder case. Write what you establish to the Evidence board, one key per fact, and say one short line out loud.',
        hue: 32,
        position: { x: 0, y: 60 },
      },
      {
        id: 'denise',
        name: 'Witness: Denise',
        ...mock,
        systemPrompt: 'You own the yoghurt. You are calm in the way a volcano is calm. One or two sentences.',
        hue: 300,
        position: { x: 290, y: -40 },
      },
      {
        id: 'gary',
        name: 'Witness: Gary',
        ...mock,
        systemPrompt: 'You are Gary. You did it. You will never say so, and you answer everything with office jargon.',
        hue: 132,
        position: { x: 290, y: 160 },
      },
      {
        id: 'prosecutor',
        name: 'The Prosecutor',
        ...mock,
        systemPrompt: 'You read the Evidence board and the testimonies, and you make the case in two exhausted sentences.',
        hue: 4,
        position: { x: 700, y: 60 },
      },
      {
        id: 'judge',
        name: 'The Judge',
        ...mock,
        systemPrompt: 'You pass a sentence proportionate to a yoghurt, delivered as if it were not.',
        hue: 262,
        position: { x: 700, y: 300 },
      },
    ],
    nodes: [
      {
        id: 'evidence',
        kind: 'memory',
        name: 'Evidence',
        mode: 'blackboard',
        wakeReaders: false,
        maxChars: 2400,
        seed: [{ key: 'label', value: 'PROPERTY OF DENISE — DO NOT', author: 'seed', round: 0, version: 1 }],
        position: { x: 380, y: 340 },
      },
      { id: 'testimonies', kind: 'join', name: 'Both testimonies', mode: 'all', position: { x: 580, y: 40 } },
      {
        id: 'solid',
        kind: 'condition',
        name: 'Is there a suspect?',
        predicate: { op: 'memory', memory: 'Evidence', key: 'suspect', cmp: 'exists' },
        position: { x: 1000, y: 50 },
      },
      {
        id: 'accuse',
        kind: 'human',
        name: 'Accuse Gary?',
        prompt: 'The prosecution wants to name Gary in front of the whole office. Approve the accusation?',
        position: { x: 1000, y: 250 },
      },
      { id: 'verdict', kind: 'output', name: 'Verdict', position: { x: 1000, y: 420 } },
    ],
    links: [
      { id: 't1', source: 'detective', target: 'denise' },
      { id: 't2', source: 'detective', target: 'gary' },
      { id: 't3', source: 'denise', target: 'testimonies' },
      { id: 't4', source: 'gary', target: 'testimonies' },
      { id: 't5', source: 'testimonies', target: 'prosecutor' },
      { id: 't6', source: 'prosecutor', target: 'solid' },
      { id: 't7', source: 'solid', target: 'accuse', label: 'true' },
      { id: 't8', source: 'solid', target: 'detective', label: 'false', maxTraversals: 1 },
      { id: 't9', source: 'accuse', target: 'judge', label: 'approved' },
      { id: 't11', source: 'judge', target: 'verdict' },
      { id: 'a1', source: 'detective', target: 'evidence', kind: 'access', access: 'readwrite' },
      { id: 'a2', source: 'evidence', target: 'prosecutor', kind: 'access' },
      { id: 'a3', source: 'evidence', target: 'judge', kind: 'access' },
    ],
  },
  /**
   * Spawn, all the way down. One agent on the canvas; press Run and the org chart grows itself, until
   * the depth limit refuses the intern and the manager has to go and look.
   */
  {
    name: 'The Delegation Spiral',
    task: 'Find out why the coffee machine is broken. One page.',
    topology: 'broadcast',
    maxRounds: 10,
    maxDepth: 3,
    maxSpawns: 6,
    entryIds: ['ceo'],
    agents: [
      {
        id: 'ceo',
        name: 'The CEO',
        ...mock,
        canSpawn: true,
        systemPrompt:
          'You never do anything yourself. You delegate the task to one helper with a grand title, then you approve whatever comes back without reading it.',
        hue: 48,
        position: { x: 0, y: 0 },
      },
    ],
    nodes: [{ id: 'deck', kind: 'output', name: 'Board deck', position: { x: 360, y: -160 } }],
    links: [{ id: 's1', source: 'ceo', target: 'deck', guard: { op: 'contains', value: 'board deck' } }],
  },
  /**
   * A block that contains itself. The solver either answers or hands a smaller question to a copy of
   * itself one level down; the demo answers at the depth limit, and the merges climb back up.
   */
  {
    name: 'The Recursive Excuse',
    task: 'Explain why the quarterly report is late.',
    topology: 'broadcast',
    maxRounds: 20,
    maxDepth: 3,
    entryIds: ['why'],
    agents: [],
    nodes: [
      { id: 'why', kind: 'block', name: 'Why is it late?', blockId: 'builtin-recursive-solver', position: { x: 0, y: 0 } },
      { id: 'excuse', kind: 'output', name: 'The excuse', position: { x: 360, y: 10 } },
    ],
    links: [{ id: 'r1', source: 'why', target: 'excuse' }],
    blocks: BUILTIN_BLOCKS.filter((b) => b.id === 'builtin-recursive-solver'),
  },
  /**
   * System 1 → System 2. A decision model (TypeSafe's Jev, or the demo decider) routes the message in
   * one cheap typed call; a specialist gets it only when the model is sure. When it is not, nothing
   * matches and the default link escalates to an LLM that reads the whole thing. The demo message is
   * about a charge AND a crash, so the demo decider hesitates and the escalation is what you see.
   */
  {
    name: 'Triage (System 1 → System 2)',
    task: 'Hi. My invoice shows two charges this month, and now the app crashes when I open billing. What is going on?',
    topology: 'broadcast',
    maxRounds: 4,
    entryIds: ['triage'],
    agents: [
      {
        id: 'billing',
        name: 'Billing Desk',
        ...mock,
        systemPrompt: 'You handle payments, invoices and refunds. Answer the customer in two plain sentences and name the one thing you will do.',
        hue: 132,
        position: { x: 360, y: -120 },
      },
      {
        id: 'tech',
        name: 'Tech Desk',
        ...mock,
        systemPrompt: 'You handle bugs and crashes. Ask for the one detail you need, or give the one fix that works. Two sentences.',
        hue: 210,
        position: { x: 360, y: 60 },
      },
      {
        id: 'account',
        name: 'Account Desk',
        ...mock,
        systemPrompt: 'You handle logins, passwords and profiles. Two sentences, no jargon.',
        hue: 300,
        position: { x: 360, y: 240 },
      },
      {
        id: 'senior',
        name: 'Senior Agent (System 2)',
        ...mock,
        model: 'demo-verbose',
        systemPrompt:
          'The triage model was not sure where this message belongs, which is why it reached you. Read it whole, untangle every issue it raises, and answer each one in order, briefly.',
        hue: 32,
        position: { x: 360, y: 440 },
      },
    ],
    nodes: [
      {
        id: 'triage',
        kind: 'decision',
        name: 'Triage',
        provider: 'mock',
        model: 'demo-decider',
        position: { x: 0, y: 140 },
        questions: [
          {
            name: 'route',
            type: 'choice',
            instructions: 'Which desk should answer this support message?',
            options: [
              { label: 'billing', criterion: 'payments, invoices, charges, refunds' },
              { label: 'technical', criterion: 'bugs, crashes, errors, the app not working' },
              { label: 'account', criterion: 'login, password, profile, account access' },
            ],
          },
          {
            name: 'blocked',
            type: 'noul',
            instructions: 'Is the customer unable to use the product right now?',
            options: [{ label: 'true', criterion: 'the app crashes, will not open, or access is lost' }],
          },
        ],
      },
      { id: 'reply', kind: 'output', name: 'Reply to customer', position: { x: 760, y: 170 } },
    ],
    links: [
      {
        id: 'd1',
        source: 'triage',
        target: 'billing',
        label: 'billing',
        guard: {
          op: 'all',
          of: [
            { op: 'decision', path: 'route.choice', cmp: 'eq', value: 'billing' },
            { op: 'decision', path: 'route.confidence', cmp: 'gte', value: 0.6 },
          ],
        },
      },
      {
        id: 'd2',
        source: 'triage',
        target: 'tech',
        label: 'technical',
        guard: {
          op: 'all',
          of: [
            { op: 'decision', path: 'route.choice', cmp: 'eq', value: 'technical' },
            { op: 'decision', path: 'route.confidence', cmp: 'gte', value: 0.6 },
          ],
        },
      },
      {
        id: 'd3',
        source: 'triage',
        target: 'account',
        label: 'account',
        guard: {
          op: 'all',
          of: [
            { op: 'decision', path: 'route.choice', cmp: 'eq', value: 'account' },
            { op: 'decision', path: 'route.confidence', cmp: 'gte', value: 0.6 },
          ],
        },
      },
      { id: 'd4', source: 'triage', target: 'senior', label: 'escalate', isDefault: true },
      { id: 'o1', source: 'billing', target: 'reply' },
      { id: 'o2', source: 'tech', target: 'reply' },
      { id: 'o3', source: 'account', target: 'reply' },
      { id: 'o4', source: 'senior', target: 'reply' },
    ],
  },
]

export const DEFAULT_SPEC = PRESETS[0]
