/**
 * The state behind "prompt the graph", shared by every surface that shows it: the hero card on the
 * first screen, the command bar docked under the canvas, and the strip on a phone. One store, so the
 * text you typed in the hero is still there when it collapses into the bar, and a generation started
 * from one surface reports its progress on whichever is visible.
 *
 * Everything that decides what is loaded lives in `engine/graphPrompt.ts`; this is the form state
 * around it, lifted out of the old dialog untouched.
 */
import { create } from 'zustand'
import { useStore } from '../store'
import type { KeyId, ProviderId } from '../types'
import { PROVIDERS, providerInfo } from '../engine/providers'
import { decisionProviderInfo } from '../engine/decisions'
import { promptGraph, type GraphPromptMode } from '../engine/graphPrompt'

const GENERATOR_KEY = 'swarm-studio.generator.v1'

/** One-click starts, per mode. Short enough to read as chips, concrete enough to run as they are. */
export const IDEAS: Record<GraphPromptMode, string[]> = {
  replace: [
    'A support triage: a decision model routes each message to billing, tech or account, and anything it is unsure about escalates to a senior LLM agent.',
    'A writer and a critic that loop until the critic scores the draft 8 or more, then an editor trims it.',
    'A research team sharing a blackboard, with a human gate before anything is published.',
  ],
  edit: [
    'Add a human gate before the output.',
    'Add a shared memory every agent can read and write.',
    'Put a decision model in front that drops messages that are off topic.',
  ],
}

/** The chat providers a generator can use first: whichever already has a key, in this order. */
const PREFERRED: ProviderId[] = ['anthropic', 'openai', 'openrouter', 'custom']

function remembered(): { provider: ProviderId; model: string } | undefined {
  try {
    const raw = localStorage.getItem(GENERATOR_KEY)
    const value = raw ? (JSON.parse(raw) as { provider?: unknown; model?: unknown }) : undefined
    if (value && PROVIDERS.some((p) => p.id === value.provider) && typeof value.model === 'string') {
      return { provider: value.provider as ProviderId, model: value.model }
    }
  } catch {
    /* nothing remembered */
  }
  return undefined
}

export function hasKeyFor(id: ProviderId): boolean {
  return id === 'mock' || Boolean(useStore.getState().keys[id]?.trim())
}

interface ComposerState {
  mode: GraphPromptMode
  provider: ProviderId
  model: string
  instruction: string
  /** The model's answer as it streams, for the preview. */
  raw: string
  problem: string | null
  progress: string | null
  busy: boolean
  /** Whether the generator was picked for this session yet (see `prepare`). */
  prepared: boolean
  setMode: (mode: GraphPromptMode) => void
  setProvider: (provider: ProviderId) => void
  setModel: (model: string) => void
  setInstruction: (text: string) => void
  /** Picks the generator: last used if it still has a key, else the first provider with one, else demo. */
  prepare: () => void
  generate: () => Promise<void>
  cancel: () => void
}

let abort: AbortController | null = null

export const useComposer = create<ComposerState>((set, get) => ({
  mode: 'replace',
  provider: 'mock',
  model: 'demo-fast',
  instruction: '',
  raw: '',
  problem: null,
  progress: null,
  busy: false,
  prepared: false,

  setMode: (mode) => set({ mode }),
  setProvider: (provider) => {
    const discovered = useStore.getState().discoveredModels
    set({
      provider,
      model: provider === 'mock' ? 'demo-fast' : providerInfo(provider).models[0] ?? discovered[provider]?.[0] ?? '',
    })
  },
  setModel: (model) => set({ model }),
  setInstruction: (instruction) => set({ instruction }),

  prepare: () => {
    const { spec, endpoints, discoveredModels } = useStore.getState()
    set({ prepared: true, problem: null, progress: null, raw: '' })
    const last = remembered()
    if (last && hasKeyFor(last.provider)) {
      set({ provider: last.provider, model: last.model })
      return
    }
    const configured = PREFERRED.find((id) => hasKeyFor(id) && (id !== 'custom' || Boolean(endpoints.custom?.trim())))
    if (!configured) {
      set({ provider: 'mock', model: 'demo-fast' })
      return
    }
    set({
      provider: configured,
      model:
        spec.agents.find((a) => a.provider === configured && a.model.trim())?.model ??
        providerInfo(configured).models[0] ??
        discoveredModels[configured]?.[0] ??
        '',
    })
  },

  generate: async () => {
    const { instruction, mode, provider, model } = get()
    const main = useStore.getState()
    abort?.abort()
    const controller = new AbortController()
    abort = controller
    set({ busy: true, problem: null, progress: null, raw: '' })
    if (provider !== 'mock') localStorage.setItem(GENERATOR_KEY, JSON.stringify({ provider, model }))
    const decisionProvider = main.keys.openrouter?.trim() ? 'openrouter' : 'mock'
    try {
      const result = await promptGraph({
        instruction,
        mode,
        provider,
        model,
        apiKey: main.keys[provider] ?? '',
        endpoints: main.endpoints,
        current: main.spec,
        defaults: {
          decisionProvider,
          decisionModel: decisionProviderInfo(decisionProvider).models[0],
        },
        // Whatever this browser holds as a secret must not come back inside a graph.
        secrets: [
          ...Object.values(main.keys as Record<KeyId, string | undefined>),
          ...Object.values(main.endpoints),
          ...Object.values(main.decisionEndpoints),
        ].filter((v): v is string => typeof v === 'string' && v.trim() !== ''),
        signal: controller.signal,
        onDelta: (delta) => set((s) => ({ raw: s.raw + delta })),
        onDiscard: () => set({ raw: '' }),
        onNotice: (message) => set({ progress: message }),
      })
      if (controller.signal.aborted) return
      if (!result.ok) {
        set({ problem: result.error })
        return
      }
      useStore.getState().replaceSwarm(result.spec)
      useStore.setState({
        notice: `${result.note ?? `Loaded "${result.spec.name}"${result.repaired ? ' (after one automatic repair)' : ''}.`} Undo brings the previous swarm back.`,
      })
      // The instruction is consumed: the next thing typed is a new ask, not a rerun of this one.
      set({ instruction: '', raw: '' })
    } finally {
      if (abort === controller) abort = null
      set({ busy: false })
    }
  },

  cancel: () => {
    abort?.abort()
    abort = null
    set({ busy: false, progress: null })
  },
}))

/** Whether Generate can be pressed with what is in the store right now. */
export function canGenerate(s: Pick<ComposerState, 'instruction' | 'busy' | 'provider' | 'model'>): boolean {
  const demo = s.provider === 'mock'
  return s.instruction.trim() !== '' && !s.busy && hasKeyFor(s.provider) && (demo || s.model.trim() !== '')
}
