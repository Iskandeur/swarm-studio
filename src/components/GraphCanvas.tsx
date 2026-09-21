import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react'
import { Box, useTheme } from '@mui/material'
import { useGraph, useStore, type RunGraph } from '../store'
import { resolveEntryIds } from '../engine/runner'
import { nodesOf } from '../engine/graph'
import { describePredicate } from '../engine/predicates'
import { stripActionTags } from '../engine/actions'
import { AgentNode, type AgentFlowNode } from './AgentNode'
import { FlowNodeView, type FlowFlowNode } from './FlowNodes'
import { MessageEdge, type MessageFlowEdge } from './MessageEdge'
import { agentColor } from '../theme'
import type { Agent, AgentStatus, FlowNode, Link } from '../types'

const nodeTypes = { agent: AgentNode, flow: FlowNodeView }
const edgeTypes = { message: MessageEdge }

type CanvasNode = AgentFlowNode | FlowFlowNode

const NO_STATUSES: Record<string, AgentStatus> = {}
const NO_RUN_GRAPH: RunGraph = { agents: [], nodes: [], links: [] }

export function GraphCanvas({ onAgentOpen, children }: { onAgentOpen?: () => void; children?: ReactNode } = {}) {
  const theme = useTheme()
  const mode = theme.palette.mode as 'light' | 'dark'
  /** Kept locally: edges are rebuilt from the store each render, so their selection would be lost.
   *  It matters because on a touch screen there is no hover — selecting is the only way to reveal
   *  the cut button. */
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const graph = useGraph()
  const editingBlockId = useStore((s) => s.editingBlockId)
  const topStatuses = useStore((s) => s.statuses)
  const nestedStatuses = useStore((s) => s.nestedStatuses)
  const transcript = useStore((s) => s.transcript)
  const transit = useStore((s) => s.transit)
  const selectedId = useStore((s) => s.selectedId)
  const runGraph = useStore((s) => s.runGraph)
  const memoryEntries = useStore((s) => s.memoryEntries)
  const flashes = useStore((s) => s.flashes)
  const skippedLinks = useStore((s) => s.skippedLinks)
  const decisions = useStore((s) => s.decisions)
  const select = useStore((s) => s.select)
  const selectLink = useStore((s) => s.selectLink)
  const moveAgent = useStore((s) => s.moveAgent)
  const addLink = useStore((s) => s.addLink)
  const removeLink = useStore((s) => s.removeLink)
  const openBlock = useStore((s) => s.openBlock)

  // A run is always the swarm. Inside a block definition, its statuses and spawns would be lies.
  // Module-level empties, not literals: a fresh `{}` per render is a new dependency every render,
  // and the effect below would rebuild the nodes in a loop.
  const inBlock = Boolean(editingBlockId)
  const statuses: Record<string, AgentStatus> = inBlock ? NO_STATUSES : topStatuses
  const extra: RunGraph = inBlock ? NO_RUN_GRAPH : runGraph

  const entryIds = useMemo(() => resolveEntryIds(graph), [graph])
  const flowNodes = useMemo(() => nodesOf(graph), [graph])

  /** The tail of each agent's in-flight message, so a node shows its own words — never half a tag. */
  const live = useMemo(() => {
    const map: Record<string, string> = {}
    if (inBlock) return map
    for (const entry of transcript) {
      if (entry.status === 'streaming' && !entry.path) map[entry.agentId] = stripActionTags(entry.text).slice(-44)
    }
    return map
  }, [transcript, inBlock])

  /**
   * React Flow keeps measured sizes on the node objects, so the canvas owns the node list and
   * the store owns the truth. We mirror the store into local state and write positions back on
   * drag end — rebuilding the array on every render would throw away those measurements.
   */
  const [nodes, setNodes] = useState<CanvasNode[]>([])

  useEffect(() => {
    const agentData = (agent: Agent, ephemeral: boolean) => ({
      name: agent.name,
      model: agent.model,
      provider: agent.provider,
      hue: agent.hue,
      status: statuses[agent.id] ?? ('idle' as const),
      isEntry: !ephemeral && entryIds.includes(agent.id),
      live: live[agent.id] ?? '',
      ephemeral,
      canSpawn: Boolean(agent.canSpawn),
      chooses: agent.dispatch === 'choose',
    })
    const allAgents = [...graph.agents, ...extra.agents]
    const flowData = (node: FlowNode, ephemeral: boolean) => {
      const entries = node.kind === 'memory' ? memoryEntries[node.id] : undefined
      const last = entries?.at(-1)
      const writer = last ? allAgents.find((a) => a.name === last.author) : undefined
      let blockProgress: { running: number; done: number } | undefined
      if (node.kind === 'block' && !inBlock) {
        blockProgress = { running: 0, done: 0 }
        for (const [key, status] of Object.entries(nestedStatuses)) {
          if (!key.startsWith(`${node.id}/`)) continue
          if (status === 'thinking' || status === 'speaking') blockProgress.running++
          if (status === 'done') blockProgress.done++
        }
      }
      return {
        node,
        status: statuses[node.id],
        flashAt: flashes[node.id],
        ...(node.kind === 'memory' ? { memoryCount: entries?.length ?? node.seed.length } : {}),
        ...(writer ? { lastWriter: { name: writer.name, hue: writer.hue } } : {}),
        ...(blockProgress ? { blockProgress } : {}),
        ...(node.kind === 'decision' && !inBlock && decisions[node.id] ? { answers: decisions[node.id] } : {}),
        ephemeral,
        isEntry: !ephemeral && entryIds.includes(node.id),
      }
    }
    setNodes((current) => {
      const previous = new Map(current.map((n) => [n.id, n]))
      const build = <T extends CanvasNode>(id: string, type: T['type'], position: { x: number; y: number }, data: T['data'], draggable = true) => {
        const existing = previous.get(id)
        return (
          existing && existing.type === type
            ? { ...existing, position: existing.dragging ? existing.position : position, selected: id === selectedId, data, draggable }
            : { id, type, position, selected: id === selectedId, data, draggable }
        ) as T
      }
      return [
        ...graph.agents.map((a) => build<AgentFlowNode>(a.id, 'agent', a.position, agentData(a, false))),
        ...flowNodes.map((n) => build<FlowFlowNode>(n.id, 'flow', n.position, flowData(n, false))),
        // What the run grew. Not draggable: it is not in the swarm, so a position would go nowhere.
        ...extra.agents.map((a) => build<AgentFlowNode>(a.id, 'agent', a.position, agentData(a, true), false)),
        ...extra.nodes.map((n) => build<FlowFlowNode>(n.id, 'flow', n.position, flowData(n, true), false)),
      ]
    })
  }, [graph, flowNodes, extra, statuses, nestedStatuses, entryIds, live, selectedId, memoryEntries, flashes, inBlock, decisions])

  /**
   * `fitView` on the component runs with whatever sizes React Flow has at mount, and on a phone the
   * nodes are not measured yet — so the graph opened at zoom 1 with half the swarm off the right
   * edge. Frame it once, the first time the nodes have real dimensions, and never again: a refit
   * after that would yank the canvas back every time the keyboard opened. Opening a block is a new
   * picture, so it frames again.
   */
  const { fitView } = useReactFlow()
  const nodesInitialized = useNodesInitialized()
  const [framedFor, setFramedFor] = useState<string | null>(null)
  const frameKey = editingBlockId ?? '<swarm>'

  useEffect(() => {
    if (!nodesInitialized || framedFor === frameKey) return
    setFramedFor(frameKey)
    // Never above 1: a swarm of two nodes framed at zoom 2 looks like a rendering bug.
    void fitView({ padding: 0.3, maxZoom: 1 })
  }, [nodesInitialized, framedFor, frameKey, fitView])

  /**
   * The one exception to "frame once": a run that GROWS the graph. Spawned helpers are placed to the
   * right of their creator, and a real screenshot showed the whole delegation chain being built off
   * screen while the canvas stayed on the one agent that started it. Only growth reframes, never a
   * reset, so the canvas does not jump when the run ends.
   */
  const grown = extra.agents.length + extra.nodes.length
  const [framedGrowth, setFramedGrowth] = useState(0)
  useEffect(() => {
    if (grown <= framedGrowth) {
      if (grown < framedGrowth) setFramedGrowth(grown)
      return
    }
    setFramedGrowth(grown)
    // After React Flow has measured the new node, or the frame is computed without it.
    const timer = setTimeout(() => void fitView({ padding: 0.3, maxZoom: 1, duration: 450 }), 120)
    return () => clearTimeout(timer)
  }, [grown, framedGrowth, fitView])

  const edges: MessageFlowEdge[] = useMemo(() => {
    const all = [...graph.agents, ...extra.agents]
    const allNodes = [...flowNodes, ...extra.nodes]
    const hueOf = (id: string) => all.find((a) => a.id === id)?.hue
    const nameOf = (id: string) => all.find((a) => a.id === id)?.name ?? allNodes.find((n) => n.id === id)?.name ?? id
    const edgeOf = (link: Link, ephemeral: boolean): MessageFlowEdge => {
      const access = link.kind === 'access'
      // An access link takes the colour of its agent, whichever end that is.
      const hue = hueOf(link.source) ?? hueOf(link.target) ?? 262
      const packet = transit.find((p) => p.id === link.id)
      const active = Boolean(packet)
      const granted = access
        ? link.access ?? (allNodes.find((n) => n.id === link.source)?.kind === 'memory' ? 'read' : 'write')
        : undefined
      const marker = {
        type: MarkerType.ArrowClosed,
        width: 16,
        height: 16,
        color: active || ephemeral ? agentColor(hue, mode) : theme.palette.divider,
      }
      return {
        id: link.id,
        source: link.source,
        target: link.target,
        type: 'message' as const,
        selected: link.id === selectedEdgeId,
        data: {
          hue,
          active,
          // A manager-mode reply, or a helper's answer, climbs back up its own downward link.
          reversed: Boolean(packet?.reversed),
          label: `${nameOf(link.source)} → ${nameOf(link.target)}`,
          ...(link.label && !ephemeral ? { branch: link.label } : {}),
          ...(link.guard ? { guard: describePredicate(link.guard) } : {}),
          ...(link.maxTraversals !== undefined ? { budget: link.maxTraversals } : {}),
          ...(link.isDefault ? { isDefault: true } : {}),
          ...(granted ? { access: granted } : {}),
          skipped: skippedLinks.includes(link.id),
          ephemeral,
        },
        markerEnd: marker,
        ...(granted === 'readwrite' ? { markerStart: marker } : {}),
      }
    }
    return [...graph.links.map((l) => edgeOf(l, false)), ...extra.links.map((l) => edgeOf(l, true))]
  }, [graph, flowNodes, extra, transit, mode, theme.palette.divider, selectedEdgeId, skippedLinks])

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      setNodes((current) => applyNodeChanges(changes, current))
      for (const change of changes) {
        if (change.type === 'select' && change.selected) select(change.id)
      }
    },
    [select],
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange<MessageFlowEdge>[]) => {
      for (const change of changes) {
        if (change.type === 'remove' && graph.links.some((l) => l.id === change.id)) {
          removeLink(change.id)
          setSelectedEdgeId((current) => (current === change.id ? null : current))
        }
      }
    },
    [removeLink, graph.links],
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) addLink(connection.source, connection.target)
    },
    [addLink],
  )

  const isEphemeral = (id: string) => extra.agents.some((a) => a.id === id) || extra.nodes.some((n) => n.id === id)

  return (
    <Box
      sx={{
        position: 'relative',
        height: '100%',
        '--swarm-handle-bg': theme.palette.background.paper,
        '& .react-flow__attribution': { display: 'none' },
        '& .react-flow__controls-button': {
          background: theme.palette.background.paper,
          borderColor: theme.palette.divider,
          color: theme.palette.text.primary,
          fill: 'currentColor',
        },
      }}
    >
      <ReactFlow<CanvasNode, MessageFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_, node) => {
          if (!isEphemeral(node.id)) moveAgent(node.id, node.position)
        }}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onEdgeClick={(_, edge) => {
          setSelectedEdgeId(edge.id)
          // A spawned link has nothing to configure.
          if (graph.links.some((l) => l.id === edge.id)) {
            selectLink(edge.id)
            onAgentOpen?.()
          }
        }}
        // Tapping a node is how you reach its model and prompt. On a phone the panel is a sheet,
        // so the tap has to open it — otherwise the settings stay invisible behind a second gesture.
        onNodeClick={(_, node) => {
          select(node.id)
          setSelectedEdgeId(null)
          onAgentOpen?.()
        }}
        // Double-click a block to walk into it, the way you would open a folder.
        onNodeDoubleClick={(_, node) => {
          const flow = flowNodes.find((n) => n.id === node.id)
          if (flow?.kind === 'block') openBlock(flow.blockId)
        }}
        onPaneClick={() => {
          select(undefined)
          selectLink(undefined)
          setSelectedEdgeId(null)
        }}
        colorMode={mode}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: 'message' }}
        minZoom={0.2}
        maxZoom={2}
        // Generous grab radius so a fingertip can land a connection.
        connectionRadius={34}
        panOnDrag
        zoomOnPinch
        zoomOnDoubleClick={false}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.2}
          color={mode === 'dark' ? 'rgba(255,255,255,.11)' : 'rgba(0,0,0,.12)'}
        />
        <Controls showInteractive={false} position="bottom-right" />
        {children}
      </ReactFlow>
    </Box>
  )
}
