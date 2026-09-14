import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import { Box, Chip, Paper, Typography, useMediaQuery, useTheme } from '@mui/material'
import BoltRoundedIcon from '@mui/icons-material/BoltRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import type { AgentStatus } from '../types'
import { agentColor, agentGlow } from '../theme'

export type AgentNodeData = {
  name: string
  model: string
  provider: string
  hue: number
  status: AgentStatus
  isEntry: boolean
  /** Tail of the message being produced right now, so the node itself shows life. */
  live: string
  tokensOut: number
}

export type AgentFlowNode = Node<AgentNodeData, 'agent'>

const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: 'idle',
  queued: 'queued',
  thinking: 'thinking',
  speaking: 'speaking',
  done: 'done',
  error: 'error',
}

export function AgentNode({ data, selected }: NodeProps<AgentFlowNode>) {
  const theme = useTheme()
  const mode = theme.palette.mode as 'light' | 'dark'
  const color = agentColor(data.hue, mode)
  const busy = data.status === 'thinking' || data.status === 'speaking'
  // A fingertip is not a mouse pointer: the connect dots need to be grabbable.
  const touch = useMediaQuery('(pointer: coarse)')
  const handleSize = touch ? 18 : 10

  return (
    <Paper
      elevation={0}
      sx={{
        position: 'relative',
        width: 232,
        px: 1.75,
        py: 1.5,
        borderRadius: 4,
        border: '1px solid',
        borderColor: selected ? color : theme.palette.divider,
        outline: selected ? `1px solid ${color}` : 'none',
        overflow: 'hidden',
        transition: 'box-shadow .25s ease, border-color .25s ease, transform .25s ease',
        transform: busy ? 'translateY(-2px)' : 'none',
        boxShadow: busy
          ? `0 0 0 1px ${agentGlow(data.hue, 0.55)}, 0 10px 34px ${agentGlow(data.hue, 0.32)}`
          : '0 1px 2px rgba(0,0,0,.14)',
        '&::before': {
          content: '""',
          position: 'absolute',
          inset: 0,
          borderRadius: 'inherit',
          background: `linear-gradient(135deg, ${agentGlow(data.hue, mode === 'dark' ? 0.16 : 0.1)}, transparent 62%)`,
          pointerEvents: 'none',
        },
      }}
    >
      {busy && (
        <Box
          sx={{
            position: 'absolute',
            left: 0,
            top: 0,
            height: 3,
            width: '38%',
            borderRadius: 3,
            bgcolor: color,
            animation: 'swarm-sweep 1.15s cubic-bezier(.4,0,.2,1) infinite',
            '@keyframes swarm-sweep': {
              '0%': { transform: 'translateX(-100%)' },
              '100%': { transform: 'translateX(365%)' },
            },
          }}
        />
      )}

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.75 }}>
        <Box
          sx={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            bgcolor: color,
            flexShrink: 0,
            boxShadow: busy ? `0 0 0 5px ${agentGlow(data.hue, 0.22)}` : 'none',
            animation: busy ? 'swarm-pulse 1.4s ease-in-out infinite' : 'none',
            '@keyframes swarm-pulse': {
              '0%,100%': { opacity: 1 },
              '50%': { opacity: 0.4 },
            },
          }}
        />
        <Typography variant="subtitle2" sx={{ flex: 1, minWidth: 0 }} noWrap>
          {data.name}
        </Typography>
        {data.isEntry && (
          <BoltRoundedIcon sx={{ fontSize: 16, color }} titleAccess="receives the task" />
        )}
        {data.status === 'done' && <CheckRoundedIcon sx={{ fontSize: 16, opacity: 0.55 }} />}
        {data.status === 'error' && <ErrorOutlineRoundedIcon color="error" sx={{ fontSize: 16 }} />}
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
        <Chip
          size="small"
          label={data.model}
          sx={{
            height: 20,
            fontSize: 11,
            fontFamily: '"Roboto Mono", monospace',
            bgcolor: agentGlow(data.hue, mode === 'dark' ? 0.18 : 0.12),
            color: 'text.primary',
          }}
        />
        <Typography variant="caption" sx={{ opacity: 0.55 }}>
          {data.provider}
        </Typography>
      </Box>

      <Typography
        variant="caption"
        sx={{
          display: 'block',
          mt: 1,
          height: 30,
          fontFamily: '"Roboto Mono", monospace',
          fontSize: 10.5,
          lineHeight: 1.4,
          opacity: data.live ? 0.82 : 0.35,
          overflow: 'hidden',
        }}
      >
        {data.live ? `…${data.live}` : STATUS_LABEL[data.status]}
      </Typography>

      <Handle type="target" position={Position.Left} style={handleStyle(color, handleSize)} />
      <Handle type="source" position={Position.Right} style={handleStyle(color, handleSize)} />
    </Paper>
  )
}

function handleStyle(color: string, size: number) {
  return {
    width: size,
    height: size,
    border: '2px solid',
    borderColor: color,
    background: 'var(--swarm-handle-bg)',
  } as const
}
