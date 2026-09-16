import { useEffect, useState, type ReactNode } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { Box, Chip, IconButton, LinearProgress, Tooltip, Typography, useMediaQuery, useTheme } from '@mui/material'
import { alpha, type Theme } from '@mui/material/styles'
import AltRouteRoundedIcon from '@mui/icons-material/AltRouteRounded'
import BoltRoundedIcon from '@mui/icons-material/BoltRounded'
import CallMergeRoundedIcon from '@mui/icons-material/CallMergeRounded'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import FlagRoundedIcon from '@mui/icons-material/FlagRounded'
import LayersRoundedIcon from '@mui/icons-material/LayersRounded'
import OpenInNewRoundedIcon from '@mui/icons-material/OpenInNewRounded'
import PanToolRoundedIcon from '@mui/icons-material/PanToolRounded'
import PodcastsRoundedIcon from '@mui/icons-material/PodcastsRounded'
import StorageRoundedIcon from '@mui/icons-material/StorageRounded'
import type { AgentStatus, FlowNode, FlowNodeKind } from '../types'
import { agentColor, agentGlow } from '../theme'
import { describePredicate } from '../engine/predicates'
import { useStore } from '../store'

/**
 * Every node of the graph that is not an agent: condition, join, output, human gate, memory, block.
 *
 * One component switching on `kind`, not six, because React Flow picks a component per node TYPE and
 * the integrator registers one type (`flow`). What the kinds share — handles, the ✕, selection, the
 * flash, the dashed outline of a spawned node — lives here once, so the six shapes cannot drift apart.
 */

export type FlowNodeData = {
  /** The node as stored in the spec. */
  node: FlowNode
  /** For human gates (`waiting` while a person must decide) and blocks. */
  status?: AgentStatus
  /** `Date.now()` of the last time the engine reported this node acting. */
  flashAt?: number
  /** Memory: number of entries right now (live, or the seed before a run). */
  memoryCount?: number
  /** Memory: who wrote last, for the flash colour. */
  lastWriter?: { name: string; hue: number }
  /** Block: inner agents thinking/speaking vs done. */
  blockProgress?: { running: number; done: number }
  /** Created by a run (a spawned block): dashed outline, no delete button. */
  ephemeral?: boolean
  /** Receives the task. */
  isEntry?: boolean
}

export type FlowFlowNode = Node<FlowNodeData, 'flow'>

/** How long a node glows after the engine reports it acting. Long enough to be seen, short enough not to smear a busy round. */
const FLASH_MS = 1200
/** A condition caption is one line under a diamond; the full predicate is in the tooltip. */
const CAPTION_CHARS = 40
/**
 * Amber, as a hue, so it goes through `agentColor`: that function is where text contrast is measured
 * (`theme.test.ts`), and "waiting for you" is information, not decoration.
 */
const AMBER_HUE = 40

const KIND_LABEL: Record<FlowNodeKind, string> = {
  condition: 'Condition',
  join: 'Join',
  output: 'Output',
  human: 'Human gate',
  memory: 'Memory',
  block: 'Block',
}

export function FlowNodeView({ id, data, selected }: NodeProps<FlowFlowNode>): JSX.Element {
  const theme = useTheme()
  const mode = theme.palette.mode as 'light' | 'dark'
  // A fingertip is not a mouse pointer: the connect dots need to be grabbable (same rule as AgentNode).
  const touch = useMediaQuery('(pointer: coarse)')
  const flashing = useFlash(data.flashAt)

  const shell: Shell = {
    id,
    data,
    selected: Boolean(selected),
    theme,
    mode,
    touch,
    flashing,
  }

  const node = data.node
  switch (node.kind) {
    case 'condition':
      return <ConditionShape shell={shell} name={node.name} caption={describePredicate(node.predicate)} />
    case 'join':
      return <JoinShape shell={shell} name={node.name} joinMode={node.mode} />
    case 'output':
      return <OutputShape shell={shell} name={node.name} />
    case 'human':
      return <HumanShape shell={shell} name={node.name} prompt={node.prompt} />
    case 'memory':
      return <MemoryShape shell={shell} name={node.name} memoryMode={node.mode} wakeReaders={node.wakeReaders} seedCount={node.seed?.length ?? 0} />
    case 'block':
      return <BlockShape shell={shell} name={node.name} blockId={node.blockId} />
    default:
      // A pasted spec from a newer version could carry a kind this build does not know. Throwing here
      // would blank the whole canvas; a plain card keeps the node visible, linkable and deletable.
      return <UnknownShape shell={shell} name={(node as { name?: string }).name ?? '?'} />
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Shared pieces                                                                                     */
/* ------------------------------------------------------------------------------------------------ */

interface Shell {
  id: string
  data: FlowNodeData
  selected: boolean
  theme: Theme
  mode: 'light' | 'dark'
  touch: boolean
  flashing: boolean
}

/**
 * True while `at` is less than FLASH_MS old.
 *
 * The store writes `flashes` only when something happens, so nothing would re-render this node to END
 * the flash — it would glow until the next unrelated update. A timer, scheduled for the time left,
 * forces that one re-render. The extra frame of slack is because a timer may fire a hair early, and
 * an early tick would find the flash still "on" and never be rescheduled (the effect only re-runs
 * when `at` changes).
 */
function useFlash(at: number | undefined): boolean {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (at === undefined) return
    const left = at + FLASH_MS - Date.now()
    if (left <= 0) return
    const timer = setTimeout(() => setTick((n) => n + 1), left + 16)
    return () => clearTimeout(timer)
  }, [at])
  return at !== undefined && Date.now() - at < FLASH_MS
}

/** Colour of the flash: the writer's hue when there is one, the theme accent otherwise. */
function flashColors(theme: Theme, mode: 'light' | 'dark', hue?: number) {
  if (hue === undefined) {
    return { color: theme.palette.primary.main, glow: alpha(theme.palette.primary.main, 0.45) }
  }
  return { color: agentColor(hue, mode), glow: agentGlow(hue, 0.5) }
}

/**
 * The border, selection and glow every shape wears. Kept free of `transform` and `animation` so it
 * can go on the rotated square of a condition without un-rotating it.
 */
function frame(shell: Shell, options: { flash?: { color: string; glow: string }; restShadow?: string; accentBorder?: string } = {}) {
  const { theme, selected, flashing, data } = shell
  const primary = theme.palette.primary.main
  const flash = flashing ? options.flash ?? flashColors(theme, shell.mode) : undefined
  const rest = options.restShadow ?? '0 1px 2px rgba(0,0,0,.14)'
  // A dashed divider-grey line is nearly invisible on the canvas, and "this was spawned" is the whole
  // point of the dashes, so an ephemeral outline gets a readable colour.
  const idle = data.ephemeral ? theme.palette.text.secondary : options.accentBorder ?? theme.palette.divider
  return {
    bgcolor: 'background.paper',
    borderWidth: 1,
    borderStyle: data.ephemeral ? 'dashed' : 'solid',
    borderColor: selected ? primary : flash ? flash.color : idle,
    outline: selected ? `1px solid ${primary}` : 'none',
    boxShadow: flash ? `0 0 0 1px ${flash.color}, 0 0 22px ${flash.glow}, ${rest}` : rest,
    transition: 'box-shadow .25s ease, border-color .25s ease, transform .25s ease',
  } as const
}

/** The outer wrapper of every kind: accessible name, and the fade-in of a node a run just created. */
function Root({ shell, label, children, width }: { shell: Shell; label: string; children: ReactNode; width?: number }) {
  return (
    <Box
      role="group"
      aria-label={label}
      data-flashing={shell.flashing ? 'true' : 'false'}
      sx={{
        position: 'relative',
        width,
        animation: shell.data.ephemeral ? 'swarm-flow-fade-in .35s ease-out' : 'none',
        '@keyframes swarm-flow-fade-in': {
          from: { opacity: 0, transform: 'scale(.94)' },
          to: { opacity: 1, transform: 'none' },
        },
      }}
    >
      {children}
    </Box>
  )
}

function DeleteButton({ shell, name, top = 4, right = 4 }: { shell: Shell; name: string; top?: number; right?: number }) {
  // A spawned node lives in the run state, never in the spec: there is nothing to delete, and a reset
  // clears it anyway.
  if (shell.data.ephemeral) return null
  return (
    <Tooltip title={`Delete ${name}`}>
      <IconButton
        size="small"
        aria-label={`Delete ${name}`}
        className="swarm-node-delete nodrag"
        onClick={(event) => {
          // Otherwise the click also reaches the node and selects what is being deleted.
          event.stopPropagation()
          useStore.getState().removeAgents([shell.id])
        }}
        sx={{
          position: 'absolute',
          top,
          right,
          zIndex: 1,
          width: 20,
          height: 20,
          // Always visible, faintly — the same reasoning as AgentNode: an affordance you only find by
          // hovering is one Iskandeur reported not having.
          opacity: shell.selected || shell.touch ? 0.65 : 0.3,
          transition: 'opacity .18s ease',
          '&:hover': { opacity: 1, color: 'error.main' },
          '.react-flow__node:hover &': { opacity: 0.8 },
        }}
      >
        <CloseRoundedIcon sx={{ fontSize: 14 }} />
      </IconButton>
    </Tooltip>
  )
}

/**
 * Same handle look and size as AgentNode, so a link is drawn the same way whatever it connects.
 * An Output never forwards (§3.2), so it gets no source handle: a link out of it could not carry anything.
 */
function Handles({ shell, color, source = true }: { shell: Shell; color: string; source?: boolean }) {
  const size = shell.touch ? 18 : 10
  const style = {
    width: size,
    height: size,
    border: '2px solid',
    borderColor: color,
    background: 'var(--swarm-handle-bg)',
  } as const
  return (
    <>
      <Handle type="target" position={Position.Left} style={style} />
      {source && <Handle type="source" position={Position.Right} style={style} />}
    </>
  )
}

function EntryBolt({ shell, color }: { shell: Shell; color: string }) {
  if (!shell.data.isEntry) return null
  return <BoltRoundedIcon sx={{ fontSize: 16, color, flexShrink: 0 }} titleAccess="receives the task" />
}

function StatusBadge({ status }: { status?: AgentStatus }) {
  if (status === 'done') return <CheckRoundedIcon sx={{ fontSize: 16, opacity: 0.55, flexShrink: 0 }} titleAccess="done" />
  if (status === 'error') return <ErrorOutlineRoundedIcon color="error" sx={{ fontSize: 16, flexShrink: 0 }} titleAccess="error" />
  return null
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/* ------------------------------------------------------------------------------------------------ */
/* Shapes                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

/** A diamond, the flowchart sign for a decision. The predicate in words sits under it. */
function ConditionShape({ shell, name, caption }: { shell: Shell; name: string; caption: string }) {
  const accent = shell.theme.palette.primary.main
  // 88px square turned 45°: its diagonal is ~124px, which is the box the handles sit on, so the
  // dots land on the left and right tips.
  const box = 124
  const side = 88
  return (
    <Root shell={shell} label={`${KIND_LABEL.condition}: ${name}`} width={200}>
      <Box sx={{ position: 'relative', width: box, height: box, mx: 'auto' }}>
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            top: (box - side) / 2,
            left: (box - side) / 2,
            width: side,
            height: side,
            borderRadius: '12px',
            transform: 'rotate(45deg)',
            ...frame(shell),
          }}
        />
        <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <AltRouteRoundedIcon sx={{ fontSize: 28, color: accent }} />
        </Box>
        {shell.data.isEntry && (
          <Box sx={{ position: 'absolute', top: 6, left: 6 }}>
            <EntryBolt shell={shell} color={accent} />
          </Box>
        )}
        <DeleteButton shell={shell} name={name} />
        <Handles shell={shell} color={accent} />
      </Box>
      <Typography variant="subtitle2" noWrap sx={{ display: 'block', textAlign: 'center', mt: 0.5 }}>
        {name}
      </Typography>
      <Tooltip title={caption}>
        <Typography
          variant="caption"
          noWrap
          sx={{ display: 'block', textAlign: 'center', fontFamily: '"Roboto Mono", monospace', fontSize: 10.5, opacity: 0.7 }}
        >
          {clip(caption, CAPTION_CHARS)}
        </Typography>
      </Tooltip>
    </Root>
  )
}

/** A barrier: a narrow bar things run into and leave together. */
function JoinShape({ shell, name, joinMode }: { shell: Shell; name: string; joinMode: 'all' | 'any' }) {
  const accent = shell.theme.palette.primary.main
  return (
    <Root shell={shell} label={`${KIND_LABEL.join}: ${name}`} width={104}>
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5 }}>
        <Box
          sx={{
            position: 'relative',
            width: 28,
            height: 96,
            borderRadius: '14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            ...frame(shell),
          }}
        >
          {/* The icon merges upward; the graph flows left to right. */}
          <CallMergeRoundedIcon sx={{ fontSize: 18, color: accent, transform: 'rotate(90deg)' }} />
          <Handles shell={shell} color={accent} />
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, maxWidth: 104 }}>
          <Typography variant="caption" noWrap sx={{ fontWeight: 500 }}>
            {name}
          </Typography>
          <EntryBolt shell={shell} color={accent} />
        </Box>
        <Chip
          size="small"
          label={joinMode}
          title={joinMode === 'all' ? 'waits for every branch' : 'lets the first arrival through'}
          sx={{ height: 16, fontSize: 10, '& .MuiChip-label': { px: 0.75 } }}
        />
      </Box>
      <DeleteButton shell={shell} name={name} top={0} right={0} />
    </Root>
  )
}

/** Where a result lands. Target only. */
function OutputShape({ shell, name }: { shell: Shell; name: string }) {
  const accent = shell.theme.palette.secondary.main
  const height = 40
  return (
    <Root shell={shell} label={`${KIND_LABEL.output}: ${name}`}>
      <Box
        sx={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          minWidth: 120,
          maxWidth: 220,
          height,
          pl: 1.5,
          // Room for the ✕, which sits centred on the right end of the pill.
          pr: shell.data.ephemeral ? 2 : 4,
          borderRadius: `${height / 2}px`,
          ...frame(shell),
        }}
      >
        <FlagRoundedIcon sx={{ fontSize: 18, color: accent, flexShrink: 0 }} />
        <Typography variant="subtitle2" noWrap sx={{ minWidth: 0 }}>
          {name}
        </Typography>
        <EntryBolt shell={shell} color={accent} />
        {/* A pill has no top-right corner: the ✕ is centred on its right end instead. */}
        <DeleteButton shell={shell} name={name} top={(height - 20) / 2} right={8} />
        <Handles shell={shell} color={accent} source={false} />
      </Box>
    </Root>
  )
}

/** A hand held up: the flow stops here until a person lets it through. */
function HumanShape({ shell, name, prompt }: { shell: Shell; name: string; prompt: string }) {
  const { mode } = shell
  const amber = agentColor(AMBER_HUE, mode)
  const waiting = shell.data.status === 'waiting'
  return (
    <Root shell={shell} label={`${KIND_LABEL.human}: ${name}`}>
      <Box
        sx={{
          position: 'relative',
          width: 220,
          px: 1.75,
          py: 1.5,
          borderRadius: '16px',
          ...frame(shell, { accentBorder: waiting ? amber : undefined }),
          // The run is paused on this node: it has to be findable on a crowded canvas at a glance.
          animation: waiting ? 'swarm-gate-pulse 1.6s ease-out infinite' : 'none',
          '@keyframes swarm-gate-pulse': {
            '0%': { boxShadow: `0 0 0 0 ${agentGlow(AMBER_HUE, 0.55)}` },
            '70%': { boxShadow: `0 0 0 10px ${agentGlow(AMBER_HUE, 0)}` },
            '100%': { boxShadow: `0 0 0 0 ${agentGlow(AMBER_HUE, 0)}` },
          },
          '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
        }}
      >
        <DeleteButton shell={shell} name={name} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5, pr: 2.5 }}>
          <PanToolRoundedIcon sx={{ fontSize: 18, color: amber, flexShrink: 0 }} />
          <Typography variant="subtitle2" noWrap sx={{ flex: 1, minWidth: 0 }}>
            {name}
          </Typography>
          <EntryBolt shell={shell} color={amber} />
          <StatusBadge status={shell.data.status} />
        </Box>
        <Typography
          variant="caption"
          sx={{
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            lineHeight: 1.4,
            opacity: 0.7,
          }}
        >
          {prompt}
        </Typography>
        {waiting && (
          <Typography variant="caption" sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.75, fontWeight: 500, color: amber }}>
            <Box component="span" sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: amber, flexShrink: 0 }} />
            waiting for you
          </Typography>
        )}
        <Handles shell={shell} color={amber} />
      </Box>
    </Root>
  )
}

/** A cylinder, the usual sign for storage. Its border flashes in the colour of whoever just wrote. */
function MemoryShape({
  shell,
  name,
  memoryMode,
  wakeReaders,
  seedCount,
}: {
  shell: Shell
  name: string
  memoryMode: string
  wakeReaders: boolean
  seedCount: number
}) {
  const { theme, mode, data } = shell
  const accent = theme.palette.secondary.main
  const writer = flashColors(theme, mode, data.lastWriter?.hue)
  const look = frame(shell, { flash: writer })
  // Before a run nothing has been counted yet, but the seed is already what a reader would get.
  const count = data.memoryCount ?? seedCount
  const lid = 28
  return (
    <Root shell={shell} label={`${KIND_LABEL.memory}: ${name}`}>
      <Box
        sx={{
          position: 'relative',
          width: 212,
          pt: `${lid - 4}px`,
          pb: 1.5,
          px: 1.75,
          // Elliptical top and bottom edges: with the lid drawn below, a card becomes a cylinder.
          borderRadius: `50% / ${lid / 2}px`,
          ...look,
          '&::before': {
            content: '""',
            position: 'absolute',
            left: -1,
            right: -1,
            top: -1,
            height: lid,
            boxSizing: 'border-box',
            borderRadius: '50%',
            border: '1px solid',
            borderStyle: look.borderStyle,
            borderColor: look.borderColor,
            background: shell.flashing ? writer.glow : alpha(accent, mode === 'dark' ? 0.14 : 0.08),
            transition: 'background .25s ease, border-color .25s ease',
            pointerEvents: 'none',
          },
        }}
      >
        <DeleteButton shell={shell} name={name} top={lid} right={8} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5, mb: 0.75, pr: 2.5 }}>
          <StorageRoundedIcon sx={{ fontSize: 18, color: accent, flexShrink: 0 }} />
          <Typography variant="subtitle2" noWrap sx={{ flex: 1, minWidth: 0 }}>
            {name}
          </Typography>
          <EntryBolt shell={shell} color={accent} />
          {wakeReaders && (
            <PodcastsRoundedIcon sx={{ fontSize: 16, opacity: 0.7, flexShrink: 0 }} titleAccess="bus: a write wakes every reader" />
          )}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          <Chip
            size="small"
            label={memoryMode}
            sx={{ height: 20, fontSize: 11, bgcolor: alpha(accent, mode === 'dark' ? 0.18 : 0.12), color: 'text.primary' }}
          />
          <Typography
            variant="caption"
            sx={{ opacity: shell.flashing ? 1 : 0.7, fontWeight: shell.flashing ? 600 : 400, transition: 'opacity .25s ease' }}
          >
            {count === 1 ? '1 entry' : `${count} entries`}
          </Typography>
        </Box>
        <Handles shell={shell} color={accent} />
      </Box>
    </Root>
  )
}

/** A saved graph used as one node: a stack of cards, with a way in. */
function BlockShape({ shell, name, blockId }: { shell: Shell; name: string; blockId: string }) {
  const { theme, mode, data } = shell
  const accent = theme.palette.primary.main
  const busy = data.status === 'thinking' || data.status === 'speaking'
  const paper = theme.palette.background.paper
  // The divider colour is too faint to draw the cards behind, which then vanish on the canvas.
  const edge = alpha(theme.palette.text.primary, mode === 'dark' ? 0.24 : 0.18)
  // Two cards behind this one, each a paper-coloured rectangle over a 1px ring. Box shadows rather
  // than extra elements, so the stack costs no layout and follows the border radius for free.
  const stack = `5px 5px 0 -1px ${paper}, 5px 5px 0 0 ${edge}, 10px 10px 0 -1px ${paper}, 10px 10px 0 0 ${edge}`
  const rest = busy ? `0 0 0 1px ${alpha(accent, 0.55)}, 0 10px 34px ${alpha(accent, 0.3)}, ${stack}` : stack
  const progress = data.blockProgress
  return (
    <Root shell={shell} label={`${KIND_LABEL.block}: ${name}`}>
      <Box
        sx={{
          position: 'relative',
          width: 232,
          px: 1.75,
          py: 1.5,
          mr: '10px',
          mb: '10px',
          borderRadius: '16px',
          ...frame(shell, { restShadow: rest }),
          transform: busy ? 'translateY(-2px)' : 'none',
        }}
      >
        <DeleteButton shell={shell} name={name} />
        <Tooltip title={`Open block ${name}`}>
          <IconButton
            size="small"
            aria-label={`Open block ${name}`}
            className="nodrag"
            onClick={(event) => {
              event.stopPropagation()
              useStore.getState().openBlock(blockId)
            }}
            sx={{ position: 'absolute', top: 4, right: data.ephemeral ? 4 : 26, width: 20, height: 20, opacity: 0.7, '&:hover': { opacity: 1 } }}
          >
            <OpenInNewRoundedIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.75, pr: data.ephemeral ? 2.5 : 5 }}>
          <LayersRoundedIcon sx={{ fontSize: 18, color: accent, flexShrink: 0 }} />
          <Typography variant="subtitle2" noWrap sx={{ flex: 1, minWidth: 0 }}>
            {name}
          </Typography>
          <EntryBolt shell={shell} color={accent} />
          <StatusBadge status={data.status} />
        </Box>
        {busy ? (
          <>
            <LinearProgress sx={{ height: 3, borderRadius: 3, mb: 0.75 }} aria-label={`${name} is running`} />
            <Typography variant="caption" sx={{ display: 'block', fontFamily: '"Roboto Mono", monospace', fontSize: 10.5, opacity: 0.8 }}>
              {progress ? `${progress.running} running · ${progress.done} done` : 'running'}
            </Typography>
          </>
        ) : (
          <Typography variant="caption" sx={{ display: 'block', fontFamily: '"Roboto Mono", monospace', fontSize: 10.5, opacity: 0.45 }}>
            {data.status ?? 'idle'}
          </Typography>
        )}
        <Handles shell={shell} color={accent} />
      </Box>
    </Root>
  )
}

function UnknownShape({ shell, name }: { shell: Shell; name: string }) {
  return (
    <Root shell={shell} label={`Node: ${name}`}>
      <Box sx={{ position: 'relative', width: 160, px: 1.75, py: 1.5, borderRadius: '16px', ...frame(shell) }}>
        <DeleteButton shell={shell} name={name} />
        <Typography variant="subtitle2" noWrap sx={{ pr: 2.5 }}>
          {name}
        </Typography>
        <Handles shell={shell} color={shell.theme.palette.text.secondary} />
      </Box>
    </Root>
  )
}
