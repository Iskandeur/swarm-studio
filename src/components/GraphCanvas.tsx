import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react'
import { Box, useTheme } from '@mui/material'
import { useStore } from '../store'
import { resolveEntryIds } from '../engine/runner'
import { AgentNode, type AgentFlowNode } from './AgentNode'
import { MessageEdge, type MessageFlowEdge } from './MessageEdge'
import { agentColor } from '../theme'

const nodeTypes = { agent: AgentNode }
const edgeTypes = { message: MessageEdge }

export function GraphCanvas({ onAgentOpen }: { onAgentOpen?: () => void } = {}) {
  const theme = useTheme()
  const mode = theme.palette.mode as 'light' | 'dark'
  /** Kept locally: edges are rebuilt from the store each render, so their selection would be lost.
   *  It matters because on a touch screen there is no hover — selecting is the only way to reveal
   *  the cut button. */
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const spec = useStore((s) => s.spec)
  const statuses = useStore((s) => s.statuses)
  const transcript = useStore((s) => s.transcript)
  const transit = useStore((s) => s.transit)
  const selectedId = useStore((s) => s.selectedId)
  const select = useStore((s) => s.select)
  const moveAgent = useStore((s) => s.moveAgent)
  const addLink = useStore((s) => s.addLink)
  const removeLink = useStore((s) => s.removeLink)

  const entryIds = useMemo(() => resolveEntryIds(spec), [spec])

  /** The tail of each agent's in-flight message, so a node shows its own words. */
  const live = useMemo(() => {
    const map: Record<string, string> = {}
    for (const entry of transcript) {
      if (entry.status === 'streaming') map[entry.agentId] = entry.text.slice(-44)
    }
    return map
  }, [transcript])

  /**
   * React Flow keeps measured sizes on the node objects, so the canvas owns the node list and
   * the store owns the truth. We mirror the store into local state and write positions back on
   * drag end — rebuilding the array on every render would throw away those measurements.
   */
  const [nodes, setNodes] = useState<AgentFlowNode[]>([])

  useEffect(() => {
    setNodes((current) => {
      const previous = new Map(current.map((n) => [n.id, n]))
      return spec.agents.map((agent) => {
        const existing = previous.get(agent.id)
        const data = {
          name: agent.name,
          model: agent.model,
          provider: agent.provider,
          hue: agent.hue,
          status: statuses[agent.id] ?? ('idle' as const),
          isEntry: entryIds.includes(agent.id),
          live: live[agent.id] ?? '',
          tokensOut: 0,
        }
        return existing
          ? { ...existing, position: existing.dragging ? existing.position : agent.position, selected: agent.id === selectedId, data }
          : { id: agent.id, type: 'agent' as const, position: agent.position, selected: agent.id === selectedId, data }
      })
    })
  }, [spec.agents, statuses, entryIds, live, selectedId])

  const edges: MessageFlowEdge[] = useMemo(
    () =>
      spec.links.map((link) => {
        const from = spec.agents.find((a) => a.id === link.source)
        const to = spec.agents.find((a) => a.id === link.target)
        const hue = from?.hue ?? 262
        const packet = transit.find((p) => p.id === link.id)
        const active = Boolean(packet)
        return {
          id: link.id,
          source: link.source,
          target: link.target,
          type: 'message' as const,
          selected: link.id === selectedEdgeId,
          data: {
            hue,
            active,
            // A manager-mode reply climbs back up its own downward link.
            reversed: Boolean(packet?.reversed),
            label: `${from?.name ?? link.source} → ${to?.name ?? link.target}`,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 16,
            height: 16,
            color: active ? agentColor(hue, mode) : theme.palette.divider,
          },
        }
      }),
    [spec.links, spec.agents, transit, mode, theme.palette.divider, selectedEdgeId],
  )

  const onNodesChange = useCallback(
    (changes: NodeChange<AgentFlowNode>[]) => {
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
        if (change.type === 'remove') {
          removeLink(change.id)
          setSelectedEdgeId((current) => (current === change.id ? null : current))
        }
      }
    },
    [removeLink],
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) addLink(connection.source, connection.target)
    },
    [addLink],
  )

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
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_, node) => moveAgent(node.id, node.position)}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onEdgeClick={(_, edge) => setSelectedEdgeId(edge.id)}
        // Tapping a node is how you reach its model and prompt. On a phone the panel is a sheet,
        // so the tap has to open it — otherwise the settings stay invisible behind a second gesture.
        onNodeClick={(_, node) => {
          select(node.id)
          setSelectedEdgeId(null)
          onAgentOpen?.()
        }}
        onPaneClick={() => {
          select(undefined)
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
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.2}
          color={mode === 'dark' ? 'rgba(255,255,255,.11)' : 'rgba(0,0,0,.12)'}
        />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </Box>
  )
}
