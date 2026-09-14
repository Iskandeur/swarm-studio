import type { SwarmSpec } from './types'

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
]

export const DEFAULT_SPEC = PRESETS[0]
