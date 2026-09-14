import type { SwarmSpec } from './types'

const mock = { provider: 'mock' as const, model: 'demo-fast', temperature: 0.7 }

/** Starter swarms. Each one is a different shape, because shape is the point of the app. */
export const PRESETS: SwarmSpec[] = [
  {
    name: 'Debate trio',
    task: 'Should a small team build its own agent framework, or adopt an existing one?',
    topology: 'broadcast',
    maxRounds: 4,
    entryIds: ['a1'],
    agents: [
      {
        id: 'a1',
        name: 'Proposer',
        ...mock,
        systemPrompt: 'You argue for the boldest defensible option. Commit to a position in your first sentence.',
        hue: 262,
        position: { x: 0, y: 0 },
      },
      {
        id: 'a2',
        name: 'Skeptic',
        ...mock,
        model: 'demo-terse',
        systemPrompt: 'You attack the weakest assumption in what you are given. One objection, sharply made.',
        hue: 4,
        position: { x: 300, y: -130 },
      },
      {
        id: 'a3',
        name: 'Synthesist',
        ...mock,
        model: 'demo-verbose',
        systemPrompt: 'You keep what survived the argument and drop the rest. No new claims of your own.',
        hue: 168,
        position: { x: 300, y: 130 },
      },
    ],
    links: [
      { id: 'l1', source: 'a1', target: 'a2' },
      { id: 'l2', source: 'a2', target: 'a3' },
      { id: 'l3', source: 'a3', target: 'a1' },
    ],
  },
  {
    name: 'Manager and specialists',
    task: 'Plan the launch of a small open-source tool: what ships, in what order, and what we skip.',
    topology: 'manager',
    maxRounds: 4,
    entryIds: ['m'],
    agents: [
      {
        id: 'm',
        name: 'Manager',
        ...mock,
        systemPrompt: 'You split the task, then decide. Never do a specialist’s work yourself.',
        hue: 262,
        position: { x: 0, y: 0 },
      },
      {
        id: 'w1',
        name: 'Engineer',
        ...mock,
        systemPrompt: 'You answer only on feasibility and effort. Give a rough size, not a plan.',
        hue: 210,
        position: { x: 320, y: -170 },
      },
      {
        id: 'w2',
        name: 'Designer',
        ...mock,
        systemPrompt: 'You answer only on what the user sees and in which order they see it.',
        hue: 32,
        position: { x: 340, y: 10 },
      },
      {
        id: 'w3',
        name: 'Skeptic',
        ...mock,
        model: 'demo-terse',
        systemPrompt: 'You name the one thing most likely to make this fail, and nothing else.',
        hue: 4,
        position: { x: 320, y: 190 },
      },
    ],
    links: [
      { id: 'l1', source: 'm', target: 'w1' },
      { id: 'l2', source: 'm', target: 'w2' },
      { id: 'l3', source: 'm', target: 'w3' },
    ],
  },
  {
    name: 'Pipeline',
    task: 'Turn this rough note into something publishable: "agents are just loops with tools, the hard part is the graph".',
    topology: 'broadcast',
    maxRounds: 4,
    entryIds: ['p1'],
    agents: [
      {
        id: 'p1',
        name: 'Researcher',
        ...mock,
        systemPrompt: 'You list the facts and open questions the note depends on. No prose.',
        hue: 168,
        position: { x: -60, y: 0 },
      },
      {
        id: 'p2',
        name: 'Writer',
        ...mock,
        model: 'demo-verbose',
        systemPrompt: 'You turn notes into one tight paragraph. Plain words, no filler.',
        hue: 262,
        position: { x: 220, y: 0 },
      },
      {
        id: 'p3',
        name: 'Editor',
        ...mock,
        model: 'demo-terse',
        systemPrompt: 'You cut. Return the same paragraph, shorter and sharper.',
        hue: 32,
        position: { x: 500, y: 0 },
      },
    ],
    links: [
      { id: 'l1', source: 'p1', target: 'p2' },
      { id: 'l2', source: 'p2', target: 'p3' },
    ],
  },
]

export const DEFAULT_SPEC = PRESETS[0]
