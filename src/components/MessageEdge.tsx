import { useState } from 'react'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react'
import { IconButton, Tooltip, useTheme } from '@mui/material'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import { agentColor } from '../theme'
import { useStore } from '../store'

export type MessageEdgeData = { hue: number; active: boolean; reversed: boolean; label: string }
export type MessageFlowEdge = Edge<MessageEdgeData, 'message'>

/** SVG has no "play backwards": walking the keyPoints from 1 to 0 is how you reverse a motion. */
function motionDirection(reversed: boolean) {
  return reversed ? { keyPoints: '1;0', keyTimes: '0;1', calcMode: 'linear' as const } : {}
}

/**
 * A directed "can speak to" link. When a message actually travels on it, a packet slides along the
 * curve — the run is legible without reading the transcript.
 *
 * It also carries its own delete button. Relying on "select the edge, press Delete" was a real
 * dead end: nothing on screen said so, and a phone has no Delete key at all.
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
  selected,
}: EdgeProps<MessageFlowEdge>) {
  const theme = useTheme()
  const mode = theme.palette.mode as 'light' | 'dark'
  const removeLink = useStore((s) => s.removeLink)
  const [hovered, setHovered] = useState(false)
  const hue = data?.hue ?? 262
  const color = agentColor(hue, mode)
  const active = Boolean(data?.active)
  const reversed = Boolean(data?.reversed)
  const showDelete = hovered || Boolean(selected)

  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: active ? color : selected ? color : theme.palette.divider,
          strokeWidth: active ? 2.4 : selected ? 2.2 : 1.6,
          opacity: active || selected ? 1 : mode === 'dark' ? 0.75 : 0.85,
          transition: 'stroke .3s ease, stroke-width .3s ease',
        }}
      />
      {/* Invisible fat path: a 1.6px line is impossible to hover, and worse to tap. */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={26}
        style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => setHovered(true)}
      />

      {active && (
        <>
          <path d={path} fill="none" stroke={color} strokeWidth={7} opacity={0.16} />
          {/* keyPoints 1;0 walks the same curve backwards, for a message climbing back up its link.
              Without it, a manager-mode reply animated exactly like the delegation that preceded it,
              so the picture said the opposite of the transcript. */}
          <circle r={5.5} fill={color}>
            <animateMotion dur="0.85s" repeatCount="indefinite" path={path} {...motionDirection(reversed)} />
          </circle>
          <circle r={11} fill={color} opacity={0.22}>
            <animateMotion dur="0.85s" repeatCount="indefinite" path={path} {...motionDirection(reversed)} />
          </circle>
        </>
      )}

      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
            opacity: showDelete ? 1 : 0,
            transition: 'opacity .18s ease',
          }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <Tooltip title={data?.label ? `Cut link: ${data.label}` : 'Cut this link'}>
            <IconButton
              size="small"
              aria-label={data?.label ? `Cut link ${data.label}` : 'Cut link'}
              onClick={(event) => {
                event.stopPropagation()
                removeLink(id)
              }}
              sx={{
                width: 24,
                height: 24,
                bgcolor: 'background.paper',
                border: '1px solid',
                borderColor: 'divider',
                boxShadow: 1,
                '&:hover': { bgcolor: 'error.main', color: 'error.contrastText', borderColor: 'error.main' },
              }}
            >
              <CloseRoundedIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </Tooltip>
        </div>
      </EdgeLabelRenderer>
    </>
  )
}
