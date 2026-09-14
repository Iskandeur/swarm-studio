import { useMemo, useState } from 'react'
import { Box, Button, IconButton, MenuItem, Paper, TextField, Tooltip, Typography, useMediaQuery } from '@mui/material'
import SendRoundedIcon from '@mui/icons-material/SendRounded'
import PauseRoundedIcon from '@mui/icons-material/PauseRounded'
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded'
import StopRoundedIcon from '@mui/icons-material/StopRounded'
import { useStore } from '../store'
import { resolveEntryIds } from '../engine/runner'

/**
 * Your own way into the swarm.
 *
 * The links say which agent may speak to which. A human is outside that graph, so this hands a
 * message to ANY agent you pick — mid-run, or while paused, or after the run has stopped. A message
 * also wakes an agent the swarm had already moved past, which is what makes it a way in rather than
 * a comment box.
 */
export function Composer() {
  const spec = useStore((s) => s.spec)
  const phase = useStore((s) => s.phase)
  const transcript = useStore((s) => s.transcript)
  const inject = useStore((s) => s.inject)
  const continueFrom = useStore((s) => s.continueFrom)
  const pause = useStore((s) => s.pause)
  const resume = useStore((s) => s.resume)
  const stop = useStore((s) => s.stop)
  // The run controls below are for PHONES only: there the sheets are modal, so the bottom bar's
  // Pause and Stop are unreachable while you read the transcript. On a desktop the run bar already
  // has them, and two pause buttons on one screen is clutter, not redundancy.
  const compact = useMediaQuery('(max-width:899.95px)')
  const [text, setText] = useState('')
  const [target, setTarget] = useState<string>('')

  const entryIds = useMemo(() => resolveEntryIds(spec), [spec])
  /** Default to whoever spoke last: mid-run, that is almost always who you want to answer. */
  const lastSpeaker = [...transcript].reverse().find((e) => e.kind !== 'human')?.agentId
  const chosen =
    spec.agents.find((a) => a.id === target)?.id ??
    spec.agents.find((a) => a.id === lastSpeaker)?.id ??
    entryIds[0] ??
    spec.agents[0]?.id ??
    ''

  const live = phase === 'running' || phase === 'paused'
  const canContinue = phase === 'done' || phase === 'stopped' || phase === 'error'
  const send = () => {
    if (text.trim() === '' || !chosen) return
    if (live) inject(chosen, text)
    else continueFrom(chosen, text)
    setText('')
  }

  if (spec.agents.length === 0) return null

  return (
    <Paper
      elevation={0}
      square
      sx={{ p: 1.25, borderTop: '1px solid', borderColor: 'divider', flexShrink: 0 }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.75 }}>
        <Typography variant="caption" sx={{ opacity: 0.6 }}>
          You →
        </Typography>
        <TextField
          select
          size="small"
          value={chosen}
          onChange={(e) => setTarget(e.target.value)}
          variant="standard"
          sx={{ minWidth: 110 }}
          inputProps={{ 'aria-label': 'Which agent receives your message' }}
        >
          {spec.agents.map((agent) => (
            <MenuItem key={agent.id} value={agent.id}>
              {agent.name}
            </MenuItem>
          ))}
        </TextField>
        <Box sx={{ flex: 1 }} />
        {compact && phase === 'running' && (
          <Tooltip title="Pause after the current round">
            <IconButton size="small" onClick={pause} aria-label="Pause the run">
              <PauseRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        {compact && phase === 'paused' && (
          <Tooltip title="Resume, delivering anything you queued">
            <IconButton size="small" color="primary" onClick={resume} aria-label="Resume the run">
              <PlayArrowRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        {/* Stop lives here too: on a phone the sheets are modal, so the bottom bar's Stop is behind
            them and a run could not be stopped from the panel you were reading. */}
        {compact && live && (
          <Tooltip title="Stop the run">
            <IconButton size="small" color="error" onClick={stop} aria-label="Stop the run">
              <StopRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 1 }}>
        <TextField
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter makes a line: the convention every chat box uses.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              send()
            }
          }}
          placeholder={live ? 'Say something to this agent…' : 'Say something, and the swarm picks up from there…'}
          multiline
          maxRows={4}
          fullWidth
          size="small"
        />
        <Button
          variant="contained"
          onClick={send}
          disabled={text.trim() === ''}
          startIcon={<SendRoundedIcon />}
          sx={{ whiteSpace: 'nowrap' }}
        >
          {live ? 'Send' : 'Continue'}
        </Button>
      </Box>

      <Typography variant="caption" sx={{ display: 'block', mt: 0.5, opacity: 0.55 }}>
        {phase === 'paused'
          ? 'Paused. Anything you send is delivered when you resume.'
          : live
            ? 'Delivered at the start of the next round, and it wakes that agent even if the swarm had moved on.'
            : canContinue
              ? 'Starts a new round from this agent, keeping what every agent already remembers.'
              : 'Run the swarm first, or send this to start it from this agent.'}
      </Typography>
    </Paper>
  )
}
