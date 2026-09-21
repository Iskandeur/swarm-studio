/**
 * "Prompt the graph": describe the swarm you want, a model writes it in the portable format, the
 * reader validates it, and it lands on the canvas as ONE undo step. Or, in Edit mode, the current
 * swarm goes to the model with the change to make, and comes back with its ids intact.
 *
 * Everything that decides what is loaded lives in `engine/graphPrompt.ts`; this is the form around it.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  MenuItem,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material'
import AutoFixHighRoundedIcon from '@mui/icons-material/AutoFixHighRounded'
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded'
import { useStore } from '../store'
import type { KeyId, ProviderId } from '../types'
import { PROVIDERS, providerInfo } from '../engine/providers'
import { decisionProviderInfo } from '../engine/decisions'
import { promptGraph, type GraphPromptMode } from '../engine/graphPrompt'

const GENERATOR_KEY = 'swarm-studio.generator.v1'

const IDEAS: Record<GraphPromptMode, string[]> = {
  replace: [
    'A support triage: a decision model routes each message to billing, tech or account, and anything it is unsure about escalates to a senior LLM agent.',
    'A writer and a critic that loop until the critic scores the draft 8 or more, then an editor trims it.',
    'A research team sharing a blackboard, with a human gate before anything is published.',
  ],
  edit: [
    'Add a human gate before the output.',
    'Add a shared memory every agent can read and write.',
    'Put a decision model in front that drops messages that are off topic.',
  ],
}

/** The chat providers a generator can use first: whichever already has a key, in this order. */
const PREFERRED: ProviderId[] = ['anthropic', 'openai', 'openrouter', 'custom']

function remembered(): { provider: ProviderId; model: string } | undefined {
  try {
    const raw = localStorage.getItem(GENERATOR_KEY)
    const value = raw ? (JSON.parse(raw) as { provider?: unknown; model?: unknown }) : undefined
    if (value && PROVIDERS.some((p) => p.id === value.provider) && typeof value.model === 'string') {
      return { provider: value.provider as ProviderId, model: value.model }
    }
  } catch {
    /* nothing remembered */
  }
  return undefined
}

export function GraphPromptDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const theme = useTheme()
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'))
  const spec = useStore((s) => s.spec)
  const keys = useStore((s) => s.keys)
  const endpoints = useStore((s) => s.endpoints)
  const decisionEndpoints = useStore((s) => s.decisionEndpoints)
  const discovered = useStore((s) => s.discoveredModels)
  const replaceSwarm = useStore((s) => s.replaceSwarm)
  const running = useStore((s) => s.phase === 'running' || s.phase === 'paused')

  const [mode, setMode] = useState<GraphPromptMode>('replace')
  const [provider, setProvider] = useState<ProviderId>('mock')
  const [model, setModel] = useState('')
  const [instruction, setInstruction] = useState('')
  const [raw, setRaw] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const abort = useRef<AbortController | null>(null)

  const hasKey = (id: ProviderId) => id === 'mock' || Boolean(keys[id]?.trim())

  // On open: what was used last time if it still has a key, else the first provider that has one
  // (with the model the swarm's agents already use on it), else the demo generator.
  useEffect(() => {
    if (!open) return
    setProblem(null)
    setProgress(null)
    setRaw('')
    const last = remembered()
    if (last && hasKey(last.provider)) {
      setProvider(last.provider)
      setModel(last.model)
      return
    }
    const configured = PREFERRED.find((id) => hasKey(id) && (id !== 'custom' || Boolean(endpoints.custom?.trim())))
    if (!configured) {
      setProvider('mock')
      setModel('demo-fast')
      return
    }
    setProvider(configured)
    setModel(
      spec.agents.find((a) => a.provider === configured && a.model.trim())?.model ??
        providerInfo(configured).models[0] ??
        discovered[configured]?.[0] ??
        '',
    )
    // Only on opening: the fields are the user's once the dialog is up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => () => abort.current?.abort(), [])

  const info = providerInfo(provider)
  const suggestions = useMemo(
    () => [...new Set([...info.models, ...(discovered[provider] ?? [])])],
    [info, discovered, provider],
  )
  const demo = provider === 'mock'
  const missingKey = !hasKey(provider)
  const canGenerate = instruction.trim() !== '' && !busy && !missingKey && (demo || model.trim() !== '')

  const close = () => {
    abort.current?.abort()
    onClose()
  }

  const generate = async () => {
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setBusy(true)
    setProblem(null)
    setProgress(null)
    setRaw('')
    if (!demo) localStorage.setItem(GENERATOR_KEY, JSON.stringify({ provider, model }))
    const decisionProvider = keys.openrouter?.trim() ? 'openrouter' : 'mock'
    try {
      const result = await promptGraph({
        instruction,
        mode,
        provider,
        model,
        apiKey: keys[provider] ?? '',
        endpoints,
        current: spec,
        defaults: {
          decisionProvider,
          decisionModel: decisionProviderInfo(decisionProvider).models[0],
        },
        // Whatever this browser holds as a secret must not come back inside a graph.
        secrets: [
          ...Object.values(keys as Record<KeyId, string | undefined>),
          ...Object.values(endpoints),
          ...Object.values(decisionEndpoints),
        ].filter((v): v is string => typeof v === 'string' && v.trim() !== ''),
        signal: controller.signal,
        onDelta: (delta) => setRaw((r) => r + delta),
        onDiscard: () => setRaw(''),
        onNotice: (message) => setProgress(message),
      })
      if (controller.signal.aborted) return
      if (!result.ok) {
        setProblem(result.error)
        return
      }
      replaceSwarm(result.spec)
      useStore.setState({
        notice: `${result.note ?? `Loaded "${result.spec.name}"${result.repaired ? ' (after one automatic repair)' : ''}.`} Undo brings the previous swarm back.`,
      })
      onClose()
    } finally {
      if (abort.current === controller) abort.current = null
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onClose={busy ? undefined : close} fullWidth maxWidth="md" fullScreen={fullScreen}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <AutoFixHighRoundedIcon color="primary" />
        Prompt the graph
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <Typography variant="body2" sx={{ opacity: 0.75 }}>
            Describe the swarm you want. A model writes it in the same JSON format as Share, the same reader checks it,
            and it replaces the canvas as one step you can undo. Nothing is loaded unless all of it is valid.
          </Typography>

          <ToggleButtonGroup
            exclusive
            size="small"
            value={mode}
            onChange={(_, next: GraphPromptMode | null) => next && setMode(next)}
            aria-label="Generation mode"
          >
            <ToggleButton value="replace">New swarm</ToggleButton>
            <ToggleButton value="edit">Edit current</ToggleButton>
          </ToggleButtonGroup>

          <TextField
            label={mode === 'edit' ? `What should change in "${spec.name}"?` : 'What swarm do you want?'}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canGenerate) void generate()
            }}
            multiline
            minRows={3}
            maxRows={10}
            fullWidth
            autoFocus
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
                onClick={() => setInstruction(idea)}
              />
            ))}
          </Box>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField
              select
              size="small"
              label="Generator"
              value={provider}
              onChange={(e) => {
                const next = e.target.value as ProviderId
                setProvider(next)
                setModel(next === 'mock' ? 'demo-fast' : providerInfo(next).models[0] ?? discovered[next]?.[0] ?? '')
              }}
              sx={{ minWidth: 220 }}
            >
              {PROVIDERS.map((p) => (
                <MenuItem key={p.id} value={p.id}>
                  {p.id === 'mock' ? 'Demo generator (no key)' : p.label}
                  {p.id !== 'mock' && !hasKey(p.id) ? ' — no key' : ''}
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
                sx={{ flex: 1 }}
                renderInput={(params) => <TextField {...params} label="Model" error={model.trim() === ''} />}
              />
            )}
          </Stack>

          {demo && (
            <Alert severity="info" variant="outlined">
              The demo generator has no model behind it: it picks the preset that matches your words, or makes one fixed
              kind of edit. Add a key in Settings to generate for real.
            </Alert>
          )}
          {missingKey && (
            <Alert severity="warning" variant="outlined">
              No {info.label} key yet. Add one in Settings, or use the demo generator.
            </Alert>
          )}
          {running && (
            <Typography variant="caption" sx={{ opacity: 0.7 }}>
              Loading a generated swarm stops the run in progress.
            </Typography>
          )}

          {progress && busy && <Alert severity="info">{progress}</Alert>}
          {problem && (
            <Alert severity="error" sx={{ '& .MuiAlert-message': { whiteSpace: 'pre-wrap' } }}>
              <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
                Nothing was loaded.
              </Typography>
              {problem}
            </Alert>
          )}

          {(busy || raw) && (
            <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, overflow: 'hidden' }}>
              {busy && <LinearProgress sx={{ height: 2 }} aria-label="Generating" />}
              <Box
                component="pre"
                aria-label="Generated JSON"
                sx={{
                  m: 0,
                  p: 1.25,
                  maxHeight: 240,
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
        </Stack>
      </DialogContent>
      <DialogActions>
        {problem && raw && (
          <Button
            color="inherit"
            startIcon={<ContentCopyRoundedIcon />}
            onClick={() => void navigator.clipboard?.writeText(raw).catch(() => {})}
            sx={{ mr: 'auto' }}
          >
            Copy the answer
          </Button>
        )}
        <Button color="inherit" onClick={close}>
          {busy ? 'Cancel' : 'Close'}
        </Button>
        <Button variant="contained" onClick={() => void generate()} disabled={!canGenerate} startIcon={<AutoFixHighRoundedIcon />}>
          {mode === 'edit' ? 'Apply change' : 'Generate'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
