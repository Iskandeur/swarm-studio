import { useState } from 'react'
import {
  Box,
  Divider,
  IconButton,
  ListItemText,
  MenuItem,
  Popover,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import HelpOutlineRoundedIcon from '@mui/icons-material/HelpOutlineRounded'
import AccountTreeRoundedIcon from '@mui/icons-material/AccountTreeRounded'
import { useStore } from '../store'
import type { Topology } from '../types'
import { DEFAULT_MAX_DEPTH, DEFAULT_MAX_SPAWNS } from '../types'

export interface TopologyInfo {
  id: Topology
  label: string
  /** One line, in the dropdown and in the tooltip. */
  hint: string
  /** What it does turn by turn, for the help popover. */
  detail: string
  /** A shape you can read at a glance. */
  sketch: string
}

export const TOPOLOGIES: TopologyInfo[] = [
  {
    id: 'broadcast',
    label: 'Broadcast',
    hint: 'Every outgoing link carries the message.',
    detail:
      'Each agent that speaks hands its message to all the agents it points at, and they all speak in the next round. The active set widens, so a mesh becomes a debate where everybody hears everybody.',
    sketch: 'A ──▶ B\n │\n └───▶ C',
  },
  {
    id: 'round-robin',
    label: 'Round-robin',
    hint: 'One outgoing link per turn, rotating.',
    detail:
      'An agent with several outgoing links uses one per turn, in rotation. Exactly one agent speaks at a time, so the swarm stays narrow and walks the graph instead of flooding it. Useful on a ring.',
    sketch: 'turn 1: A ──▶ B\nturn 2: B ──▶ A\nturn 3: A ──▶ C',
  },
  {
    id: 'manager',
    label: 'Manager',
    hint: 'Workers answer, then the entry agent speaks again.',
    detail:
      'The entry agent delegates to everyone it points at; each worker replies upward instead of onwards; then the manager speaks again with every reply in hand. A hierarchy, not a conversation.',
    sketch: 'A ──▶ B ─┐\n │       │\n └──▶ C ─┴─▶ A',
  },
]

/** Topology and round budget. A row in the desktop app bar, a column in the mobile sheet. */
export function SwarmSettings({ direction = 'row' }: { direction?: 'row' | 'column' }) {
  const spec = useStore((s) => s.spec)
  const setSpec = useStore((s) => s.setSpec)
  const setTopology = useStore((s) => s.setTopology)
  const [help, setHelp] = useState<HTMLElement | null>(null)
  const [limits, setLimits] = useState<HTMLElement | null>(null)
  const column = direction === 'column'
  const current = TOPOLOGIES.find((t) => t.id === spec.topology)

  return (
    <Stack direction={direction} spacing={column ? 2 : 1.5} sx={{ width: column ? '100%' : 'auto' }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5, width: column ? '100%' : 'auto' }}>
        <Tooltip title={current ? `${current.label}: ${current.hint}` : ''} placement="bottom">
          <TextField
            select
            label="Topology"
            value={spec.topology}
            onChange={(e) => setTopology(e.target.value as Topology)}
            sx={{ width: column ? '100%' : 160 }}
            helperText={column ? current?.hint : undefined}
            SelectProps={{ renderValue: (value) => TOPOLOGIES.find((t) => t.id === value)?.label ?? String(value) }}
          >
            {TOPOLOGIES.map((t) => (
              // The dropdown explains itself: the three hints are visible side by side at the moment
              // you are actually choosing, which a hover tooltip can never do.
              <MenuItem key={t.id} value={t.id} sx={{ alignItems: 'flex-start', maxWidth: 340 }}>
                <ListItemText
                  primary={t.label}
                  secondary={t.hint}
                  secondaryTypographyProps={{ sx: { whiteSpace: 'normal', fontSize: 11.5, lineHeight: 1.35 } }}
                />
              </MenuItem>
            ))}
          </TextField>
        </Tooltip>

        <Tooltip title="What do the topologies do?">
          <IconButton size="small" onClick={(e) => setHelp(e.currentTarget)} aria-label="Explain the topologies">
            <HelpOutlineRoundedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      <Popover
        open={Boolean(help)}
        anchorEl={help}
        onClose={() => setHelp(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { maxWidth: 420, p: 2 } } }}
      >
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          How a turn is handed on
        </Typography>
        <Typography variant="caption" sx={{ opacity: 0.7, display: 'block', mb: 1.5 }}>
          The links say who <i>may</i> speak to whom. The topology says which of those links are used,
          and when.
        </Typography>
        <Stack spacing={1.5} divider={<Divider flexItem />}>
          {TOPOLOGIES.map((t) => (
            <Box key={t.id}>
              <Typography variant="subtitle2" color={t.id === spec.topology ? 'primary' : 'text.primary'}>
                {t.label}
                {t.id === spec.topology && ' · current'}
              </Typography>
              <Typography variant="body2" sx={{ mt: 0.25, lineHeight: 1.5 }}>
                {t.detail}
              </Typography>
              <Box
                component="pre"
                sx={{
                  mt: 0.75,
                  mb: 0,
                  p: 1,
                  borderRadius: 1.5,
                  bgcolor: 'action.hover',
                  fontFamily: '"Roboto Mono", monospace',
                  fontSize: 11,
                  lineHeight: 1.5,
                  overflowX: 'auto',
                }}
              >
                {t.sketch}
              </Box>
            </Box>
          ))}
        </Stack>
        <Typography variant="caption" sx={{ opacity: 0.7, display: 'block', mt: 1.5 }}>
          In every topology, a run stops when nobody is left to speak or Max rounds is reached.
        </Typography>
      </Popover>

      <TextField
        label="Max rounds"
        type="number"
        value={spec.maxRounds}
        // No upper bound: it is a budget, not a safety rail, and capping it at 24 silently
        // rewrote what the user typed. Above ~40 rounds the warning is the honest guard.
        onChange={(e) => setSpec({ maxRounds: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
        sx={{ width: column ? '100%' : 110 }}
        inputProps={{ min: 1, step: 1, inputMode: 'numeric' }}
        error={spec.maxRounds > 40}
        helperText={
          spec.maxRounds > 40
            ? `${spec.maxRounds} rounds will cost real money on a paid provider`
            : column
              ? 'Hard stop on the number of turns, rounds inside blocks included.'
              : undefined
        }
      />

      {/* Only the two limits that make recursion safe. They cost nothing until a block contains
          itself or an agent may spawn, and then they are what stops the run from growing for ever.
          In the app bar they sit behind one button: two more fields there pushed the bar past the
          width of a laptop screen. */}
      {column ? (
        <Limits column />
      ) : (
        <>
          <Tooltip title="Recursion limits: depth and spawns">
            <IconButton size="small" onClick={(e) => setLimits(e.currentTarget)} aria-label="Recursion limits">
              <AccountTreeRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Popover
            open={Boolean(limits)}
            anchorEl={limits}
            onClose={() => setLimits(null)}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            transformOrigin={{ vertical: 'top', horizontal: 'right' }}
            slotProps={{ paper: { sx: { width: 300, p: 2 } } }}
          >
            <Limits column />
          </Popover>
        </>
      )}
    </Stack>
  )
}

/** Max depth and max spawns, with what they bound. */
function Limits({ column }: { column: boolean }) {
  const spec = useStore((s) => s.spec)
  const setSpec = useStore((s) => s.setSpec)
  return (
    <Stack spacing={2} sx={{ width: '100%' }}>
      <TextField
        label="Max depth"
        type="number"
        value={spec.maxDepth ?? DEFAULT_MAX_DEPTH}
        onChange={(e) => setSpec({ maxDepth: Math.min(8, Math.max(0, Math.floor(Number(e.target.value) || 0))) })}
        fullWidth={column}
        inputProps={{ min: 0, max: 8, step: 1, inputMode: 'numeric' }}
        helperText="How deep blocks may nest, and helpers may spawn helpers."
      />
      <TextField
        label="Max spawns"
        type="number"
        value={spec.maxSpawns ?? DEFAULT_MAX_SPAWNS}
        onChange={(e) => setSpec({ maxSpawns: Math.min(100, Math.max(0, Math.floor(Number(e.target.value) || 0))) })}
        fullWidth={column}
        inputProps={{ min: 0, max: 100, step: 1, inputMode: 'numeric' }}
        helperText="Helpers agents may create in one run, all depths together."
      />
    </Stack>
  )
}
