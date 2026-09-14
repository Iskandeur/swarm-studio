import { Box, Button, Chip, IconButton, Paper, Stack, TextField, Tooltip, Typography } from '@mui/material'
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded'
import StopRoundedIcon from '@mui/icons-material/StopRounded'
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded'
import { useStore, useTotals } from '../store'

const PHASE_LABEL: Record<string, string> = {
  idle: 'ready',
  running: 'running',
  done: 'finished',
  error: 'failed',
  stopped: 'stopped',
  paused: 'paused',
}

/** Bottom bar: the task, the run controls, and the live counters. */
export function RunBar() {
  const spec = useStore((s) => s.spec)
  const setSpec = useStore((s) => s.setSpec)
  const phase = useStore((s) => s.phase)
  const start = useStore((s) => s.start)
  const stop = useStore((s) => s.stop)
  const reset = useStore((s) => s.reset)
  const totals = useTotals()
  const running = phase === 'running'

  return (
    <Paper
      elevation={0}
      sx={{
        p: 1.5,
        borderTop: '1px solid',
        borderColor: 'divider',
        borderRadius: 0,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1.5,
      }}
    >
      <TextField
        label="Task given to the entry agents"
        value={spec.task}
        onChange={(e) => setSpec({ task: e.target.value })}
        multiline
        maxRows={3}
        fullWidth
        sx={{ flex: 1 }}
      />

      <Stack spacing={0.75} sx={{ minWidth: 190 }}>
        <Stack direction="row" spacing={0.75}>
          {running ? (
            <Button variant="contained" color="error" startIcon={<StopRoundedIcon />} onClick={stop} fullWidth>
              Stop
            </Button>
          ) : (
            <Button variant="contained" startIcon={<PlayArrowRoundedIcon />} onClick={start} fullWidth>
              Run swarm
            </Button>
          )}
          <Tooltip title="Clear the run">
            <IconButton onClick={reset} disabled={running}>
              <RestartAltRoundedIcon />
            </IconButton>
          </Tooltip>
        </Stack>

        <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
          <Chip
            size="small"
            label={PHASE_LABEL[phase] ?? phase}
            color={phase === 'error' ? 'error' : running ? 'primary' : 'default'}
            sx={{ height: 20, fontSize: 11 }}
          />
          <Typography variant="caption" sx={{ opacity: 0.65, fontFamily: '"Roboto Mono", monospace' }}>
            r{totals.rounds}/{spec.maxRounds} · {totals.messages} msg · {totals.tokensIn}↓ {totals.tokensOut}↑
          </Typography>
        </Box>
      </Stack>
    </Paper>
  )
}
