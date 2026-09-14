import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  Chip,
  Divider,
  IconButton,
  LinearProgress,
  Paper,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Tooltip,
  Typography,
} from '@mui/material'
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded'
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import UnfoldMoreRoundedIcon from '@mui/icons-material/UnfoldMoreRounded'
import IosShareRoundedIcon from '@mui/icons-material/IosShareRounded'
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import { useStore } from '../store'
import { agentColor, agentGlow } from '../theme'
import { RichText } from './RichText'
import { Composer } from './Composer'
import { exportFilename, toJson, toMarkdown } from '../engine/transcriptExport'
import type { TranscriptEntry } from '../types'

/** Longer than this and a message is folded: the panel is for reading, not for scrolling past. */
const FOLD_CHARS = 700

/** Saves a string as a file, without a backend to go through. */
function download(text: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Right panel: what was actually said, in order, colour-matched to the graph. */
export function TranscriptPanel() {
  const transcript = useStore((s) => s.transcript)
  const spec = useStore((s) => s.spec)
  const agents = spec.agents
  const round = useStore((s) => s.round)
  const themeMode = useStore((s) => s.themeMode)
  const phase = useStore((s) => s.phase)
  const error = useStore((s) => s.error)
  const select = useStore((s) => s.select)
  const [rendering, setRendering] = useState<'rich' | 'raw'>('rich')
  const [agentFilter, setAgentFilter] = useState<string | null>(null)
  const [exportMenu, setExportMenu] = useState<HTMLElement | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  /** Only follow the stream while the reader is already at the bottom. */
  const stickToBottom = useRef(true)

  const visible = useMemo(
    () => (agentFilter ? transcript.filter((e) => e.agentId === agentFilter) : transcript),
    [transcript, agentFilter],
  )

  const lastText = transcript.at(-1)?.text.length ?? 0
  useEffect(() => {
    if (stickToBottom.current) bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [visible.length, lastText])

  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? id
  const hueOf = (id: string) => agents.find((a) => a.id === id)?.hue ?? 262
  const spoke = [...new Set(transcript.map((e) => e.agentId))]

  /** Built at click time, not on every render: the timestamp has to be the moment you exported. */
  const runMeta = () => ({ exportedAt: new Date().toISOString(), phase, rounds: round })
  const markdown = () => toMarkdown(spec, transcript, runMeta())
  const json = () => toJson(spec, transcript, runMeta())

  return (
    <Stack sx={{ height: '100%', overflow: 'hidden' }}>
      <Box sx={{ px: 2, pt: 2, pb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="subtitle2" sx={{ opacity: 0.7, flex: 1 }}>
          TRANSCRIPT · {transcript.length}
        </Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={rendering}
          onChange={(_, value) => value && setRendering(value)}
        >
          <ToggleButton value="rich" sx={{ px: 1, py: 0.25, fontSize: 11 }}>
            Formatted
          </ToggleButton>
          <ToggleButton value="raw" sx={{ px: 1, py: 0.25, fontSize: 11 }}>
            Raw
          </ToggleButton>
        </ToggleButtonGroup>

        <Tooltip title="Export this run">
          <span>
            <IconButton
              size="small"
              onClick={(e) => setExportMenu(e.currentTarget)}
              disabled={transcript.length === 0}
              aria-label="Export this run"
            >
              <IosShareRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Menu anchorEl={exportMenu} open={Boolean(exportMenu)} onClose={() => setExportMenu(null)}>
          {/* Markdown first, and it is the one to reach for: it carries the configuration and the
              prompts alongside the transcript, so it is as readable by a model as by a person. */}
          <MenuItem
            onClick={() => {
              void navigator.clipboard?.writeText(markdown())
              setExportMenu(null)
            }}
          >
            <ListItemIcon>
              <ContentCopyRoundedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary="Copy as Markdown" secondary="For a human, or to paste into a chat" />
          </MenuItem>
          <MenuItem
            onClick={() => {
              void navigator.clipboard?.writeText(json())
              setExportMenu(null)
            }}
          >
            <ListItemIcon>
              <ContentCopyRoundedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary="Copy as JSON" secondary="Same content, machine shape" />
          </MenuItem>
          <Divider />
          <MenuItem
            onClick={() => {
              download(markdown(), exportFilename(spec, 'md'), 'text/markdown')
              setExportMenu(null)
            }}
          >
            <ListItemIcon>
              <DownloadRoundedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={`Download ${exportFilename(spec, 'md')}`} />
          </MenuItem>
          <MenuItem
            onClick={() => {
              download(json(), exportFilename(spec, 'json'), 'application/json')
              setExportMenu(null)
            }}
          >
            <ListItemIcon>
              <DownloadRoundedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={`Download ${exportFilename(spec, 'json')}`} />
          </MenuItem>
        </Menu>
      </Box>

      {spoke.length > 1 && (
        <Box sx={{ px: 1.5, pb: 1, display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
          <Chip
            size="small"
            label="All"
            variant={agentFilter === null ? 'filled' : 'outlined'}
            onClick={() => setAgentFilter(null)}
            sx={{ height: 22, fontSize: 11 }}
          />
          {spoke.map((id) => (
            <Chip
              key={id}
              size="small"
              label={nameOf(id)}
              variant={agentFilter === id ? 'filled' : 'outlined'}
              onClick={() => setAgentFilter(agentFilter === id ? null : id)}
              sx={{
                height: 22,
                fontSize: 11,
                borderColor: agentColor(hueOf(id), themeMode),
                ...(agentFilter === id && { bgcolor: agentGlow(hueOf(id), 0.28) }),
              }}
            />
          ))}
        </Box>
      )}

      {phase === 'running' && <LinearProgress sx={{ height: 2 }} />}
      <Divider />

      <Box
        ref={scroller}
        onScroll={(event) => {
          const el = event.currentTarget
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
        sx={{ p: 1.5, overflowY: 'auto', flex: 1 }}
      >
        {visible.length === 0 && (
          <Typography variant="body2" sx={{ p: 1.5, opacity: 0.55 }}>
            Nothing said yet. Write a task at the bottom and press Run — the demo provider needs no
            API key.
          </Typography>
        )}

        <Stack spacing={1.25}>
          {visible.map((entry, index) => {
            const previous = visible[index - 1]
            const newRound = !previous || previous.round !== entry.round
            return (
              <Box key={entry.id}>
                {newRound && (
                  <Divider sx={{ mb: 1.25, '&::before, &::after': { borderColor: 'divider' } }}>
                    <Typography variant="caption" sx={{ opacity: 0.6, letterSpacing: 1 }}>
                      ROUND {entry.round}
                    </Typography>
                  </Divider>
                )}
                <Message
                  entry={entry}
                  name={nameOf(entry.agentId)}
                  // A canned demo answer must say so, or a first-time reader takes "the agents
                  // ignored my task" for the product being broken.
                  demo={agents.find((a) => a.id === entry.agentId)?.provider === 'mock'}
                  hue={hueOf(entry.agentId)}
                  to={entry.to.map(nameOf)}
                  mode={themeMode}
                  rendering={rendering}
                  onSelectAgent={() => select(entry.agentId)}
                />
              </Box>
            )
          })}
        </Stack>

        {error && (
          <Paper elevation={0} sx={{ mt: 1.5, p: 1.5, bgcolor: 'error.main', color: 'error.contrastText' }}>
            <Typography variant="body2">{error}</Typography>
          </Paper>
        )}
        <div ref={bottom} />
      </Box>

      <Composer />
    </Stack>
  )
}

function Message({
  entry,
  name,
  demo,
  hue,
  to,
  mode,
  rendering,
  onSelectAgent,
}: {
  entry: TranscriptEntry
  name: string
  demo: boolean
  hue: number
  to: string[]
  mode: 'light' | 'dark'
  rendering: 'rich' | 'raw'
  onSelectAgent: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const streaming = entry.status === 'streaming'
  const long = entry.text.length > FOLD_CHARS
  const folded = long && !expanded && !streaming
  // A stopped answer keeps its partial text, so it renders like a normal one, not like a failure.
  const stoppedEmpty = entry.status === 'stopped' && entry.text.trim() === ''
  const shown = folded ? entry.text.slice(0, FOLD_CHARS) : entry.text
  const seconds = entry.endedAt ? (entry.endedAt - entry.startedAt) / 1000 : undefined
  const color = agentColor(hue, mode)

  const copy = () => {
    void navigator.clipboard?.writeText(entry.text).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      },
      () => {},
    )
  }

  const human = entry.kind === 'human'

  return (
    <Paper
      elevation={0}
      sx={{
        p: 1.5,
        // A human message is visibly not an agent's: dashed border, no agent tint, so scanning the
        // transcript never confuses what you said with what the swarm produced.
        border: human ? '1px dashed' : undefined,
        borderColor: human ? 'text.disabled' : undefined,
        borderLeft: human ? undefined : '3px solid',
        borderLeftColor: human ? undefined : color,
        bgcolor: human ? 'transparent' : agentGlow(hue, mode === 'dark' ? 0.07 : 0.05),
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.75, flexWrap: 'wrap' }}>
        {human ? (
          <Typography variant="caption" sx={{ fontWeight: 700, opacity: 0.8 }}>
            You
          </Typography>
        ) : (
          <Typography
            variant="caption"
            onClick={onSelectAgent}
            sx={{ fontWeight: 700, color, cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }}
          >
            {name}
          </Typography>
        )}
        {to.length > 0 && (
          <>
            <ArrowForwardRoundedIcon sx={{ fontSize: 13, opacity: 0.5 }} />
            <Typography variant="caption" sx={{ opacity: 0.65, color: human ? color : undefined }}>
              {to.join(', ')}
            </Typography>
          </>
        )}
        {!human && to.length === 0 && entry.status === 'complete' && (
          <Chip size="small" label="swarm output" sx={{ height: 17, fontSize: 10 }} />
        )}
        {demo && !human && (
          <Tooltip title="Canned local text from the demo provider — not a model, and it does not read your task">
            <Chip size="small" label="demo" variant="outlined" sx={{ height: 17, fontSize: 10, opacity: 0.8 }} />
          </Tooltip>
        )}
        {entry.status === 'stopped' && (
          <Chip size="small" label="stopped" variant="outlined" sx={{ height: 17, fontSize: 10 }} />
        )}
        <Box sx={{ flex: 1 }} />
        {!human && (
          <Typography variant="caption" sx={{ opacity: 0.4, fontFamily: '"Roboto Mono", monospace', fontSize: 10.5 }}>
            {entry.tokensIn}↓ {entry.tokensOut}↑{seconds !== undefined ? ` · ${seconds.toFixed(1)}s` : ''}
          </Typography>
        )}
        <Tooltip title={copied ? 'Copied' : 'Copy this message'}>
          <IconButton size="small" onClick={copy} aria-label="Copy this message" sx={{ p: 0.25 }}>
            {copied ? (
              <CheckRoundedIcon sx={{ fontSize: 14, color: 'success.main' }} />
            ) : (
              <ContentCopyRoundedIcon sx={{ fontSize: 14, opacity: 0.5 }} />
            )}
          </IconButton>
        </Tooltip>
      </Box>

      {entry.status === 'error' ? (
        <Typography variant="body2" color="error" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
          {entry.text}
        </Typography>
      ) : stoppedEmpty ? (
        <Typography variant="body2" sx={{ opacity: 0.55, fontStyle: 'italic' }}>
          Stopped before this agent answered.
        </Typography>
      ) : rendering === 'raw' ? (
        <Typography
          variant="body2"
          sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, fontFamily: '"Roboto Mono", monospace', fontSize: 12 }}
        >
          {shown}
        </Typography>
      ) : (
        <RichText source={shown} />
      )}

      {folded && (
        <Box
          onClick={() => setExpanded(true)}
          sx={{
            mt: 0.5,
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            cursor: 'pointer',
            color,
            fontSize: 11.5,
            fontWeight: 500,
          }}
        >
          <UnfoldMoreRoundedIcon sx={{ fontSize: 14 }} />
          Show the remaining {entry.text.length - FOLD_CHARS} characters
        </Box>
      )}

      {streaming && (
        <Box
          component="span"
          sx={{
            display: 'inline-block',
            width: 7,
            height: 14,
            ml: 0.25,
            verticalAlign: -2,
            bgcolor: color,
            animation: 'swarm-caret 1s steps(2) infinite',
            '@keyframes swarm-caret': { '50%': { opacity: 0 } },
          }}
        />
      )}
    </Paper>
  )
}
