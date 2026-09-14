import { useMemo, useState } from 'react'
import { Box, CssBaseline, Paper, ThemeProvider } from '@mui/material'
import { ReactFlowProvider } from '@xyflow/react'
import { buildTheme } from './theme'
import { useStore } from './store'
import { TopBar } from './components/TopBar'
import { Inspector } from './components/Inspector'
import { GraphCanvas } from './components/GraphCanvas'
import { TranscriptPanel } from './components/TranscriptPanel'
import { RunBar } from './components/RunBar'
import { SettingsDialog } from './components/SettingsDialog'

export default function App() {
  const themeMode = useStore((s) => s.themeMode)
  const theme = useMemo(() => buildTheme(themeMode), [themeMode])
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <TopBar onOpenSettings={() => setSettingsOpen(true)} />

        <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <Paper
            elevation={0}
            square
            sx={{ width: 320, flexShrink: 0, borderRight: '1px solid', borderColor: 'divider' }}
          >
            <Inspector />
          </Paper>

          <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <Box sx={{ flex: 1, minHeight: 0 }}>
              <ReactFlowProvider>
                <GraphCanvas />
              </ReactFlowProvider>
            </Box>
            <RunBar />
          </Box>

          <Paper
            elevation={0}
            square
            sx={{ width: 390, flexShrink: 0, borderLeft: '1px solid', borderColor: 'divider' }}
          >
            <TranscriptPanel />
          </Paper>
        </Box>
      </Box>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </ThemeProvider>
  )
}
