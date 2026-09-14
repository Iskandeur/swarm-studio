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
import type { ProviderId } from '../types'

type Probe = { state: 'idle' | 'busy' | 'ok' | 'fail'; message?: string }

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const theme = useTheme()
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'))
  const keys = useStore((s) => s.keys)
  const setKey = useStore((s) => s.setKey)
  const endpoints = useStore((s) => s.endpoints)
  const setEndpoint = useStore((s) => s.setEndpoint)
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

        <Typography variant="caption" sx={{ display: 'block', mt: 3, opacity: 0.65 }}>
          The app runs entirely in your browser, so a call only works if the endpoint allows your
          origin (CORS). Internal gateways often allow <code>localhost</code> and nothing else: in
          that case clone the repo and run <code>npm run dev</code> instead of using the published
          site, or put a proxy of your own in the Endpoint URL field. A failing Test that mentions
          CORS, or gives no detail at all, is almost always this.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={() => PROVIDERS.forEach((p) => p.keyLabel && setKey(p.id, ''))}>
          Clear keys
        </Button>
        <Button variant="contained" onClick={onClose}>
          Done
        </Button>
      </DialogActions>
    </Dialog>
  )
}
