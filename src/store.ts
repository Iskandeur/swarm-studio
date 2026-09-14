import { create } from 'zustand'
import type { Agent, AgentStatus, Link, ProviderId, RunPhase, SwarmSpec, Topology, TranscriptEntry } from './types'
import { DEFAULT_SPEC } from './presets'
import { runSwarm, type TransitPacket } from './engine/runner'
import { createRunSession, type RunSession } from './engine/session'
import { rekey } from './engine/portable'

const SPEC_KEY = 'swarm-studio.spec.v1'
const KEYS_KEY = 'swarm-studio.keys.v1'
const THEME_KEY = 'swarm-studio.theme.v1'
const ENDPOINTS_KEY = 'swarm-studio.endpoints.v1'
const MODELS_KEY = 'swarm-studio.models.v1'

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
  }
}

interface State {
  spec: SwarmSpec
  phase: RunPhase
  round: number
  error?: string
  statuses: Record<string, AgentStatus>
  transcript: TranscriptEntry[]
  /** Messages in flight, with their direction along the link. */
  transit: TransitPacket[]
  selectedId?: string
  /** Extra agents ticked in the roster. Edits then apply to all of them at once. */
  multiIds: string[]
  /** Undo stack of whole specs — small enough that diffing would only add bugs. */
  past: SwarmSpec[]
  future: SwarmSpec[]
  /** Transient, non-fatal message from a run (e.g. a model that refused a parameter). */
  notice?: string
  keys: Partial<Record<ProviderId, string>>
  /** Per-provider endpoint override. Typed by the user, kept in this browser only. */
  endpoints: Partial<Record<ProviderId, string>>
  /** Models discovered from an endpoint's /models, offered as autocomplete options. */
  discoveredModels: Partial<Record<ProviderId, string[]>>
  themeMode: 'light' | 'dark'

  setSpec: (patch: Partial<SwarmSpec>) => void
  loadPreset: (spec: SwarmSpec) => void
  addAgent: () => void
  updateAgent: (id: string, patch: Partial<Agent>) => void
  removeAgent: (id: string) => void
  moveAgent: (id: string, position: { x: number; y: number }) => void
  addLink: (source: string, target: string) => void
  removeLink: (id: string) => void
  toggleEntry: (id: string) => void
  select: (id?: string) => void
  toggleMulti: (id: string) => void
  setMulti: (ids: string[]) => void
  /** Applies one patch to every agent in `ids` — the point of the multi-selection. */
  applyToAgents: (ids: string[], patch: Partial<Agent>) => void
  duplicateAgent: (id: string) => void
  removeAgents: (ids: string[]) => void
  /** Drops a pasted clipping into the current swarm, re-keying whatever collides. */
  pasteAgents: (incoming: { agents: Agent[]; links: Link[] }) => number
  /** Replaces the whole swarm with a pasted one. */
  replaceSwarm: (spec: SwarmSpec) => void
  undo: () => void
  redo: () => void
  dismissNotice: () => void
  setTopology: (topology: Topology) => void
  setKey: (provider: ProviderId, value: string) => void
  setEndpoint: (provider: ProviderId, value: string) => void
  setDiscoveredModels: (provider: ProviderId, models: string[]) => void
  toggleTheme: () => void
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

export const useStore = create<State>((set, get) => {
  const persistSpec = (spec: SwarmSpec) => localStorage.setItem(SPEC_KEY, JSON.stringify(spec))

  const HISTORY_DEPTH = 50

  /**
   * `history: false` for edits that fire on every keystroke (the task text, the round budget).
   * Recording those would fill the undo stack with single characters and bury the structural change
   * the user actually wants back.
   */
  const mutate = (fn: (spec: SwarmSpec) => SwarmSpec, options: { history?: boolean } = {}) => {
    const previous = get().spec
    const spec = fn(structuredClone(previous))
    persistSpec(spec)
    if (options.history === false) {
      set({ spec })
      return
    }
    set((s) => ({ spec, past: [...s.past, previous].slice(-HISTORY_DEPTH), future: [] }))
  }

  const initialSpec = load<SwarmSpec>(SPEC_KEY, DEFAULT_SPEC)

  const nameOf = (spec: SwarmSpec, id: string) => spec.agents.find((a) => a.id === id)?.name ?? id

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
  const launch = (
    state: State,
    options: { startFrom?: string[]; keepTranscript?: boolean },
  ) => {
    const { spec, keys, endpoints } = state
    controller?.abort()
    controller = new AbortController()
    if (!options.keepTranscript || !session) session = createRunSession()

    set({
      ...(options.keepTranscript ? {} : { transcript: [], statuses: {} }),
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
        onRound: (round) => fresh() && set({ round }),
        onAgentStatus: (agentId, status) =>
          fresh() && set((s) => ({ statuses: { ...s.statuses, [agentId]: status } })),
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
          set({ transit: packets })
          clearTimeout(transitTimer)
          transitTimer = setTimeout(() => fresh() && set({ transit: [] }), 900)
        },
      },
      controller.signal,
      { endpoints, session, startFrom: options.startFrom },
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
    transcript: [],
    transit: [],
    keys: load(KEYS_KEY, {}),
    endpoints: load(ENDPOINTS_KEY, {}),
    discoveredModels: load(MODELS_KEY, {}),
    themeMode: load<'light' | 'dark'>(THEME_KEY, 'dark'),

    // Typed character by character, so it stays out of the undo stack.
    setSpec: (patch) => mutate((spec) => ({ ...spec, ...patch }), { history: false }),

    loadPreset: (preset) => {
      haltRun()
      const spec = structuredClone(preset)
      persistSpec(spec)
      set({
        spec,
        transcript: [],
        statuses: {},
        round: 0,
        phase: 'idle',
        error: undefined,
        notice: undefined,
        selectedId: spec.agents[0]?.id,
        multiIds: [],
        past: [],
        future: [],
      })
    },

    addAgent: () => {
      const id = `a${Date.now().toString(36)}`
      mutate((spec) => {
        const index = spec.agents.length
        spec.agents.push({
          id,
          name: `Agent ${index + 1}`,
          provider: 'mock',
          model: 'demo-fast',
          systemPrompt: 'You are a careful specialist. Answer in one short paragraph.',
          temperature: 0.7,
          hue: HUES[index % HUES.length],
          position: { x: 120 + (index % 3) * 260, y: 60 + Math.floor(index / 3) * 180 },
        })
        return spec
      })
      set({ selectedId: id })
    },

    updateAgent: (id, patch) =>
      mutate(
        (spec) => {
          spec.agents = spec.agents.map((a) => (a.id === id ? { ...a, ...patch } : a))
          return spec
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
      mutate((spec) => {
        spec.agents = spec.agents.filter((a) => !doomed.has(a.id))
        // Links and entry points that pointed at a deleted agent would otherwise linger as
        // references to nothing, which the engine would then try to resolve.
        spec.links = spec.links.filter((l) => !doomed.has(l.source) && !doomed.has(l.target))
        spec.entryIds = spec.entryIds.filter((e) => !doomed.has(e))
        return spec
      })
      set((s) => ({
        selectedId: s.selectedId && doomed.has(s.selectedId) ? undefined : s.selectedId,
        multiIds: s.multiIds.filter((m) => !doomed.has(m)),
      }))
    },

    duplicateAgent: (id) => {
      const source = get().spec.agents.find((a) => a.id === id)
      if (!source) return
      const copy: Agent = {
        ...structuredClone(source),
        id: `a${Date.now().toString(36)}`,
        name: `${source.name} copy`,
        position: { x: source.position.x + 60, y: source.position.y + 60 },
      }
      mutate((spec) => {
        spec.agents.push(copy)
        return spec
      })
      set({ selectedId: copy.id })
    },

    pasteAgents: (incoming) => {
      if (incoming.agents.length === 0) return 0
      const taken = new Set(get().spec.agents.map((a) => a.id))
      const stamp = Date.now().toString(36)
      const { agents, links } = rekey(incoming, taken, (index) => `p${stamp}${index}`)
      mutate((spec) => {
        spec.agents.push(...agents)
        spec.links.push(...links)
        return spec
      })
      set({ selectedId: agents[0]?.id, multiIds: agents.map((a) => a.id) })
      return agents.length
    },

    replaceSwarm: (incoming) => {
      haltRun()
      const spec = structuredClone(incoming)
      persistSpec(spec)
      set({
        spec,
        transcript: [],
        statuses: {},
        round: 0,
        phase: 'idle',
        error: undefined,
        notice: undefined,
        selectedId: spec.agents[0]?.id,
        multiIds: [],
        past: [],
        future: [],
      })
    },

    applyToAgents: (ids, patch) => {
      const targets = new Set(ids)
      if (targets.size === 0) return
      mutate((spec) => {
        spec.agents = spec.agents.map((a) => (targets.has(a.id) ? { ...a, ...patch } : a))
        return spec
      })
    },

    // Dragging is continuous but `moveAgent` only fires on drag end, so one drag is one undo step.
    moveAgent: (id, position) =>
      mutate((spec) => {
        spec.agents = spec.agents.map((a) => (a.id === id ? { ...a, position } : a))
        return spec
      }),

    addLink: (source, target) =>
      mutate((spec) => {
        if (source === target) return spec
        if (spec.links.some((l) => l.source === source && l.target === target)) return spec
        spec.links.push({ id: `l${Date.now().toString(36)}`, source, target } satisfies Link)
        return spec
      }),

    removeLink: (id) =>
      mutate((spec) => {
        spec.links = spec.links.filter((l) => l.id !== id)
        return spec
      }),

    toggleEntry: (id) =>
      mutate((spec) => {
        spec.entryIds = spec.entryIds.includes(id) ? spec.entryIds.filter((e) => e !== id) : [...spec.entryIds, id]
        return spec
      }),

    select: (selectedId) => set({ selectedId }),

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
        }
      }),

    redo: () =>
      set((s) => {
        const next = s.future[0]
        if (!next) return s
        const restored = preserveTypedText(next, s.spec)
        persistSpec(restored)
        return { spec: restored, past: [...s.past, s.spec].slice(-HISTORY_DEPTH), future: s.future.slice(1) }
      }),

    dismissNotice: () => set({ notice: undefined }),
    setTopology: (topology) => mutate((spec) => ({ ...spec, topology })),

    setKey: (provider, value) => {
      const keys = { ...get().keys, [provider]: value }
      localStorage.setItem(KEYS_KEY, JSON.stringify(keys))
      set({ keys })
    },

    setEndpoint: (provider, value) => {
      const endpoints = { ...get().endpoints, [provider]: value }
      localStorage.setItem(ENDPOINTS_KEY, JSON.stringify(endpoints))
      set({ endpoints })
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

    reset: () => {
      haltRun()
      set({ transcript: [], statuses: {}, round: 0, phase: 'idle', error: undefined, transit: [] })
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

    start: () => launch(get(), {}),
  }
})

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
