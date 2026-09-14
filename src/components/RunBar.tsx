import { Box, Button, Chip, IconButton, Paper, Stack, TextField, Tooltip, Typography } from '@mui/material'
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded'
import PauseRoundedIcon from '@mui/icons-material/PauseRounded'
import StopRoundedIcon from '@mui/icons-material/StopRounded'
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded'
import { useStore, useTotals } from '../store'
import { SwarmSettings } from './SwarmSettings'

const PHASE_LABEL: Record<string, string> = {
  idle: 'ready',
  running: 'running',
  done: 'finished',
  error: 'failed',
  stopped: 'stopped',
  paused: 'paused',
}

export function RunStatus() {
  const spec = useStore((s) => s.spec)
  const phase = useStore((s) => s.phase)
  const totals = useTotals()
  return (
    <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'center', flexWrap: 'wrap' }}>
      <Chip
        size="small"
        label={PHASE_LABEL[phase] ?? phase}
        color={phase === 'error' ? 'error' : phase === 'running' ? 'primary' : 'default'}
        sx={{ height: 20, fontSize: 11 }}
      />
      <Typography variant="caption" sx={{ opacity: 0.65, fontFamily: '"Roboto Mono", monospace' }}>
        r{totals.rounds}/{spec.maxRounds} · {totals.messages} msg · {totals.tokensIn}↓ {totals.tokensOut}↑
      </Typography>
    </Box>
  )
}

/**
 * The task and the run controls. `bar` sits under the desktop canvas; `sheet` is the same thing
 * laid out for a phone bottom sheet, where the topology settings join it.
 */
export function RunBar({ layout = 'bar' }: { layout?: 'bar' | 'sheet' }) {
  const spec = useStore((s) => s.spec)
  const setSpec = useStore((s) => s.setSpec)
  const phase = useStore((s) => s.phase)
  const start = useStore((s) => s.start)
  const stop = useStore((s) => s.stop)
  const pause = useStore((s) => s.pause)
  const resume = useStore((s) => s.resume)
  const reset = useStore((s) => s.reset)
  const running = phase === 'running'
  const sheet = layout === 'sheet'

  const runButton =
    phase === 'paused' ? (
      <Button variant="contained" startIcon={<PlayArrowRoundedIcon />} onClick={resume} fullWidth>
        Resume
      </Button>
    ) : running ? (
      <Button variant="contained" color="error" startIcon={<StopRoundedIcon />} onClick={stop} fullWidth>
        Stop
      </Button>
    ) : (
      <Button variant="contained" startIcon={<PlayArrowRoundedIcon />} onClick={start} fullWidth>
        Run swarm
      </Button>
    )

  /** Pause parks the loop at the next round boundary; Stop ends it. Two different buttons. */
  const pauseButton = running ? (
    <Tooltip title="Pause after the current round">
      <IconButton onClick={pause} aria-label="Pause the run">
        <PauseRoundedIcon />
      </IconButton>
    </Tooltip>
  ) : phase === 'paused' ? (
    <Tooltip title="Stop the run">
      <IconButton onClick={stop} aria-label="Stop the run" color="error">
        <StopRoundedIcon />
      </IconButton>
    </Tooltip>
  ) : null

  const task = (
    <TextField
      label="Task given to the entry agents"
      value={spec.task}
      onChange={(e) => setSpec({ task: e.target.value })}
      multiline
      minRows={sheet ? 3 : 1}
      maxRows={sheet ? 6 : 3}
      fullWidth
    />
  )

  if (sheet) {
    return (
      <Stack spacing={2.5} sx={{ p: 2, pb: 3 }}>
        {task}
        <SwarmSettings direction="column" />
        <Stack direction="row" spacing={1}>
          {runButton}
          {pauseButton}
          <Tooltip title="Clear the run">
            <IconButton onClick={reset} disabled={running}>
              <RestartAltRoundedIcon />
            </IconButton>
          </Tooltip>
        </Stack>
        <RunStatus />
      </Stack>
    )
  }

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
      <Box sx={{ flex: 1 }}>{task}</Box>

      <Stack spacing={0.75} sx={{ minWidth: 190 }}>
        <Stack direction="row" spacing={0.75}>
          {runButton}
          {pauseButton}
          <Tooltip title="Clear the run">
            <IconButton onClick={reset} disabled={running}>
              <RestartAltRoundedIcon />
            </IconButton>
          </Tooltip>
        </Stack>
        <RunStatus />
      </Stack>
    </Paper>
  )
}
