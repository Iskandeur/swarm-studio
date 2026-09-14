import { useEffect, useRef } from 'react'
import { Box, Chip, Divider, LinearProgress, Paper, Stack, Typography } from '@mui/material'
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded'
import { useStore } from '../store'
import { agentColor, agentGlow } from '../theme'

/** Right panel: what was actually said, in order, colour-matched to the graph. */
export function TranscriptPanel() {
  const transcript = useStore((s) => s.transcript)
  const agents = useStore((s) => s.spec.agents)
  const themeMode = useStore((s) => s.themeMode)
  const phase = useStore((s) => s.phase)
  const error = useStore((s) => s.error)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [transcript.length])

  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? id
  const hueOf = (id: string) => agents.find((a) => a.id === id)?.hue ?? 262

  return (
    <Stack sx={{ height: '100%', overflow: 'hidden' }}>
      <Box sx={{ px: 2, pt: 2, pb: 1 }}>
        <Typography variant="subtitle2" sx={{ opacity: 0.7 }}>
          TRANSCRIPT · {transcript.length}
        </Typography>
      </Box>
      {phase === 'running' && <LinearProgress sx={{ height: 2 }} />}
      <Divider />

      <Stack spacing={1.25} sx={{ p: 1.5, overflowY: 'auto', flex: 1 }}>
        {transcript.length === 0 && (
          <Typography variant="body2" sx={{ p: 1.5, opacity: 0.55 }}>
            Nothing said yet. Write a task at the bottom and press Run — the demo provider needs no
            API key.
          </Typography>
        )}

        {transcript.map((entry) => {
          const hue = hueOf(entry.agentId)
          return (
            <Paper
              key={entry.id}
              elevation={0}
              sx={{
                p: 1.5,
                borderLeft: '3px solid',
                borderLeftColor: agentColor(hue, themeMode),
                bgcolor: agentGlow(hue, themeMode === 'dark' ? 0.07 : 0.05),
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.75, flexWrap: 'wrap' }}>
                <Typography variant="caption" sx={{ fontWeight: 600, color: agentColor(hue, themeMode) }}>
                  {nameOf(entry.agentId)}
                </Typography>
                <Chip size="small" label={`round ${entry.round}`} sx={{ height: 18, fontSize: 10 }} />
                {entry.to.length > 0 && (
                  <>
                    <ArrowForwardRoundedIcon sx={{ fontSize: 13, opacity: 0.5 }} />
                    <Typography variant="caption" sx={{ opacity: 0.65 }}>
                      {entry.to.map(nameOf).join(', ')}
                    </Typography>
                  </>
                )}
                <Box sx={{ flex: 1 }} />
                <Typography variant="caption" sx={{ opacity: 0.45, fontFamily: '"Roboto Mono", monospace' }}>
                  {entry.tokensIn}↓ {entry.tokensOut}↑
                </Typography>
              </Box>

              <Typography
                variant="body2"
                color={entry.status === 'error' ? 'error' : 'text.primary'}
                sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.55 }}
              >
                {entry.text}
                {entry.status === 'streaming' && (
                  <Box
                    component="span"
                    sx={{
                      display: 'inline-block',
                      width: 7,
                      height: 14,
                      ml: 0.25,
                      verticalAlign: -2,
                      bgcolor: agentColor(hue, themeMode),
                      animation: 'swarm-caret 1s steps(2) infinite',
                      '@keyframes swarm-caret': { '50%': { opacity: 0 } },
                    }}
                  />
                )}
              </Typography>
            </Paper>
          )
        })}

        {error && (
          <Paper elevation={0} sx={{ p: 1.5, bgcolor: 'error.main', color: 'error.contrastText' }}>
            <Typography variant="body2">{error}</Typography>
          </Paper>
        )}
        <div ref={bottom} />
      </Stack>
    </Stack>
  )
}
