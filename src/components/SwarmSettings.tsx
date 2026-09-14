import { MenuItem, Stack, TextField, Tooltip } from '@mui/material'
import { useStore } from '../store'
import type { Topology } from '../types'

export const TOPOLOGIES: Array<{ id: Topology; label: string; hint: string }> = [
  { id: 'broadcast', label: 'Broadcast', hint: 'Every outgoing link carries the message.' },
  { id: 'round-robin', label: 'Round-robin', hint: 'One outgoing link per turn, rotating.' },
  { id: 'manager', label: 'Manager', hint: 'Workers answer, then the entry agent speaks again.' },
]

/** Topology and round budget. A row in the desktop app bar, a column in the mobile sheet. */
export function SwarmSettings({ direction = 'row' }: { direction?: 'row' | 'column' }) {
  const spec = useStore((s) => s.spec)
  const setSpec = useStore((s) => s.setSpec)
  const setTopology = useStore((s) => s.setTopology)
  const column = direction === 'column'

  return (
    <Stack direction={direction} spacing={column ? 2 : 1.5} sx={{ width: column ? '100%' : 'auto' }}>
      <Tooltip title={TOPOLOGIES.find((t) => t.id === spec.topology)?.hint ?? ''}>
        <TextField
          select
          label="Topology"
          value={spec.topology}
          onChange={(e) => setTopology(e.target.value as Topology)}
          sx={{ width: column ? '100%' : 150 }}
          helperText={column ? TOPOLOGIES.find((t) => t.id === spec.topology)?.hint : undefined}
        >
          {TOPOLOGIES.map((t) => (
            <MenuItem key={t.id} value={t.id}>
              {t.label}
            </MenuItem>
          ))}
        </TextField>
      </Tooltip>

      <TextField
        label="Max rounds"
        type="number"
        value={spec.maxRounds}
        onChange={(e) => setSpec({ maxRounds: Math.max(1, Math.min(24, Number(e.target.value) || 1)) })}
        sx={{ width: column ? '100%' : 100 }}
        inputProps={{ min: 1, max: 24, inputMode: 'numeric' }}
      />
    </Stack>
  )
}
