import type { ProviderId, SwarmSpec } from '../types.ts'
import { PRESETS } from '../presets.ts'
import { exportSwarm, parsePortable, portableToSpec } from './portable.ts'
import { callProvider, providerInfo, resolveEndpoint, type Endpoints } from './providers.ts'
import { extractJson } from './predicates.ts'
import { DEFAULT_MAX_TOKENS } from './runner.ts'

export type GraphPromptMode = 'replace' | 'edit'

export interface PromptGraphOptions {
  instruction: string
  mode: GraphPromptMode
  provider: ProviderId
  model: string
  apiKey: string
  endpoints?: Endpoints
  /** The current swarm, required for mode: edit. */
  current?: SwarmSpec
  signal: AbortSignal
  onDelta?: (text: string) => void
  /** Called when a retry wipes the previous streamed output. */
  onDiscard?: () => void
  /** For UI surfaces: non-fatal explanation of what happened. */
  onNotice?: (message: string) => void
}

export type PromptGraphResult =
  | { ok: true; spec: SwarmSpec; raw: string; repaired: boolean }
  | { ok: false; error: string; raw: string; repaired: boolean }

const SECRETISH = /\b(api[_-]?key|endpoint|bearer|authorization)\b/i

function cleanInstruction(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function exampleSwarmJson(): string {
  // The one that exercises nodes and gates is the best prompt for generation.
  const preset = PRESETS.find((p) => p.name === 'The Fridge Tribunal') ?? PRESETS[0]
  return exportSwarm(preset)
}

function formatSpecSummary(): string {
  const providers = ['mock', 'anthropic', 'openai', 'openrouter', 'custom'].join(', ')
  const nodeKinds = ['condition', 'join', 'output', 'human', 'memory', 'block'].join(', ')
  return [
    'Return ONLY ONE JSON object, no prose, no markdown fences.',
    'It must be a Swarm Studio portable export with: { format:"swarm-studio", version:2, kind:"swarm", name, task, topology, maxRounds, entryIds, agents, nodes, links, blocks }.',
    `agents[].provider must be one of: ${providers}.`,
    `nodes[].kind must be one of: ${nodeKinds}.`,
    'Never include API keys or endpoint URLs anywhere in the JSON. They do not travel.',
  ].join('\n')
}

function buildSystemPrompt(opts: { mode: GraphPromptMode; current?: SwarmSpec }): string {
  const lines: string[] = []
  lines.push('You generate Swarm Studio graphs.')
  lines.push(formatSpecSummary())
  lines.push('')

  if (opts.mode === 'edit') {
    lines.push('Mode: EDIT. You will receive the current swarm JSON and an instruction.')
    lines.push('Rules for edit mode:')
    lines.push('- Keep every existing agent id and node id unchanged.')
    lines.push('- You may add new agents/nodes with new ids, but never rename an existing id.')
    lines.push('- Keep the portable format and the constraints above.')
    lines.push('')
  } else {
    lines.push('Mode: REPLACE. Generate a complete new swarm matching the instruction.')
    lines.push('')
  }

  lines.push('Portable format example (copy the shape, not the content):')
  lines.push(exampleSwarmJson())

  return lines.join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return ''
  }
}

function validatePortableSwarm(text: string): { ok: true; spec: SwarmSpec } | { ok: false; error: string } {
  const result = parsePortable(text)
  if (!result.ok) return { ok: false, error: result.error }
  if (result.value.kind !== 'swarm') return { ok: false, error: 'Expected a whole swarm (kind: "swarm"), not a clipping.' }
  return { ok: true, spec: portableToSpec(result.value) }
}

function ensureEditPreservesIds(next: SwarmSpec, current: SwarmSpec): string | undefined {
  const beforeAgents = new Set(current.agents.map((a) => a.id))
  const afterAgents = new Set(next.agents.map((a) => a.id))
  for (const id of beforeAgents) {
    if (!afterAgents.has(id)) return `Edit mode must preserve agent ids. Missing agent id: ${id}`
  }

  const beforeNodes = new Set((current.nodes ?? []).map((n) => n.id))
  const afterNodes = new Set((next.nodes ?? []).map((n) => n.id))
  for (const id of beforeNodes) {
    if (!afterNodes.has(id)) return `Edit mode must preserve node ids. Missing node id: ${id}`
  }

  return undefined
}

function demoPresetFor(instruction: string): SwarmSpec {
  const lower = instruction.toLowerCase()
  const choose = (name: string) => PRESETS.find((p) => p.name === name)

  const picked =
    (lower.includes('fridge') || lower.includes('memory') || lower.includes('gate') ? choose('The Fridge Tribunal') : undefined) ??
    (lower.includes('delegate') || lower.includes('spawn') ? choose('The Delegation Spiral') : undefined) ??
    (lower.includes('block') || lower.includes('recursive') ? choose('The Recursive Excuse') : undefined) ??
    (lower.includes('manager') ? choose('The Best Man Speech') : undefined) ??
    choose('The Dignity Pipeline') ??
    PRESETS[0]

  // Marked, so nobody confuses it for a real LLM generation.
  return { ...structuredClone(picked), name: `Demo: ${picked.name}` }
}

async function demoGenerate(opts: {
  instruction: string
  mode: GraphPromptMode
  current?: SwarmSpec
  attempt: number
  signal: AbortSignal
  onDelta?: (text: string) => void
}): Promise<string> {
  if (opts.signal.aborted) throw new DOMException('aborted', 'AbortError')

  // Hidden test hook: in tests we can force one invalid JSON output to exercise the repair loop.
  if (opts.attempt === 1 && /demo-invalid-first/i.test(opts.instruction)) {
    const broken = '{"format":"swarm-studio","version":2,"kind":"swarm"' // missing brace
    opts.onDelta?.(broken)
    return broken
  }

  let spec: SwarmSpec
  if (opts.mode === 'edit' && opts.current) {
    spec = structuredClone(opts.current)
    // A tiny visible change to prove "edit" did something.
    spec.name = spec.name.includes('Demo:') ? spec.name : `Demo: ${spec.name}`
    spec.task = spec.task ? `${spec.task} (demo edit)` : 'Demo edit'
  } else {
    spec = demoPresetFor(opts.instruction)
    spec.task = cleanInstruction(opts.instruction) || spec.task
  }

  const json = exportSwarm(spec)
  // Stream in one shot: the demo generator is deterministic and instant.
  opts.onDelta?.(json)
  return json
}

async function llmGenerate(opts: {
  instruction: string
  mode: GraphPromptMode
  provider: ProviderId
  model: string
  apiKey: string
  endpoints?: Endpoints
  current?: SwarmSpec
  signal: AbortSignal
  onDelta?: (text: string) => void
  onDiscard?: () => void
  onNotice?: (message: string) => void
  attempt: number
  previousRaw?: string
  previousError?: string
}): Promise<string> {
  const system = buildSystemPrompt({ mode: opts.mode, current: opts.current })
  const lines: string[] = []
  lines.push(`Instruction: ${cleanInstruction(opts.instruction)}`)
  if (opts.mode === 'edit') {
    lines.push('')
    lines.push('Current swarm JSON (edit this):')
    lines.push(exportSwarm(opts.current!))
  }
  if (opts.previousRaw && opts.previousError) {
    lines.push('')
    lines.push('Your previous output was invalid.')
    lines.push(`Error: ${opts.previousError}`)
    lines.push('Return a corrected JSON object, and nothing else.')
    lines.push('Previous output:')
    lines.push(opts.previousRaw)
  }

  let firstDelta = true
  const res = await callProvider(opts.provider, {
    model: opts.model,
    system,
    messages: [{ role: 'user', content: lines.join('\n') }],
    temperature: 0.2,
    maxTokens: Math.max(800, DEFAULT_MAX_TOKENS * 6),
    apiKey: opts.apiKey,
    endpoint: resolveEndpoint(opts.provider, opts.endpoints),
    signal: opts.signal,
    onNotice: opts.onNotice,
    onDiscard: () => {
      firstDelta = true
      opts.onDiscard?.()
    },
    onDelta: (delta) => {
      if (firstDelta) firstDelta = false
      opts.onDelta?.(delta)
    },
  })

  return res.text
}

function extractPortableJson(raw: string): { ok: true; jsonText: string } | { ok: false; error: string; jsonText?: string } {
  const extracted = extractJson(raw)
  if (extracted === undefined) {
    return { ok: false, error: 'No JSON object found in the output. Return one JSON object only.' }
  }
  if (!isRecord(extracted) && !Array.isArray(extracted)) {
    return { ok: false, error: 'The extracted JSON is not an object or array.' }
  }
  const jsonText = stringifyJson(extracted)
  if (!jsonText) return { ok: false, error: 'Could not stringify the extracted JSON.' }
  return { ok: true, jsonText }
}

export async function promptGraph(opts: PromptGraphOptions): Promise<PromptGraphResult> {
  const instruction = cleanInstruction(opts.instruction)
  if (!instruction) return { ok: false, error: 'Write what you want, then generate.', raw: '', repaired: false }
  if (opts.mode === 'edit' && !opts.current) {
    return { ok: false, error: 'Edit mode needs the current swarm.', raw: '', repaired: false }
  }

  const info = providerInfo(opts.provider)
  if (!opts.model.trim() && info.models.length === 0) {
    return { ok: false, error: `Pick a model for ${info.label}.`, raw: '', repaired: false }
  }

  const generator = opts.provider === 'mock' ? demoGenerate : llmGenerate

  let raw = ''
  let repaired = false

  const attemptOnce = async (attempt: number, previousError?: string): Promise<{ ok: true; spec: SwarmSpec } | { ok: false; error: string }> => {
    raw = ''

    const text = await generator({
      instruction,
      mode: opts.mode,
      provider: opts.provider,
      model: opts.model,
      apiKey: opts.apiKey,
      endpoints: opts.endpoints,
      current: opts.current,
      signal: opts.signal,
      onDelta: (delta) => {
        raw += delta
        opts.onDelta?.(delta)
      },
      onDiscard: () => {
        raw = ''
        opts.onDiscard?.()
      },
      onNotice: opts.onNotice,
      attempt,
      ...(attempt === 2 ? { previousRaw: raw, previousError } : {}),
    } as any)

    raw = text

    const extracted = extractPortableJson(raw)
    if (!extracted.ok) return { ok: false, error: extracted.error }

    // A dumb but effective guard: keys/URLs are forbidden even as inert extra fields.
    if (SECRETISH.test(extracted.jsonText)) {
      return { ok: false, error: 'The JSON appears to contain a key or an endpoint. Those must not be included.' }
    }

    const validated = validatePortableSwarm(extracted.jsonText)
    if (!validated.ok) return { ok: false, error: validated.error }

    if (opts.mode === 'edit' && opts.current) {
      const problem = ensureEditPreservesIds(validated.spec, opts.current)
      if (problem) return { ok: false, error: problem }
    }

    return { ok: true, spec: validated.spec }
  }

  try {
    const first = await attemptOnce(1)
    if (first.ok) return { ok: true, spec: first.spec, raw, repaired }

    repaired = true
    opts.onNotice?.('The generated JSON did not validate. Retrying once with the error message…')
    opts.onDiscard?.()

    const second = await attemptOnce(2, first.error)
    if (second.ok) return { ok: true, spec: second.spec, raw, repaired }
    return { ok: false, error: second.error, raw, repaired }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message, raw, repaired }
  }
}
