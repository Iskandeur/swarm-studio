/**
 * The swarm engine.
 *
 * One round = every currently-active node speaks (in parallel), then each message is handed along
 * the links its author may use. Whoever received something is active next round. The run ends when
 * nobody is left to speak or the step budget (`maxRounds`) is spent. That is a superstep machine —
 * the Pregel model LangGraph also runs on — and version 2 widens it rather than replacing it:
 *
 *  · **what a node can be**: besides agents, zero-token Condition / Join / Output nodes, Human gates,
 *    Memory nodes, and Blocks (a saved graph run as one node, recursively);
 *  · **what a link can require**: a guard predicate, a label an agent can choose, a loop budget;
 *  · **what agents can share**: memories they read in their prompt and write with a tag;
 *  · **what the graph can become**: agents allowed to spawn helpers that appear live.
 *
 * Design and reasons: docs/graph-engineering.md.
 *
 * Everything the UI animates comes out of the callbacks below, so the visualisation is never
 * guessing: it draws exactly what the engine did.
 */
import type {
  ActionChip,
  Agent,
  AgentStatus,
  BlockDef,
  BlockNode,
  DecisionAnswers,
  DecisionNode,
  FlowNode,
  Graph,
  HumanNode,
  JoinNode,
  Link,
  MemoryEntry,
  MemoryNode,
  SwarmSpec,
  TranscriptEntry,
} from '../types.ts'
import { DEFAULT_MAX_DEPTH, DEFAULT_MAX_SPAWNS } from '../types.ts'
import { callProvider, estimateTokens, resolveEndpoint, type ChatMessage, type Endpoints } from './providers.ts'
import {
  createGraphState,
  createRunSession,
  type Delivery,
  type GateDecision,
  type GraphState,
  type Injection,
  type PendingGate,
  type RunSession,
} from './session.ts'
import { parseActions, type Action, type SpawnAction, type WriteAction } from './actions.ts'
import { evaluate } from './predicates.ts'
import {
  callDecision,
  decisionKey,
  resolveDecisionEndpoint,
  summarizeDecision,
  type DecisionEndpoints,
} from './decisions.ts'
import { applyWrite, createMemoryState, readValue, renderMemory, type MemoryState } from './memory.ts'
import {
  canWrite,
  findBlock,
  findFlowNode,
  messageLinks,
  nodesOf,
  normalizeSpec,
  readableMemories,
  resolveEntryIds as resolveGraphEntryIds,
  TURN_KINDS,
  writableMemories,
} from './graph.ts'

/**
 * Default ceiling on one agent's answer. A swarm is read as a conversation, so a turn that runs to
 * 1 500 tokens of bullet lists breaks the form even when the content is fine.
 */
export const DEFAULT_MAX_TOKENS = 220

/**
 * How many zero-token nodes one message may cross in a row. Only a cycle made entirely of such
 * nodes can reach it — a real graph has an agent every few hops — and without it that cycle would
 * spin inside one round for ever.
 */
export const MAX_DETERMINISTIC_HOPS = 64

/** Pause after a round's deliveries, so the packets can be seen travelling. Shorter inside a block. */
const TRANSIT_MS = 650
const NESTED_TRANSIT_MS = 120

export interface OutputEvent {
  path: string[]
  nodeId: string
  text: string
}

export interface MemoryWriteEvent {
  path: string[]
  memoryId: string
  entry: MemoryEntry
}

export interface SpawnEvent {
  path: string[]
  parentId: string
  node: Agent | BlockNode
  link: Link
}

export interface BranchEvent {
  path: string[]
  nodeId: string
  taken: string[]
  skipped: string[]
}

export interface RunnerCallbacks {
  onPhase: (phase: 'running' | 'done' | 'error' | 'stopped' | 'paused', detail?: string) => void
  /** Top-level rounds only: a block's inner rounds are its own business. */
  onRound: (round: number) => void
  /** `path` is absent at the top level, and names the block nodes above otherwise. */
  onAgentStatus: (agentId: string, status: AgentStatus, path?: string[]) => void
  onMessageStart: (entry: TranscriptEntry) => void
  onMessageDelta: (entryId: string, delta: string) => void
  onMessageEnd: (entryId: string, patch: Partial<TranscriptEntry>) => void
  /** Wipe what has been streamed so far: the provider is fetching the answer again. */
  onMessageReset?: (entryId: string) => void
  /**
   * Messages in flight, for the animation.
   *
   * `reversed` matters: in manager topology a worker's reply travels UP its own downward link, so
   * the packet has to run from target to source. Without the flag, the delegation round and the
   * collection round were pixel-identical and the animation contradicted the transcript.
   */
  onTransit: (packets: TransitPacket[]) => void
  /** Something worth telling the user that did not stop the run. */
  onNotice?: (message: string) => void
  /** A human message entering the swarm, so the transcript shows it in its place. */
  onInjection?: (injection: Injection & { round: number }) => void
  onOutput?: (event: OutputEvent) => void
  onMemoryWrite?: (event: MemoryWriteEvent) => void
  onMemoryRead?: (event: { path: string[]; memoryId: string; agentId: string }) => void
  onSpawn?: (event: SpawnEvent) => void
  /** A message reached a human gate: the flow behind it waits for `session.decideGate`. */
  onHumanGate?: (gate: PendingGate) => void
  onGateClosed?: (event: { id: string; decision: GateDecision | null }) => void
  /** A decision about which links a message took, and which it did not. */
  onBranch?: (event: BranchEvent) => void
  /** A Decision node answered: its typed answers, for the node's bars on the canvas. */
  onDecision?: (event: { path: string[]; nodeId: string; answers: DecisionAnswers }) => void
  /** A zero-token node did its work (for a flash on the canvas). */
  onNodeFired?: (event: { path: string[]; nodeId: string; kind: FlowNode['kind'] }) => void
}

export type ApiKeys = Partial<Record<string, string>>

/** A message on a link, and which way along it. */
export interface TransitPacket {
  id: string
  /** true when the message runs against the link's own direction (a manager-mode or spawn reply). */
  reversed: boolean
  /** Absent at the top level. A link inside a block is not on the canvas you are looking at. */
  path?: string[]
}

/** Agents (or blocks) that receive the task. */
export function resolveEntryIds(spec: Graph): string[] {
  return resolveGraphEntryIds(spec)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface RunOptions {
  endpoints?: Endpoints
  /** Endpoint overrides for Decision nodes (a relay for TypeSafe's own API, say). */
  decisionEndpoints?: DecisionEndpoints
  /** Reuse a session to keep memory and cursors across a continued run. */
  session?: RunSession
  /** Agents that speak first, overriding the spec's entry points (used to continue from one agent). */
  startFrom?: string[]
  /** Block definitions available besides the swarm's own (built-ins, this browser's library). */
  library?: BlockDef[]
}

interface Packet {
  /** Absent for a delivery that crosses no drawn link (the task entering a condition, say). */
  link?: Link
  target: string
  reversed?: boolean
  items: Delivery[]
  /** Zero-token nodes crossed in a row. */
  hops: number
  /** Their names, for the error message when a zero-token cycle is caught. */
  trail: string[]
}

/** A completed turn: who spoke, and what their words and tags were. */
interface Turn {
  id: string
  name: string
  entryId: string
  prose: string
  actions: Action[]
  /** What travels on the links when it is not the prose itself (a Decision node passes the state on). */
  carry?: string
  /** Typed answers of a Decision node, attached to what it passes on. */
  decision?: DecisionAnswers
}

interface Level {
  graph: Graph
  /** Block node ids from the top level down. Empty at the top. */
  path: string[]
  depth: number
  task: string
  /** Name of the block node this level runs for. Absent at the top. */
  blockName?: string
  state: GraphState
  round: number
  outputs: string[]
  /** Last thing each agent said, for a block with no Output node. */
  lastText: Map<string, string>
  spawnParent: Map<string, { parentId: string; link: Link }>
  spawnDepth: Map<string, number>
  /** Warnings already given, so a loop does not repeat the same notice every round. */
  warned: Set<string>
}

interface Ctx {
  spec: SwarmSpec
  keys: ApiKeys
  endpoints: Endpoints
  decisionEndpoints: DecisionEndpoints
  cb: RunnerCallbacks
  signal: AbortSignal
  inner: AbortController
  failed: { error: Error | null }
  session: RunSession
  steps: { used: number }
  spawns: { used: number }
  counter: { value: number }
  library: BlockDef[]
  maxDepth: number
  maxSpawns: number
  /** Agents told "queued" that have not reached a terminal status yet, with their path key. */
  queued: Map<string, { id: string; path: string[] }>
}

export async function runSwarm(
  rawSpec: SwarmSpec,
  keys: ApiKeys,
  cb: RunnerCallbacks,
  signal: AbortSignal,
  options: RunOptions = {},
): Promise<void> {
  const spec = normalizeSpec(rawSpec)
  const session = options.session ?? createRunSession()
  const entryIds = resolveEntryIds(spec)
  const hasSpeaker = spec.agents.length > 0 || nodesOf(spec).some((n) => TURN_KINDS.has(n.kind))
  if (!hasSpeaker || entryIds.length === 0) {
    cb.onPhase('error', 'Add at least one agent before running.')
    return
  }

  /**
   * An inner signal, so that one agent's failure stops its siblings.
   *
   * Agents in a round run concurrently. Without this, a provider error in one of them set the run
   * to "error" while the others kept streaming text into the transcript — a failed run that goes on
   * talking, which is worse than either outcome on its own.
   */
  const inner = new AbortController()
  const stopEverything = () => inner.abort()
  if (signal.aborted) inner.abort()
  else signal.addEventListener('abort', stopEverything, { once: true })

  const ctx: Ctx = {
    spec,
    keys,
    endpoints: options.endpoints ?? {},
    decisionEndpoints: options.decisionEndpoints ?? {},
    cb,
    signal,
    inner,
    /**
     * Set when a turn fails for a real reason, to tell "stopped by the user" from "broke".
     * A holder object rather than a bare `let`: it is written inside a closure, and the compiler
     * narrows a closure-assigned local to `never` at the read site.
     */
    failed: { error: null },
    session,
    steps: { used: 0 },
    spawns: { used: 0 },
    counter: { value: 0 },
    library: options.library ?? [],
    maxDepth: spec.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxSpawns: spec.maxSpawns ?? DEFAULT_MAX_SPAWNS,
    queued: new Map(),
  }

  const level = createLevel(structuredClone(graphOf(spec)), [], 0, spec.task, session.graph)

  const inbox = new Map<string, Delivery[]>()
  const known = new Set([...level.graph.agents.map((a) => a.id), ...nodesOf(level.graph).map((n) => n.id)])
  const start = (options.startFrom ?? []).filter((id) => known.has(id))
  const initial: Packet[] = []
  if (options.startFrom) {
    // A continued run does not repeat the task: the agents already have it in their memory.
    for (const id of start.length > 0 ? start : entryIds) inbox.set(id, [])
  } else {
    for (const id of entryIds) initial.push(packetTo(id, [{ kind: 'task', text: spec.task }]))
  }

  cb.onPhase('running')

  try {
    if (initial.length > 0) await resolve(ctx, level, initial, inbox, 0, { animate: false })
    await loop(ctx, level, inbox)
    if (ctx.failed.error) cb.onPhase('error', ctx.failed.error.message)
    else cb.onPhase(signal.aborted ? 'stopped' : 'done')
  } catch (err) {
    // `failed.error` wins over the abort flag: the inner signal is aborted BY the failure, so reading the
    // signal alone would report every breakage as "the user stopped it".
    if (ctx.failed.error) cb.onPhase('error', ctx.failed.error.message)
    else if (signal.aborted) cb.onPhase('stopped')
    else cb.onPhase('error', err instanceof Error ? err.message : String(err))
  } finally {
    signal.removeEventListener('abort', stopEverything)
    // Nodes marked `queued` that never got to speak would keep that badge for ever — stopping
    // during the wake-up stagger left the graph claiming agents were still waiting their turn.
    for (const { id, path } of ctx.queued.values()) cb.onAgentStatus(id, 'idle', pathArg(path))
  }
}

function graphOf(spec: SwarmSpec): Graph {
  return { agents: spec.agents, nodes: nodesOf(spec), links: spec.links, entryIds: spec.entryIds }
}

function createLevel(graph: Graph, path: string[], depth: number, task: string, state: GraphState, blockName?: string): Level {
  // A memory already in the state (a continued run) keeps its entries, but takes the node's current
  // settings: the user may have changed the mode or the budget between two runs.
  for (const node of nodesOf(graph)) {
    if (node.kind !== 'memory') continue
    const existing = state.memories.get(node.id)
    if (existing) existing.node = node
    else state.memories.set(node.id, createMemoryState(node))
  }
  return {
    graph,
    path,
    depth,
    task,
    ...(blockName ? { blockName } : {}),
    state,
    round: 0,
    outputs: [],
    lastText: new Map(),
    spawnParent: new Map(),
    spawnDepth: new Map(),
    warned: new Set(),
  }
}

/** Callbacks take `path` only when it says something: top-level calls look exactly as before. */
function pathArg(path: string[]): string[] | undefined {
  return path.length > 0 ? path : undefined
}

function packetTo(target: string, items: Delivery[], link?: Link, reversed = false): Packet {
  return { target, items, link, reversed, hops: 0, trail: [] }
}

function notice(ctx: Ctx, level: Level, key: string, message: string) {
  if (level.warned.has(key)) return
  level.warned.add(key)
  ctx.cb.onNotice?.(message)
}

function agentOf(level: Level, id: string): Agent | undefined {
  return level.graph.agents.find((a) => a.id === id)
}

function isSpeaker(level: Level, id: string): boolean {
  if (agentOf(level, id)) return true
  const kind = findFlowNode(level.graph, id)?.kind
  return kind !== undefined && TURN_KINDS.has(kind)
}

function textOf(items: Delivery[]): string {
  return items.map((d) => d.text).join('\n\n')
}

/** Every Decision answer the items carry, merged by question name; the later one wins a clash. */
function decisionOf(items: Delivery[]): DecisionAnswers | undefined {
  const carried = items.filter((d) => d.decision)
  if (carried.length === 0) return undefined
  return Object.assign({}, ...carried.map((d) => d.decision))
}

function toChatMessage(d: Delivery): ChatMessage {
  switch (d.kind) {
    case 'task':
      return { role: 'user', content: d.text }
    case 'human':
      // A human injection IS addressed to the agent, so it says so — the only message that is.
      return { role: 'user', content: `[the human running this swarm speaks to you] ${d.text}` }
    case 'system':
      return { role: 'user', content: `[system] ${d.text}` }
    case 'bus':
      return { role: 'user', content: d.text }
    case 'delegation':
      return { role: 'user', content: `[${d.author ?? 'another agent'} delegates this subtask to you] ${d.text}` }
    case 'part':
      // Marked as a transcript line, not as someone talking TO the recipient. A chat API has no
      // third role, so the framing has to do the work the role cannot.
      return { role: 'user', content: `[transcript] ${d.author ?? 'someone'} said:\n${d.text}` }
  }
}

function memoryByName(level: Level, name: string): MemoryState | undefined {
  const wanted = name.trim().toLowerCase()
  for (const state of level.state.memories.values()) {
    if (state.node.name.trim().toLowerCase() === wanted && findFlowNode(level.graph, state.node.id)) return state
  }
  return undefined
}

function readMemoryFor(level: Level) {
  return (memory: string, key: string) => {
    const state = memoryByName(level, memory)
    return state ? readValue(state, key) : undefined
  }
}

/** The round loop of one graph level. The top level and every block run share it. */
async function loop(ctx: Ctx, level: Level, inbox: Map<string, Delivery[]>): Promise<void> {
  const { cb } = ctx
  const top = level.path.length === 0
  for (;;) {
    if (ctx.inner.signal.aborted) break

    if (top) {
      // The pause gate sits at the round boundary, before the "nobody left to speak" check: an
      // injection arriving while paused can repopulate the active set, which is how a finished-
      // looking run picks up again.
      if (ctx.session.isPaused()) {
        cb.onPhase('paused')
        await ctx.session.waitWhilePaused(ctx.signal)
        if (ctx.signal.aborted) break
        cb.onPhase('running')
      }
      deliverInjections(ctx, level, inbox)
    }

    await releaseTimedOutJoins(ctx, level, inbox)
    if (inbox.size === 0) await releaseQuiescentJoins(ctx, level, inbox)
    if (inbox.size === 0) break
    if (ctx.inner.signal.aborted) break

    if (ctx.steps.used >= ctx.spec.maxRounds) {
      if (!top) notice(ctx, level, 'budget', `A block stopped early: the swarm's step budget (${ctx.spec.maxRounds}) is spent.`)
      break
    }
    ctx.steps.used++
    const round = ++level.round
    if (top) cb.onRound(round)

    const active = [...inbox.entries()]
    inbox.clear()
    for (const [id] of active) {
      cb.onAgentStatus(id, 'queued', pathArg(level.path))
      ctx.queued.set(queueKey(level, id), { id, path: level.path })
    }

    const turns = active.map(async ([id, deliveries], index) => {
      // A small stagger: the swarm wakes up as a wave instead of a flat blink.
      await sleep(index * 140)
      if (ctx.inner.signal.aborted) return null
      const agent = agentOf(level, id)
      if (agent) return speak(ctx, level, agent, deliveries, round)
      const node = findFlowNode(level.graph, id)
      if (node?.kind === 'block') return runBlockNode(ctx, level, node, deliveries, round)
      if (node?.kind === 'decision') return runDecisionNode(ctx, level, node, deliveries, round)
      return null
    })

    // allSettled, not all: a rejection must not leave the siblings unobserved and still writing.
    // `speak` already aborts the inner signal on a real failure, so they wind down on their own.
    const settled = await Promise.allSettled(turns)
    const spoken = settled
      .map((result) => (result.status === 'fulfilled' ? result.value : null))
      .filter(Boolean) as Turn[]
    if (ctx.failed.error) throw ctx.failed.error
    if (ctx.inner.signal.aborted) break

    // Effects apply in transcript order: writes first, so a guard reading memory sees this round's
    // state; then routing; then spawns, whose helpers speak next round.
    const chips = new Map<string, ActionChip[]>(spoken.map((t) => [t.id, []]))
    for (const turn of spoken) {
      level.lastText.set(turn.id, turn.prose)
      for (const action of turn.actions) {
        if (action.type === 'write') chips.get(turn.id)!.push(applyWriteAction(ctx, level, turn, action, round, inbox))
      }
    }

    const packets: Packet[] = []
    const extraTransit: TransitPacket[] = []
    for (const turn of spoken) {
      const routed = route(ctx, level, turn, round)
      packets.push(...routed.packets)
      chips.get(turn.id)!.push(...routed.chips)
      for (const action of turn.actions) {
        if (action.type !== 'spawn') continue
        const spawned = applySpawn(ctx, level, turn, action, inbox)
        chips.get(turn.id)!.push(spawned.chip)
        if (spawned.transit) extraTransit.push(spawned.transit)
      }
      const actions = chips.get(turn.id)!
      cb.onMessageEnd(turn.entryId, {
        to: routed.packets.map((p) => p.target),
        ...(actions.length > 0 ? { actions } : {}),
      })
    }

    await resolve(ctx, level, packets, inbox, round, { animate: true, extraTransit })
  }
}

function queueKey(level: Level, id: string): string {
  return [...level.path, id].join('/')
}

/**
 * Hands queued human messages to their agents and makes them active.
 *
 * An injected message can wake an agent the swarm had already moved past — that is the point of
 * "input wherever I want": the graph says who may speak to whom, and a human is outside it.
 */
function deliverInjections(ctx: Ctx, level: Level, inbox: Map<string, Delivery[]>) {
  for (const injection of ctx.session.takeInjections()) {
    if (!agentOf(level, injection.agentId)) continue
    const queue = inbox.get(injection.agentId) ?? []
    queue.push({ kind: 'human', text: injection.text })
    inbox.set(injection.agentId, queue)
    ctx.cb.onInjection?.({ ...injection, round: level.round + 1 })
  }
}

/**
 * Which links a turn's message takes.
 *
 * Order matters and is the one in the design: dispatch (all / rotate / choose / manager), then each
 * kept link's guard, then its loop budget.
 */
function route(ctx: Ctx, level: Level, turn: Turn, round: number): { packets: Packet[]; chips: ActionChip[] } {
  const chips: ActionChip[] = []
  const items: Delivery[] = [
    { kind: 'part', author: turn.name, text: turn.carry ?? turn.prose, ...(turn.decision ? { decision: turn.decision } : {}) },
  ]
  // Words are what travel. A turn that only wrote to memory, or only spawned, has nothing to hand on.
  if (turn.prose.trim() === '') return { packets: [], chips }

  const spawned = level.spawnParent.get(turn.id)
  if (spawned) {
    // A helper answers the agent that created it, up the dashed link it arrived by.
    return { packets: [packetTo(spawned.parentId, items, spawned.link, true)], chips }
  }

  const agent = agentOf(level, turn.id)
  const outgoing = messageLinks(level.graph).filter((l) => l.source === turn.id)
  const dispatch = agent?.dispatch && agent.dispatch !== 'inherit' ? agent.dispatch : undefined
  const topology = ctx.spec.topology

  if (agent && !dispatch && topology === 'manager') {
    const entries = resolveEntryIds(level.graph)
    if (!entries.includes(agent.id)) {
      // Workers report back up to the manager rather than onwards.
      const up = level.graph.links.filter((l) => l.kind !== 'access' && l.target === agent.id && entries.includes(l.source))
      return { packets: up.map((l) => packetTo(l.source, items, l, true)), chips }
    }
  }

  // A Decision node routes by its guards alone: rotating its branches would ignore what it decided.
  if (turn.decision) return { packets: routeDecision(ctx, level, turn, outgoing, items, round), chips }

  const effective = dispatch ?? (topology === 'round-robin' ? 'rotate' : 'all')
  let candidates = outgoing
  if (agent && effective === 'choose') {
    const named = new Set(
      turn.actions.flatMap((a) => (a.type === 'route' ? a.labels : [])).map((l) => l.trim().toLowerCase()),
    )
    const labelled = outgoing.filter((l) => l.label)
    const unlabelled = outgoing.filter((l) => !l.label)
    let chosen = labelled.filter((l) => named.has(l.label!.trim().toLowerCase()))
    if (labelled.length > 0 && chosen.length === 0) {
      const fallback = labelled.find((l) => l.isDefault)
      chosen = fallback ? [fallback] : []
      const said = named.size > 0 ? `named "${[...named].join(', ')}", which is not one of its branches` : 'named no branch'
      ctx.cb.onNotice?.(
        `${turn.name} ${said}: ${fallback ? `took the default branch "${fallback.label}"` : 'the message went nowhere'}.`,
      )
    }
    for (const link of chosen) chips.push({ type: 'route', text: `route: ${link.label}` })
    candidates = [...chosen, ...unlabelled]
  }

  const { kept, skipped } = filterLinks(ctx, level, candidates, turn.prose, round)
  let taken = kept
  if (effective === 'rotate' && kept.length > 0) {
    const cursor = level.state.rrCursor.get(turn.id) ?? 0
    level.state.rrCursor.set(turn.id, cursor + 1)
    taken = [kept[cursor % kept.length]]
  }
  if (skipped.length > 0 || effective === 'choose') {
    const takenIds = new Set(taken.map((l) => l.id))
    ctx.cb.onBranch?.({
      path: level.path,
      nodeId: turn.id,
      taken: taken.map((l) => l.id),
      skipped: outgoing.filter((l) => !takenIds.has(l.id)).map((l) => l.id),
    })
  }
  return { packets: taken.map((l) => packetTo(l.target, items, l)), chips }
}

/** Guards and loop budgets. A link that fails either is skipped, never an error. */
function filterLinks(ctx: Ctx, level: Level, links: Link[], subject: string, round: number, decision?: DecisionAnswers) {
  const kept: Link[] = []
  const skipped: Link[] = []
  for (const link of links) {
    const used = level.state.traversals.get(link.id) ?? 0
    if (link.maxTraversals !== undefined && used >= link.maxTraversals) {
      notice(ctx, level, `budget:${link.id}`, `A link has carried its ${link.maxTraversals} message(s) and is now closed.`)
      skipped.push(link)
      continue
    }
    if (link.guard) {
      const result = evaluate(link.guard, { text: subject, visits: used, round, readMemory: readMemoryFor(level), ...(decision ? { decision } : {}) })
      if (result.problem) notice(ctx, level, `guard:${link.id}`, `A link condition could not be read: ${result.problem}`)
      if (!result.value) {
        skipped.push(link)
        continue
      }
    }
    kept.push(link)
  }
  return { kept, skipped }
}

/**
 * Carries packets until each rests at an agent, a block, a human gate or nowhere.
 *
 * Zero-token nodes act inside the round: a condition that took a round of its own would add a
 * visible pause and burn the step budget for nothing.
 */
async function resolve(
  ctx: Ctx,
  level: Level,
  packets: Packet[],
  inbox: Map<string, Delivery[]>,
  round: number,
  options: { animate: boolean; extraTransit?: TransitPacket[] },
): Promise<void> {
  const transit: TransitPacket[] = [...(options.extraTransit ?? [])]
  const gates: Array<{ node: HumanNode; items: Delivery[]; packet: Packet }> = []
  const queue = [...packets]

  while (queue.length > 0) {
    const packet = queue.shift()!
    if (packet.link) {
      transit.push({ id: packet.link.id, reversed: Boolean(packet.reversed), ...(level.path.length ? { path: level.path } : {}) })
      level.state.traversals.set(packet.link.id, (level.state.traversals.get(packet.link.id) ?? 0) + 1)
    }
    if (isSpeaker(level, packet.target)) {
      const queued = inbox.get(packet.target) ?? []
      queued.push(...packet.items)
      inbox.set(packet.target, queued)
      continue
    }
    const node = findFlowNode(level.graph, packet.target)
    if (!node || node.kind === 'memory') continue

    if (packet.hops >= MAX_DETERMINISTIC_HOPS) {
      const names = [...new Set(packet.trail)].slice(0, 6).join(' → ')
      throw new Error(`A loop made only of zero-token nodes never reaches an agent: ${names}. Put an agent in it, or a loop budget on one of its links.`)
    }
    const visits = level.state.fires.get(node.id) ?? 0
    level.state.fires.set(node.id, visits + 1)
    ctx.cb.onNodeFired?.({ path: level.path, nodeId: node.id, kind: node.kind })
    const onward = (links: Link[], items: Delivery[]) => {
      for (const link of links) {
        queue.push({ link, target: link.target, items, hops: packet.hops + 1, trail: [...packet.trail, node.name] })
      }
    }

    switch (node.kind) {
      case 'condition': {
        const subject = textOf(packet.items)
        const decision = decisionOf(packet.items)
        const result = evaluate(node.predicate, {
          text: subject,
          visits,
          round,
          readMemory: readMemoryFor(level),
          ...(decision ? { decision } : {}),
        })
        if (result.problem) notice(ctx, level, `condition:${node.id}`, `Condition "${node.name}" could not be read: ${result.problem}`)
        const branch = result.value ? 'true' : 'false'
        const outgoing = messageLinks(level.graph).filter((l) => l.source === node.id)
        // An unlabelled link out of a condition counts as its "true" side: that is what a single
        // arrow out of a diamond means to anyone reading the canvas.
        const side = outgoing.filter((l) => (l.label?.trim().toLowerCase() || 'true') === branch)
        const { kept } = filterLinks(ctx, level, side, subject, round, decision)
        const keptIds = new Set(kept.map((l) => l.id))
        ctx.cb.onBranch?.({
          path: level.path,
          nodeId: node.id,
          taken: kept.map((l) => l.id),
          skipped: outgoing.filter((l) => !keptIds.has(l.id)).map((l) => l.id),
        })
        onward(kept, packet.items)
        break
      }
      case 'join':
        onward(...joinArrival(ctx, level, node, packet, round))
        break
      case 'output': {
        const text = textOf(packet.items)
        level.outputs.push(text)
        ctx.cb.onOutput?.({ path: level.path, nodeId: node.id, text })
        break
      }
      case 'human':
        gates.push({ node, items: packet.items, packet })
        break
      case 'block':
        break
    }
  }

  if (transit.length > 0) {
    ctx.cb.onTransit(transit)
    if (options.animate) await sleep(level.path.length > 0 ? NESTED_TRANSIT_MS : TRANSIT_MS)
  }

  for (const gate of gates) {
    if (ctx.inner.signal.aborted) return
    const decision = await waitAtGate(ctx, level, gate.node, gate.items)
    if (!decision) return
    const label = decision.approved ? 'approved' : 'rejected'
    const outgoing = messageLinks(level.graph).filter((l) => l.source === gate.node.id)
    const side = outgoing.filter((l) => (l.label?.trim().toLowerCase() || 'approved') === label)
    const edited = decision.text.trim() !== textOf(gate.items).trim()
    const carried = decisionOf(gate.items)
    const items: Delivery[] = edited
      ? [{ kind: 'part', author: 'The human', text: decision.text, ...(carried ? { decision: carried } : {}) }]
      : gate.items
    const { kept } = filterLinks(ctx, level, side, decision.text, round, carried)
    const next = kept.map((link) => ({
      link,
      target: link.target,
      items,
      hops: gate.packet.hops + 1,
      trail: [...gate.packet.trail, gate.node.name],
    }))
    await resolve(ctx, level, next, inbox, round, options)
  }
}

async function waitAtGate(ctx: Ctx, level: Level, node: HumanNode, items: Delivery[]): Promise<GateDecision | null> {
  const id = `gate${++ctx.counter.value}`
  const pending: PendingGate = {
    id,
    nodeId: node.id,
    path: level.path,
    name: node.name,
    prompt: node.prompt,
    text: textOf(items),
  }
  ctx.cb.onAgentStatus(node.id, 'waiting', pathArg(level.path))
  // Registered BEFORE the callback: a UI (or a test) that decides synchronously inside
  // `onHumanGate` must find the gate already waiting.
  const waiting = ctx.session.waitForGate(pending, ctx.inner.signal)
  ctx.cb.onHumanGate?.(pending)
  const decision = await waiting
  ctx.cb.onGateClosed?.({ id, decision })
  ctx.cb.onAgentStatus(node.id, decision ? 'done' : 'idle', pathArg(level.path))
  return decision
}

/** A join's reaction to one arrival: what it forwards now, if anything. */
function joinArrival(ctx: Ctx, level: Level, node: JoinNode, packet: Packet, round: number): [Link[], Delivery[]] {
  const incoming = messageLinks(level.graph).filter((l) => l.target === node.id)
  const holding = level.state.holdings.get(node.id) ?? { since: round, parts: new Map(), armed: true }
  level.state.holdings.set(node.id, holding)
  const key = packet.link?.id ?? 'entry'

  if (node.mode === 'any') {
    const first = holding.armed
    holding.parts.set(key, [])
    holding.armed = false
    // Re-armed once the wave is complete, so a join inside a loop fires again on the next pass.
    if (incoming.every((l) => holding.parts.has(l.id))) {
      holding.parts.clear()
      holding.armed = true
    }
    if (!first) return [[], []]
    return [joinOutgoing(ctx, level, node, packet.items, round), packet.items]
  }

  if (holding.parts.size === 0) holding.since = round
  holding.parts.set(key, [...(holding.parts.get(key) ?? []), ...packet.items])
  if (!incoming.every((l) => holding.parts.has(l.id))) return [[], []]
  const items = releaseHolding(level, node, incoming)
  return [joinOutgoing(ctx, level, node, items, round), items]
}

function releaseHolding(level: Level, node: JoinNode, incoming: Link[]): Delivery[] {
  const holding = level.state.holdings.get(node.id)
  if (!holding) return []
  // In the order the links were drawn, so the combined message reads the same on every run.
  const order = [...incoming.map((l) => l.id), ...[...holding.parts.keys()].filter((k) => !incoming.some((l) => l.id === k))]
  const items = order.flatMap((id) => holding.parts.get(id) ?? [])
  holding.parts.clear()
  holding.armed = true
  return items
}

function joinOutgoing(ctx: Ctx, level: Level, node: JoinNode, items: Delivery[], round: number): Link[] {
  const outgoing = messageLinks(level.graph).filter((l) => l.source === node.id)
  return filterLinks(ctx, level, outgoing, textOf(items), round, decisionOf(items)).kept
}

/**
 * A join waiting for a branch that will never come would hold its messages for ever. So when nothing
 * else is left to run, every join holding something lets it go — LangGraph calls these deferred
 * nodes. What it releases is marked, so the transcript does not pretend every branch answered.
 */
async function releaseQuiescentJoins(ctx: Ctx, level: Level, inbox: Map<string, Delivery[]>) {
  const packets: Packet[] = []
  for (const node of nodesOf(level.graph)) {
    if (node.kind !== 'join') continue
    const holding = level.state.holdings.get(node.id)
    if (!holding) continue
    if (node.mode === 'any') {
      holding.parts.clear()
      holding.armed = true
      continue
    }
    if (holding.parts.size === 0) continue
    const incoming = messageLinks(level.graph).filter((l) => l.target === node.id)
    const items = releaseHolding(level, node, incoming)
    notice(ctx, level, `quiescent:${node.id}:${level.round}`, `Join "${node.name}" released what it had: its other branches never ran.`)
    for (const link of joinOutgoing(ctx, level, node, items, level.round)) {
      packets.push({ link, target: link.target, items, hops: 1, trail: [node.name] })
    }
  }
  if (packets.length > 0) await resolve(ctx, level, packets, inbox, level.round, { animate: true })
}

async function releaseTimedOutJoins(ctx: Ctx, level: Level, inbox: Map<string, Delivery[]>) {
  const packets: Packet[] = []
  for (const node of nodesOf(level.graph)) {
    if (node.kind !== 'join' || node.mode !== 'all' || !node.timeoutRounds) continue
    const holding = level.state.holdings.get(node.id)
    if (!holding || holding.parts.size === 0) continue
    if (level.round - holding.since < node.timeoutRounds) continue
    const incoming = messageLinks(level.graph).filter((l) => l.target === node.id)
    const items = releaseHolding(level, node, incoming)
    ctx.cb.onNotice?.(`Join "${node.name}" stopped waiting after ${node.timeoutRounds} round(s).`)
    for (const link of joinOutgoing(ctx, level, node, items, level.round)) {
      packets.push({ link, target: link.target, items, hops: 1, trail: [node.name] })
    }
  }
  if (packets.length > 0) await resolve(ctx, level, packets, inbox, level.round, { animate: true })
}

function applyWriteAction(
  ctx: Ctx,
  level: Level,
  turn: Turn,
  action: WriteAction,
  round: number,
  inbox: Map<string, Delivery[]>,
): ActionChip {
  const state = memoryByName(level, action.memory)
  if (!state) {
    ctx.cb.onNotice?.(`${turn.name} wrote to "${action.memory}", but there is no memory by that name here.`)
    return { type: 'refused', text: `no memory "${action.memory}"` }
  }
  // The permission is the graph's, not the prompt's: a model that invents a write is refused.
  if (!canWrite(level.graph, turn.id, state.node.id)) {
    ctx.cb.onNotice?.(`${turn.name} may not write to "${state.node.name}": draw a write link first.`)
    return { type: 'refused', text: `no write access to ${state.node.name}` }
  }
  const result = applyWrite(state, { key: action.key, value: action.value }, turn.name, round)
  if (!result.ok || !result.entry) {
    ctx.cb.onNotice?.(result.problem ?? `A write to ${state.node.name} was refused.`)
    return { type: 'refused', text: result.problem ?? 'write refused' }
  }
  const entry = result.entry
  ctx.cb.onMemoryWrite?.({ path: level.path, memoryId: state.node.id, entry })

  if (state.node.wakeReaders) {
    // A bus: everyone who can read it hears about the write next round, linked by messages or not.
    for (const reader of level.graph.agents) {
      if (reader.id === turn.id) continue
      if (!readableMemories(level.graph, reader.id).some((m) => m.id === state.node.id)) continue
      const queue = inbox.get(reader.id) ?? []
      queue.push({
        kind: 'bus',
        text: `[memory ${state.node.name}] ${turn.name} wrote${entry.key ? ` ${entry.key}` : ''}: ${entry.value}`,
      })
      inbox.set(reader.id, queue)
    }
  }
  const where = entry.key ? `${state.node.name}.${entry.key}` : state.node.name
  return { type: 'write', text: `→ ${where}` }
}

function findBlockByReference(ctx: Ctx, reference: string): BlockDef | undefined {
  const wanted = reference.trim().toLowerCase()
  const all = [...(ctx.spec.blocks ?? []), ...ctx.library]
  return all.find((b) => b.id === reference) ?? all.find((b) => b.name.trim().toLowerCase() === wanted)
}

function applySpawn(
  ctx: Ctx,
  level: Level,
  turn: Turn,
  action: SpawnAction,
  inbox: Map<string, Delivery[]>,
): { chip: ActionChip; transit?: TransitPacket } {
  const parent = agentOf(level, turn.id)
  const label = action.name ?? action.block ?? 'helper'
  const refuse = (reason: string): { chip: ActionChip } => {
    ctx.cb.onNotice?.(`${turn.name} could not spawn "${label}": ${reason}.`)
    const queue = inbox.get(turn.id) ?? []
    queue.push({ kind: 'system', text: `spawn refused (${label}): ${reason}. Carry on by yourself.` })
    inbox.set(turn.id, queue)
    return { chip: { type: 'refused', text: `spawn ${label}: ${reason}` } }
  }
  if (!parent || !parent.canSpawn) return refuse('this agent is not allowed to spawn')
  const parentDepth = level.spawnDepth.get(parent.id) ?? level.depth
  if (ctx.spawns.used >= ctx.maxSpawns) return refuse(`the swarm's spawn limit (${ctx.maxSpawns}) is reached`)
  if (parentDepth + 1 > ctx.maxDepth) return refuse(`the depth limit (${ctx.maxDepth}) is reached`)
  const block = action.block ? findBlockByReference(ctx, action.block) : undefined
  if (action.block && !block) return refuse(`there is no block named "${action.block}"`)

  const n = ++ctx.spawns.used
  const siblings = [...level.spawnParent.values()].filter((s) => s.parentId === parent.id).length
  const id = `${parent.id}~s${n}`
  const position = { x: parent.position.x + 280, y: parent.position.y - 60 + siblings * 130 }
  const link: Link = { id: `${parent.id}~l${n}`, source: parent.id, target: id, label: 'spawned' }

  let node: Agent | BlockNode
  if (block) {
    node = { id, kind: 'block', name: action.name ?? block.name, position, blockId: block.id }
    level.graph.nodes = [...nodesOf(level.graph), node]
  } else {
    const name = action.name ?? 'Helper'
    node = {
      id,
      name,
      provider: parent.provider,
      model: parent.model,
      temperature: parent.temperature,
      ...(parent.maxTokens !== undefined ? { maxTokens: parent.maxTokens } : {}),
      systemPrompt: `You are ${name}, called in by ${parent.name} for one subtask. Do exactly that subtask and report the result, in your own voice.`,
      hue: (parent.hue + 47 * n) % 360,
      position,
      dispatch: 'all',
      // Live recursion: a helper of a spawner may spawn too, within the same depth and count limits.
      canSpawn: parent.canSpawn,
    }
    level.graph.agents = [...level.graph.agents, node]
  }
  level.spawnParent.set(id, { parentId: parent.id, link })
  level.spawnDepth.set(id, parentDepth + 1)
  inbox.set(id, [...(inbox.get(id) ?? []), { kind: 'delegation', author: parent.name, text: action.task }])
  ctx.cb.onSpawn?.({ path: level.path, parentId: parent.id, node, link })
  return {
    // The task goes in the chip: when a delegator says nothing but the tag, the chip IS its turn.
    chip: { type: 'spawn', text: `spawned ${node.name}: ${action.task.length > 90 ? `${action.task.slice(0, 89)}…` : action.task}` },
    transit: { id: link.id, reversed: false, ...(level.path.length ? { path: level.path } : {}) },
  }
}

/**
 * Where a Decision node's message goes: every outgoing link whose guard passes on its answers. A link
 * marked default is the "else": taken only when no other link is.
 */
function routeDecision(ctx: Ctx, level: Level, turn: Turn, outgoing: Link[], items: Delivery[], round: number): Packet[] {
  const regular = outgoing.filter((l) => !l.isDefault)
  const fallback = outgoing.filter((l) => l.isDefault)
  let { kept } = filterLinks(ctx, level, regular, turn.carry ?? turn.prose, round, turn.decision)
  if (kept.length === 0 && fallback.length > 0) {
    kept = filterLinks(ctx, level, fallback, turn.carry ?? turn.prose, round, turn.decision).kept
  }
  const keptIds = new Set(kept.map((l) => l.id))
  ctx.cb.onBranch?.({
    path: level.path,
    nodeId: turn.id,
    taken: kept.map((l) => l.id),
    skipped: outgoing.filter((l) => !keptIds.has(l.id)).map((l) => l.id),
  })
  if (kept.length === 0 && outgoing.length > 0) {
    notice(ctx, level, `nobranch:${turn.id}`, `${turn.name}: no outgoing link matched its answers, so the message stopped there. Mark one link as the default to catch the rest.`)
  }
  return kept.map((l) => packetTo(l.target, items, l))
}

/**
 * Runs a Decision node: one call to a decision model with what reached the node as the state.
 *
 * It generates no text. The transcript shows its typed answers; what it passes on is the state it
 * judged, followed by one line of verdict, so an agent downstream (the System 2 an uncertain answer
 * escalates to) sees both the message and why it was sent there.
 */
async function runDecisionNode(
  ctx: Ctx,
  level: Level,
  node: DecisionNode,
  deliveries: Delivery[],
  round: number,
): Promise<Turn | null> {
  const { cb } = ctx
  const entryId = `m${++ctx.counter.value}`
  const state = deliveries
    .map((d) => (d.kind === 'part' ? `${d.author ?? 'someone'}: ${d.text}` : d.text))
    .join('\n\n')
  cb.onMessageStart({
    id: entryId,
    round,
    agentId: node.id,
    to: [],
    text: '',
    status: 'streaming',
    tokensIn: 0,
    tokensOut: 0,
    startedAt: Date.now(),
    speaker: node.name,
    ...(level.path.length ? { path: level.path } : {}),
  })
  cb.onAgentStatus(node.id, 'thinking', pathArg(level.path))
  ctx.queued.delete(queueKey(level, node.id))

  try {
    const result = await callDecision({
      node,
      state,
      apiKey: decisionKey(node.provider, ctx.keys),
      endpoint: resolveDecisionEndpoint(node.provider, ctx.decisionEndpoints),
      signal: ctx.inner.signal,
    })
    const summary = summarizeDecision(result.answers)
    cb.onMessageEnd(entryId, {
      text: summary,
      status: 'complete',
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      endedAt: Date.now(),
      decision: result.answers,
    })
    cb.onDecision?.({ path: level.path, nodeId: node.id, answers: result.answers })
    cb.onAgentStatus(node.id, 'done', pathArg(level.path))
    // What the node forwards is the state it judged: the original words, not a rewrite of them.
    const forwarded = deliveries.map((d) => d.text).join('\n\n')
    return {
      id: node.id,
      name: node.name,
      entryId,
      prose: summary,
      carry: `${forwarded}\n\n[${node.name}] ${summary.replace(/\n/g, '; ')}`,
      actions: [],
      decision: result.answers,
    }
  } catch (err) {
    if (ctx.inner.signal.aborted) {
      cb.onMessageEnd(entryId, { status: 'stopped', endedAt: Date.now() })
      cb.onAgentStatus(node.id, 'idle', pathArg(level.path))
      return null
    }
    const message = `${node.name}: ${err instanceof Error ? err.message : String(err)}`
    cb.onMessageEnd(entryId, { status: 'error', text: message, endedAt: Date.now() })
    cb.onAgentStatus(node.id, 'error', pathArg(level.path))
    ctx.failed.error = new Error(message)
    ctx.inner.abort()
    throw ctx.failed.error
  }
}

/**
 * Runs a block node: its graph, as a nested run, with what reached the node as the task.
 *
 * The result is what reached the block's Output nodes, or, when it has none, the last words of each
 * of its leaf agents. It leaves the node like an agent's message.
 */
async function runBlockNode(
  ctx: Ctx,
  level: Level,
  node: BlockNode,
  deliveries: Delivery[],
  round: number,
): Promise<Turn | null> {
  const { cb } = ctx
  const entryId = `m${++ctx.counter.value}`
  const task = deliveries
    .map((d) => (d.kind === 'part' ? `${d.author ?? 'someone'}: ${d.text}` : d.text))
    .join('\n\n')
  cb.onMessageStart({
    id: entryId,
    round,
    agentId: node.id,
    to: [],
    text: '',
    status: 'streaming',
    tokensIn: 0,
    tokensOut: 0,
    startedAt: Date.now(),
    speaker: node.name,
    ...(level.path.length ? { path: level.path } : {}),
  })
  cb.onAgentStatus(node.id, 'thinking', pathArg(level.path))
  ctx.queued.delete(queueKey(level, node.id))

  const def = findBlock(ctx.spec, node.blockId, ctx.library)
  let text: string
  if (!def) {
    text = `[block "${node.name}" has no definition in this swarm]`
    notice(ctx, level, `nodef:${node.id}`, `Block "${node.name}" refers to a definition this swarm does not have.`)
  } else if (level.depth + 1 > ctx.maxDepth) {
    // Recursion bottoms out here instead of failing: the parent gets a result it can read.
    text = `[${node.name} not run: depth limit ${ctx.maxDepth} reached]`
    notice(ctx, level, `depth:${node.id}`, `Block "${node.name}" hit the depth limit (${ctx.maxDepth}).`)
  } else {
    const graph = structuredClone(def.graph)
    if (node.overrides) {
      graph.agents = graph.agents.map((a) => ({
        ...a,
        ...(node.overrides?.provider ? { provider: node.overrides.provider } : {}),
        ...(node.overrides?.model ? { model: node.overrides.model } : {}),
      }))
    }
    const child = createLevel(graph, [...level.path, node.id], level.depth + 1, task, createGraphState(), node.name)
    const inbox = new Map<string, Delivery[]>()
    const entries = resolveEntryIds(graph)
    await resolve(
      ctx,
      child,
      entries.map((id) => packetTo(id, [{ kind: 'task', text: task }])),
      inbox,
      0,
      { animate: false },
    )
    await loop(ctx, child, inbox)
    if (ctx.failed.error) throw ctx.failed.error
    if (child.outputs.length > 0) {
      text = child.outputs.join('\n\n')
    } else {
      const leaves = graph.agents.filter((a) => !messageLinks(graph).some((l) => l.source === a.id))
      text = leaves
        .map((a) => child.lastText.get(a.id))
        .filter((t): t is string => Boolean(t && t.trim()))
        .join('\n\n')
    }
    if (!text.trim()) text = `[${node.name} produced nothing]`
  }

  if (ctx.inner.signal.aborted) {
    cb.onMessageEnd(entryId, { status: 'stopped', endedAt: Date.now() })
    cb.onAgentStatus(node.id, 'idle', pathArg(level.path))
    return null
  }
  cb.onMessageEnd(entryId, {
    text,
    status: 'complete',
    tokensOut: estimateTokens(text),
    endedAt: Date.now(),
  })
  cb.onAgentStatus(node.id, 'done', pathArg(level.path))
  return { id: node.id, name: node.name, entryId, prose: text, actions: [] }
}

async function speak(ctx: Ctx, level: Level, agent: Agent, deliveries: Delivery[], round: number): Promise<Turn | null> {
  const { cb } = ctx
  const arriving = deliveries.map(toChatMessage)
  const history = level.state.memory.get(agent.id) ?? []
  const messages = [...history, ...arriving]
  const entryId = `m${++ctx.counter.value}`
  const spawnedBy = level.spawnParent.get(agent.id)

  const context = arriving.map((m) => m.content).join('\n')
  const readable = readableMemories(level.graph, agent.id)
  const writable = writableMemories(level.graph, agent.id)
  const memories = [...new Set([...readable, ...writable])].map((node) => {
    const state = level.state.memories.get(node.id)
    const canRead = readable.includes(node)
    if (canRead) cb.onMemoryRead?.({ path: level.path, memoryId: node.id, agentId: agent.id })
    return { node, read: canRead, write: writable.includes(node), view: canRead && state ? renderMemory(state, context) : '' }
  })

  const outgoing = messageLinks(level.graph).filter((l) => l.source === agent.id)
  const choose = agent.dispatch === 'choose'
  const myDepth = level.spawnDepth.get(agent.id) ?? level.depth
  // Only offered when it could succeed: telling an agent at the limit how to spawn invites a refusal.
  const maySpawn = Boolean(agent.canSpawn) && myDepth + 1 <= ctx.maxDepth && ctx.spawns.used < ctx.maxSpawns
  const system = buildSystem(agent, {
    task: level.task,
    targetNames: spawnedBy ? [] : outgoing.map((l) => nameOf(level, l.target)),
    branches: choose
      ? outgoing.filter((l) => l.label).map((l) => ({ label: l.label!, target: nameOf(level, l.target), isDefault: Boolean(l.isDefault) }))
      : [],
    memories,
    spawn: maySpawn
      ? {
          remaining: Math.max(0, ctx.maxSpawns - ctx.spawns.used),
          blocks: [...(ctx.spec.blocks ?? []), ...ctx.library].slice(0, 12),
        }
      : undefined,
    delegatedBy: spawnedBy ? nameOf(level, spawnedBy.parentId) : undefined,
    nesting: level.path.length > 0 ? { block: level.blockName ?? 'a block', depth: level.depth, limit: ctx.maxDepth } : undefined,
    delegationDepth: spawnedBy ? { depth: myDepth, limit: ctx.maxDepth } : undefined,
  })

  const entry: TranscriptEntry = {
    id: entryId,
    round,
    agentId: agent.id,
    to: [],
    text: '',
    status: 'streaming',
    tokensIn: estimateTokens(system + messages.map((m) => m.content).join('')),
    tokensOut: 0,
    startedAt: Date.now(),
    ...(level.path.length || spawnedBy ? { speaker: agent.name, hue: agent.hue } : {}),
    ...(level.path.length ? { path: level.path } : {}),
  }
  cb.onMessageStart(entry)
  cb.onAgentStatus(agent.id, 'thinking', pathArg(level.path))

  let firstDelta = true
  try {
    const result = await callProvider(agent.provider, {
      model: agent.model,
      system,
      messages,
      temperature: agent.temperature,
      maxTokens: agent.maxTokens ?? DEFAULT_MAX_TOKENS,
      apiKey: ctx.keys[agent.provider] ?? '',
      endpoint: resolveEndpoint(agent.provider, ctx.endpoints),
      signal: ctx.inner.signal,
      onNotice: cb.onNotice,
      onDiscard: () => {
        firstDelta = true
        cb.onMessageReset?.(entryId)
      },
      onDelta: (delta) => {
        if (firstDelta) {
          firstDelta = false
          cb.onAgentStatus(agent.id, 'speaking', pathArg(level.path))
        }
        cb.onMessageDelta(entryId, delta)
      },
    })
    // The agent remembers what it actually wrote, tags included: it should know it already routed.
    level.state.memory.set(agent.id, [...messages, { role: 'assistant', content: result.text }])
    const parsed = parseActions(result.text)
    for (const problem of parsed.problems) cb.onNotice?.(`${agent.name}: ${problem}`)
    cb.onMessageEnd(entryId, {
      text: parsed.prose,
      status: 'complete',
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      endedAt: Date.now(),
    })
    ctx.queued.delete(queueKey(level, agent.id))
    cb.onAgentStatus(agent.id, 'done', pathArg(level.path))
    return { id: agent.id, name: agent.name, entryId, prose: parsed.prose, actions: parsed.actions }
  } catch (err) {
    // Stopped — either by the user, or by a sibling's failure winding the round down.
    // ⚠️ The text is NOT overwritten: whatever already streamed is the most interesting part of a
    // halted answer, and replacing it with "(stopped)" threw away work the user watched arrive.
    if (ctx.inner.signal.aborted) {
      cb.onMessageEnd(entryId, { status: 'stopped', endedAt: Date.now() })
      ctx.queued.delete(queueKey(level, agent.id))
      cb.onAgentStatus(agent.id, 'idle', pathArg(level.path))
      return null
    }
    const message = err instanceof Error ? err.message : String(err)
    cb.onMessageEnd(entryId, { status: 'error', text: message, endedAt: Date.now() })
    ctx.queued.delete(queueKey(level, agent.id))
    cb.onAgentStatus(agent.id, 'error', pathArg(level.path))
    // Remember the cause, THEN stop the siblings: they must not keep streaming into a failed run.
    ctx.failed.error = err instanceof Error ? err : new Error(message)
    ctx.inner.abort()
    throw err
  }
}

function nameOf(level: Level, id: string): string {
  return agentOf(level, id)?.name ?? findFlowNode(level.graph, id)?.name ?? id
}

interface SystemInfo {
  task: string
  targetNames: string[]
  branches: Array<{ label: string; target: string; isDefault: boolean }>
  memories: Array<{ node: MemoryNode; read: boolean; write: boolean; view: string }>
  spawn?: { remaining: number; blocks: BlockDef[] }
  delegatedBy?: string
  /** Inside a block: which one, how deep, and the limit — what a model needs to stop recursing. */
  nesting?: { block: string; depth: number; limit: number }
  delegationDepth?: { depth: number; limit: number }
}

/**
 * The system prompt. Its ORDER is load-bearing, and getting it wrong wrecked a whole run.
 *
 * What happened on 14/09 with "The Cat Council": the persona came first, followed by four lines of
 * scaffolding ending in "be brief". Every agent ignored its character and answered like a helpful
 * assistant — The Cat produced *"Decision: Keep the cat inside. Why: 1. Safety & Comfort…"* with
 * headings and bullet lists, and the two agents after it opened with "That's a solid plan!" and
 * "I'm glad you liked the suggestions!". Three failures, one cause each:
 *
 *  1. **Scaffolding last wins.** A model weights the end of a system prompt more than its start, so
 *     the housekeeping outranked the role. The role now comes LAST, marked as overriding.
 *  2. **The previous agent's turn arrives in the `user` role** (there is no other choice in a chat
 *     API), which is the cue for "someone is asking me for help". Hence the praise and the advice.
 *     So the prompt says explicitly that these are transcript lines, not requests.
 *  3. **Brevity asked in prose is a suggestion.** It is now also a `max_tokens` (see `Agent.maxTokens`).
 *
 * Version 2 adds the graph's capabilities (branches, memories, delegation) between the rules and the
 * role, so the role still has the last word.
 */
export function buildSystem(agent: Agent, info: SystemInfo): string {
  const lines: string[] = []
  lines.push(`You are "${agent.name}", one voice in a multi-agent swarm working on a shared task.`)
  lines.push(`The shared task is: ${info.task.trim()}`)
  if (info.nesting) {
    lines.push(
      `You are inside the block "${info.nesting.block}", at nesting depth ${info.nesting.depth} (the limit is ${info.nesting.limit}). At the limit, answer directly instead of recursing.`,
    )
  }
  if (info.delegationDepth) {
    lines.push(`You are a helper at delegation depth ${info.delegationDepth.depth} (the limit is ${info.delegationDepth.limit}).`)
  }
  if (info.delegatedBy) {
    lines.push(`${info.delegatedBy} created you for one subtask. What you say goes back to ${info.delegatedBy}.`)
  } else if (info.targetNames.length > 0) {
    lines.push(`What you say is passed to: ${info.targetNames.join(', ')}. Write for them.`)
  } else {
    lines.push('Nothing is downstream of you: what you say is the swarm output.')
  }
  lines.push('')
  lines.push('How this conversation works:')
  lines.push(
    '- The messages you receive are OTHER AGENTS\' TURNS, quoted from the transcript. They are not requests addressed to you, and nobody is asking you for help.',
  )
  lines.push(
    '- So never open by evaluating what came before ("that\'s a great point", "solid plan", "I\'m glad you liked"). Never offer advice, tips, lists of suggestions or follow-up questions unless your role is to do exactly that.',
  )
  lines.push('- Say your part and stop. One short paragraph. No headings, no bullet lists, no tables.')
  lines.push('- Stay in character even when it would be more helpful not to. The swarm is the point, not your helpfulness.')

  const tags = info.branches.length > 0 || info.memories.some((m) => m.write) || info.spawn
  if (tags) {
    lines.push('- The tags described below are actions. Nobody sees them as words: write your message, then add the tags.')
  }

  if (info.branches.length > 0) {
    lines.push('')
    lines.push('Where your message goes — you decide. End with a route tag naming one branch (or several, comma-separated):')
    for (const branch of info.branches) {
      lines.push(`- <route to="${branch.label}"/> sends it to ${branch.target}${branch.isDefault ? ' (the default if you name none)' : ''}`)
    }
  }

  for (const memory of info.memories) {
    const { node } = memory
    lines.push('')
    const rights = memory.read && memory.write ? 'you read and write it' : memory.read ? 'you read it' : 'you write to it'
    lines.push(`Shared memory "${node.name}" (${node.mode}; ${rights}):`)
    if (memory.read) lines.push(memory.view)
    if (memory.write) {
      if (node.mode === 'blackboard') lines.push(`To set a value: <write memory="${node.name}" key="a-short-key">the value</write>`)
      if (node.mode === 'log') lines.push(`To post: <write memory="${node.name}">what you post</write>`)
      if (node.mode === 'document') lines.push(`To replace the whole document: <write memory="${node.name}">the full new text</write>`)
    }
  }

  if (info.spawn) {
    lines.push('')
    lines.push(
      `You may create helpers for subtasks (${info.spawn.remaining} left in this run). Each answers you next round:`,
    )
    lines.push('<spawn name="Short Role Name">the subtask, self-contained</spawn>')
    if (info.spawn.blocks.length > 0) {
      lines.push('Or run a saved block as a helper:')
      for (const block of info.spawn.blocks) {
        lines.push(`<spawn block="${block.name}">its task</spawn>${block.description ? ` — ${block.description}` : ''}`)
      }
    }
    lines.push('Only delegate what genuinely needs separate work.')
  }

  lines.push('')
  // Last, and announced as the winner: this is the line that has to survive the model's habits.
  lines.push('YOUR ROLE — this overrides everything above:')
  lines.push(agent.systemPrompt.trim())
  return lines.join('\n')
}
