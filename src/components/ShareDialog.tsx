import { useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material'
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded'
import CheckRoundedIcon from '@mui/icons-material/CheckRounded'
import { useStore } from '../store'
import { exportAgents, exportSwarm, parsePortable, portableToSpec } from '../engine/portable'

/**
 * Share and receive a configuration.
 *
 * The point of this dialog is one sentence: paste what comes out of it into a friend's Swarm Studio
 * and they get your swarm. So it shows the JSON as text — copyable, readable, pasteable in a chat —
 * rather than hiding it behind a file download. Keys and endpoint URLs never travel.
 */
export function ShareDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const spec = useStore((s) => s.spec)
  const multiIds = useStore((s) => s.multiIds)
  const selectedId = useStore((s) => s.selectedId)
  const pasteAgents = useStore((s) => s.pasteAgents)
  const replaceSwarm = useStore((s) => s.replaceSwarm)

  const [tab, setTab] = useState<'out' | 'in'>('out')
  const [incoming, setIncoming] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  // A dialog reopened after a paste should not still be showing the last error.
  useEffect(() => {
    if (open) setProblem(null)
  }, [open])

  /** What "copy the selection" means: the ticked agents, or failing that the selected one. */
  const clipping = multiIds.length > 0 ? multiIds : selectedId ? [selectedId] : []
  const swarmJson = exportSwarm(spec)
  const clippingJson = clipping.length > 0 ? exportAgents(spec, clipping) : ''

  const copy = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(what)
        setTimeout(() => setCopied(null), 1600)
      },
      () => setProblem('This browser refused clipboard access — select the text and copy it by hand.'),
    )
  }

  const receive = () => {
    const result = parsePortable(incoming)
    if (!result.ok) return setProblem(result.error)
    setProblem(null)
    if (result.value.kind === 'swarm') {
      replaceSwarm(portableToSpec(result.value))
    } else {
      pasteAgents(result.value)
    }
    setIncoming('')
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>Share this configuration</DialogTitle>
      <Tabs value={tab} onChange={(_, value) => setTab(value)} sx={{ px: 3, minHeight: 40 }}>
        <Tab value="out" label="Copy out" sx={{ minHeight: 40 }} />
        <Tab value="in" label="Paste in" sx={{ minHeight: 40 }} />
      </Tabs>

      <DialogContent>
        {problem && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setProblem(null)}>
            {problem}
          </Alert>
        )}

        {tab === 'out' ? (
          <>
            <Typography variant="body2" sx={{ mb: 1.5, opacity: 0.75 }}>
              Paste either block into someone else's Swarm Studio and they get your configuration.
              API keys and endpoint URLs are deliberately absent: they are yours, not part of the swarm.
            </Typography>

            <Block
              title={`The whole swarm — ${spec.agents.length} agents, ${spec.links.length} links`}
              json={swarmJson}
              copied={copied === 'swarm'}
              onCopy={() => copy(swarmJson, 'swarm')}
            />

            <Block
              title={
                clipping.length > 0
                  ? `Just the selection — ${clipping.length} agent${clipping.length === 1 ? '' : 's'}`
                  : 'Just the selection — tick agents in the roster first'
              }
              json={clippingJson}
              copied={copied === 'clipping'}
              onCopy={() => copy(clippingJson, 'clipping')}
            />
          </>
        ) : (
          <>
            <Typography variant="body2" sx={{ mb: 1.5, opacity: 0.75 }}>
              Paste a swarm to replace this one, or a clipping of agents to add them to it. An older
              export, a bare list of agents, or a single agent object all work.
            </Typography>
            <TextField
              value={incoming}
              onChange={(e) => setIncoming(e.target.value)}
              placeholder='{ "format": "swarm-studio", "kind": "swarm", … }'
              multiline
              minRows={12}
              maxRows={20}
              fullWidth
              spellCheck={false}
              inputProps={{ 'aria-label': 'Paste a swarm or a clipping of agents', style: { fontFamily: '"Roboto Mono", monospace', fontSize: 12 } }}
            />
          </>
        )}
      </DialogContent>

      <DialogActions>
        <Button color="inherit" onClick={onClose}>
          Close
        </Button>
        {tab === 'in' && (
          <Button variant="contained" onClick={receive} disabled={incoming.trim() === ''}>
            Load it
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}

function Block({
  title,
  json,
  copied,
  onCopy,
}: {
  title: string
  json: string
  copied: boolean
  onCopy: () => void
}) {
  return (
    <Box sx={{ mb: 2.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.75 }}>
        <Typography variant="subtitle2" sx={{ flex: 1 }}>
          {title}
        </Typography>
        <Button
          size="small"
          variant={copied ? 'contained' : 'outlined'}
          color={copied ? 'success' : 'primary'}
          startIcon={copied ? <CheckRoundedIcon /> : <ContentCopyRoundedIcon />}
          onClick={onCopy}
          disabled={json === ''}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </Box>
      <Box
        component="pre"
        sx={{
          m: 0,
          p: 1.25,
          maxHeight: 200,
          overflow: 'auto',
          borderRadius: 1.5,
          border: '1px solid',
          borderColor: 'divider',
          bgcolor: 'action.hover',
          fontFamily: '"Roboto Mono", monospace',
          fontSize: 11.5,
          lineHeight: 1.5,
        }}
      >
        {json || '—'}
      </Box>
    </Box>
  )
}
