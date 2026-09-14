/**
 * The interchange format: how a swarm, or a single agent, travels between two people.
 *
 * The promise is narrow and worth stating: **paste this into a friend's Swarm Studio and they get
 * your configuration.** So the format carries everything needed to reproduce a run except the two
 * things that must never travel — API keys, and endpoint URLs, which are private infrastructure.
 *
 * Two shapes, one reader:
 *  · `kind: "swarm"` — a whole graph (agents, links, topology, task, round budget, entry points)
 *  · `kind: "agents"` — a clipping of one or more agents, with the links BETWEEN them
 *
 * `parsePortable` is deliberately forgiving on the way in and strict about what it returns: it
 * accepts a bare exported spec from an older version, an agent object on its own, or an array of
 * agents, and it always answers with a discriminated union — never a half-filled object. Every
 * refusal carries a sentence a human can act on, because the only place this is used is a paste box.
 */
import type { Agent, Link, ProviderId, SwarmSpec, Topology } from '../types.ts'

export const PORTABLE_VERSION = 1
const TOPOLOGIES: Topology[] = ['broadcast', 'round-robin', 'manager']
const PROVIDERS: ProviderId[] = ['mock', 'openai', 'anthropic', 'openrouter', 'custom']
const HUES = [262, 168, 4, 32, 210, 300, 132, 48]

export interface PortableSwarm {
  format: 'swarm-studio'
  version: number
  kind: 'swarm'
  name: string
  task: string
  topology: Topology
  maxRounds: number
  entryIds: string[]
  agents: Agent[]
  links: Link[]
}

export interface PortableAgents {
  format: 'swarm-studio'
  version: number
  kind: 'agents'
  agents: Agent[]
  links: Link[]
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
    entryIds: spec.entryIds,
    agents: spec.agents,
    links: spec.links,
  }
  return JSON.stringify(payload, null, 2)
}

/**
 * A clipping of agents. Links are included only when BOTH ends are in the selection — a link to an
 * agent the recipient does not have would be a reference to nothing.
 */
export function exportAgents(spec: SwarmSpec, ids: string[]): string {
  const keep = new Set(ids)
  const payload: PortableAgents = {
    format: 'swarm-studio',
    version: PORTABLE_VERSION,
    kind: 'agents',
    agents: spec.agents.filter((a) => keep.has(a.id)),
    links: spec.links.filter((l) => keep.has(l.source) && keep.has(l.target)),
  }
  return JSON.stringify(payload, null, 2)
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function readAgent(raw: unknown, index: number): Agent | string {
  if (!raw || typeof raw !== 'object') return `agent #${index + 1} is not an object`
  const record = raw as Record<string, unknown>
  const name = asString(record.name).trim()
  if (!name) return `agent #${index + 1} has no name`
  const provider = PROVIDERS.includes(record.provider as ProviderId)
    ? (record.provider as ProviderId)
    : 'mock'
  const position = record.position as { x?: unknown; y?: unknown } | undefined
  const temperature = Number(record.temperature)
  return {
    // A pasted id may collide with one already on the canvas; the caller re-keys.
    id: asString(record.id) || `p${index}`,
    name,
    provider,
    model: asString(record.model),
    systemPrompt: asString(record.systemPrompt),
    // Clamped, not trusted: a hand-edited 9.9 would be refused by every provider at run time.
    temperature: Number.isFinite(temperature) ? Math.min(2, Math.max(0, temperature)) : 0.7,
    hue: Number.isFinite(Number(record.hue)) ? Number(record.hue) : HUES[index % HUES.length],
    position: {
      x: Number.isFinite(Number(position?.x)) ? Number(position?.x) : 80 + (index % 3) * 260,
      y: Number.isFinite(Number(position?.y)) ? Number(position?.y) : 60 + Math.floor(index / 3) * 180,
    },
  }
}

/** Keeps only links whose two ends exist, so nothing pasted can reference a missing agent. */
function readLinks(raw: unknown, known: Set<string>): Link[] {
  if (!Array.isArray(raw)) return []
  const links: Link[] = []
  const seen = new Set<string>()
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return
    const record = entry as Record<string, unknown>
    const source = asString(record.source)
    const target = asString(record.target)
    if (!known.has(source) || !known.has(target) || source === target) return
    const pair = `${source}>${target}`
    if (seen.has(pair)) return
    seen.add(pair)
    links.push({ id: asString(record.id) || `pl${index}`, source, target })
  })
  return links
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
  const rawAgents = record.agents
  if (!Array.isArray(rawAgents) || rawAgents.length === 0) {
    return { ok: false, error: `${what} contains no agents.` }
  }
  const agents: Agent[] = []
  for (const [index, raw] of rawAgents.entries()) {
    const parsed = readAgent(raw, index)
    if (typeof parsed === 'string') return { ok: false, error: parsed }
    agents.push(parsed)
  }
  const known = new Set(agents.map((a) => a.id))
  return {
    ok: true,
    value: {
      format: 'swarm-studio',
      version: PORTABLE_VERSION,
      kind: 'agents',
      agents,
      links: readLinks(record.links, known),
    },
  }
}

function readSwarmPayload(record: Record<string, unknown>): ParseResult {
  const parsed = readAgentsPayload(record, 'the pasted swarm')
  if (!parsed.ok) return parsed
  const { agents, links } = parsed.value
  const known = new Set(agents.map((a) => a.id))
  const rounds = Number(record.maxRounds)
  return {
    ok: true,
    value: {
      format: 'swarm-studio',
      version: PORTABLE_VERSION,
      kind: 'swarm',
      name: asString(record.name, 'Pasted swarm'),
      task: asString(record.task),
      topology: TOPOLOGIES.includes(record.topology as Topology) ? (record.topology as Topology) : 'broadcast',
      maxRounds: Number.isFinite(rounds) && rounds >= 1 ? Math.floor(rounds) : 4,
      // An entry id that names no agent would make the run start nowhere.
      entryIds: Array.isArray(record.entryIds) ? record.entryIds.filter((id): id is string => known.has(String(id))) : [],
      agents,
      links,
    },
  }
}

/**
 * Re-keys a clipping so it can be dropped into a swarm that may already use those ids.
 * Offsets positions too, so a paste of the same agent twice does not stack invisibly.
 */
export function rekey(
  incoming: { agents: Agent[]; links: Link[] },
  taken: Set<string>,
  mint: (index: number) => string,
  offset = 40,
): { agents: Agent[]; links: Link[] } {
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
  const links = incoming.links.map((link, index) => ({
    id: `${mint(index)}l`,
    source: map.get(link.source) ?? link.source,
    target: map.get(link.target) ?? link.target,
  }))
  return { agents, links }
}
