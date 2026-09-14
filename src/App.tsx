import { useMemo, useState } from 'react'
import {
  Badge,
  BottomNavigation,
  BottomNavigationAction,
  Box,
  CssBaseline,
  Drawer,
  LinearProgress,
  Paper,
  ThemeProvider,
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

type Sheet = 'agents' | 'setup' | 'log' | null

export default function App() {
  const themeMode = useStore((s) => s.themeMode)
  const theme = useMemo(() => buildTheme(themeMode), [themeMode])
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Shell onOpenSettings={() => setSettingsOpen(true)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </ThemeProvider>
  )
}

function Shell({ onOpenSettings }: { onOpenSettings: () => void }) {
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
      <TopBar onOpenSettings={onOpenSettings} />
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
