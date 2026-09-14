import { useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  BottomNavigation,
  BottomNavigationAction,
  Box,
  Button,
  CssBaseline,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Drawer,
  LinearProgress,
  Paper,
  Snackbar,
  Stack,
  ThemeProvider,
  Typography,
  useMediaQuery,
} from '@mui/material'
import GroupsRoundedIcon from '@mui/icons-material/GroupsRounded'
import TuneRoundedIcon from '@mui/icons-material/TuneRounded'
import ForumRoundedIcon from '@mui/icons-material/ForumRounded'
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded'
import StopRoundedIcon from '@mui/icons-material/StopRounded'
import { ReactFlowProvider } from '@xyflow/react'
import { buildTheme } from './theme'
import { useStore } from './store'
import { TopBar } from './components/TopBar'
import { Inspector } from './components/Inspector'
import { GraphCanvas } from './components/GraphCanvas'
import { TranscriptPanel } from './components/TranscriptPanel'
import { RunBar } from './components/RunBar'
import { SettingsDialog } from './components/SettingsDialog'
import { SHORTCUTS, useHotkeys } from './components/useHotkeys'

type Sheet = 'agents' | 'setup' | 'log' | null

export default function App() {
  const themeMode = useStore((s) => s.themeMode)
  const theme = useMemo(() => buildTheme(themeMode), [themeMode])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const notice = useStore((s) => s.notice)
  const dismissNotice = useStore((s) => s.dismissNotice)

  useHotkeys({ onHelp: () => setHelpOpen(true) })

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Shell onOpenSettings={() => setSettingsOpen(true)} onOpenHelp={() => setHelpOpen(true)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ShortcutsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      {/* A model refusing a parameter is not a failure, so it must not look like one — but it has
          to be visible, or the slider silently lies about what was sent. */}
      <Snackbar
        open={Boolean(notice)}
        autoHideDuration={9000}
        onClose={dismissNotice}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="info" variant="filled" onClose={dismissNotice} sx={{ maxWidth: 520 }}>
          {notice}
        </Alert>
      </Snackbar>
    </ThemeProvider>
  )
}

function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Keyboard shortcuts</DialogTitle>
      <DialogContent>
        <Stack spacing={1}>
          {SHORTCUTS.map((shortcut) => (
            <Box key={shortcut.keys} sx={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
              <Box
                component="kbd"
                sx={{
                  fontFamily: '"Roboto Mono", monospace',
                  fontSize: 11.5,
                  px: 0.75,
                  py: 0.25,
                  borderRadius: 1,
                  border: '1px solid',
                  borderColor: 'divider',
                  bgcolor: 'action.hover',
                  whiteSpace: 'nowrap',
                }}
              >
                {shortcut.keys}
              </Box>
              <Typography variant="body2">{shortcut.what}</Typography>
            </Box>
          ))}
        </Stack>
        <Typography variant="caption" sx={{ display: 'block', mt: 2, opacity: 0.65 }}>
          Shortcuts are ignored while you are typing in a field.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={onClose}>
          Done
        </Button>
      </DialogActions>
    </Dialog>
  )
}

function Shell({ onOpenSettings, onOpenHelp }: { onOpenSettings: () => void; onOpenHelp: () => void }) {
  // `md` is the switch: below it there is no room for three columns side by side.
  const mobile = useMediaQuery('(max-width:899.95px)')

  return (
    <Box
      sx={{
        // dvh follows the mobile URL bar; vh is the fallback for older engines.
        height: ['100vh', '100dvh'],
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <TopBar onOpenSettings={onOpenSettings} onOpenHelp={onOpenHelp} />
      {mobile ? <MobileBody /> : <DesktopBody />}
    </Box>
  )
}

function Canvas({ onAgentOpen }: { onAgentOpen?: () => void } = {}) {
  return (
    <ReactFlowProvider>
      <GraphCanvas onAgentOpen={onAgentOpen} />
    </ReactFlowProvider>
  )
}

function DesktopBody() {
  return (
    <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <Paper elevation={0} square sx={{ width: 320, flexShrink: 0, borderRight: '1px solid', borderColor: 'divider' }}>
        <Inspector />
      </Paper>

      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Box sx={{ flex: 1, minHeight: 0 }}>
          <Canvas />
        </Box>
        <RunBar />
      </Box>

      <Paper elevation={0} square sx={{ width: 390, flexShrink: 0, borderLeft: '1px solid', borderColor: 'divider' }}>
        <TranscriptPanel />
      </Paper>
    </Box>
  )
}

/**
 * Phone layout: the graph keeps the whole screen, because watching the run is the point. The three
 * panels become bottom sheets, and Run stays one tap away whichever sheet is open.
 */
function MobileBody() {
  const [sheet, setSheet] = useState<Sheet>(null)
  const phase = useStore((s) => s.phase)
  const start = useStore((s) => s.start)
  const stop = useStore((s) => s.stop)
  const messages = useStore((s) => s.transcript.length)
  const agents = useStore((s) => s.spec.agents.length)
  const running = phase === 'running'

  const toggle = (next: Exclude<Sheet, null>) => setSheet((current) => (current === next ? null : next))

  return (
    <>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <Canvas onAgentOpen={() => setSheet('agents')} />
      </Box>

      <Paper elevation={0} square sx={{ borderTop: '1px solid', borderColor: 'divider', flexShrink: 0 }}>
        {running && <LinearProgress sx={{ height: 2 }} />}
        <BottomNavigation
          showLabels
          value={sheet}
          sx={{ bgcolor: 'transparent', height: 60, pb: 'env(safe-area-inset-bottom)' }}
        >
          <BottomNavigationAction
            label="Agents"
            value="agents"
            onClick={() => toggle('agents')}
            icon={
              <Badge badgeContent={agents} color="default" showZero={false}>
                <GroupsRoundedIcon />
              </Badge>
            }
          />
          <BottomNavigationAction label="Task" value="setup" onClick={() => toggle('setup')} icon={<TuneRoundedIcon />} />
          <BottomNavigationAction
            label="Log"
            value="log"
            onClick={() => toggle('log')}
            icon={
              <Badge badgeContent={messages} color="primary" showZero={false} max={99}>
                <ForumRoundedIcon />
              </Badge>
            }
          />
          <BottomNavigationAction
            label={running ? 'Stop' : 'Run'}
            value="run"
            onClick={() => (running ? stop() : start())}
            icon={running ? <StopRoundedIcon color="error" /> : <PlayArrowRoundedIcon color="primary" />}
          />
        </BottomNavigation>
      </Paper>

      <BottomSheet open={sheet === 'agents'} onClose={() => setSheet(null)}>
        <Inspector />
      </BottomSheet>
      <BottomSheet open={sheet === 'setup'} onClose={() => setSheet(null)} height="auto">
        <RunBar layout="sheet" />
      </BottomSheet>
      <BottomSheet open={sheet === 'log'} onClose={() => setSheet(null)}>
        <TranscriptPanel />
      </BottomSheet>
    </>
  )
}

function BottomSheet({
  open,
  onClose,
  children,
  height = '78dvh',
}: {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  height?: string
}) {
  return (
    <Drawer
      anchor="bottom"
      open={open}
      onClose={onClose}
      slotProps={{
        paper: {
          sx: {
            height,
            maxHeight: '90dvh',
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            pb: 'env(safe-area-inset-bottom)',
          },
        },
      }}
    >
      <Box
        sx={{
          width: 36,
          height: 4,
          borderRadius: 2,
          bgcolor: 'divider',
          mx: 'auto',
          mt: 1.25,
          mb: 0.5,
          flexShrink: 0,
        }}
      />
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>{children}</Box>
    </Drawer>
  )
}
