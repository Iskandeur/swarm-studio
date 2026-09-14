import { create } from 'zustand'
import type { Agent, AgentStatus, Link, ProviderId, RunPhase, SwarmSpec, Topology, TranscriptEntry } from './types'
import { DEFAULT_SPEC } from './presets'
import { runSwarm } from './engine/runner'

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

interface State {
  spec: SwarmSpec
  phase: RunPhase
  round: number
  error?: string
  statuses: Record<string, AgentStatus>
  transcript: TranscriptEntry[]
  /** Link ids currently carrying a message, for the flight animation. */
  transit: string[]
  selectedId?: string
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
  setTopology: (topology: Topology) => void
  setKey: (provider: ProviderId, value: string) => void
  setEndpoint: (provider: ProviderId, value: string) => void
  setDiscoveredModels: (provider: ProviderId, models: string[]) => void
  toggleTheme: () => void
  start: () => void
  stop: () => void
  reset: () => void
}

let controller: AbortController | null = null

export const useStore = create<State>((set, get) => {
  const persistSpec = (spec: SwarmSpec) => localStorage.setItem(SPEC_KEY, JSON.stringify(spec))

  const mutate = (fn: (spec: SwarmSpec) => SwarmSpec) => {
    const spec = fn(structuredClone(get().spec))
    persistSpec(spec)
    set({ spec })
  }

  return {
    spec: load<SwarmSpec>(SPEC_KEY, DEFAULT_SPEC),
    phase: 'idle',
    round: 0,
    statuses: {},
    transcript: [],
    transit: [],
    keys: load(KEYS_KEY, {}),
    endpoints: load(ENDPOINTS_KEY, {}),
    discoveredModels: load(MODELS_KEY, {}),
    themeMode: load<'light' | 'dark'>(THEME_KEY, 'dark'),

    setSpec: (patch) => mutate((spec) => ({ ...spec, ...patch })),

    loadPreset: (preset) => {
      const spec = structuredClone(preset)
      persistSpec(spec)
      set({ spec, transcript: [], statuses: {}, round: 0, phase: 'idle', error: undefined, selectedId: undefined })
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
      mutate((spec) => {
        spec.agents = spec.agents.map((a) => (a.id === id ? { ...a, ...patch } : a))
        return spec
      }),

    removeAgent: (id) => {
      mutate((spec) => {
        spec.agents = spec.agents.filter((a) => a.id !== id)
        spec.links = spec.links.filter((l) => l.source !== id && l.target !== id)
        spec.entryIds = spec.entryIds.filter((e) => e !== id)
        return spec
      })
      if (get().selectedId === id) set({ selectedId: undefined })
    },

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

    reset: () => set({ transcript: [], statuses: {}, round: 0, phase: 'idle', error: undefined, transit: [] }),

    stop: () => {
      controller?.abort()
      controller = null
    },

    start: () => {
      const { spec, keys, endpoints } = get()
      controller?.abort()
      controller = new AbortController()
      set({ transcript: [], statuses: {}, round: 0, error: undefined, transit: [], phase: 'running' })

      let transitTimer: ReturnType<typeof setTimeout> | undefined
      void runSwarm(
        spec,
        keys,
        {
          onPhase: (phase, detail) => set({ phase, error: detail }),
          onRound: (round) => set({ round }),
          onAgentStatus: (agentId, status) => set((s) => ({ statuses: { ...s.statuses, [agentId]: status } })),
          onMessageStart: (entry) => set((s) => ({ transcript: [...s.transcript, entry] })),
          onMessageDelta: (entryId, delta) =>
            set((s) => ({
              transcript: s.transcript.map((e) => (e.id === entryId ? { ...e, text: e.text + delta } : e)),
            })),
          onMessageEnd: (entryId, patch) =>
            set((s) => ({ transcript: s.transcript.map((e) => (e.id === entryId ? { ...e, ...patch } : e)) })),
          onTransit: (linkIds) => {
            set({ transit: linkIds })
            clearTimeout(transitTimer)
            transitTimer = setTimeout(() => set({ transit: [] }), 900)
          },
        },
        controller.signal,
        endpoints,
      )
    },
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
