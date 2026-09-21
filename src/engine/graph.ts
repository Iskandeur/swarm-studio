/**
 * Reading a graph without caring whether it came from version 1 or version 2.
 *
 * A version-1 spec has no `nodes`, links without `kind`, and no blocks. Every reader goes through the
 * helpers below instead of touching those fields directly, so a stored swarm from last week and a
 * swarm pasted from an older build run the same way as a new one.
 */
import type { Access, Agent, BlockDef, FlowNode, Graph, Link, MemoryNode, SwarmSpec } from '../types.ts'

export function nodesOf(graph: Graph): FlowNode[] {
  return graph.nodes ?? []
}

export function isAccess(link: Link): boolean {
  return link.kind === 'access'
}

export function messageLinks(graph: Graph): Link[] {
  return graph.links.filter((l) => !isAccess(l))
}

export type AnyNode = { kind: 'agent'; agent: Agent } | { kind: FlowNode['kind']; node: FlowNode }

/** Every id on the graph, agents and other nodes together. */
export function nodeIds(graph: Graph): Set<string> {
  return new Set([...graph.agents.map((a) => a.id), ...nodesOf(graph).map((n) => n.id)])
}

export function findFlowNode(graph: Graph, id: string): FlowNode | undefined {
  return nodesOf(graph).find((n) => n.id === id)
}

export function nameOfNode(graph: Graph, id: string): string {
  return graph.agents.find((a) => a.id === id)?.name ?? findFlowNode(graph, id)?.name ?? id
}

/**
 * What an access link grants. The direction on the canvas follows the data — agent → memory is a
 * write, memory → agent a read — unless the link says `readwrite` explicitly.
 */
export function accessGranted(link: Link, memoryId: string): Access {
  if (link.access === 'readwrite') return 'readwrite'
  if (link.access) return link.access
  return link.source === memoryId ? 'read' : 'write'
}

/** The agent at the other end of an access link, or undefined when the link is not memory ↔ agent. */
export function accessEnds(graph: Graph, link: Link): { memory: MemoryNode; agentId: string } | undefined {
  if (!isAccess(link)) return undefined
  const sourceNode = findFlowNode(graph, link.source)
  const targetNode = findFlowNode(graph, link.target)
  if (sourceNode?.kind === 'memory' && graph.agents.some((a) => a.id === link.target)) {
    return { memory: sourceNode, agentId: link.target }
  }
  if (targetNode?.kind === 'memory' && graph.agents.some((a) => a.id === link.source)) {
    return { memory: targetNode, agentId: link.source }
  }
  return undefined
}

export function canRead(graph: Graph, agentId: string, memoryId: string): boolean {
  return graph.links.some((l) => {
    const ends = accessEnds(graph, l)
    if (!ends || ends.agentId !== agentId || ends.memory.id !== memoryId) return false
    const granted = accessGranted(l, memoryId)
    return granted === 'read' || granted === 'readwrite'
  })
}

export function canWrite(graph: Graph, agentId: string, memoryId: string): boolean {
  return graph.links.some((l) => {
    const ends = accessEnds(graph, l)
    if (!ends || ends.agentId !== agentId || ends.memory.id !== memoryId) return false
    const granted = accessGranted(l, memoryId)
    return granted === 'write' || granted === 'readwrite'
  })
}

/** Memories an agent can see, in canvas order. */
export function readableMemories(graph: Graph, agentId: string): MemoryNode[] {
  return nodesOf(graph).filter((n): n is MemoryNode => n.kind === 'memory' && canRead(graph, agentId, n.id))
}

export function writableMemories(graph: Graph, agentId: string): MemoryNode[] {
  return nodesOf(graph).filter((n): n is MemoryNode => n.kind === 'memory' && canWrite(graph, agentId, n.id))
}

/**
 * Kinds that take a turn in a round, like an agent: they cost a call and time, so they are scheduled,
 * not resolved inline. A block runs a nested graph; a decision asks a decision model.
 */
export const TURN_KINDS: ReadonlySet<FlowNode['kind']> = new Set(['block', 'decision'])

/**
 * Nodes that receive the task: the explicit entry list, or every agent, block or decision with no
 * incoming MESSAGE link. Access links do not count — a memory feeding an agent does not make it a follower.
 */
export function resolveEntryIds(graph: Graph): string[] {
  const known = nodeIds(graph)
  if (graph.entryIds.length > 0) return graph.entryIds.filter((id) => known.has(id))
  const hasIncoming = new Set(messageLinks(graph).map((l) => l.target))
  const speakers = [
    ...graph.agents.map((a) => a.id),
    ...nodesOf(graph).filter((n) => TURN_KINDS.has(n.kind)).map((n) => n.id),
  ]
  const roots = speakers.filter((id) => !hasIncoming.has(id))
  if (roots.length > 0) return roots
  return speakers.slice(0, 1)
}

export function findBlock(spec: Pick<SwarmSpec, 'blocks'>, blockId: string, library: BlockDef[] = []): BlockDef | undefined {
  return spec.blocks?.find((b) => b.id === blockId) ?? library.find((b) => b.id === blockId)
}

/** A spec as the engine expects it: every optional collection present. Never mutates its input. */
export function normalizeSpec(spec: SwarmSpec): SwarmSpec {
  return {
    ...spec,
    nodes: spec.nodes ?? [],
    blocks: spec.blocks ?? [],
  }
}
