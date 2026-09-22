import { create } from 'zustand'
import type {
  Agent,
  AgentStatus,
  BlockDef,
  DecisionAnswers,
  DecisionProviderId,
  FlowNode,
  FlowNodeKind,
  Graph,
  KeyId,
  Link,
  MemoryEntry,
  ProviderId,
  RunPhase,
  SwarmSpec,
  Topology,
  TranscriptEntry,
} from './types'
import { DEFAULT_MEMORY_CHARS } from './types'
import { DEFAULT_SPEC } from './presets'
import { BUILTIN_BLOCKS } from './blocks'
import { runSwarm, type OutputEvent, type TransitPacket } from './engine/runner'
import { createRunSession, type GateDecision, type PendingGate, type RunSession } from './engine/session'
import { rekey } from './engine/portable'
import { nodesOf, resolveEntryIds } from './engine/graph'
import { decisionProviderInfo, type DecisionEndpoints } from './engine/decisions'

const SPEC_KEY = 'swarm-studio.spec.v1'
const KEYS_KEY = 'swarm-studio.keys.v1'
const THEME_KEY = 'swarm-studio.theme.v1'
const ENDPOINTS_KEY = 'swarm-studio.endpoints.v1'
const MODELS_KEY = 'swarm-studio.models.v1'
const LIBRARY_KEY = 'swarm-studio.blocks.v1'
const DECISION_ENDPOINTS_KEY = 'swarm-studio.decision-endpoints.v1'

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

const HUES = [262, 168, 4, 32, 210, 300, 132, 48]

/**
 * Two different sets, and conflating them was a bug.
 *
 * `TYPED_FIELDS` fire on every keystroke, so recording them would fill the undo stack with single
 * characters. `PRESERVED_FIELDS` are carried forward across an undo so that prose typed after a
 * snapshot is not silently lost.
 *
 * `model` is typed (it is a free-text autocomplete) but must NOT be preserved: it is also set
 * deliberately, in bulk and by switching provider, and preserving it made those changes look
 * un-undoable. It is short enough that losing a few characters to an undo costs nothing.
 */
const TYPED_FIELDS = new Set<keyof Agent>(['name', 'systemPrompt', 'model'])
const PRESERVED_FIELDS: Array<keyof Agent> = ['name', 'systemPrompt']
/** The same rule for the other nodes: their names, a gate's prompt, a memory's seed text. */
const TYPED_NODE_FIELDS = new Set(['name', 'prompt', 'seed'])

export function isTextOnly(patch: Partial<Agent>): boolean {
  const keys = Object.keys(patch) as Array<keyof Agent>
  return keys.length > 0 && keys.every((key) => TYPED_FIELDS.has(key))
}

/**
 * Carries the text the user has typed since the snapshot into the spec being restored.
 *
 * Text edits are deliberately absent from the history, so a snapshot always predates them. Undo
 * must therefore mean "undo the structural change, keep what I typed" — otherwise skipping the
 * history just moves the loss from the stack to the restore. An agent that exists only in the
 * snapshot (the one coming back from a deletion) keeps its own text, which is the only text it has.
 */
export function preserveTypedText(restored: SwarmSpec, current: SwarmSpec): SwarmSpec {
  const live = new Map(current.agents.map((a) => [a.id, a]))
  const liveNodes = new Map(nodesOf(current).map((n) => [n.id, n]))
  return {
    ...restored,
    task: current.task,
    maxRounds: current.maxRounds,
    agents: restored.agents.map((a) => {
      const now = live.get(a.id)
      if (!now) return a
      const carried: Partial<Agent> = {}
      for (const field of PRESERVED_FIELDS) Object.assign(carried, { [field]: now[field] })
      return { ...a, ...carried }
    }),
    ...(restored.nodes
      ? {
          nodes: restored.nodes.map((n) => {
            const now = liveNodes.get(n.id)
            if (!now || now.kind !== n.kind) return n
            const carried: Record<string, unknown> = { name: now.name }
            if (now.kind === 'human' && n.kind === 'human') carried.prompt = now.prompt
            return { ...n, ...carried } as FlowNode
          }),
        }
      : {}),
  }
}

/** The graph the canvas is showing: the swarm itself, or the inside of the block being edited. */
export function graphIn(spec: SwarmSpec, editingBlockId?: string): Graph {
  if (!editingBlockId) return spec
  return spec.blocks?.find((b) => b.id === editingBlockId)?.graph ?? spec
}

/** What a run added to the canvas: spawned helpers and their dashed links. Never saved. */
export interface RunGraph {
  agents: Agent[]
  nodes: FlowNode[]
  links: Link[]
}

const EMPTY_RUN_GRAPH: RunGraph = { agents: [], nodes: [], links: [] }

interface State {
  spec: SwarmSpec
  phase: RunPhase
  round: number
  error?: string
  statuses: Record<string, AgentStatus>
  /** Statuses inside blocks, keyed by `path/id`. The block node's badge is derived from them. */
  nestedStatuses: Record<string, AgentStatus>
  transcript: TranscriptEntry[]
  /** Messages in flight, with their direction along the link. */
  transit: TransitPacket[]
  selectedId?: string
  selectedLinkId?: string
  /** Extra agents ticked in the roster. Edits then apply to all of them at once. */
  multiIds: string[]
  /** Undo stack of whole specs — small enough that diffing would only add bugs. */
  past: SwarmSpec[]
  future: SwarmSpec[]
  /** Transient, non-fatal message from a run (e.g. a model that refused a parameter). */
  notice?: string
  /** API keys by slot: the chat providers, plus TypeSafe's own for Decision nodes. */
  keys: Partial<Record<KeyId, string>>
  /** Per-provider endpoint override. Typed by the user, kept in this browser only. */
  endpoints: Partial<Record<ProviderId, string>>
  /** The same for Decision nodes: a relay for TypeSafe, which refuses browser origins. */
  decisionEndpoints: DecisionEndpoints
  /** Models discovered from an endpoint's /models, offered as autocomplete options. */
  discoveredModels: Partial<Record<ProviderId, string[]>>
  themeMode: 'light' | 'dark'
  /**
   * Bumped whenever the whole graph is replaced (a starter swarm, a generated one, a paste of a
   * swarm). The canvas reframes on it, and the front-door prompt gets out of the way.
   */
  graphEpoch: number

  /** Set while the canvas shows the inside of a block definition. */
  editingBlockId?: string
  /** Blocks saved in this browser. The built-ins are not in here: see `useLibrary`. */
  library: BlockDef[]
  runGraph: RunGraph
  /** Live entries of the top-level memories, by memory id. Absent until the first write. */
  memoryEntries: Record<string, MemoryEntry[]>
  gates: PendingGate[]
  outputs: OutputEvent[]
  /** When each node last did something visible (a write, a condition firing), for a flash. */
  flashes: Record<string, number>
  /** Links a branch decision did not take this round, dimmed on the canvas. */
  skippedLinks: string[]
  /** The last typed answers of each top-level Decision node, for its bars. */
  decisions: Record<string, DecisionAnswers>

  setSpec: (patch: Partial<SwarmSpec>) => void
  loadPreset: (spec: SwarmSpec) => void
  addAgent: () => void
  updateAgent: (id: string, patch: Partial<Agent>) => void
  removeAgent: (id: string) => void
  moveAgent: (id: string, position: { x: number; y: number }) => void
  addNode: (kind: Exclude<FlowNodeKind, 'block'>, position?: { x: number; y: number }) => string
  updateNode: (id: string, patch: Partial<FlowNode>) => void
  addLink: (source: string, target: string) => void
  updateLink: (id: string, patch: Partial<Link>) => void
  removeLink: (id: string) => void
  toggleEntry: (id: string) => void
  select: (id?: string) => void
  selectLink: (id?: string) => void
  toggleMulti: (id: string) => void
  setMulti: (ids: string[]) => void
  /** Applies one patch to every agent in `ids` — the point of the multi-selection. */
  applyToAgents: (ids: string[], patch: Partial<Agent>) => void
  duplicateAgent: (id: string) => void
  /** Removes agents AND other nodes, with every link and entry flag that pointed at them. */
  removeAgents: (ids: string[]) => void
  /** Drops a pasted clipping into the current graph, re-keying whatever collides. */
  pasteAgents: (incoming: { agents: Agent[]; links: Link[]; nodes?: FlowNode[]; blocks?: BlockDef[] }) => number
  /** Replaces the whole swarm with a pasted one. */
  replaceSwarm: (spec: SwarmSpec) => void
  undo: () => void
  redo: () => void
  dismissNotice: () => void
  setTopology: (topology: Topology) => void
  setKey: (slot: KeyId, value: string) => void
  setEndpoint: (provider: ProviderId, value: string) => void
  setDecisionEndpoint: (provider: DecisionProviderId, value: string) => void
  setDiscoveredModels: (provider: ProviderId, models: string[]) => void
  toggleTheme: () => void

  /** Opens a block definition on the canvas; `undefined` goes back to the swarm. */
  openBlock: (blockId?: string) => void
  /** Adds a node for this block, copying the definition into the swarm so it travels with it. */
  insertBlock: (def: BlockDef, position?: { x: number; y: number }) => string
  /** Saves the given nodes, and the links between them, as a block in this swarm and this browser. */
  saveBlock: (ids: string[], name: string, description: string) => BlockDef | undefined
  deleteLibraryBlock: (id: string) => void
  /** Replaces a block node with an inline copy of its graph. */
  detachBlock: (nodeId: string) => void
  /** Copies the helpers spawned by the last run into the swarm, as ordinary agents. */
  keepSpawned: () => number
  decideGate: (id: string, decision: GateDecision) => void

  start: () => void
  pause: () => void
  resume: () => void
  /** Hand a message to one agent, mid-run or while paused. Delivered with the next round. */
  inject: (agentId: string, text: string) => void
  /** Pick a finished run back up, from one agent, with every agent's memory intact. */
  continueFrom: (agentId: string, text: string) => void
  stop: () => void
  reset: () => void
}

let controller: AbortController | null = null
/** Survives across runs so a finished run can be continued with its memory. */
let session: RunSession | null = null
/**
 * Run generation. Stop-then-start twice in a second and the first runner's last callbacks land
 * after the second one has started: it wrote "stopped" over a run that was already running. Every
 * callback is gated on the generation it belongs to.
 */
let runSeq = 0

const NODE_DEFAULTS: { [K in Exclude<FlowNodeKind, 'block'>]: (index: number) => Omit<Extract<FlowNode, { kind: K }>, 'id' | 'position'> } = {
  condition: () => ({ kind: 'condition', name: 'Condition', predicate: { op: 'contains', value: 'yes' } }),
  join: () => ({ kind: 'join', name: 'Join', mode: 'all' }),
  output: () => ({ kind: 'output', name: 'Output' }),
  human: () => ({ kind: 'human', name: 'Human gate', prompt: 'Let this through?' }),
  decision: () => ({
    kind: 'decision',
    name: 'Decision',
    provider: 'mock',
    model: decisionProviderInfo('mock').models[0],
    questions: [
      {
        name: 'route',
        type: 'choice',
        instructions: 'What kind of message is this?',
        options: [
          { label: 'question', criterion: 'asks for information' },
          { label: 'request', criterion: 'asks for something to be done' },
          { label: 'other', criterion: 'anything else' },
        ],
      },
    ],
  }),
  memory: (index) => ({
    kind: 'memory',
    name: index === 0 ? 'Memory' : `Memory ${index + 1}`,
    mode: 'blackboard',
    wakeReaders: false,
    seed: [],
    maxChars: DEFAULT_MEMORY_CHARS,
  }),
}

const mintId = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`

export const useStore = create<State>((set, get) => {
  const persistSpec = (spec: SwarmSpec) => localStorage.setItem(SPEC_KEY, JSON.stringify(spec))
  const persistLibrary = (library: BlockDef[]) => localStorage.setItem(LIBRARY_KEY, JSON.stringify(library))

  const HISTORY_DEPTH = 50

  /** The last coalescing edit: which field, and when. */
  let lastBurst: { key: string; at: number } | null = null
  const BURST_MS = 1500

  /**
   * `history: false` for edits that fire on every keystroke (the task text, the round budget).
   * Recording those would fill the undo stack with single characters and bury the structural change
   * the user actually wants back.
   *
   * `coalesce` is for fields that are typed AND structural — a condition's value, a link's budget, a
   * block's model override. Out of the history they could not be undone; in it, one keystroke per
   * step, they pushed real steps off the 50-deep stack (the reviewer of the inspector caught it).
   * So a burst of edits to the same field is ONE step: the snapshot from before the burst.
   */
  const mutate = (fn: (spec: SwarmSpec) => SwarmSpec, options: { history?: boolean; coalesce?: string } = {}) => {
    const previous = get().spec
    const spec = fn(structuredClone(previous))
    persistSpec(spec)
    if (options.history === false) {
      set({ spec })
      return
    }
    const now = Date.now()
    if (options.coalesce && lastBurst?.key === options.coalesce && now - lastBurst.at < BURST_MS) {
      lastBurst.at = now
      set({ spec, future: [] })
      return
    }
    lastBurst = options.coalesce ? { key: options.coalesce, at: now } : null
    set((s) => ({ spec, past: [...s.past, previous].slice(-HISTORY_DEPTH), future: [] }))
  }

  /**
   * The same, aimed at whichever graph the canvas shows. Editing inside a block edits its
   * definition, so every instance of the block changes with it — like a component.
   */
  const mutateGraph = (fn: (graph: Graph) => void, options: { history?: boolean; coalesce?: string } = {}) =>
    mutate((spec) => {
      fn(graphIn(spec, get().editingBlockId))
      return spec
    }, options)

  const initialSpec = load<SwarmSpec>(SPEC_KEY, DEFAULT_SPEC)
  const current = () => graphIn(get().spec, get().editingBlockId)

  const nameOf = (graph: Graph, id: string) =>
    graph.agents.find((a) => a.id === id)?.name ?? nodesOf(graph).find((n) => n.id === id)?.name ?? id

  const kindOf = (graph: Graph, id: string): 'agent' | FlowNodeKind | undefined =>
    graph.agents.some((a) => a.id === id) ? 'agent' : nodesOf(graph).find((n) => n.id === id)?.kind

  const clearedRun = {
    transcript: [],
    statuses: {},
    nestedStatuses: {},
    round: 0,
    transit: [],
    runGraph: EMPTY_RUN_GRAPH,
    memoryEntries: {},
    gates: [],
    outputs: [],
    flashes: {},
    skippedLinks: [],
    decisions: {},
  }

  /**
   * Ends the current run for good.
   *
   * Bumping the generation matters as much as the abort: a runner that is mid-stream will still
   * deliver a few callbacks, and without the bump they land in whatever swarm replaced it —
   * a probe caught exactly that, loading a preset mid-run left messages signed by agents that no
   * longer existed.
   */
  const haltRun = () => {
    runSeq++
    session?.resume()
    session = null
    controller?.abort()
    controller = null
  }

  /**
   * Starts a loop over the swarm. `start` throws away the previous session; `continueFrom` keeps it,
   * which is what lets a finished run pick up with every agent's memory intact.
   */
  const launch = (state: State, options: { startFrom?: string[]; keepTranscript?: boolean }) => {
    const { spec, keys, endpoints, decisionEndpoints } = state
    controller?.abort()
    controller = new AbortController()
    if (!options.keepTranscript || !session) session = createRunSession()

    set({
      ...(options.keepTranscript
        ? { runGraph: EMPTY_RUN_GRAPH, gates: [], skippedLinks: [], nestedStatuses: {} }
        : clearedRun),
      round: 0,
      error: undefined,
      notice: undefined,
      transit: [],
      phase: 'running',
    })

    // Everything below belongs to THIS generation. A callback from an older runner is dropped.
    const mine = ++runSeq
    const fresh = () => mine === runSeq
    let transitTimer: ReturnType<typeof setTimeout> | undefined
    let injected = 0

    void runSwarm(
      spec,
      keys,
      {
        onPhase: (phase, detail) => fresh() && set({ phase, error: detail }),
        onRound: (round) => fresh() && set({ round, skippedLinks: [] }),
        onAgentStatus: (agentId, status, path) => {
          if (!fresh()) return
          if (path && path.length > 0) {
            const key = [...path, agentId].join('/')
            set((s) => ({ nestedStatuses: { ...s.nestedStatuses, [key]: status } }))
          } else {
            set((s) => ({ statuses: { ...s.statuses, [agentId]: status } }))
          }
        },
        onMessageStart: (entry) => fresh() && set((s) => ({ transcript: [...s.transcript, entry] })),
        onMessageDelta: (entryId, delta) =>
          fresh() &&
          set((s) => ({
            transcript: s.transcript.map((e) => (e.id === entryId ? { ...e, text: e.text + delta } : e)),
          })),
        onMessageEnd: (entryId, patch) =>
          fresh() &&
          set((s) => ({ transcript: s.transcript.map((e) => (e.id === entryId ? { ...e, ...patch } : e)) })),
        onMessageReset: (entryId) =>
          fresh() &&
          set((st) => ({
            transcript: st.transcript.map((e) => (e.id === entryId ? { ...e, text: '' } : e)),
          })),
        onNotice: (notice) => fresh() && set({ notice }),
        // A human message takes its place in the transcript, so the order of the conversation is
        // the real one and not "everything the agents said, plus something I typed somewhere".
        onInjection: (injection) =>
          fresh() &&
          set((s) => ({
            transcript: [
              ...s.transcript,
              {
                id: `h${mine}-${++injected}`,
                round: injection.round,
                agentId: injection.agentId,
                kind: 'human' as const,
                to: [injection.agentId],
                text: injection.text,
                status: 'complete' as const,
                tokensIn: 0,
                tokensOut: 0,
                startedAt: Date.now(),
                endedAt: Date.now(),
              },
            ],
          })),
        onTransit: (packets) => {
          if (!fresh()) return
          // A link inside a block is not on this canvas, and its id may even collide with one that is.
          const visible = packets.filter((p) => !p.path || p.path.length === 0)
          if (visible.length === 0) return
          set({ transit: visible })
          clearTimeout(transitTimer)
          transitTimer = setTimeout(() => fresh() && set({ transit: [] }), 900)
        },
        onSpawn: (event) => {
          if (!fresh() || event.path.length > 0) return
          set((s) => ({
            runGraph: {
              agents: 'kind' in event.node ? s.runGraph.agents : [...s.runGraph.agents, event.node],
              nodes: 'kind' in event.node ? [...s.runGraph.nodes, event.node] : s.runGraph.nodes,
              links: [...s.runGraph.links, event.link],
            },
          }))
        },
        onMemoryWrite: (event) => {
          if (!fresh() || event.path.length > 0) return
          set((s) => ({
            memoryEntries: { ...s.memoryEntries, [event.memoryId]: [...(s.memoryEntries[event.memoryId] ?? []), event.entry] },
            flashes: { ...s.flashes, [event.memoryId]: Date.now() },
          }))
        },
        onDecision: (event) => {
          if (!fresh() || event.path.length > 0) return
          set((s) => ({
            decisions: { ...s.decisions, [event.nodeId]: event.answers },
            flashes: { ...s.flashes, [event.nodeId]: Date.now() },
          }))
        },
        onNodeFired: (event) => {
          if (!fresh() || event.path.length > 0) return
          set((s) => ({ flashes: { ...s.flashes, [event.nodeId]: Date.now() } }))
        },
        onBranch: (event) => {
          if (!fresh() || event.path.length > 0 || event.skipped.length === 0) return
          set((s) => ({ skippedLinks: [...new Set([...s.skippedLinks, ...event.skipped])] }))
        },
        onHumanGate: (gate) => fresh() && set((s) => ({ gates: [...s.gates, gate] })),
        onGateClosed: (event) => fresh() && set((s) => ({ gates: s.gates.filter((g) => g.id !== event.id) })),
        onOutput: (event) => fresh() && set((s) => ({ outputs: [...s.outputs, event] })),
      },
      controller.signal,
      { endpoints, decisionEndpoints, session, startFrom: options.startFrom, library: [...BUILTIN_BLOCKS, ...state.library] },
    )
  }

  return {
    spec: initialSpec,
    // An agent is selected from the first frame on purpose: with nothing selected, the panel shows
    // only a hint, so the model and the prompt — the two things you came for — are invisible.
    selectedId: initialSpec.agents[0]?.id,
    multiIds: [],
    past: [],
    future: [],
    phase: 'idle',
    round: 0,
    statuses: {},
    nestedStatuses: {},
    transcript: [],
    transit: [],
    keys: load(KEYS_KEY, {}),
    endpoints: load(ENDPOINTS_KEY, {}),
    decisionEndpoints: load(DECISION_ENDPOINTS_KEY, {}),
    discoveredModels: load(MODELS_KEY, {}),
    themeMode: load<'light' | 'dark'>(THEME_KEY, 'dark'),
    graphEpoch: 0,
    library: load<BlockDef[]>(LIBRARY_KEY, []),
    runGraph: EMPTY_RUN_GRAPH,
    memoryEntries: {},
    gates: [],
    outputs: [],
    flashes: {},
    skippedLinks: [],
    decisions: {},

    // Typed character by character, so it stays out of the undo stack.
    setSpec: (patch) => mutate((spec) => ({ ...spec, ...patch }), { history: false }),

    loadPreset: (preset) => {
      haltRun()
      const spec = structuredClone(preset)
      persistSpec(spec)
      set((s) => ({
        ...clearedRun,
        spec,
        phase: 'idle',
        error: undefined,
        notice: undefined,
        selectedId: spec.agents[0]?.id,
        selectedLinkId: undefined,
        editingBlockId: undefined,
        multiIds: [],
        past: [],
        future: [],
        graphEpoch: s.graphEpoch + 1,
      }))
    },

    addAgent: () => {
      const id = `a${Date.now().toString(36)}`
      mutateGraph((graph) => {
        const index = graph.agents.length
        graph.agents.push({
          id,
          name: `Agent ${index + 1}`,
          provider: 'mock',
          model: 'demo-fast',
          systemPrompt: 'You are a careful specialist. Answer in one short paragraph.',
          temperature: 0.7,
          hue: HUES[index % HUES.length],
          position: { x: 120 + (index % 3) * 260, y: 60 + Math.floor(index / 3) * 180 },
        })
      })
      set({ selectedId: id, selectedLinkId: undefined })
    },

    updateAgent: (id, patch) =>
      mutateGraph(
        (graph) => {
          graph.agents = graph.agents.map((a) => (a.id === id ? { ...a, ...patch } : a))
        },
        // Text fields fire on every keystroke. Recorded, twenty characters of prompt would push the
        // real structural step (a deleted agent) out of a 50-deep stack — so Ctrl+Z would stop being
        // able to bring it back. A probe caught exactly that. Inside a focused field the browser's
        // own undo still works on the text.
        { history: !isTextOnly(patch) },
      ),

    removeAgent: (id) => get().removeAgents([id]),

    removeAgents: (ids) => {
      const doomed = new Set(ids)
      if (doomed.size === 0) return
      mutateGraph((graph) => {
        graph.agents = graph.agents.filter((a) => !doomed.has(a.id))
        graph.nodes = nodesOf(graph).filter((n) => !doomed.has(n.id))
        // Links and entry points that pointed at a deleted node would otherwise linger as
        // references to nothing, which the engine would then try to resolve.
        graph.links = graph.links.filter((l) => !doomed.has(l.source) && !doomed.has(l.target))
        graph.entryIds = graph.entryIds.filter((e) => !doomed.has(e))
      })
      set((s) => ({
        selectedId: s.selectedId && doomed.has(s.selectedId) ? undefined : s.selectedId,
        multiIds: s.multiIds.filter((m) => !doomed.has(m)),
      }))
    },

    addNode: (kind, position) => {
      const id = mintId('n')
      mutateGraph((graph) => {
        const nodes = nodesOf(graph)
        const index = nodes.filter((n) => n.kind === kind).length
        const count = graph.agents.length + nodes.length
        const at = position ?? { x: 140 + (count % 4) * 220, y: 320 + Math.floor(count / 4) * 150 }
        const node = { ...NODE_DEFAULTS[kind](index), id, position: at } as FlowNode
        // The key is already there: a new Decision node starts on the real model, not the demo.
        if (node.kind === 'decision' && get().keys.openrouter?.trim()) {
          node.provider = 'openrouter'
          node.model = decisionProviderInfo('openrouter').models[0]
        }
        graph.nodes = [...nodes, node]
      })
      set({ selectedId: id, selectedLinkId: undefined })
      return id
    },

    updateNode: (id, patch) => {
      const keys = Object.keys(patch)
      const typedOnly = keys.length > 0 && keys.every((k) => TYPED_NODE_FIELDS.has(k))
      mutateGraph(
        (graph) => {
          graph.nodes = nodesOf(graph).map((n) => {
            if (n.id !== id) return n
            const next = { ...n, ...patch } as Record<string, unknown>
            // `undefined` in a patch means "remove the field", as for links.
            for (const key of keys) if ((patch as Record<string, unknown>)[key] === undefined) delete next[key]
            return next as unknown as FlowNode
          })
        },
        typedOnly ? { history: false } : { coalesce: `node:${id}:${keys.sort().join(',')}` },
      )
    },

    duplicateAgent: (id) => {
      const source = current().agents.find((a) => a.id === id)
      if (!source) return
      const copy: Agent = {
        ...structuredClone(source),
        id: `a${Date.now().toString(36)}`,
        name: `${source.name} copy`,
        position: { x: source.position.x + 60, y: source.position.y + 60 },
      }
      mutateGraph((graph) => {
        graph.agents.push(copy)
      })
      set({ selectedId: copy.id })
    },

    pasteAgents: (incoming) => {
      const graph = current()
      if (incoming.agents.length === 0 && (incoming.nodes ?? []).length === 0) return 0
      const taken = new Set([...graph.agents.map((a) => a.id), ...nodesOf(graph).map((n) => n.id)])
      const stamp = Date.now().toString(36)
      const { agents, links, nodes } = rekey(incoming, taken, (index) => `p${stamp}${index}`)
      mutate((spec) => {
        const target = graphIn(spec, get().editingBlockId)
        target.agents.push(...agents)
        target.nodes = [...nodesOf(target), ...nodes]
        target.links.push(...links)
        // A pasted block node is useless without its definition; an existing one is never overwritten.
        const known = new Set((spec.blocks ?? []).map((b) => b.id))
        const missing = (incoming.blocks ?? []).filter((b) => !known.has(b.id))
        if (missing.length > 0) spec.blocks = [...(spec.blocks ?? []), ...missing]
        return spec
      })
      set({ selectedId: agents[0]?.id ?? nodes[0]?.id, multiIds: agents.map((a) => a.id) })
      return agents.length + nodes.length
    },

    replaceSwarm: (incoming) => {
      haltRun()
      const next = structuredClone(incoming)
      const previous = get().spec
      persistSpec(next)
      set((s) => ({
        ...clearedRun,
        spec: next,
        phase: 'idle',
        error: undefined,
        notice: undefined,
        selectedId: next.agents[0]?.id,
        selectedLinkId: undefined,
        editingBlockId: undefined,
        multiIds: [],
        past: [...s.past, previous].slice(-HISTORY_DEPTH),
        future: [],
        graphEpoch: s.graphEpoch + 1,
      }))
    },

    applyToAgents: (ids, patch) => {
      const targets = new Set(ids)
      if (targets.size === 0) return
      mutateGraph((graph) => {
        graph.agents = graph.agents.map((a) => (targets.has(a.id) ? { ...a, ...patch } : a))
      })
    },

    // Dragging is continuous but `moveAgent` only fires on drag end, so one drag is one undo step.
    moveAgent: (id, position) =>
      mutateGraph((graph) => {
        graph.agents = graph.agents.map((a) => (a.id === id ? { ...a, position } : a))
        graph.nodes = nodesOf(graph).map((n) => (n.id === id ? { ...n, position } : n))
      }),

    /**
     * Draws a link, and decides what KIND of link it is from its two ends: touching a memory makes
     * it an access link (and only an agent may sit at the other end), a condition's first two
     * outgoing links are its `true` and `false` sides, a gate's are `approved` and `rejected`.
     */
    addLink: (source, target) => {
      const graph = current()
      const from = kindOf(graph, source)
      const to = kindOf(graph, target)
      if (source === target || !from || !to) return
      if (from === 'memory' || to === 'memory') {
        const other = from === 'memory' ? to : from
        if (other !== 'agent') {
          set({ notice: 'A memory connects to agents only: draw the link from an agent, or to one.' })
          return
        }
        const reverse = graph.links.find((l) => l.kind === 'access' && l.source === target && l.target === source)
        if (reverse) {
          // Drawing the second direction of an existing access link means "both".
          get().updateLink(reverse.id, { access: 'readwrite' })
          return
        }
        if (graph.links.some((l) => l.kind === 'access' && l.source === source && l.target === target)) return
        mutateGraph((g) => {
          g.links.push({ id: mintId('l'), source, target, kind: 'access' })
        })
        return
      }
      if (from === 'output') {
        set({ notice: 'An output ends the flow: nothing leaves it.' })
        return
      }
      mutateGraph((g) => {
        if (g.links.some((l) => l.kind !== 'access' && l.source === source && l.target === target)) return
        const link: Link = { id: mintId('l'), source, target }
        const used = g.links.filter((l) => l.source === source).map((l) => l.label)
        if (from === 'condition') link.label = used.includes('true') ? 'false' : 'true'
        if (from === 'human') link.label = used.includes('approved') ? 'rejected' : 'approved'
        g.links.push(link)
      })
    },

    updateLink: (id, patch) =>
      mutateGraph(
        (graph) => {
          graph.links = graph.links.map((l) => {
            if (l.id !== id) return l
            const next = { ...l, ...patch }
            // `undefined` in a patch means "remove the field", so the saved JSON stays clean.
            for (const key of Object.keys(patch) as Array<keyof Link>) if (patch[key] === undefined) delete next[key]
            return next
          })
        },
        { coalesce: `link:${id}:${Object.keys(patch).sort().join(',')}` },
      ),

    removeLink: (id) => {
      mutateGraph((graph) => {
        graph.links = graph.links.filter((l) => l.id !== id)
      })
      set((s) => ({ selectedLinkId: s.selectedLinkId === id ? undefined : s.selectedLinkId }))
    },

    toggleEntry: (id) =>
      mutateGraph((graph) => {
        graph.entryIds = graph.entryIds.includes(id) ? graph.entryIds.filter((e) => e !== id) : [...graph.entryIds, id]
      }),

    select: (selectedId) => set({ selectedId, ...(selectedId ? { selectedLinkId: undefined } : {}) }),

    selectLink: (selectedLinkId) => set({ selectedLinkId, ...(selectedLinkId ? { selectedId: undefined } : {}) }),

    toggleMulti: (id) =>
      set((s) => ({
        multiIds: s.multiIds.includes(id) ? s.multiIds.filter((m) => m !== id) : [...s.multiIds, id],
      })),

    setMulti: (ids) => set({ multiIds: ids }),

    /**
     * Undo restores the previous *structure* while keeping the fields deliberately left out of the
     * history. Without this, typing the task after adding an agent and then undoing would silently
     * throw the text away too: the snapshot predates it, so it has no idea it exists.
     */
    undo: () =>
      set((s) => {
        const previous = s.past.at(-1)
        if (!previous) return s
        const restored = preserveTypedText(previous, s.spec)
        persistSpec(restored)
        return {
          spec: restored,
          past: s.past.slice(0, -1),
          future: [s.spec, ...s.future].slice(0, HISTORY_DEPTH),
          // The block being edited may not exist in the restored spec.
          editingBlockId: restored.blocks?.some((b) => b.id === s.editingBlockId) ? s.editingBlockId : undefined,
        }
      }),

    redo: () =>
      set((s) => {
        const next = s.future[0]
        if (!next) return s
        const restored = preserveTypedText(next, s.spec)
        persistSpec(restored)
        return {
          spec: restored,
          past: [...s.past, s.spec].slice(-HISTORY_DEPTH),
          future: s.future.slice(1),
          editingBlockId: restored.blocks?.some((b) => b.id === s.editingBlockId) ? s.editingBlockId : undefined,
        }
      }),

    dismissNotice: () => set({ notice: undefined }),
    setTopology: (topology) => mutate((spec) => ({ ...spec, topology })),

    setKey: (slot, value) => {
      const keys = { ...get().keys, [slot]: value }
      localStorage.setItem(KEYS_KEY, JSON.stringify(keys))
      set({ keys })
    },

    setEndpoint: (provider, value) => {
      const endpoints = { ...get().endpoints, [provider]: value }
      localStorage.setItem(ENDPOINTS_KEY, JSON.stringify(endpoints))
      set({ endpoints })
    },

    setDecisionEndpoint: (provider, value) => {
      const decisionEndpoints = { ...get().decisionEndpoints, [provider]: value }
      localStorage.setItem(DECISION_ENDPOINTS_KEY, JSON.stringify(decisionEndpoints))
      set({ decisionEndpoints })
    },

    setDiscoveredModels: (provider, models) => {
      const discoveredModels = { ...get().discoveredModels, [provider]: models }
      localStorage.setItem(MODELS_KEY, JSON.stringify(discoveredModels))
      set({ discoveredModels })
    },

    toggleTheme: () => {
      const themeMode = get().themeMode === 'dark' ? 'light' : 'dark'
      localStorage.setItem(THEME_KEY, JSON.stringify(themeMode))
      set({ themeMode })
    },

    openBlock: (blockId) => {
      if (blockId && !get().spec.blocks?.some((b) => b.id === blockId)) {
        // A built-in or a library block has to be in the swarm before its inside can be edited.
        const def = [...BUILTIN_BLOCKS, ...get().library].find((b) => b.id === blockId)
        if (!def) return
        mutate((spec) => ({ ...spec, blocks: [...(spec.blocks ?? []), structuredClone(def)] }))
      }
      set({ editingBlockId: blockId, selectedId: undefined, selectedLinkId: undefined, multiIds: [] })
    },

    insertBlock: (def, position) => {
      const id = mintId('b')
      mutate((spec) => {
        if (!spec.blocks?.some((b) => b.id === def.id)) spec.blocks = [...(spec.blocks ?? []), structuredClone(def)]
        const graph = graphIn(spec, get().editingBlockId)
        const count = graph.agents.length + nodesOf(graph).length
        graph.nodes = [
          ...nodesOf(graph),
          {
            id,
            kind: 'block',
            name: def.name,
            blockId: def.id,
            position: position ?? { x: 160 + (count % 4) * 220, y: 320 + Math.floor(count / 4) * 150 },
          },
        ]
        return spec
      })
      set({ selectedId: id, selectedLinkId: undefined })
      return id
    },

    saveBlock: (ids, name, description) => {
      const graph = current()
      const keep = new Set(ids)
      const agents = graph.agents.filter((a) => keep.has(a.id))
      const nodes = nodesOf(graph).filter((n) => keep.has(n.id))
      if (agents.length + nodes.length === 0 || !name.trim()) return undefined
      // Positions are made relative to the selection, so the inside opens framed.
      const all = [...agents, ...nodes]
      const minX = Math.min(...all.map((n) => n.position.x))
      const minY = Math.min(...all.map((n) => n.position.y))
      const shift = <T extends { position: { x: number; y: number } }>(n: T): T => ({
        ...structuredClone(n),
        position: { x: n.position.x - minX, y: n.position.y - minY },
      })
      const def: BlockDef = {
        id: mintId('blk-'),
        name: name.trim(),
        description: description.trim(),
        graph: {
          agents: agents.map(shift),
          nodes: nodes.map(shift),
          links: structuredClone(graph.links.filter((l) => keep.has(l.source) && keep.has(l.target))),
          entryIds: graph.entryIds.filter((id) => keep.has(id)),
        },
      }
      mutate((spec) => ({ ...spec, blocks: [...(spec.blocks ?? []), def] }))
      const library = [...get().library, def]
      persistLibrary(library)
      set({ library, notice: `Saved "${def.name}" as a block. It is in the library, ready to drop anywhere.` })
      return def
    },

    deleteLibraryBlock: (id) => {
      const library = get().library.filter((b) => b.id !== id)
      persistLibrary(library)
      set({ library })
    },

    detachBlock: (nodeId) => {
      const graph = current()
      const node = nodesOf(graph).find((n) => n.id === nodeId)
      if (!node || node.kind !== 'block') return
      const def =
        get().spec.blocks?.find((b) => b.id === node.blockId) ??
        [...BUILTIN_BLOCKS, ...get().library].find((b) => b.id === node.blockId)
      if (!def) return
      const inner = def.graph
      const stamp = Date.now().toString(36)
      // Every id is minted afresh, not only the colliding ones: detaching the same block twice must
      // not give two copies that share ids with each other.
      const ids = new Map<string, string>()
      const fresh = (id: string) => {
        if (!ids.has(id)) ids.set(id, `d${stamp}${ids.size}`)
        return ids.get(id)!
      }
      const at = (p: { x: number; y: number }) => ({ x: node.position.x + p.x, y: node.position.y + p.y })
      // The block's Output nodes existed to say what it returns. Inline, what reached them simply
      // carries on along the links that used to leave the block, so they go.
      const outputs = new Set(nodesOf(inner).filter((n) => n.kind === 'output').map((n) => n.id))
      const agents = inner.agents.map((a) => ({ ...structuredClone(a), id: fresh(a.id), position: at(a.position) }))
      const nodes = nodesOf(inner)
        .filter((n) => !outputs.has(n.id))
        .map((n) => ({ ...structuredClone(n), id: fresh(n.id), position: at(n.position) }))
      const links = inner.links
        .filter((l) => !outputs.has(l.target))
        .map((l, i) => ({ ...structuredClone(l), id: `d${stamp}l${i}`, source: fresh(l.source), target: fresh(l.target) }))
      const entries = resolveEntryIds(inner).map(fresh)
      const exits =
        outputs.size > 0
          ? [...new Set(inner.links.filter((l) => outputs.has(l.target)).map((l) => fresh(l.source)))]
          : inner.agents.filter((a) => !inner.links.some((l) => l.source === a.id && l.kind !== 'access')).map((a) => fresh(a.id))
      mutateGraph((g) => {
        const incoming = g.links.filter((l) => l.target === nodeId)
        const outgoing = g.links.filter((l) => l.source === nodeId)
        g.links = g.links.filter((l) => l.source !== nodeId && l.target !== nodeId)
        g.nodes = [...nodesOf(g).filter((n) => n.id !== nodeId), ...nodes]
        g.agents.push(...agents)
        g.links.push(...links)
        // What went INTO the block now goes into its entry points; what left it now leaves its exits.
        incoming.forEach((l, i) => entries.forEach((e, j) => g.links.push({ ...l, id: `d${stamp}i${i}-${j}`, target: e })))
        outgoing.forEach((l, i) => exits.forEach((x, j) => g.links.push({ ...l, id: `d${stamp}o${i}-${j}`, source: x })))
        g.entryIds = g.entryIds.flatMap((id) => (id === nodeId ? entries : [id]))
      })
      set({ selectedId: agents[0]?.id })
    },

    keepSpawned: () => {
      const { runGraph } = get()
      const count = runGraph.agents.length + runGraph.nodes.length
      if (count === 0) return 0
      mutate((spec) => {
        const taken = new Set([...spec.agents.map((a) => a.id), ...nodesOf(spec).map((n) => n.id)])
        const clean = (id: string) => id.replace(/~/g, '-')
        const agents = runGraph.agents.filter((a) => !taken.has(clean(a.id))).map((a) => ({ ...a, id: clean(a.id) }))
        const nodes = runGraph.nodes.filter((n) => !taken.has(clean(n.id))).map((n) => ({ ...n, id: clean(n.id) }))
        spec.agents.push(...agents)
        spec.nodes = [...nodesOf(spec), ...nodes]
        // A kept helper becomes an ordinary agent downstream of the one that created it.
        for (const link of runGraph.links) {
          const { label: _label, ...rest } = link
          spec.links.push({ ...rest, id: clean(link.id), source: clean(link.source), target: clean(link.target) })
        }
        return spec
      })
      set({ runGraph: EMPTY_RUN_GRAPH, notice: `Kept ${count} spawned ${count === 1 ? 'node' : 'nodes'} in the swarm.` })
      return count
    },

    decideGate: (id, decision) => {
      session?.decideGate(id, decision)
    },

    reset: () => {
      haltRun()
      set({ ...clearedRun, phase: 'idle', error: undefined })
    },

    stop: () => {
      // Resume first: a paused runner is parked on the gate, and aborting alone would leave it there.
      session?.resume()
      controller?.abort()
      controller = null
    },

    pause: () => session?.pause(),

    resume: () => {
      session?.resume()
      if (get().phase === 'paused') set({ phase: 'running' })
    },

    inject: (agentId, text) => {
      const trimmed = text.trim()
      if (trimmed === '' || !session) return
      session.inject(agentId, trimmed)
      set({ notice: `Message queued for ${nameOf(get().spec, agentId)} — delivered next round.` })
    },

    continueFrom: (agentId, text) => {
      // A finished run keeps its session, so continuing is a fresh loop over the SAME memory.
      const trimmed = text.trim()
      if (!session) return get().start()
      session.resume()
      if (trimmed !== '') session.inject(agentId, trimmed)
      launch(get(), { startFrom: [agentId], keepTranscript: true })
    },

    start: () => {
      // A run is always the swarm, never the inside of a block you happen to be editing.
      launch(get(), {})
    },
  }
})

/** The graph the canvas and the inspector are editing. */
export function useGraph(): Graph {
  const spec = useStore((s) => s.spec)
  const editingBlockId = useStore((s) => s.editingBlockId)
  return graphIn(spec, editingBlockId)
}

/** Every block you can drop: this swarm's, this browser's, and the built-ins, without duplicates. */
export function allBlocks(spec: SwarmSpec, library: BlockDef[]): Array<BlockDef & { source: 'swarm' | 'saved' | 'builtin' }> {
  const seen = new Set<string>()
  const out: Array<BlockDef & { source: 'swarm' | 'saved' | 'builtin' }> = []
  for (const [source, list] of [
    ['swarm', spec.blocks ?? []],
    ['saved', library],
    ['builtin', BUILTIN_BLOCKS],
  ] as const) {
    for (const block of list) {
      if (seen.has(block.id)) continue
      seen.add(block.id)
      out.push({ ...block, source })
    }
  }
  return out
}

/**
 * Totals for the header gauges. Tokens are estimates unless the provider reported usage.
 * Selectors return stable references on purpose: a fresh object on every render loops under zustand v5.
 */
export function useTotals() {
  const transcript = useStore((s) => s.transcript)
  const rounds = useStore((s) => s.round)
  let tokensIn = 0
  let tokensOut = 0
  for (const entry of transcript) {
    tokensIn += entry.tokensIn
    tokensOut += entry.tokensOut
  }
  return { messages: transcript.length, tokensIn, tokensOut, rounds }
}
