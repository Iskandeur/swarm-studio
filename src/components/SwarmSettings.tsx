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
import { useStore } from '../store'
import type { Topology } from '../types'

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
        onChange={(e) => setSpec({ maxRounds: Math.max(1, Math.min(24, Number(e.target.value) || 1)) })}
        sx={{ width: column ? '100%' : 100 }}
        inputProps={{ min: 1, max: 24, inputMode: 'numeric' }}
        helperText={column ? 'Hard stop on the number of turns.' : undefined}
      />
    </Stack>
  )
}
