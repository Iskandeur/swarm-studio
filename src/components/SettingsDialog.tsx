import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Link,
  Stack,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material'
import ScienceRoundedIcon from '@mui/icons-material/ScienceRounded'
import { useStore } from '../store'
import { DEFAULT_ENDPOINTS, PROVIDERS, listModels, resolveEndpoint } from '../engine/providers'
import { DECISION_PROVIDERS, DEFAULT_DECISION_ENDPOINTS } from '../engine/decisions'
import type { ProviderId } from '../types'

type Probe = { state: 'idle' | 'busy' | 'ok' | 'fail'; message?: string }

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const theme = useTheme()
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'))
  const keys = useStore((s) => s.keys)
  const setKey = useStore((s) => s.setKey)
  const endpoints = useStore((s) => s.endpoints)
  const setEndpoint = useStore((s) => s.setEndpoint)
  const decisionEndpoints = useStore((s) => s.decisionEndpoints)
  const setDecisionEndpoint = useStore((s) => s.setDecisionEndpoint)
  const discoveredModels = useStore((s) => s.discoveredModels)
  const setDiscoveredModels = useStore((s) => s.setDiscoveredModels)
  const [probes, setProbes] = useState<Partial<Record<ProviderId, Probe>>>({})

  const probe = async (provider: ProviderId) => {
    setProbes((p) => ({ ...p, [provider]: { state: 'busy' } }))
    try {
      const models = await listModels(provider, {
        endpoint: resolveEndpoint(provider, endpoints),
        apiKey: keys[provider] ?? '',
      })
      setDiscoveredModels(provider, models)
      setProbes((p) => ({
        ...p,
        [provider]: { state: 'ok', message: `${models.length} model${models.length === 1 ? '' : 's'} available` },
      }))
    } catch (err) {
      setProbes((p) => ({
        ...p,
        [provider]: { state: 'fail', message: err instanceof Error ? err.message : String(err) },
      }))
    }
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" fullScreen={fullScreen}>
      <DialogTitle>Providers</DialogTitle>
      <DialogContent>
        <Alert severity="info" sx={{ mb: 2 }}>
          Keys and URLs are kept in this browser's local storage and sent straight to the endpoint.
          There is no backend in this project, so nothing passes through a server of ours. Use a key
          with a spend limit anyway.
        </Alert>

        <Stack spacing={3} divider={<Divider flexItem />}>
          {PROVIDERS.filter((p) => p.keyLabel).map((provider) => {
            const status = probes[provider.id]
            const found = discoveredModels[provider.id]?.length ?? 0
            return (
              <Stack key={provider.id} spacing={1.5}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography variant="subtitle2">{provider.label}</Typography>
                  {found > 0 && <Chip size="small" label={`${found} models`} sx={{ height: 20, fontSize: 11 }} />}
                </Box>
                {provider.hint && (
                  <Typography variant="caption" sx={{ opacity: 0.65, mt: -0.75 }}>
                    {provider.hint}
                  </Typography>
                )}

                <TextField
                  label="Endpoint URL"
                  value={endpoints[provider.id] ?? ''}
                  onChange={(e) => setEndpoint(provider.id, e.target.value)}
                  placeholder={DEFAULT_ENDPOINTS[provider.id] || 'https://your-gateway/v1/chat/completions'}
                  fullWidth
                  autoComplete="off"
                  spellCheck={false}
                  helperText={
                    provider.needsEndpoint
                      ? 'Required. The full chat-completions URL.'
                      : 'Leave empty for the official endpoint. Fill it to route through a proxy or mirror.'
                  }
                />

                <TextField
                  label={provider.keyLabel}
                  type="password"
                  value={keys[provider.id] ?? ''}
                  onChange={(e) => setKey(provider.id, e.target.value)}
                  autoComplete="off"
                  fullWidth
                  helperText={
                    provider.keyUrl ? (
                      <Link href={provider.keyUrl} target="_blank" rel="noreferrer" underline="hover">
                        get a key
                      </Link>
                    ) : undefined
                  }
                />

                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={
                      status?.state === 'busy' ? <CircularProgress size={14} /> : <ScienceRoundedIcon />
                    }
                    disabled={status?.state === 'busy' || !resolveEndpoint(provider.id, endpoints)}
                    onClick={() => probe(provider.id)}
                  >
                    Test and list models
                  </Button>
                  {status?.state === 'ok' && (
                    <Typography variant="caption" color="success.main">
                      {status.message}
                    </Typography>
                  )}
                  {status?.state === 'fail' && (
                    <Typography variant="caption" color="error" sx={{ wordBreak: 'break-word', flex: 1 }}>
                      {status.message}
                    </Typography>
                  )}
                </Box>
              </Stack>
            )
          })}
        </Stack>

        <Divider sx={{ my: 3 }} />
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          Decision models
        </Typography>
        <Typography variant="caption" sx={{ display: 'block', opacity: 0.65, mb: 2 }}>
          Used by Decision nodes. These models (TypeSafe&apos;s Jev is the first) answer typed questions about a message
          — a choice, a yes/no, a score — with probabilities, instead of writing text.
        </Typography>
        <Stack spacing={3} divider={<Divider flexItem />}>
          {DECISION_PROVIDERS.filter((p) => p.keyId).map((provider) => (
            <Stack key={provider.id} spacing={1.5}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Typography variant="subtitle2">{provider.label}</Typography>
                <Chip size="small" label={provider.models[0]} sx={{ height: 20, fontSize: 11, fontFamily: '"Roboto Mono", monospace' }} />
              </Box>
              {provider.hint && (
                <Typography variant="caption" sx={{ opacity: 0.65, mt: -0.75 }}>
                  {provider.hint}
                </Typography>
              )}
              <TextField
                label="Endpoint URL"
                value={decisionEndpoints[provider.id] ?? ''}
                onChange={(e) => setDecisionEndpoint(provider.id, e.target.value)}
                placeholder={DEFAULT_DECISION_ENDPOINTS[provider.id]}
                fullWidth
                autoComplete="off"
                spellCheck={false}
                helperText={
                  provider.id === 'typesafe'
                    ? 'Empty = TypeSafe’s own API, which a browser page cannot call. Put a relay of your own here.'
                    : provider.id === 'laya'
                      ? 'Empty = Laya on this computer, port 8000, started with tools/laya-serve-cors.py (plain laya-serve sends no CORS headers).'
                      : 'Leave empty for the official endpoint.'
                }
              />
              {provider.keyId === 'openrouter' ? (
                <Typography variant="body2" sx={{ opacity: 0.8 }}>
                  Uses the OpenRouter key above{keys.openrouter?.trim() ? ' (set).' : ' — not set yet.'}
                </Typography>
              ) : (
                <TextField
                  label={provider.keyLabel}
                  type="password"
                  value={(provider.keyId && keys[provider.keyId]) ?? ''}
                  onChange={(e) => provider.keyId && setKey(provider.keyId, e.target.value)}
                  autoComplete="off"
                  fullWidth
                  helperText={
                    provider.keyUrl ? (
                      <Link href={provider.keyUrl} target="_blank" rel="noreferrer" underline="hover">
                        get a key
                      </Link>
                    ) : provider.keyOptional ? (
                      'Leave empty unless you started the server with a key.'
                    ) : undefined
                  }
                />
              )}
            </Stack>
          ))}
        </Stack>

        <Typography variant="caption" sx={{ display: 'block', mt: 3, opacity: 0.65 }}>
          The app runs entirely in your browser, so a call only works if the endpoint allows your
          origin (CORS). Internal gateways often allow <code>localhost</code> and nothing else: in
          that case clone the repo and run <code>npm run dev</code> instead of using the published
          site, or put a proxy of your own in the Endpoint URL field. A failing Test that mentions
          CORS, or gives no detail at all, is almost always this.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button
          color="inherit"
          onClick={() => {
            PROVIDERS.forEach((p) => p.keyLabel && setKey(p.id, ''))
            setKey('typesafe', '')
            setKey('laya', '')
          }}
        >
          Clear keys
        </Button>
        <Button variant="contained" onClick={onClose}>
          Done
        </Button>
      </DialogActions>
    </Dialog>
  )
}
