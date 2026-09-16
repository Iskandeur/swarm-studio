import { useRef, useState } from 'react'
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
  useMediaQuery,
} from '@mui/material'
import PanToolRoundedIcon from '@mui/icons-material/PanToolRounded'
import { useStore } from '../store'
import type { PendingGate } from '../engine/session'

/**
 * A human gate that the run has reached: the flow is parked until you decide.
 *
 * Not dismissible by a backdrop click or Escape on purpose. Closing it without a decision would leave
 * the run silently holding with nothing on screen saying why. It closes when the engine reports the
 * gate closed — after a decision, or after a Stop.
 */
export function GateDialog() {
  const gates = useStore((s) => s.gates)
  const fullScreen = useMediaQuery('(max-width:899.95px)')
  const gate = gates[0]
  // Kept through the closing transition, so the dialog does not fade out empty.
  const last = useRef<PendingGate | undefined>(gate)
  if (gate) last.current = gate
  const shown = gate ?? last.current

  return (
    <Dialog open={Boolean(gate)} fullWidth maxWidth="sm" fullScreen={fullScreen} aria-labelledby="gate-dialog-title">
      {shown && (
        // Keyed by gate, so the next gate in the queue starts from ITS text, not from your edit of the last one.
        <GateForm key={shown.id} gate={shown} waiting={Math.max(0, gates.length - 1)} />
      )}
    </Dialog>
  )
}

function GateForm({ gate, waiting }: { gate: PendingGate; waiting: number }) {
  const decideGate = useStore((s) => s.decideGate)
  const stop = useStore((s) => s.stop)
  const [text, setText] = useState(gate.text)

  return (
    <>
      <DialogTitle id="gate-dialog-title" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <PanToolRoundedIcon fontSize="small" sx={{ opacity: 0.75 }} />
        <Box component="span" sx={{ flex: 1 }}>
          {gate.name}
        </Box>
        {waiting > 0 && <Chip size="small" label={`${waiting} more waiting`} sx={{ height: 22, fontSize: 11 }} />}
      </DialogTitle>

      <DialogContent>
        <Typography variant="body1" sx={{ mb: 0.75, fontWeight: 500 }}>
          {gate.prompt}
        </Typography>
        <Typography variant="body2" sx={{ mb: 2, opacity: 0.75 }}>
          The run is holding here until you decide. Editing the text changes what continues.
        </Typography>
        <TextField
          label="Incoming text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          multiline
          minRows={6}
          maxRows={16}
          fullWidth
          autoFocus
        />
        {text !== gate.text && (
          <Typography variant="caption" component="div" sx={{ mt: 0.75, opacity: 0.6 }}>
            Edited — your version is what goes on.
          </Typography>
        )}
      </DialogContent>

      <DialogActions disableSpacing sx={{ px: 3, pb: 2, flexWrap: 'wrap', gap: 1 }}>
        {/* The dialog is modal, so the run bar's Stop is behind it. A gate must not be a trap. */}
        <Button color="inherit" onClick={stop} sx={{ mr: 'auto', opacity: 0.8 }}>
          Stop the run
        </Button>
        <Button variant="outlined" color="error" onClick={() => decideGate(gate.id, { approved: false, text })}>
          Reject
        </Button>
        <Button variant="contained" onClick={() => decideGate(gate.id, { approved: true, text })}>
          Approve
        </Button>
      </DialogActions>
    </>
  )
}
