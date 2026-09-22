import { useState } from 'react'
import { Box, Button, Chip, IconButton, Popover, Stack, TextField, Tooltip, Typography } from '@mui/material'
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded'
import PauseRoundedIcon from '@mui/icons-material/PauseRounded'
import StopRoundedIcon from '@mui/icons-material/StopRounded'
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
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
      <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: '"Roboto Mono", monospace' }}>
        r{totals.rounds}/{spec.maxRounds} · {totals.messages} msg · {totals.tokensIn}↓ {totals.tokensOut}↑
      </Typography>
    </Box>
  )
}

/** The task field. Shared by the desktop popover and the phone sheet. */
function TaskField({ rows }: { rows: number }) {
  const task = useStore((s) => s.spec.task)
  const setSpec = useStore((s) => s.setSpec)
  return (
    <TextField
      label="Task given to the entry agents"
      value={task}
      onChange={(e) => setSpec({ task: e.target.value })}
      multiline
      minRows={rows}
      maxRows={rows + 3}
      fullWidth
    />
  )
}

/** Run, Stop, Pause, Resume, Clear — the buttons, in the shape each layout needs. */
function useRunButtons(fullWidth: boolean) {
  const phase = useStore((s) => s.phase)
  const start = useStore((s) => s.start)
  const stop = useStore((s) => s.stop)
  const pause = useStore((s) => s.pause)
  const resume = useStore((s) => s.resume)
  const reset = useStore((s) => s.reset)
  const running = phase === 'running'

  const main =
    phase === 'paused' ? (
      <Button variant="contained" startIcon={<PlayArrowRoundedIcon />} onClick={resume} fullWidth={fullWidth}>
        Resume
      </Button>
    ) : running ? (
      <Button variant="contained" color="error" startIcon={<StopRoundedIcon />} onClick={stop} fullWidth={fullWidth}>
        Stop
      </Button>
    ) : (
      <Button variant="contained" startIcon={<PlayArrowRoundedIcon />} onClick={start} fullWidth={fullWidth} sx={{ px: 2.5 }}>
        Run swarm
      </Button>
    )

  /** Pause parks the loop at the next round boundary; Stop ends it. Two different buttons. */
  const secondary = running ? (
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

  const clear = (
    <Tooltip title="Clear the run">
      <span>
        <IconButton onClick={reset} disabled={running} aria-label="Clear the run">
          <RestartAltRoundedIcon />
        </IconButton>
      </span>
    </Tooltip>
  )

  return { main, secondary, clear, running }
}

/**
 * Desktop: the run controls at the right of the command bar. The task, topology and budgets sit
 * behind ONE button that shows the task, so the bar stays a single quiet row.
 */
export function RunControls() {
  const task = useStore((s) => s.spec.task)
  const { main, secondary, clear } = useRunButtons(false)
  const [settings, setSettings] = useState<HTMLElement | null>(null)
  const summary = task.trim() === '' ? 'Task · none yet' : `Task · ${task.length > 30 ? `${task.slice(0, 29)}…` : task}`

  return (
    <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flexShrink: 0 }}>
      <Tooltip title="Task, topology and budgets for the run">
        <Button
          color="inherit"
          onClick={(e) => setSettings(e.currentTarget)}
          startIcon={<TuneRoundedIcon />}
          aria-label="Task and run settings"
          sx={{
            maxWidth: 260,
            color: 'text.secondary',
            fontWeight: 400,
            '& .MuiButton-startIcon': { mr: 0.75 },
          }}
        >
          <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {summary}
          </Box>
        </Button>
      </Tooltip>
      <Popover
        open={Boolean(settings)}
        anchorEl={settings}
        onClose={() => setSettings(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        slotProps={{ paper: { sx: { width: 400, maxWidth: 'calc(100vw - 32px)', p: 2.5, mt: -1.5 } } }}
      >
        <Stack spacing={2.5}>
          <Typography variant="subtitle2">Run settings</Typography>
          <TaskField rows={3} />
          <SwarmSettings direction="column" />
        </Stack>
      </Popover>
      {clear}
      {secondary}
      {main}
    </Stack>
  )
}

/** Phone: the Task sheet — the task, the topology settings, the run buttons, the counters. */
export function RunBar() {
  const { main, secondary, clear } = useRunButtons(true)
  return (
    <Stack spacing={2.5} sx={{ p: 2, pb: 3 }}>
      <TaskField rows={3} />
      <SwarmSettings direction="column" />
      <Stack direction="row" spacing={1}>
        {main}
        {secondary}
        {clear}
      </Stack>
      <RunStatus />
    </Stack>
  )
}
