/**
 * Domain model for a swarm: who the agents are, what else sits on the graph, and who may reach whom.
 *
 * Version 2 (see docs/graph-engineering.md). Agents stay in their own array because most of the UI is
 * built around them; every other kind of node lives in `nodes`, discriminated by `kind`.
 */

export type ProviderId = 'mock' | 'openai' | 'anthropic' | 'openrouter' | 'custom'

/**
 * Where a Decision node sends its typed questions. Not a chat provider: these models answer
 * `choice` / `noul` / `score` questions about a state and never write text (docs/graph-engineering.md §Decision).
 */
export type DecisionProviderId = 'mock' | 'openrouter' | 'typesafe' | 'laya'

/** Every key slot this browser keeps. TypeSafe's and Laya's are the slots no chat provider uses. */
export type KeyId = ProviderId | 'typesafe' | 'laya'

/** How a speaking turn is handed to the agents an agent points at. */
export type Topology =
  /** Every outgoing link carries the message. The swarm widens each round. */
  | 'broadcast'
  /** One outgoing link per turn, rotating. The swarm stays narrow and walks. */
  | 'round-robin'
  /** Workers answer, then the entry agent speaks again with every reply in hand. */
  | 'manager'

/**
 * Per-agent override of the swarm topology.
 * `choose` = the agent names the branch itself, with `<route to="label"/>`.
 */
export type Dispatch = 'inherit' | 'all' | 'rotate' | 'choose'

export interface Agent {
  id: string
  name: string
  provider: ProviderId
  model: string
  systemPrompt: string
  temperature: number
  /**
   * Hard ceiling on this agent's answer.
   *
   * "One short paragraph" in the prompt is a suggestion a model can ignore, and it did: a run on
   * 14/09 produced 457, then 1077, then 1554 output tokens with bullet lists and markdown tables.
   * Optional so older stored specs keep working; `DEFAULT_MAX_TOKENS` applies when absent.
   */
  maxTokens?: number
  /** Hue (0-360) used everywhere this agent shows up: node, edge, transcript. */
  hue: number
  position: { x: number; y: number }
  /** Absent = `inherit`: the swarm topology decides. */
  dispatch?: Dispatch
  /** May create sub-agents during a run with `<spawn>`. */
  canSpawn?: boolean
}

export type Comparison = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'contains'
export type CountComparison = 'eq' | 'gt' | 'gte' | 'lt' | 'lte'

/**
 * A condition, as DATA. A pasted swarm comes from someone else, so nothing here is ever evaluated as
 * code: `engine/predicates.ts` interprets it. Anything malformed evaluates to false.
 */
export type Predicate =
  | { op: 'always' }
  | { op: 'contains'; value: string; caseSensitive?: boolean }
  | { op: 'matches'; pattern: string; flags?: string }
  | { op: 'json'; path: string; cmp: Comparison; value?: string | number | boolean }
  | { op: 'memory'; memory: string; key: string; cmp: Comparison; value?: string | number | boolean }
  /** Reads the typed answers a Decision node attached to the message: `route.choice`, `route.confidence`, `urgent.noul`. */
  | { op: 'decision'; path: string; cmp: Comparison; value?: string | number | boolean }
  | { op: 'visits'; cmp: CountComparison; value: number }
  | { op: 'round'; cmp: CountComparison; value: number }
  | { op: 'all'; of: Predicate[] }
  | { op: 'any'; of: Predicate[] }
  | { op: 'not'; of: Predicate }

export type LinkKind = 'message' | 'access'
export type Access = 'read' | 'write' | 'readwrite'

export interface Link {
  id: string
  source: string
  target: string
  /** Absent = `message`. An `access` link connects an agent and a memory. */
  kind?: LinkKind
  /** Branch name. Shown on the edge, named by `<route to>`, and `true`/`false` out of a condition. */
  label?: string
  /** Absent = always taken (when dispatch keeps it). */
  guard?: Predicate
  /** Taken when a `choose` agent names no branch that exists. */
  isDefault?: boolean
  /** Loop budget: how many times this link may carry a message in one run. */
  maxTraversals?: number
  /** For `access` links. Absent = `read` when the memory is the source, `write` when it is the target. */
  access?: Access
}

interface NodeBase {
  id: string
  name: string
  position: { x: number; y: number }
}

/** Zero tokens: forwards to its `true` or its `false` links. */
export interface ConditionNode extends NodeBase {
  kind: 'condition'
  predicate: Predicate
}

/** A barrier: holds arrivals until every activated branch has delivered (`all`), or the first (`any`). */
export interface JoinNode extends NodeBase {
  kind: 'join'
  mode: 'all' | 'any'
  /** Releases what it holds after this many rounds of waiting. */
  timeoutRounds?: number
}

/** Records what reaches it as a result of this graph. */
export interface OutputNode extends NodeBase {
  kind: 'output'
}

/** Stops the flow until a human approves (or rejects, or edits) what reached it. */
export interface HumanNode extends NodeBase {
  kind: 'human'
  prompt: string
}

export type MemoryMode = 'blackboard' | 'log' | 'document'

export interface MemoryEntry {
  key: string
  value: string
  /** Agent name, or `seed` for entries loaded before the run. */
  author: string
  round: number
  version: number
}

/** Shared knowledge. Who reads and who writes is drawn as `access` links. */
export interface MemoryNode extends NodeBase {
  kind: 'memory'
  mode: MemoryMode
  /** A write activates every reader next round: the memory becomes a publish-subscribe bus. */
  wakeReaders: boolean
  /** Loaded before the run: reference documents, rules, a glossary. */
  seed: MemoryEntry[]
  /** How much of it one reader receives per turn. */
  maxChars: number
}

/** A saved graph used as a single node. */
export interface BlockNode extends NodeBase {
  kind: 'block'
  blockId: string
  /** Applied to every agent inside the block. */
  overrides?: { provider?: ProviderId; model?: string }
}

/**
 * A typed question for a decision model.
 *  · `choice`: one label out of `options` (label → what it means). Answer: choice, confidence, probabilities.
 *  · `noul`: yes or no. `options` may describe `true` and `false`. Answer: the probability of yes.
 *  · `score`: a level on an ordered rubric, `levels[0]` lowest. Answer: expected score, confidence, probabilities.
 */
export type DecisionQuestionType = 'choice' | 'noul' | 'score'

export interface DecisionQuestion {
  /** The key the answer comes back under, and what a guard names: `route` in `route.choice`. */
  name: string
  type: DecisionQuestionType
  instructions: string
  /** `choice`: label → criterion. `noul`: optional `true` / `false` descriptions. Unused by `score`. */
  options?: Array<{ label: string; criterion: string }>
  /** `score` only: at least two level descriptions, lowest first. */
  levels?: string[]
}

/** One typed answer, as the engine hands it to guards. Numbers are 0..1 except a score. */
export type DecisionAnswer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'noul'; noul: number; yes: boolean }
  | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number>; level: string }

export type DecisionAnswers = Record<string, DecisionAnswer>

/**
 * Zero generated text: asks a decision model typed questions about what reached it, and publishes the
 * typed answers so link guards and conditions can route on them (the System 1 half of System 1 / System 2).
 */
export interface DecisionNode extends NodeBase {
  kind: 'decision'
  provider: DecisionProviderId
  model: string
  questions: DecisionQuestion[]
}

export type FlowNode = ConditionNode | JoinNode | OutputNode | HumanNode | MemoryNode | BlockNode | DecisionNode
export type FlowNodeKind = FlowNode['kind']

export interface Graph {
  agents: Agent[]
  /** Optional so a version-1 spec is still a valid graph; read it through `nodesOf`. */
  nodes?: FlowNode[]
  links: Link[]
  /** Agents (or blocks) that receive the task. Empty means "every node with no incoming message link". */
  entryIds: string[]
}

export interface BlockDef {
  id: string
  name: string
  /** Shown in the library, and to agents allowed to spawn it. */
  description: string
  graph: Graph
}

export interface SwarmSpec extends Graph {
  name: string
  task: string
  /** The default dispatch for agents that `inherit`. */
  topology: Topology
  /** Global step budget. Nested runs are charged to it too. */
  maxRounds: number
  /** Nesting limit for blocks and spawns. Default `DEFAULT_MAX_DEPTH`. */
  maxDepth?: number
  /** Spawns allowed in one run, all depths together. Default `DEFAULT_MAX_SPAWNS`. */
  maxSpawns?: number
  /** Block definitions travel with the swarm that uses them. */
  blocks?: BlockDef[]
}

export const DEFAULT_MAX_DEPTH = 3
export const DEFAULT_MAX_SPAWNS = 12
export const DEFAULT_MEMORY_CHARS = 2400

export type AgentStatus = 'idle' | 'queued' | 'thinking' | 'speaking' | 'done' | 'error' | 'waiting'

/** A chip in the transcript: something the message DID besides being read. */
export interface ActionChip {
  type: 'route' | 'write' | 'spawn' | 'refused'
  text: string
}

export interface TranscriptEntry {
  id: string
  round: number
  /** The speaker. For a human injection this is the RECIPIENT, and `kind` is `human`. */
  agentId: string
  /** `human` marks a message you typed; `system` a message the engine produced (a join, a refusal). */
  kind?: 'agent' | 'human' | 'system'
  /** Node ids this message was handed to. Empty for a leaf. */
  to: string[]
  text: string
  /** `stopped` keeps whatever had already streamed: a halted answer is not a failed one. */
  status: 'streaming' | 'complete' | 'error' | 'stopped'
  tokensIn: number
  tokensOut: number
  startedAt: number
  endedAt?: number
  /** Where it happened: block node ids from the top level down. Absent = top level. */
  path?: string[]
  /** Display name of the speaker, for nodes the spec does not know (spawned, or inside a block). */
  speaker?: string
  /** Hue of the speaker, for the same reason. */
  hue?: number
  actions?: ActionChip[]
  /** Set on a Decision node's entry: the typed answers, which the text only summarises. */
  decision?: DecisionAnswers
}

export type RunPhase = 'idle' | 'running' | 'paused' | 'done' | 'error' | 'stopped'
