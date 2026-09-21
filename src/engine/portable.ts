/**
 * The interchange format: how a swarm, or a single agent, travels between two people.
 *
 * The promise is narrow and worth stating: **paste this into a friend's Swarm Studio and they get
 * your configuration.** So the format carries everything needed to reproduce a run except the two
 * things that must never travel — API keys, and endpoint URLs, which are private infrastructure.
 *
 * Two shapes, one reader:
 *  · `kind: "swarm"` — a whole graph (agents, nodes, links, blocks, topology, task, budgets, entries)
 *  · `kind: "agents"` — a clipping of agents and nodes, with the links BETWEEN them
 *
 * `parsePortable` is deliberately forgiving on the way in and strict about what it returns: it
 * accepts a bare exported spec from an older version, an agent object on its own, or an array of
 * agents, and it always answers with a discriminated union — never a half-filled object. Every
 * refusal carries a sentence a human can act on, because the only place this is used is a paste box.
 *
 * Version 2 adds flow nodes, conditional links, access links and block definitions. Version 1 reads
 * unchanged: it is a version-2 graph with none of those.
 */
import type {
  Access,
  Agent,
  BlockDef,
  BlockNode,
  DecisionProviderId,
  DecisionQuestion,
  DecisionQuestionType,
  Dispatch,
  FlowNode,
  Graph,
  Link,
  MemoryEntry,
  MemoryMode,
  ProviderId,
  SwarmSpec,
  Topology,
} from '../types.ts'
import { DEFAULT_MEMORY_CHARS } from '../types.ts'
import { readPredicate } from './predicates.ts'
import { DECISION_PROVIDER_IDS, DECISION_TYPES, decisionProviderInfo } from './decisions.ts'

export const PORTABLE_VERSION = 2
const TOPOLOGIES: Topology[] = ['broadcast', 'round-robin', 'manager']
const PROVIDERS: ProviderId[] = ['mock', 'openai', 'anthropic', 'openrouter', 'custom']
const DISPATCHES: Dispatch[] = ['inherit', 'all', 'rotate', 'choose']
const MEMORY_MODES: MemoryMode[] = ['blackboard', 'log', 'document']
const ACCESSES: Access[] = ['read', 'write', 'readwrite']
const HUES = [262, 168, 4, 32, 210, 300, 132, 48]
/** A pasted document is welcome as a knowledge base, a pasted novel per entry is not. */
const MAX_SEED_VALUE = 50_000
const MAX_SEED_ENTRIES = 500
/** A decision call asks everything at once; past a few dozen questions it is a mistake, not a design. */
const MAX_QUESTIONS = 32
const MAX_OPTIONS = 64

export interface PortableSwarm {
  format: 'swarm-studio'
  version: number
  kind: 'swarm'
  name: string
  task: string
  topology: Topology
  maxRounds: number
  maxDepth?: number
  maxSpawns?: number
  entryIds: string[]
  agents: Agent[]
  nodes: FlowNode[]
  links: Link[]
  blocks: BlockDef[]
}

export interface PortableAgents {
  format: 'swarm-studio'
  version: number
  kind: 'agents'
  agents: Agent[]
  nodes: FlowNode[]
  links: Link[]
  /** Definitions of the blocks the clipped block nodes use, so the paste is self-sufficient. */
  blocks: BlockDef[]
}

export type Portable = PortableSwarm | PortableAgents
export type ParseResult = { ok: true; value: Portable } | { ok: false; error: string }

/** A whole swarm, ready to paste. Pretty-printed: it is meant to be read in a chat window. */
export function exportSwarm(spec: SwarmSpec): string {
  const payload: PortableSwarm = {
    format: 'swarm-studio',
    version: PORTABLE_VERSION,
    kind: 'swarm',
    name: spec.name,
    task: spec.task,
    topology: spec.topology,
    maxRounds: spec.maxRounds,
    ...(spec.maxDepth !== undefined ? { maxDepth: spec.maxDepth } : {}),
    ...(spec.maxSpawns !== undefined ? { maxSpawns: spec.maxSpawns } : {}),
    entryIds: spec.entryIds,
    agents: spec.agents,
    nodes: spec.nodes ?? [],
    links: spec.links,
    blocks: spec.blocks ?? [],
  }
  return JSON.stringify(payload, null, 2)
}

/**
 * A clipping of agents and nodes. Links are included only when BOTH ends are in the selection — a
 * link to something the recipient does not have would be a reference to nothing.
 */
export function exportAgents(spec: SwarmSpec, ids: string[]): string {
  const keep = new Set(ids)
  const nodes = (spec.nodes ?? []).filter((n) => keep.has(n.id))
  const used = new Set(nodes.filter((n): n is BlockNode => n.kind === 'block').map((n) => n.blockId))
  const payload: PortableAgents = {
    format: 'swarm-studio',
    version: PORTABLE_VERSION,
    kind: 'agents',
    agents: spec.agents.filter((a) => keep.has(a.id)),
    nodes,
    links: spec.links.filter((l) => keep.has(l.source) && keep.has(l.target)),
    blocks: (spec.blocks ?? []).filter((b) => used.has(b.id)),
  }
  return JSON.stringify(payload, null, 2)
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asFinite(value: unknown): number | undefined {
  if (value === null || value === '' || typeof value === 'boolean') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function readPosition(raw: unknown, index: number): { x: number; y: number } {
  const position = raw as { x?: unknown; y?: unknown } | undefined
  return {
    x: asFinite(position?.x) ?? 80 + (index % 3) * 260,
    y: asFinite(position?.y) ?? 60 + Math.floor(index / 3) * 180,
  }
}

function readAgent(raw: unknown, index: number): Agent | string {
  if (!raw || typeof raw !== 'object') return `agent #${index + 1} is not an object`
  const record = raw as Record<string, unknown>
  const name = asString(record.name).trim()
  if (!name) return `agent #${index + 1} has no name`
  const provider = PROVIDERS.includes(record.provider as ProviderId) ? (record.provider as ProviderId) : 'mock'
  const temperature = asFinite(record.temperature)
  const maxTokens = asFinite(record.maxTokens)
  const agent: Agent = {
    // A pasted id may collide with one already on the canvas; the caller re-keys.
    id: asString(record.id) || `p${index}`,
    name,
    provider,
    model: asString(record.model),
    systemPrompt: asString(record.systemPrompt),
    // Clamped, not trusted: a hand-edited 9.9 would be refused by every provider at run time.
    temperature: temperature !== undefined ? Math.min(2, Math.max(0, temperature)) : 0.7,
    hue: asFinite(record.hue) ?? HUES[index % HUES.length],
    position: readPosition(record.position, index),
  }
  // Optional fields are only written when present: a round trip must give back the same object.
  if (maxTokens !== undefined && maxTokens >= 1) agent.maxTokens = Math.floor(maxTokens)
  if (DISPATCHES.includes(record.dispatch as Dispatch)) agent.dispatch = record.dispatch as Dispatch
  if (typeof record.canSpawn === 'boolean') agent.canSpawn = record.canSpawn
  return agent
}

function readSeed(raw: unknown): MemoryEntry[] {
  if (!Array.isArray(raw)) return []
  const entries: MemoryEntry[] = []
  for (const item of raw.slice(0, MAX_SEED_ENTRIES)) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const value = asString(record.value)
    if (!value) continue
    entries.push({
      key: asString(record.key),
      value: value.slice(0, MAX_SEED_VALUE),
      author: asString(record.author, 'seed') || 'seed',
      round: 0,
      version: Math.max(1, Math.floor(asFinite(record.version) ?? 1)),
    })
  }
  return entries
}

/**
 * A Decision node's questions. Forgiving like the rest of the reader: the API's own shape, where
 * `criteria` is an object of label → description (or, for a score, a list of levels), is accepted
 * as well as ours, so a request copied from TypeSafe's docs pastes as-is. A question that cannot be
 * read is dropped; the inspector then says the node needs one.
 */
function readQuestions(raw: unknown): DecisionQuestion[] {
  const entries: Array<[string | undefined, unknown]> = Array.isArray(raw)
    ? raw.map((q) => [undefined, q])
    : raw && typeof raw === 'object'
      ? Object.entries(raw as Record<string, unknown>)
      : []
  const questions: DecisionQuestion[] = []
  for (const [key, item] of entries.slice(0, MAX_QUESTIONS)) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const name = (asString(record.name) || key || '').trim()
    const type = DECISION_TYPES.includes(record.type as DecisionQuestionType) ? (record.type as DecisionQuestionType) : undefined
    if (!name || !type) continue
    const question: DecisionQuestion = { name, type, instructions: asString(record.instructions).slice(0, MAX_SEED_VALUE) }
    const criteria = record.criteria
    if (type === 'score') {
      const source = Array.isArray(record.levels) ? record.levels : Array.isArray(criteria) ? criteria : []
      question.levels = source.map((l) => (typeof l === 'string' ? l : l == null ? '' : JSON.stringify(l))).slice(0, MAX_OPTIONS)
    } else {
      let options: Array<{ label: string; criterion: string }> = []
      if (Array.isArray(record.options)) {
        options = record.options
          .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === 'object')
          .map((o) => ({ label: asString(o.label).trim(), criterion: asString(o.criterion) }))
      } else if (criteria && typeof criteria === 'object' && !Array.isArray(criteria)) {
        options = Object.entries(criteria as Record<string, unknown>).map(([label, c]) => ({
          label: label.trim(),
          criterion: typeof c === 'string' ? c : c == null ? '' : JSON.stringify(c),
        }))
      }
      options = options.filter((o) => o.label).slice(0, MAX_OPTIONS)
      if (type === 'noul') options = options.filter((o) => o.label === 'true' || o.label === 'false')
      if (options.length > 0 || type === 'choice') question.options = options
    }
    questions.push(question)
  }
  return questions
}

function readFlowNode(raw: unknown, index: number): FlowNode | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const id = asString(record.id) || `n${index}`
  const position = readPosition(record.position, index)
  const kind = record.kind
  const named = (fallback: string) => asString(record.name).trim() || fallback
  switch (kind) {
    case 'condition':
      return { id, kind, name: named('Condition'), position, predicate: readPredicate(record.predicate) ?? { op: 'always' } }
    case 'join': {
      const timeout = asFinite(record.timeoutRounds)
      return {
        id,
        kind,
        name: named('Join'),
        position,
        mode: record.mode === 'any' ? 'any' : 'all',
        ...(timeout !== undefined && timeout >= 1 ? { timeoutRounds: Math.floor(timeout) } : {}),
      }
    }
    case 'output':
      return { id, kind, name: named('Output'), position }
    case 'human':
      return { id, kind, name: named('Human gate'), position, prompt: asString(record.prompt) }
    case 'memory': {
      const chars = asFinite(record.maxChars)
      return {
        id,
        kind,
        name: named('Memory'),
        position,
        mode: MEMORY_MODES.includes(record.mode as MemoryMode) ? (record.mode as MemoryMode) : 'blackboard',
        wakeReaders: record.wakeReaders === true,
        seed: readSeed(record.seed),
        maxChars: chars !== undefined && chars >= 200 ? Math.min(40_000, Math.floor(chars)) : DEFAULT_MEMORY_CHARS,
      }
    }
    case 'decision': {
      const provider = DECISION_PROVIDER_IDS.includes(record.provider as DecisionProviderId)
        ? (record.provider as DecisionProviderId)
        : 'mock'
      return {
        id,
        kind,
        name: named('Decision'),
        position,
        provider,
        model: asString(record.model) || decisionProviderInfo(provider).models[0],
        questions: readQuestions(record.questions),
      }
    }
    case 'block': {
      const blockId = asString(record.blockId)
      if (!blockId) return undefined
      const overrides = record.overrides as Record<string, unknown> | undefined
      const node: BlockNode = { id, kind, name: named('Block'), position, blockId }
      if (overrides && typeof overrides === 'object') {
        const clean: NonNullable<BlockNode['overrides']> = {}
        if (PROVIDERS.includes(overrides.provider as ProviderId)) clean.provider = overrides.provider as ProviderId
        if (typeof overrides.model === 'string' && overrides.model) clean.model = overrides.model
        if (Object.keys(clean).length > 0) node.overrides = clean
      }
      return node
    }
    default:
      return undefined
  }
}

/**
 * Keeps only links that make sense on this graph.
 *
 * A message link needs two ends that can speak or relay (not a memory). An access link needs exactly
 * one memory and one agent. A self-loop and a duplicate are dropped.
 */
function readLinks(raw: unknown, agents: Set<string>, nodes: FlowNode[]): Link[] {
  if (!Array.isArray(raw)) return []
  const memories = new Set(nodes.filter((n) => n.kind === 'memory').map((n) => n.id))
  const known = new Set([...agents, ...nodes.map((n) => n.id)])
  const links: Link[] = []
  const seen = new Set<string>()
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return
    const record = entry as Record<string, unknown>
    const source = asString(record.source)
    const target = asString(record.target)
    if (!known.has(source) || !known.has(target) || source === target) return
    const kind = record.kind === 'access' ? 'access' : 'message'
    if (kind === 'access') {
      const valid = (memories.has(source) && agents.has(target)) || (memories.has(target) && agents.has(source))
      if (!valid) return
    } else if (memories.has(source) || memories.has(target)) {
      return
    }
    const pair = `${kind}:${source}>${target}`
    if (seen.has(pair)) return
    seen.add(pair)
    const link: Link = { id: asString(record.id) || `pl${index}`, source, target }
    if (kind === 'access') {
      link.kind = 'access'
      if (ACCESSES.includes(record.access as Access)) link.access = record.access as Access
    } else if (record.kind === 'message') {
      link.kind = 'message'
    }
    const label = asString(record.label).trim()
    if (label) link.label = label
    const guard = record.guard === undefined ? undefined : readPredicate(record.guard)
    if (guard) link.guard = guard
    if (record.isDefault === true) link.isDefault = true
    const budget = asFinite(record.maxTraversals)
    if (budget !== undefined && budget >= 1) link.maxTraversals = Math.floor(budget)
    links.push(link)
  })
  return links
}

interface GraphRead {
  agents: Agent[]
  nodes: FlowNode[]
  links: Link[]
}

function readGraphParts(record: Record<string, unknown>, what: string, allowEmpty: boolean): GraphRead | string {
  const rawAgents = Array.isArray(record.agents) ? record.agents : []
  const rawNodes = Array.isArray(record.nodes) ? record.nodes : []
  if (rawAgents.length === 0 && (rawNodes.length === 0 || !allowEmpty)) {
    return `${what} contains no agents.`
  }
  const agents: Agent[] = []
  for (const [index, raw] of rawAgents.entries()) {
    const parsed = readAgent(raw, index)
    if (typeof parsed === 'string') return parsed
    agents.push(parsed)
  }
  const agentIds = new Set(agents.map((a) => a.id))
  const nodes: FlowNode[] = []
  const taken = new Set(agentIds)
  rawNodes.forEach((raw, index) => {
    const node = readFlowNode(raw, index)
    // An id shared with an agent would make every lookup ambiguous.
    if (!node || taken.has(node.id)) return
    taken.add(node.id)
    nodes.push(node)
  })
  return { agents, nodes, links: readLinks(record.links, agentIds, nodes) }
}

function readEntryIds(raw: unknown, known: Set<string>): string[] {
  // An entry id that names nothing would make the run start nowhere.
  return Array.isArray(raw) ? raw.map(String).filter((id) => known.has(id)) : []
}

function readBlocks(raw: unknown): BlockDef[] {
  if (!Array.isArray(raw)) return []
  const blocks: BlockDef[] = []
  const ids = new Set<string>()
  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object') return
    const record = item as Record<string, unknown>
    const id = asString(record.id) || `b${index}`
    if (ids.has(id)) return
    const graphRecord = (record.graph && typeof record.graph === 'object' ? record.graph : {}) as Record<string, unknown>
    const parts = readGraphParts(graphRecord, 'a block', true)
    // A block that cannot be read is dropped rather than failing the whole paste.
    if (typeof parts === 'string') return
    const known = new Set([...parts.agents.map((a) => a.id), ...parts.nodes.map((n) => n.id)])
    const graph: Graph = { ...parts, entryIds: readEntryIds(graphRecord.entryIds, known) }
    ids.add(id)
    blocks.push({
      id,
      name: asString(record.name).trim() || `Block ${index + 1}`,
      description: asString(record.description),
      graph,
    })
  })
  return blocks
}

/**
 * Reads whatever was pasted. Accepts the two portable shapes, a bare spec exported by an earlier
 * version, a single agent object, and an array of agents.
 */
export function parsePortable(text: string): ParseResult {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, error: 'Nothing to read — paste some JSON first.' }

  let data: unknown
  try {
    data = JSON.parse(trimmed)
  } catch {
    return {
      ok: false,
      error: trimmed.startsWith('{') || trimmed.startsWith('[')
        ? 'That is not valid JSON — a comma or a brace is probably missing.'
        : 'That does not look like JSON. Paste the block starting with { or [.',
    }
  }

  // A bare array, or a single agent object: treat it as a clipping of agents.
  if (Array.isArray(data)) return readAgentsPayload({ agents: data }, 'a pasted list')
  if (!data || typeof data !== 'object') return { ok: false, error: 'Expected a JSON object or array.' }

  const record = data as Record<string, unknown>
  if (record.format !== undefined && record.format !== 'swarm-studio') {
    return { ok: false, error: `This JSON says it is "${String(record.format)}", not a Swarm Studio export.` }
  }
  if (typeof record.version === 'number' && record.version > PORTABLE_VERSION) {
    return {
      ok: false,
      error: `This export is version ${record.version}; this build reads up to ${PORTABLE_VERSION}. Update the app.`,
    }
  }

  if (record.kind === 'agents') return readAgentsPayload(record, 'the pasted clipping')
  // `kind: swarm`, or an older bare spec: both have agents plus a task or a topology.
  if (record.kind === 'swarm' || 'topology' in record || 'task' in record) {
    return readSwarmPayload(record)
  }
  // A single agent, pasted on its own.
  if ('systemPrompt' in record || 'model' in record) return readAgentsPayload({ agents: [record] }, 'the pasted agent')

  return { ok: false, error: 'Unrecognised JSON: no agents, no task, no topology.' }
}

function readAgentsPayload(record: Record<string, unknown>, what: string): ParseResult {
  // A clipping may be only nodes (a memory and a condition, say), but never nothing.
  const parts = readGraphParts(record, what, true)
  if (typeof parts === 'string') return { ok: false, error: parts }
  return {
    ok: true,
    value: {
      format: 'swarm-studio',
      version: PORTABLE_VERSION,
      kind: 'agents',
      ...parts,
      blocks: readBlocks(record.blocks),
    },
  }
}

function readSwarmPayload(record: Record<string, unknown>): ParseResult {
  const parts = readGraphParts(record, 'the pasted swarm', true)
  if (typeof parts === 'string') return { ok: false, error: parts }
  const known = new Set([...parts.agents.map((a) => a.id), ...parts.nodes.map((n) => n.id)])
  const rounds = asFinite(record.maxRounds)
  const depth = asFinite(record.maxDepth)
  const spawns = asFinite(record.maxSpawns)
  return {
    ok: true,
    value: {
      format: 'swarm-studio',
      version: PORTABLE_VERSION,
      kind: 'swarm',
      name: asString(record.name, 'Pasted swarm'),
      task: asString(record.task),
      topology: TOPOLOGIES.includes(record.topology as Topology) ? (record.topology as Topology) : 'broadcast',
      maxRounds: rounds !== undefined && rounds >= 1 ? Math.floor(rounds) : 4,
      ...(depth !== undefined && depth >= 0 ? { maxDepth: Math.min(8, Math.floor(depth)) } : {}),
      ...(spawns !== undefined && spawns >= 0 ? { maxSpawns: Math.min(100, Math.floor(spawns)) } : {}),
      entryIds: readEntryIds(record.entryIds, known),
      ...parts,
      blocks: readBlocks(record.blocks),
    },
  }
}

/** A parsed swarm as a spec the store can hold. */
export function portableToSpec(value: PortableSwarm): SwarmSpec {
  const { format: _format, version: _version, kind: _kind, ...spec } = value
  return spec
}

/**
 * Re-keys a clipping so it can be dropped into a swarm that may already use those ids.
 * Offsets positions too, so a paste of the same agent twice does not stack invisibly.
 */
export function rekey(
  incoming: { agents: Agent[]; links: Link[]; nodes?: FlowNode[] },
  taken: Set<string>,
  mint: (index: number) => string,
  offset = 40,
): { agents: Agent[]; links: Link[]; nodes: FlowNode[] } {
  const map = new Map<string, string>()
  const agents = incoming.agents.map((agent, index) => {
    const id = taken.has(agent.id) ? mint(index) : agent.id
    map.set(agent.id, id)
    return {
      ...agent,
      id,
      position: taken.has(agent.id)
        ? { x: agent.position.x + offset, y: agent.position.y + offset }
        : agent.position,
    }
  })
  const base = incoming.agents.length
  const nodes = (incoming.nodes ?? []).map((node, index) => {
    const id = taken.has(node.id) ? mint(base + index) : node.id
    map.set(node.id, id)
    return {
      ...node,
      id,
      position: taken.has(node.id) ? { x: node.position.x + offset, y: node.position.y + offset } : node.position,
    }
  })
  const links = incoming.links.map((link, index) => ({
    ...link,
    id: `${mint(index)}l`,
    source: map.get(link.source) ?? link.source,
    target: map.get(link.target) ?? link.target,
  }))
  return { agents, links, nodes }
}
