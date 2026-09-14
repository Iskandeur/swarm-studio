import { BaseEdge, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react'
import { useTheme } from '@mui/material'
import { agentColor } from '../theme'

export type MessageEdgeData = { hue: number; active: boolean }
export type MessageFlowEdge = Edge<MessageEdgeData, 'message'>

/**
 * A directed "can speak to" link. When a message actually travels on it, a packet
 * slides along the curve — the run is legible without reading the transcript.
 */
export function MessageEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps<MessageFlowEdge>) {
  const theme = useTheme()
  const mode = theme.palette.mode as 'light' | 'dark'
  const hue = data?.hue ?? 262
  const color = agentColor(hue, mode)
  const active = Boolean(data?.active)

  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: active ? color : theme.palette.divider,
          strokeWidth: active ? 2.4 : 1.6,
          opacity: active ? 1 : mode === 'dark' ? 0.75 : 0.85,
          transition: 'stroke .3s ease, stroke-width .3s ease',
        }}
      />
      {active && (
        <>
          <path d={path} fill="none" stroke={color} strokeWidth={7} opacity={0.16} />
          <circle r={5.5} fill={color}>
            <animateMotion dur="0.85s" repeatCount="indefinite" path={path} />
          </circle>
          <circle r={11} fill={color} opacity={0.22}>
            <animateMotion dur="0.85s" repeatCount="indefinite" path={path} />
          </circle>
        </>
      )}
    </>
  )
}
