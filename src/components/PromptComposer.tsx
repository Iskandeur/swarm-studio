/**
 * "Prompt the graph", as the front door of the app.
 *
 * Three faces of the same form, all reading `useComposer`:
 * - `PromptHero`: the card in the middle of the first screen. Describe → Generate, and the graph
 *   lands on the canvas behind it. Also reachable later, from the bar or Ctrl/⌘+K.
 * - `PromptDock`: the command bar under the canvas once a graph exists. Type a change, press Enter.
 * - `PromptStrip`: the one-line button above the phone's bottom navigation that opens the hero.
 */
import { useEffect, useMemo, useRef } from 'react'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  IconButton,
  LinearProgress,
  Link,
  MenuItem,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material'
import AutoFixHighRoundedIcon from '@mui/icons-material/AutoFixHighRounded'
import ArrowUpwardRoundedIcon from '@mui/icons-material/ArrowUpwardRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded'
import OpenInFullRoundedIcon from '@mui/icons-material/OpenInFullRounded'
import { useStore } from '../store'
import type { ProviderId } from '../types'
import { PROVIDERS, providerInfo } from '../engine/providers'
import { canGenerate, hasKeyFor, IDEAS, useComposer } from './useGraphComposer'

/** The keystroke that opens the hero from anywhere; also shown in the shortcuts list. */
export const PROMPT_SHORTCUT = 'Ctrl/⌘ + K'

/** The words on the card, so the tests and the README agree with the screen. */
export const HERO_TITLE = 'Describe the swarm you want'

function useGenerator() {
  const provider = useComposer((s) => s.provider)
  const model = useComposer((s) => s.model)
  const keys = useStore((s) => s.keys)
  const discovered = useStore((s) => s.discoveredModels)
  const info = providerInfo(provider)
  const suggestions = useMemo(
    () => [...new Set([...info.models, ...(discovered[provider] ?? [])])],
    [info, discovered, provider],
  )
  // `keys` is read so a key typed in Settings re-renders the "no key" hints without a reload.
  void keys
  return { provider, model, info, suggestions, demo: provider === 'mock', missingKey: !hasKeyFor(provider) }
}

/** Provider + model, the way the old dialog offered them. */
function GeneratorPicker({ dense = false }: { dense?: boolean }) {
  const { provider, model, suggestions, demo } = useGenerator()
  const setProvider = useComposer((s) => s.setProvider)
  const setModel = useComposer((s) => s.setModel)
  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ flex: 1, minWidth: 0 }}>
      <TextField
        select
        size="small"
        label="Generator"
        value={provider}
        onChange={(e) => setProvider(e.target.value as ProviderId)}
        sx={{ minWidth: dense ? 180 : 210 }}
      >
        {PROVIDERS.map((p) => (
          <MenuItem key={p.id} value={p.id}>
            {p.id === 'mock' ? 'Demo generator (no key)' : p.label}
            {p.id !== 'mock' && !hasKeyFor(p.id) ? ' — no key' : ''}
          </MenuItem>
        ))}
      </TextField>
      {!demo && (
        <Autocomplete
          freeSolo
          size="small"
          options={suggestions}
          value={model}
          onInputChange={(_, next) => setModel(next)}
          sx={{ flex: 1, minWidth: 160 }}
          renderInput={(params) => <TextField {...params} label="Model" error={model.trim() === ''} />}
        />
      )}
    </Stack>
  )
}

/** Progress, the error that explains itself, and the streamed answer. Same on every face. */
function Feedback({ preview = true }: { preview?: boolean }) {
  const busy = useComposer((s) => s.busy)
  const raw = useComposer((s) => s.raw)
  const problem = useComposer((s) => s.problem)
  const progress = useComposer((s) => s.progress)
  const running = useStore((s) => s.phase === 'running' || s.phase === 'paused')
  return (
    <>
      {running && !busy && !problem && (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          Loading a generated swarm stops the run in progress.
        </Typography>
      )}
      {progress && busy && <Alert severity="info">{progress}</Alert>}
      {problem && (
        <Alert
          severity="error"
          sx={{ '& .MuiAlert-message': { whiteSpace: 'pre-wrap', minWidth: 0 } }}
          action={
            raw ? (
              <Button
                color="inherit"
                size="small"
                startIcon={<ContentCopyRoundedIcon />}
                onClick={() => void navigator.clipboard?.writeText(raw).catch(() => {})}
              >
                Copy the answer
              </Button>
            ) : undefined
          }
        >
          <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
            Nothing was loaded.
          </Typography>
          {problem}
        </Alert>
      )}
      {preview && (busy || raw) && (
        <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, overflow: 'hidden' }}>
          {busy && <LinearProgress sx={{ height: 2 }} aria-label="Generating" />}
          <Box
            component="pre"
            aria-label="Generated JSON"
            sx={{
              m: 0,
              p: 1.25,
              maxHeight: 160,
              overflow: 'auto',
              bgcolor: 'action.hover',
              fontFamily: '"Roboto Mono", monospace',
              fontSize: 11.5,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {raw || 'Waiting for the first tokens…'}
          </Box>
        </Box>
      )}
    </>
  )
}

function ModeToggle({ size = 'small' }: { size?: 'small' | 'medium' }) {
  const mode = useComposer((s) => s.mode)
  const setMode = useComposer((s) => s.setMode)
  return (
    <ToggleButtonGroup
      exclusive
      size={size}
      value={mode}
      onChange={(_, next) => next && setMode(next)}
      aria-label="Generation mode"
      sx={{ flexShrink: 0, '& .MuiToggleButton-root': { px: 1.25, py: 0.4, fontSize: 12.5, lineHeight: 1.4 } }}
    >
      <ToggleButton value="replace">New swarm</ToggleButton>
      <ToggleButton value="edit">Edit current</ToggleButton>
    </ToggleButtonGroup>
  )
}

/**
 * The first screen. Sits over the canvas, not in a modal: the graph behind stays on the page (and
 * the demo swarm behind a blank prompt is the hint of what will appear).
 */
export function PromptHero({
  onClose,
  onOpenSettings,
  onBuildByHand,
  onOpenPresets,
}: {
  onClose: () => void
  onOpenSettings: () => void
  onBuildByHand: () => void
  onOpenPresets: (anchor: HTMLElement) => void
}) {
  const spec = useStore((s) => s.spec)
  const mode = useComposer((s) => s.mode)
  const instruction = useComposer((s) => s.instruction)
  const setInstruction = useComposer((s) => s.setInstruction)
  const busy = useComposer((s) => s.busy)
  const generate = useComposer((s) => s.generate)
  const cancel = useComposer((s) => s.cancel)
  const prepare = useComposer((s) => s.prepare)
  const ready = useComposer(canGenerate)
  const { info, demo, missingKey } = useGenerator()
  const field = useRef<HTMLTextAreaElement>(null)

  // Opening picks the generator, as the old dialog did on open; the fields are the user's after that.
  useEffect(() => {
    prepare()
    field.current?.focus()
  }, [prepare])

  const submit = () => {
    if (ready) void generate()
  }

  return (
    <Box
      data-hero
      role="region"
      aria-label="Prompt the graph"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) onClose()
      }}
      sx={{
        position: 'absolute',
        inset: 0,
        zIndex: 8,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: { xs: 'flex-end', md: 'center' },
        p: { xs: 1, md: 3 },
        overflowY: 'auto',
        bgcolor: (t) => (t.palette.mode === 'dark' ? 'rgba(19,18,24,0.72)' : 'rgba(251,248,253,0.72)'),
        backdropFilter: 'blur(6px)',
      }}
    >
      <Paper
        elevation={0}
        sx={{
          width: '100%',
          maxWidth: 720,
          p: { xs: 2, md: 3.5 },
          borderRadius: { xs: 4, md: 6 },
          border: '1px solid',
          borderColor: 'divider',
          boxShadow: (t) => (t.palette.mode === 'dark' ? '0 24px 64px rgba(0,0,0,.45)' : '0 24px 64px rgba(60,40,110,.14)'),
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, mb: 2 }}>
          <Box
            sx={{
              width: 40,
              height: 40,
              borderRadius: 3,
              display: 'grid',
              placeItems: 'center',
              bgcolor: 'primary.main',
              color: 'primary.contrastText',
              flexShrink: 0,
            }}
          >
            <AutoFixHighRoundedIcon fontSize="small" />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="h5" component="h1" sx={{ fontWeight: 600, letterSpacing: -0.2, lineHeight: 1.2 }}>
              {HERO_TITLE}
            </Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5 }}>
              A model writes the graph — agents, links, gates, memory — and it lands as one step you can undo. Then
              press Run and watch it talk.
            </Typography>
          </Box>
          <Tooltip title="Skip: use the canvas as it is (Esc)">
            <IconButton onClick={onClose} aria-label="Close the prompt" disabled={busy} size="small">
              <CloseRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>

        <Stack spacing={1.75}>
          <ModeToggle />

          <TextField
            inputRef={field}
            label={mode === 'edit' ? `What should change in "${spec.name}"?` : 'What swarm do you want?'}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit()
            }}
            multiline
            minRows={3}
            maxRows={8}
            fullWidth
            slotProps={{ htmlInput: { 'aria-label': 'Describe the graph' } }}
          />

          <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
            {IDEAS[mode].map((idea) => (
              <Chip
                key={idea}
                size="small"
                variant="outlined"
                label={idea.length > 64 ? `${idea.slice(0, 63)}…` : idea}
                title={idea}
                onClick={() => {
                  setInstruction(idea)
                  field.current?.focus()
                }}
              />
            ))}
          </Box>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
            <GeneratorPicker />
            {busy ? (
              <Button color="inherit" onClick={cancel} sx={{ flexShrink: 0 }}>
                Cancel
              </Button>
            ) : (
              <Button
                variant="contained"
                size="large"
                onClick={submit}
                disabled={!ready}
                startIcon={<AutoFixHighRoundedIcon />}
                sx={{ flexShrink: 0, px: 3 }}
              >
                {mode === 'edit' ? 'Apply change' : 'Generate'}
              </Button>
            )}
          </Stack>

          {demo && (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              The demo generator has no model behind it: it picks the preset that matches your words, or makes one
              fixed kind of edit.{' '}
              <Link component="button" type="button" onClick={onOpenSettings} sx={{ verticalAlign: 'baseline' }}>
                Add a key
              </Link>{' '}
              to generate for real.
            </Typography>
          )}
          {missingKey && (
            <Alert severity="warning" variant="outlined">
              No {info.label} key yet.{' '}
              <Link component="button" type="button" onClick={onOpenSettings} sx={{ verticalAlign: 'baseline' }}>
                Add one
              </Link>
              , or use the demo generator.
            </Alert>
          )}

          <Feedback />

          <Typography variant="caption" sx={{ color: 'text.secondary', pt: 0.5 }}>
            Prefer to start from something?{' '}
            <Link component="button" type="button" onClick={(e) => onOpenPresets(e.currentTarget)} sx={{ verticalAlign: 'baseline' }}>
              Open a starter swarm
            </Link>
            {' · '}
            <Link component="button" type="button" onClick={onBuildByHand} sx={{ verticalAlign: 'baseline' }}>
              Build by hand
            </Link>
          </Typography>
        </Stack>
      </Paper>
    </Box>
  )
}

/**
 * The command bar: the same ask, one line, always in reach once a graph exists. Enter generates,
 * Shift+Enter makes a line, the expand button brings the hero back with the full picker.
 */
export function PromptDock({ onExpand }: { onExpand: () => void }) {
  const mode = useComposer((s) => s.mode)
  const instruction = useComposer((s) => s.instruction)
  const setInstruction = useComposer((s) => s.setInstruction)
  const busy = useComposer((s) => s.busy)
  const problem = useComposer((s) => s.problem)
  const generate = useComposer((s) => s.generate)
  const cancel = useComposer((s) => s.cancel)
  const ready = useComposer(canGenerate)
  const { info, demo, model } = useGenerator()

  const submit = () => {
    if (ready) void generate()
  }

  return (
    <Box sx={{ flex: 1, minWidth: 0, maxWidth: 680 }}>
      <Collapse in={Boolean(problem)} unmountOnExit>
        <Box sx={{ mb: 1 }}>
          <Feedback preview={false} />
        </Box>
      </Collapse>
      <Paper
        elevation={0}
        data-dock
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          pl: 1.5,
          pr: 0.75,
          py: 0.5,
          borderRadius: 4,
          border: '1px solid',
          borderColor: 'divider',
          position: 'relative',
          overflow: 'hidden',
          boxShadow: (t) => (t.palette.mode === 'dark' ? '0 8px 28px rgba(0,0,0,.35)' : '0 8px 28px rgba(60,40,110,.10)'),
          '&:focus-within': { borderColor: 'primary.main' },
        }}
      >
        {busy && <LinearProgress sx={{ position: 'absolute', left: 0, right: 0, top: 0, height: 2 }} aria-label="Generating" />}
        <AutoFixHighRoundedIcon color="primary" sx={{ fontSize: 20, flexShrink: 0 }} />
        <TextField
          variant="standard"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={mode === 'edit' ? 'Describe a change to this swarm…' : 'Describe a new swarm…'}
          multiline
          maxRows={4}
          fullWidth
          slotProps={{
            input: { disableUnderline: true, sx: { fontSize: 14.5, py: 0.5 } },
            htmlInput: { 'aria-label': 'Describe the graph' },
          }}
        />
        <ModeToggle />
        <Tooltip title={demo ? 'Demo generator: picks a matching preset. Click to change.' : `${info.label} · ${model}. Click to change.`}>
          <Chip
            size="small"
            variant="outlined"
            label={demo ? 'Demo' : info.label}
            onClick={onExpand}
            sx={{ flexShrink: 0, maxWidth: 120 }}
          />
        </Tooltip>
        <Tooltip title={`Open the full prompt (${PROMPT_SHORTCUT})`}>
          <IconButton size="small" onClick={onExpand} aria-label="Open the full prompt">
            <OpenInFullRoundedIcon sx={{ fontSize: 17 }} />
          </IconButton>
        </Tooltip>
        {busy ? (
          <Tooltip title="Cancel">
            <IconButton size="small" onClick={cancel} aria-label="Cancel generation">
              <CircularProgress size={18} />
            </IconButton>
          </Tooltip>
        ) : (
          <Tooltip title={mode === 'edit' ? 'Apply change (Enter)' : 'Generate (Enter)'}>
            <span>
              <IconButton
                size="small"
                color="primary"
                onClick={submit}
                disabled={!ready}
                aria-label={mode === 'edit' ? 'Apply change' : 'Generate'}
                sx={{
                  bgcolor: ready ? 'primary.main' : 'action.disabledBackground',
                  color: ready ? 'primary.contrastText' : 'text.disabled',
                  '&:hover': { bgcolor: 'primary.dark' },
                  '&.Mui-disabled': { color: 'text.disabled' },
                }}
              >
                <ArrowUpwardRoundedIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </span>
          </Tooltip>
        )}
      </Paper>
    </Box>
  )
}

/** Phone: one tap above the bottom navigation opens the hero. */
export function PromptStrip({ onOpen }: { onOpen: () => void }) {
  const busy = useComposer((s) => s.busy)
  const instruction = useComposer((s) => s.instruction)
  return (
    <Box sx={{ px: 1.25, pt: 1, pb: 0.75, flexShrink: 0 }}>
      <Paper
        elevation={0}
        component="button"
        type="button"
        onClick={onOpen}
        aria-label="Prompt the graph"
        sx={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1.5,
          py: 1.1,
          borderRadius: 4,
          border: '1px solid',
          borderColor: 'divider',
          cursor: 'pointer',
          textAlign: 'left',
          font: 'inherit',
          color: 'text.primary',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {busy && <LinearProgress sx={{ position: 'absolute', left: 0, right: 0, top: 0, height: 2 }} />}
        <AutoFixHighRoundedIcon color="primary" sx={{ fontSize: 20 }} />
        <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0, color: instruction ? 'text.primary' : 'text.secondary' }}>
          {busy ? 'Generating…' : instruction || `${HERO_TITLE}…`}
        </Typography>
      </Paper>
    </Box>
  )
}
