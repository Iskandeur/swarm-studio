import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Link, Stack, TextField, Typography } from '@mui/material'
import { useStore } from '../store'
import { PROVIDERS } from '../engine/providers'

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const keys = useStore((s) => s.keys)
  const setKey = useStore((s) => s.setKey)

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>API keys</DialogTitle>
      <DialogContent>
        <Alert severity="info" sx={{ mb: 2 }}>
          Keys are kept in this browser's local storage and sent straight to the provider. There is no
          backend in this project, so nothing passes through a server of ours. Use a key with a spend
          limit anyway.
        </Alert>

        <Stack spacing={2}>
          {PROVIDERS.filter((p) => p.keyLabel).map((provider) => (
            <TextField
              key={provider.id}
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
          ))}
        </Stack>

        <Typography variant="caption" sx={{ display: 'block', mt: 2, opacity: 0.65 }}>
          Browser calls need the provider to allow cross-origin requests. Anthropic and OpenRouter do;
          if a provider refuses, use the demo provider or put your own proxy in front.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button
          color="inherit"
          onClick={() => PROVIDERS.forEach((p) => p.keyLabel && setKey(p.id, ''))}
        >
          Clear all
        </Button>
        <Button variant="contained" onClick={onClose}>
          Done
        </Button>
      </DialogActions>
    </Dialog>
  )
}
