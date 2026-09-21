/**
 * "Prompt the graph": describe a swarm in words, get it on the canvas.
 *
 * The graph is JSON in a documented format (docs/format.md), which is exactly the kind of thing a
 * model writes well — as long as three things hold, and this module is those three things:
 *
 *  1. **The model is told the real format.** The reference below is built from the same constants the
 *     reader checks against (providers, node kinds, predicate ops, decision types), and a test fails
 *     when a kind or an op exists in the types but not in the prompt. Two presets, serialised by the
 *     exporter itself, are the examples.
 *  2. **The output goes through the existing reader** (`parsePortable`), forgiving in, strict out, and
 *     then through an audit of what the reader had to DROP: a link to an id that does not exist, a
 *     guard it could not read. The reader drops those silently, which is right for a paste box and
 *     wrong here: a dropped guard is an unguarded link, a silently different graph. So a drop is an
 *     error, and the error goes back to the model for one repair.
 *  3. **Nothing half-made is ever loaded.** Either a whole validated swarm comes back, and the caller
 *     loads it as ONE undo step, or an error a human can read comes back, and the canvas is untouched.
 *
 * Keys and endpoint URLs never reach the generator: the current graph is sent through the exporter,
 * which has no field for either. The output is also checked against the keys and endpoints actually
 * configured, so not even a model that invented one could get it onto the canvas.
 */
import type {
  DecisionProviderId,
  FlowNode,
  FlowNodeKind,
  Link,
  Predicate,
  ProviderId,
  SwarmSpec,
} from '../types.ts'
import { PRESETS } from '../presets.ts'
import { exportSwarm, parsePortable, portableToSpec } from './portable.ts'
import { callProvider, PROVIDERS, resolveEndpoint, type ChatRequest, type ChatResult, type Endpoints } from './providers.ts'
import { DECISION_PROVIDER_IDS, DECISION_TYPES, decisionProviderInfo } from './decisions.ts'
import { readPredicate } from './predicates.ts'
import { resolveEntryIds } from './graph.ts'

export type GraphPromptMode = 'replace' | 'edit'

/** Every node kind, checked against the type: adding a kind without teaching the generator fails to compile. */
export const GENERATOR_NODE_KINDS = ['condition', 'join', 'output', 'human', 'memory', 'block', 'decision'] as const
type MissingKind = Exclude<FlowNodeKind, (typeof GENERATOR_NODE_KINDS)[number]>
const kindsAreComplete: MissingKind extends never ? true : false = true

/** Every predicate op, same guarantee. */
export const GENERATOR_PREDICATE_OPS = ['always', 'contains', 'matches', 'json', 'memory', 'decision', 'visits', 'round', 'all', 'any', 'not'] as const
type MissingOp = Exclude<Predicate['op'], (typeof GENERATOR_PREDICATE_OPS)[number]>
const opsAreComplete: MissingOp extends never ? true : false = true
void kindsAreComplete
void opsAreComplete

/** Big enough for a dozen agents with real prompts; a cut-off answer is reported as such. */
export const GENERATOR_MAX_TOKENS = 8000

export interface GeneratorDefaults {
  /** What generated agents use unless the instruction asks otherwise. */
  provider: ProviderId
  model: string
  decisionProvider: DecisionProviderId
  decisionModel: string
}

/** A chat completion. Injectable so the repair loop can be tested without a network. */
export type Complete = (provider: ProviderId, req: ChatRequest) => Promise<ChatResult>

export interface PromptGraphOptions {
  instruction: string
  mode: GraphPromptMode
  provider: ProviderId
  model: string
  apiKey: string
  endpoints?: Endpoints
  /** The swarm on the canvas. Required for `edit`. */
  current?: SwarmSpec
  defaults?: Partial<GeneratorDefaults>
  /** Keys and endpoint URLs configured in this browser: the output must contain none of them. */
  secrets?: string[]
  signal: AbortSignal
  /** Streamed text, as it arrives. */
  onDelta?: (text: string) => void
  /** Whatever was streamed is void: the provider re-fetches, or the repair starts. */
  onDiscard?: () => void
  /** Something worth saying that is not a failure. */
  onNotice?: (message: string) => void
  complete?: Complete
}

export type PromptGraphResult =
  | { ok: true; spec: SwarmSpec; raw: string; repaired: boolean; demo: boolean; note?: string }
  | { ok: false; error: string; raw: string; repaired: boolean }

/* ------------------------------------------------------------------------------------------------ */
/* The prompt                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

function compact(spec: SwarmSpec): string {
  return JSON.stringify(JSON.parse(exportSwarm(spec)))
}

/** The examples: one graph-engineering preset and the System 1 → System 2 preset. */
function examples(): SwarmSpec[] {
  return ['The Fridge Tribunal', 'Triage (System 1 → System 2)']
    .map((name) => PRESETS.find((p) => p.name === name))
    .filter((p): p is SwarmSpec => Boolean(p))
}

/**
 * The format, as the model needs it. Every enumeration is read from the code's own lists, so a new
 * provider or question type reaches the generator without anyone remembering to update a string.
 */
export function formatReference(defaults: GeneratorDefaults): string {
  const providers = PROVIDERS.map((p) => p.id).join(' | ')
  const decisionProviders = DECISION_PROVIDER_IDS.join(' | ')
  return `FORMAT — Swarm Studio portable export, version 2. Answer with ONE JSON object:
{"format":"swarm-studio","version":2,"kind":"swarm","name":string,"task":string,"topology":"broadcast"|"round-robin"|"manager","maxRounds":integer 1-40,"maxDepth"?:integer,"maxSpawns"?:integer,"entryIds":[ids],"agents":[Agent],"nodes":[Node],"links":[Link],"blocks":[Block]}

IDS: short unique strings ("triage", "writer", "c1"). Agents and nodes share ONE id space. Every link source/target and every entryIds item must be an existing id. entryIds = the nodes that receive the task (empty = every agent/block/decision with no incoming message link).
POSITIONS: {"x":number,"y":number} in pixels. The flow reads left to right: about 320px between columns, 180px between rows.
TOPOLOGY: broadcast = a message goes along every outgoing link; round-robin = one outgoing link per turn, rotating; manager = the entry agent delegates, workers report back to it.
maxRounds: the step budget; every round where anything speaks costs one. Keep it just above the longest path (loops included).

AGENT: {"id","name","provider","model","systemPrompt","temperature":0-2,"hue":0-360,"position","maxTokens"?:int,"dispatch"?:"inherit"|"all"|"rotate"|"choose","canSpawn"?:bool}
- provider: ${providers}. Use provider "${defaults.provider}" and model "${defaults.model}" for every agent unless the instruction names others.
- systemPrompt: the agent's role in the second person, specific and in a voice of its own. Each turn is one short paragraph; say what this agent contributes and what it must not do.
- hue: give each agent a distinct hue.
- dispatch "choose": the agent picks its branch by writing <route to="label"/>; its outgoing links need labels, and one may be "isDefault".
- canSpawn true: the agent may create helpers at run time with <spawn name="Role">subtask</spawn>.
- Agents write to a memory with <write memory="Memory name" key="k">value</write> (they need a write access link).

NODES (every node: {"id","kind","name","position", …}):
- condition {"predicate":Predicate}: costs no tokens. Outgoing links labelled "true" and "false" (unlabelled counts as "true").
- join {"mode":"all"|"any","timeoutRounds"?:int}: "all" waits for every incoming branch and forwards one combined message.
- output {}: marks a result. Nothing may leave it.
- human {"prompt":string}: pauses the run for a person. Outgoing links labelled "approved" and "rejected".
- memory {"mode":"blackboard"|"log"|"document","wakeReaders":bool,"seed":[{"key","value"}],"maxChars":int}: shared knowledge. Connected ONLY by access links, and only to agents.
- block {"blockId":string,"overrides"?:{"provider","model"}}: runs the graph of blocks[].id == blockId as one node.
- decision {"provider":${decisionProviders},"model":string,"questions":[Question]}: a typed decision model (a "System One" model such as TypeSafe's Jev). It writes NO text: it answers typed questions about the message it receives and forwards that message with its answers attached. Use provider "${defaults.decisionProvider}" and model "${defaults.decisionModel}".
  Question: {"name":one word,"type":${DECISION_TYPES.map((t) => `"${t}"`).join('|')},"instructions":string,"options"?:[{"label","criterion"}],"levels"?:[string]}
  · choice: options = the labels to pick from (≥2), each with a criterion. Answer: {choice, confidence 0-1, probabilities}.
  · noul: a yes/no question; options may describe "true" and "false". Answer: {noul = p(yes) 0-1, yes: bool}.
  · score: levels = ordered rubric, lowest first (≥2). Answer: {score (expected level, may be fractional), confidence, level}.
  Route on the answers with guards on its outgoing links: {"op":"decision","path":"route.choice","cmp":"eq","value":"billing"}, {"op":"decision","path":"route.confidence","cmp":"lt","value":0.6}, {"op":"decision","path":"urgent.yes","cmp":"eq","value":true}. A link with "isDefault":true is taken only when no other link of the decision is: the usual escalation to an LLM agent when the decision is unsure (System 1 → System 2).

LINK: {"id","source","target","kind"?:"message"|"access","label"?,"guard"?:Predicate,"isDefault"?:bool,"maxTraversals"?:int,"access"?:"read"|"write"|"readwrite"}
- message links carry what a node says to the next node. access links connect a memory and an agent: memory → agent = read, agent → memory = write, or "access":"readwrite".
- A loop MUST be bounded: a "maxTraversals" on one of its links, or a guard on "visits"/"round".

PREDICATE (link guards and condition nodes), as data:
{"op":"always"} | {"op":"contains","value":string,"caseSensitive"?:bool} | {"op":"matches","pattern":regex,"flags"?:"imsu"} | {"op":"json","path":"a.b","cmp":Cmp,"value"?} (reads a JSON object in the message) | {"op":"memory","memory":"Memory name","key":string,"cmp":Cmp,"value"?} | {"op":"decision","path":"question.field","cmp":Cmp,"value"?} | {"op":"visits"|"round","cmp":"eq"|"gt"|"gte"|"lt"|"lte","value":int} | {"op":"all"|"any","of":[Predicate]} | {"op":"not","of":Predicate}
Cmp: "eq"|"neq"|"gt"|"gte"|"lt"|"lte"|"exists"|"contains" ("exists" takes no value).

BLOCK: {"id","name","description","graph":{"agents","nodes","links","entryIds"}} — only when a block node uses it.

NEVER put an API key, a token, a password or an endpoint URL anywhere in the JSON. They do not travel.`
}

export function buildGeneratorSystem(mode: GraphPromptMode, defaults: GeneratorDefaults): string {
  const lines = [
    'You design multi-agent swarms for Swarm Studio, a visual editor for agent graphs. You answer with the graph as JSON, and nothing else: no prose, no markdown fences, no comments.',
    '',
    formatReference(defaults),
    '',
    'DESIGN: prefer the smallest graph that does what was asked. Name agents by their role. Give every agent a distinct, concrete system prompt. Put an output node where results land. Use conditions, joins, human gates, memories, blocks and decision nodes only where they earn their place.',
    '',
  ]
  if (mode === 'edit') {
    lines.push(
      'MODE: EDIT. You receive the current swarm and a change to make. Return the WHOLE swarm with the change applied.',
      '- Keep every id that still exists exactly as it is, and keep positions of nodes you do not move.',
      '- New agents or nodes get new ids that are not already used.',
      '- Change nothing the instruction does not ask you to change.',
    )
  } else {
    lines.push('MODE: CREATE. Design a new swarm from the instruction. Write a concrete "task" the swarm will receive when run.')
  }
  lines.push('', 'EXAMPLES of valid documents (the shape to copy, not the content):')
  for (const example of examples()) lines.push(compact(example))
  return lines.join('\n')
}

export function buildGeneratorMessage(instruction: string, mode: GraphPromptMode, current?: SwarmSpec): string {
  const lines = [`INSTRUCTION: ${instruction.trim()}`]
  if (mode === 'edit' && current) {
    lines.push('', 'CURRENT SWARM (apply the instruction to it):', exportSwarm(current))
  }
  return lines.join('\n')
}

export function buildRepairMessage(error: string, previous: string): string {
  const cut = previous.length > 60_000 ? `${previous.slice(0, 60_000)}\n…(truncated)` : previous
  return [
    'Your previous answer could not be loaded.',
    `PROBLEM: ${error}`,
    'Return the corrected swarm as ONE complete JSON object, and nothing else.',
    '',
    'YOUR PREVIOUS ANSWER:',
    cut,
  ].join('\n')
}

/* ------------------------------------------------------------------------------------------------ */
/* Reading the answer                                                                                */
/* ------------------------------------------------------------------------------------------------ */

const CUT_OFF = 'The JSON is cut off before its end: the answer was probably too long. Return a smaller graph with shorter prompts.'
const NOT_AN_OBJECT = 'The answer is a JSON array; a swarm is one JSON object.'

/**
 * The first JSON object in a model's answer, whatever it wrapped it in: a ```json fence, a sentence
 * before and after, nothing at all.
 *
 * Only TOP-LEVEL containers are candidates. The guards' `extractJson` is the wrong tool here: on an
 * answer cut off at the token limit it skips the unclosed outer object and returns the first complete
 * agent inside it — a plausible object that is not the graph. So a container that never closes is
 * named as cut off (its fix, a smaller graph, is not the fix for bad JSON), and the scan never looks
 * inside a container it has already judged.
 */
export function extractGraphJson(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  for (const fence of raw.matchAll(/```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi)) {
    const parsed = tryParse(fence[1])
    if (isObject(parsed)) return { ok: true, value: parsed }
    if (Array.isArray(parsed)) return { ok: false, error: NOT_AN_OBJECT }
  }
  let sawInvalid = false
  for (let i = 0; i < raw.length; i++) {
    if (!startsContainer(raw, i)) continue
    const end = closeOf(raw, i)
    if (end < 0) return { ok: false, error: CUT_OFF }
    const parsed = tryParse(raw.slice(i, end))
    if (isObject(parsed)) return { ok: true, value: parsed }
    if (Array.isArray(parsed)) return { ok: false, error: NOT_AN_OBJECT }
    sawInvalid = true
    i = end - 1
  }
  return {
    ok: false,
    error: sawInvalid
      ? 'The answer contains a JSON object that does not parse (a missing comma, quote or brace).'
      : 'The answer contains no JSON object.',
  }
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text.trim())
  } catch {
    return undefined
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `{"…` or `{}`, or `[{` / `[]`: what a JSON document opens with, and prose braces (`{name}`) do not. */
function startsContainer(text: string, at: number): boolean {
  const ch = text[at]
  if (ch !== '{' && ch !== '[') return false
  let i = at + 1
  while (i < text.length && /\s/.test(text[i])) i++
  const next = text[i]
  return ch === '{' ? next === '"' || next === '}' : next === '{' || next === ']'
}

/** Index just past the bracket closing the one at `start`, or -1 if the text ends first. */
function closeOf(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth++
    else if ((ch === '}' || ch === ']') && --depth === 0) return i + 1
  }
  return -1
}

function list(raw: unknown): Record<string, unknown>[] {
  return Array.isArray(raw) ? raw.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object') : []
}

/**
 * What the reader dropped or rewrote on the way in. The reader is right to be forgiving with a paste;
 * a generated graph that lost a guard is a DIFFERENT graph, and has to be sent back.
 */
export function auditDrops(raw: Record<string, unknown>, spec: SwarmSpec): string[] {
  const problems: string[] = []
  const say = (items: string[], what: string) => {
    if (items.length === 0) return
    const shown = items.slice(0, 4).join('; ')
    problems.push(`${what}: ${shown}${items.length > 4 ? ` (and ${items.length - 4} more)` : ''}`)
  }

  const nodes = new Map((spec.nodes ?? []).map((n) => [n.id, n]))
  const ids = new Set([...spec.agents.map((a) => a.id), ...nodes.keys()])
  const rawNodes = list(raw.nodes)
  say(
    rawNodes.filter((n) => typeof n.id !== 'string' || !nodes.has(n.id)).map((n) => `${String(n.id ?? '?')} (kind ${String(n.kind ?? '?')})`),
    'nodes that could not be read (unknown kind, missing field, or an id already used)',
  )
  say(
    list(raw.agents).filter((a) => typeof a.id !== 'string' || !spec.agents.some((x) => x.id === a.id)).map((a) => String(a.id ?? a.name ?? '?')),
    'agents without a usable id',
  )

  const duplicate = (values: string[]) => [...new Set(values.filter((v, i) => values.indexOf(v) !== i))]
  say(duplicate(spec.agents.map((a) => a.id)), 'agent ids used twice')
  say(duplicate(spec.links.map((l) => l.id)), 'link ids used twice')

  const links = new Map(spec.links.map((l) => [l.id, l]))
  const droppedLinks: string[] = []
  const droppedGuards: string[] = []
  const rawLinks = Array.isArray(raw.links) ? raw.links : []
  for (const [index, entry] of rawLinks.entries()) {
    if (!entry || typeof entry !== 'object') continue
    const link = entry as Record<string, unknown>
    // The reader names an id-less link after its index; look it up the same way.
    const kept = links.get(typeof link.id === 'string' && link.id ? link.id : `pl${index}`)
    const describe = `${String(link.source)} → ${String(link.target)}`
    if (!kept) {
      const why = !ids.has(String(link.source)) || !ids.has(String(link.target))
        ? 'an end is not an existing id'
        : link.source === link.target
          ? 'a node cannot link to itself'
          : 'not valid between these two kinds (a memory links to agents only, by an access link), or a duplicate'
      droppedLinks.push(`${describe}: ${why}`)
      continue
    }
    if (link.guard !== undefined && link.guard !== null && !kept.guard) droppedGuards.push(`${describe}: ${JSON.stringify(link.guard).slice(0, 120)}`)
  }
  say(droppedLinks, 'links that were dropped')
  say(droppedGuards, 'guards that are not valid predicates')

  for (const node of rawNodes) {
    if (node.kind === 'condition' && node.predicate !== undefined && !readPredicate(node.predicate)) {
      problems.push(`condition ${String(node.id)} has a predicate that is not valid: ${JSON.stringify(node.predicate).slice(0, 120)}`)
    }
    if (node.kind === 'decision') {
      const read = nodes.get(String(node.id))
      const asked = list(node.questions).length || (node.questions && typeof node.questions === 'object' ? Object.keys(node.questions).length : 0)
      if (read?.kind === 'decision' && read.questions.length < asked) {
        problems.push(`decision ${String(node.id)}: ${asked - read.questions.length} question(s) could not be read (each needs a one-word "name" and a "type" among ${DECISION_TYPES.join(', ')})`)
      }
    }
  }
  const rawEntries = Array.isArray(raw.entryIds) ? raw.entryIds.map(String) : []
  say(rawEntries.filter((id) => !ids.has(id)), 'entryIds that name nothing')
  return problems
}

/** Can this swarm run at all? */
function runnable(spec: SwarmSpec): string | undefined {
  const speakers = spec.agents.length + (spec.nodes ?? []).filter((n) => n.kind === 'block' || n.kind === 'decision').length
  if (speakers === 0) return 'The swarm has no agent, block or decision node, so nothing could run.'
  if (resolveEntryIds(spec).length === 0) return 'No node receives the task.'
  return undefined
}

/**
 * Edit mode keeps ids by construction. A model that re-keyed an existing agent (it rewrote `a1` as
 * `critic`) is caught by kind and name, and the old id is put back everywhere the new one appears;
 * a node the instruction removed is simply gone. Positions the answer left out are restored.
 */
export function restoreIdentity(next: SwarmSpec, current: SwarmSpec, raw: Record<string, unknown>): SwarmSpec {
  const spec = structuredClone(next)
  type Entity = { id: string; kind: string; name: string }
  const before: Entity[] = [
    ...current.agents.map((a) => ({ id: a.id, kind: 'agent', name: a.name })),
    ...(current.nodes ?? []).map((n) => ({ id: n.id, kind: n.kind, name: n.name })),
  ]
  const after: Entity[] = [
    ...spec.agents.map((a) => ({ id: a.id, kind: 'agent', name: a.name })),
    ...(spec.nodes ?? []).map((n) => ({ id: n.id, kind: n.kind, name: n.name })),
  ]
  const afterIds = new Set(after.map((e) => e.id))
  const beforeIds = new Set(before.map((e) => e.id))
  const rename = new Map<string, string>()
  for (const old of before) {
    if (afterIds.has(old.id)) continue
    const key = (e: Entity) => `${e.kind}:${e.name.trim().toLowerCase()}`
    const match = after.find((e) => !beforeIds.has(e.id) && !rename.has(e.id) && key(e) === key(old))
    if (match) rename.set(match.id, old.id)
  }
  const map = (id: string) => rename.get(id) ?? id
  spec.agents = spec.agents.map((a) => ({ ...a, id: map(a.id) }))
  spec.nodes = (spec.nodes ?? []).map((n) => ({ ...n, id: map(n.id) }) as FlowNode)
  spec.links = spec.links.map((l) => ({ ...l, source: map(l.source), target: map(l.target) }))
  spec.entryIds = spec.entryIds.map(map)

  // Where the answer gave no position, an existing node stays where it was.
  const positioned = new Set(
    [...list(raw.agents), ...list(raw.nodes)]
      .filter((e) => e.position && typeof e.position === 'object')
      .map((e) => map(String(e.id))),
  )
  const oldPosition = new Map(
    [...current.agents, ...(current.nodes ?? [])].map((e) => [e.id, e.position] as const),
  )
  const place = <T extends { id: string; position: { x: number; y: number } }>(e: T): T =>
    !positioned.has(e.id) && oldPosition.has(e.id) ? { ...e, position: { ...oldPosition.get(e.id)! } } : e
  spec.agents = spec.agents.map(place)
  spec.nodes = spec.nodes.map(place)
  return spec
}

/**
 * Lays out whatever the answer left without a position: columns by distance from the entry points,
 * rows in order of appearance. Nodes that do have a position are left alone.
 */
/** Ids the answer itself placed. */
function positionedIds(raw: Record<string, unknown>): Set<string> {
  return new Set(
    [...list(raw.agents), ...list(raw.nodes)].filter((e) => e.position && typeof e.position === 'object').map((e) => String(e.id)),
  )
}

/**
 * `placed` is either the raw answer (its positioned ids count) or the set of ids already placed —
 * in edit mode that includes every node restored to where it was, which must not be laid out again.
 */
export function layoutMissing(spec: SwarmSpec, placed: Record<string, unknown> | Set<string>): SwarmSpec {
  const positioned = placed instanceof Set ? placed : positionedIds(placed)
  const all = [...spec.agents.map((a) => a.id), ...(spec.nodes ?? []).map((n) => n.id)]
  const missing = all.filter((id) => !positioned.has(id))
  if (missing.length === 0) return spec

  const depth = new Map<string, number>()
  const queue: Array<[string, number]> = resolveEntryIds(spec).map((id) => [id, 0])
  const messages: Link[] = spec.links.filter((l) => l.kind !== 'access')
  for (let i = 0; i < queue.length; i++) {
    const [id, d] = queue[i]
    if (depth.has(id)) continue
    depth.set(id, d)
    for (const link of messages) if (link.source === id && !depth.has(link.target)) queue.push([link.target, d + 1])
  }
  // A memory sits one column after the first agent that touches it; anything unreached goes last.
  const last = Math.max(0, ...depth.values()) + 1
  for (const link of spec.links.filter((l) => l.kind === 'access')) {
    for (const [memory, agent] of [[link.source, link.target], [link.target, link.source]]) {
      if (!depth.has(memory) && depth.has(agent) && (spec.nodes ?? []).some((n) => n.id === memory && n.kind === 'memory')) {
        depth.set(memory, depth.get(agent)!)
      }
    }
  }
  const rows = new Map<number, number>()
  const at = new Map<string, { x: number; y: number }>()
  for (const id of all) {
    const column = depth.get(id) ?? last
    const row = rows.get(column) ?? 0
    rows.set(column, row + 1)
    if (!positioned.has(id)) at.set(id, { x: column * 320, y: row * 180 + ((spec.nodes ?? []).some((n) => n.id === id && n.kind === 'memory') ? 90 : 0) })
  }
  return {
    ...spec,
    agents: spec.agents.map((a) => (at.has(a.id) ? { ...a, position: at.get(a.id)! } : a)),
    nodes: (spec.nodes ?? []).map((n) => (at.has(n.id) ? ({ ...n, position: at.get(n.id)! } as FlowNode) : n)),
  }
}

function leakedSecret(text: string, secrets: string[]): boolean {
  return secrets.some((secret) => secret.trim().length >= 8 && text.includes(secret.trim()))
}

export interface Validation {
  ok: boolean
  spec?: SwarmSpec
  error?: string
}

/** The whole gate between a model's text and the canvas. Pure, so every refusal is testable. */
export function validateGenerated(
  raw: string,
  options: { mode: GraphPromptMode; current?: SwarmSpec; secrets?: string[] },
): Validation {
  const extracted = extractGraphJson(raw)
  if (!extracted.ok) return { ok: false, error: extracted.error }
  const text = JSON.stringify(extracted.value)
  if (leakedSecret(text, options.secrets ?? [])) {
    return { ok: false, error: 'The answer contains one of your API keys or endpoint URLs. It was not loaded.' }
  }
  const parsed = parsePortable(text)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  if (parsed.value.kind !== 'swarm') {
    return { ok: false, error: 'The answer is a clipping of agents ("kind":"agents"), not a whole swarm ("kind":"swarm").' }
  }
  let spec = portableToSpec(parsed.value)
  const drops = auditDrops(extracted.value, spec)
  if (drops.length > 0) return { ok: false, error: drops.join('\n') }
  const stuck = runnable(spec)
  if (stuck) return { ok: false, error: stuck }
  const placed = positionedIds(extracted.value)
  if (options.mode === 'edit' && options.current) {
    spec = restoreIdentity(spec, options.current, extracted.value)
    // Every node that existed before has its position now: the model's, or the one it had.
    for (const e of [...options.current.agents, ...(options.current.nodes ?? [])]) placed.add(e.id)
  }
  spec = layoutMissing(spec, placed)
  return { ok: true, spec }
}

/* ------------------------------------------------------------------------------------------------ */
/* Running it                                                                                        */
/* ------------------------------------------------------------------------------------------------ */

export function defaultsFor(provider: ProviderId, model: string, partial: Partial<GeneratorDefaults> = {}): GeneratorDefaults {
  return {
    provider: partial.provider ?? provider,
    model: partial.model ?? model,
    decisionProvider: partial.decisionProvider ?? 'mock',
    decisionModel: partial.decisionModel ?? decisionProviderInfo(partial.decisionProvider ?? 'mock').models[0],
  }
}

export async function promptGraph(opts: PromptGraphOptions): Promise<PromptGraphResult> {
  const instruction = opts.instruction.trim()
  if (!instruction) return { ok: false, error: 'Describe the swarm you want first.', raw: '', repaired: false }
  if (opts.mode === 'edit' && !opts.current) return { ok: false, error: 'There is no current swarm to edit.', raw: '', repaired: false }
  if (opts.provider === 'mock') return demoGenerate(opts, instruction)
  if (!opts.model.trim()) return { ok: false, error: 'Choose a model for the generator.', raw: '', repaired: false }

  const complete = opts.complete ?? callProvider
  const defaults = defaultsFor(opts.provider, opts.model, opts.defaults)
  const system = buildGeneratorSystem(opts.mode, defaults)
  const first = buildGeneratorMessage(instruction, opts.mode, opts.current)
  const ask = async (messages: ChatRequest['messages']) => {
    const result = await complete(opts.provider, {
      model: opts.model.trim(),
      system,
      messages,
      temperature: 0.2,
      maxTokens: GENERATOR_MAX_TOKENS,
      apiKey: opts.apiKey,
      endpoint: resolveEndpoint(opts.provider, opts.endpoints),
      signal: opts.signal,
      onDelta: (delta) => opts.onDelta?.(delta),
      onNotice: opts.onNotice,
      onDiscard: opts.onDiscard,
    })
    return result.text
  }

  let raw = ''
  let repaired = false
  try {
    raw = await ask([{ role: 'user', content: first }])
    let check = validateGenerated(raw, opts)
    if (!check.ok) {
      // One repair, with the reader's own words. Past that, a human reads the error.
      repaired = true
      opts.onNotice?.(`The first answer did not load (${firstLine(check.error)}). Asking the model to fix it…`)
      opts.onDiscard?.()
      const previous = raw
      raw = await ask([
        { role: 'user', content: first },
        { role: 'assistant', content: previous },
        { role: 'user', content: buildRepairMessage(check.error ?? 'invalid', previous) },
      ])
      check = validateGenerated(raw, opts)
    }
    if (!check.ok || !check.spec) return { ok: false, error: check.error ?? 'The answer could not be loaded.', raw, repaired }
    return { ok: true, spec: check.spec, raw, repaired, demo: false }
  } catch (err) {
    if (opts.signal.aborted) return { ok: false, error: 'Stopped.', raw, repaired }
    return { ok: false, error: err instanceof Error ? err.message : String(err), raw, repaired }
  }
}

function firstLine(text: string | undefined): string {
  const line = (text ?? '').split('\n')[0]
  return line.length > 140 ? `${line.slice(0, 139)}…` : line
}

/* ------------------------------------------------------------------------------------------------ */
/* The demo generator                                                                                */
/* ------------------------------------------------------------------------------------------------ */

/** Keyword → preset. Checked in order; the first hit wins. */
const DEMO_PICKS: Array<{ words: RegExp; preset: string }> = [
  { words: /triage|classif|rout|decision|jev|system ?1|support|ticket|escalat|intent/i, preset: 'Triage (System 1 → System 2)' },
  { words: /memory|blackboard|evidence|investigat|gate|approv|human|court|trial|judge/i, preset: 'The Fridge Tribunal' },
  { words: /spawn|delegat|hierarch|org|manager chain|helper/i, preset: 'The Delegation Spiral' },
  { words: /recurs|block|divide|split|subproblem/i, preset: 'The Recursive Excuse' },
  { words: /write|edit|essay|draft|critic|review|pipeline|fact/i, preset: 'The Dignity Pipeline' },
  { words: /speech|wedding|debate|panel|opinion|brainstorm/i, preset: 'The Best Man Speech' },
]

/**
 * No key, no model: a preset chosen by keywords, or a deterministic edit. Streamed like a real answer
 * so the dialog behaves the same, and labelled demo in its name and in the note, because it would be
 * dishonest to let it pass for generation.
 */
async function demoGenerate(opts: PromptGraphOptions, instruction: string): Promise<PromptGraphResult> {
  let spec: SwarmSpec
  let note: string
  if (opts.mode === 'edit' && opts.current) {
    const edit = demoEdit(opts.current, instruction)
    spec = edit.spec
    note = `Demo generator (no model): ${edit.what}. Pick a provider with a key for real edits.`
  } else {
    const pick = DEMO_PICKS.find((p) => p.words.test(instruction))
    const preset = PRESETS.find((p) => p.name === pick?.preset) ?? PRESETS[0]
    spec = { ...structuredClone(preset), name: `Demo: ${preset.name}` }
    note = `Demo generator (no model): your words matched the preset "${preset.name}". Pick a provider with a key to generate a real graph.`
  }
  const raw = exportSwarm(spec)
  try {
    for (let i = 0; i < raw.length; i += 240) {
      if (opts.signal.aborted) return { ok: false, error: 'Stopped.', raw: raw.slice(0, i), repaired: false }
      opts.onDelta?.(raw.slice(i, i + 240))
      await new Promise((r) => setTimeout(r, 4))
    }
  } catch {
    /* a closed dialog is not an error */
  }
  const check = validateGenerated(raw, { mode: opts.mode, current: opts.current })
  if (!check.ok || !check.spec) return { ok: false, error: check.error ?? 'invalid', raw, repaired: false }
  return { ok: true, spec: check.spec, raw, repaired: false, demo: true, note }
}

function freshId(taken: Set<string>, base: string): string {
  let id = base
  for (let i = 2; taken.has(id); i++) id = `${base}${i}`
  taken.add(id)
  return id
}

/** A few deterministic edits, enough to show that Edit keeps the graph and changes one thing. */
export function demoEdit(current: SwarmSpec, instruction: string): { spec: SwarmSpec; what: string } {
  const spec = structuredClone(current)
  spec.nodes = spec.nodes ?? []
  const taken = new Set([...spec.agents.map((a) => a.id), ...spec.nodes.map((n) => n.id), ...spec.links.map((l) => l.id)])
  const all = [...spec.agents, ...spec.nodes]
  const right = all.length ? Math.max(...all.map((e) => e.position.x)) + 320 : 0
  const top = all.length ? Math.min(...all.map((e) => e.position.y)) : 0
  const outputs = spec.nodes.filter((n) => n.kind === 'output').map((n) => n.id)
  const lower = instruction.toLowerCase()

  if (/gate|human|approv|review by me|check with me/.test(lower) && outputs.length > 0) {
    const gate = freshId(taken, 'gate')
    spec.nodes.push({ id: gate, kind: 'human', name: 'Approve?', prompt: 'Let this result through?', position: { x: right, y: top } })
    // Everything that reached an output now passes the gate first.
    spec.links = spec.links.map((l) => (outputs.includes(l.target) ? { ...l, target: gate } : l))
    spec.links.push({ id: freshId(taken, 'l'), source: gate, target: outputs[0], label: 'approved' })
    return { spec, what: 'added a human gate in front of the output' }
  }
  if (/memory|blackboard|notes|shared/.test(lower) && spec.agents.length > 0) {
    const memory = freshId(taken, 'notes')
    spec.nodes.push({ id: memory, kind: 'memory', name: 'Shared notes', mode: 'blackboard', wakeReaders: false, seed: [], maxChars: 2400, position: { x: right, y: top + 200 } })
    for (const agent of spec.agents) spec.links.push({ id: freshId(taken, 'm'), source: agent.id, target: memory, kind: 'access', access: 'readwrite' })
    return { spec, what: 'added a shared blackboard every agent reads and writes' }
  }
  if (/triage|decision|classif|route|jev/.test(lower)) {
    const entries = resolveEntryIds(spec)
    const decision = freshId(taken, 'triage')
    const minX = all.length ? Math.min(...all.map((e) => e.position.x)) : 0
    spec.nodes.push({
      id: decision,
      kind: 'decision',
      name: 'Triage',
      provider: 'mock',
      model: 'demo-decider',
      position: { x: minX - 320, y: top },
      questions: [
        { name: 'relevant', type: 'noul', instructions: 'Is this message something the swarm should work on?' },
      ],
    })
    for (const entry of entries) {
      spec.links.push({ id: freshId(taken, 'l'), source: decision, target: entry, guard: { op: 'decision', path: 'relevant.yes', cmp: 'eq', value: true } })
    }
    spec.entryIds = [decision]
    return { spec, what: 'put a Decision node in front of the entry points' }
  }
  const leaves = spec.agents.filter((a) => !spec.links.some((l) => l.source === a.id && l.kind !== 'access'))
  const reviewer = freshId(taken, 'reviewer')
  spec.agents.push({
    id: reviewer,
    name: 'The Reviewer',
    provider: spec.agents[0]?.provider ?? 'mock',
    model: spec.agents[0]?.model ?? 'demo-fast',
    systemPrompt: 'You read what reached you and name the single weakest point in it, in one sentence.',
    temperature: 0.4,
    hue: 48,
    position: { x: right, y: top },
  })
  for (const leaf of leaves) spec.links.push({ id: freshId(taken, 'l'), source: leaf.id, target: reviewer })
  return { spec, what: 'added a reviewer after the last agents' }
}
