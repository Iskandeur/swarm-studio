/**
 * Built-in blocks: saved graphs you can drop onto any swarm as a single node.
 *
 * Each one shows one pattern of graph engineering, and each one runs on the demo provider with no
 * key — its characters have lines in `DEMO_VOICES`. Ids start with `builtin-` so a block saved in
 * the browser can never shadow one of these by accident.
 */
import type { Agent, BlockDef } from './types'

function agent(id: string, name: string, systemPrompt: string, hue: number, x: number, y: number, extra: Partial<Agent> = {}): Agent {
  return { id, name, provider: 'mock', model: 'demo-fast', systemPrompt, temperature: 0.7, hue, position: { x, y }, ...extra }
}

export const BUILTIN_BLOCKS: BlockDef[] = [
  {
    id: 'builtin-critic-loop',
    name: 'Critic loop',
    description: 'A writer drafts, a critic scores it in JSON, and the draft goes back until it scores 7 or more. Two rewrites at most.',
    graph: {
      entryIds: ['writer'],
      agents: [
        agent('writer', 'Loop Writer', 'You write the draft the task asks for. When a critic note arrives, rewrite the whole draft to answer it.', 210, 0, 0),
        agent(
          'critic',
          'Loop Critic',
          'You score the draft from 0 to 10. Answer with a JSON block {"score": n, "note": "..."}. When the score is 7 or more, repeat the final draft in full after the JSON.',
          4,
          300,
          0,
        ),
      ],
      nodes: [
        { id: 'good', kind: 'condition', name: 'Score ≥ 7?', position: { x: 580, y: 10 }, predicate: { op: 'json', path: 'score', cmp: 'gte', value: 7 } },
        { id: 'out', kind: 'output', name: 'Final draft', position: { x: 820, y: 10 } },
      ],
      links: [
        { id: 'wc', source: 'writer', target: 'critic' },
        { id: 'cg', source: 'critic', target: 'good' },
        { id: 'go', source: 'good', target: 'out', label: 'true' },
        { id: 'gw', source: 'good', target: 'writer', label: 'false', maxTraversals: 2 },
      ],
    },
  },
  {
    id: 'builtin-debate',
    name: 'Debate',
    description: 'Pro and Con argue in parallel, a join waits for both, and a judge decides.',
    graph: {
      entryIds: ['pro', 'con'],
      agents: [
        agent('pro', 'Debate Pro', 'You argue FOR, in two sentences, as persuasively as honesty allows.', 132, 0, 0),
        agent('con', 'Debate Con', 'You argue AGAINST, in two sentences, as persuasively as honesty allows.', 4, 0, 180),
        agent('judge', 'Debate Judge', 'You read both sides and decide. One paragraph, and say which argument won.', 48, 520, 90),
      ],
      nodes: [
        { id: 'both', kind: 'join', name: 'Both sides', position: { x: 290, y: 100 }, mode: 'all' },
        { id: 'out', kind: 'output', name: 'Ruling', position: { x: 800, y: 100 } },
      ],
      links: [
        { id: 'pb', source: 'pro', target: 'both' },
        { id: 'cb', source: 'con', target: 'both' },
        { id: 'bj', source: 'both', target: 'judge' },
        { id: 'jo', source: 'judge', target: 'out' },
      ],
    },
  },
  {
    id: 'builtin-map-reduce',
    name: 'Map-reduce',
    description: 'A splitter spawns one helper per part, then hands everything to a reducer once every helper is back.',
    graph: {
      entryIds: ['splitter'],
      agents: [
        agent(
          'splitter',
          'Splitter',
          'Split the task into independent parts and spawn one helper per part. When every helper has answered, start your message with "MERGE:" and list their results.',
          262,
          0,
          0,
          { canSpawn: true },
        ),
        agent('reducer', 'Reducer', 'Combine the parts into one answer. Keep what agrees, flag what does not.', 168, 360, 0),
      ],
      nodes: [{ id: 'out', kind: 'output', name: 'Combined', position: { x: 660, y: 10 } }],
      links: [
        { id: 'sr', source: 'splitter', target: 'reducer', guard: { op: 'matches', pattern: '^\\s*MERGE:' } },
        { id: 'ro', source: 'reducer', target: 'out' },
      ],
    },
  },
  {
    id: 'builtin-recursive-solver',
    name: 'Recursive solver',
    description: 'Answers directly when the problem is small enough; otherwise hands it to a copy of itself, one level deeper, and merges what comes back.',
    graph: {
      entryIds: ['solver'],
      agents: [
        agent(
          'solver',
          'Recursive Solver',
          'Decide whether the problem is small enough to answer now. If it is, answer and end with <route to="direct"/>. If not, restate a smaller version of it and end with <route to="split"/>.',
          300,
          0,
          60,
          { dispatch: 'choose' },
        ),
        agent('merger', 'Merger', 'Put the smaller answer back into the context of the bigger problem.', 210, 560, 160),
      ],
      nodes: [
        { id: 'deeper', kind: 'block', name: 'One level deeper', position: { x: 300, y: 160 }, blockId: 'builtin-recursive-solver' },
        { id: 'out', kind: 'output', name: 'Answer', position: { x: 820, y: 60 } },
      ],
      links: [
        { id: 'sd', source: 'solver', target: 'out', label: 'direct' },
        { id: 'ss', source: 'solver', target: 'deeper', label: 'split', isDefault: true },
        { id: 'dm', source: 'deeper', target: 'merger' },
        { id: 'mo', source: 'merger', target: 'out' },
      ],
    },
  },
]
