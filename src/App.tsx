import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { Panel, ReactFlowProvider } from '@xyflow/react'
import { buildTheme } from './theme'
import { useStore } from './store'
import { PresetMenu, TopBar } from './components/TopBar'
import { Inspector } from './components/Inspector'
import { GraphCanvas } from './components/GraphCanvas'
import { TranscriptPanel } from './components/TranscriptPanel'
import { RunBar, RunControls } from './components/RunBar'
import { SettingsDialog } from './components/SettingsDialog'
import { ShareDialog } from './components/ShareDialog'
import { PromptDock, PromptHero, PromptStrip } from './components/PromptComposer'
import { SHORTCUTS, useHotkeys } from './components/useHotkeys'
import { NodePalette } from './components/NodePalette'
import { BlockLibrary } from './components/BlockLibrary'
import { GateDialog } from './components/GateDialog'

type Sheet = 'agents' | 'setup' | 'log' | null

export default function App() {
  const themeMode = useStore((s) => s.themeMode)
  const theme = useMemo(() => buildTheme(themeMode), [themeMode])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [presetAnchor, setPresetAnchor] = useState<HTMLElement | null>(null)
  // The front door: open on every load. Describe → Generate is the first thing the app offers;
  // everything else is one click behind it.
  const [heroOpen, setHeroOpen] = useState(true)
  const notice = useStore((s) => s.notice)
  const dismissNotice = useStore((s) => s.dismissNotice)
  const graphEpoch = useStore((s) => s.graphEpoch)
  const phase = useStore((s) => s.phase)

  const openHero = useCallback(() => setHeroOpen(true), [])
  useHotkeys({ onHelp: () => setHelpOpen(true), onPrompt: openHero })

  // A graph that just landed (generated, or a starter swarm picked from the hero) is the thing to
  // look at, so the card gets out of the way. So does a run: watching it is the point.
  const seenEpoch = useRef(graphEpoch)
  useEffect(() => {
    if (graphEpoch !== seenEpoch.current) {
      seenEpoch.current = graphEpoch
      setHeroOpen(false)
    }
  }, [graphEpoch])
  useEffect(() => {
    if (phase === 'running') setHeroOpen(false)
  }, [phase])

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Shell
        heroOpen={heroOpen}
        onHeroOpen={openHero}
        onHeroClose={() => setHeroOpen(false)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenHelp={() => setHelpOpen(true)}
        onOpenShare={() => setShareOpen(true)}
        onOpenPresets={setPresetAnchor}
      />
      <PresetMenu anchorEl={presetAnchor} onClose={() => setPresetAnchor(null)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ShortcutsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} />
      {/* A human gate stops the run wherever you are looking, so its question is app-wide. */}
      <GateDialog />
      {/* A model refusing a parameter is not a failure, so it must not look like one — but it has
          to be visible, or the slider silently lies about what was sent. */}
      <Snackbar
        open={Boolean(notice)}
        autoHideDuration={9000}
        onClose={dismissNotice}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
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
        <Typography variant="caption" sx={{ display: 'block', mt: 2, color: 'text.secondary' }}>
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

interface ShellProps {
  heroOpen: boolean
  onHeroOpen: () => void
  onHeroClose: () => void
  onOpenSettings: () => void
  onOpenHelp: () => void
  onOpenShare: () => void
  onOpenPresets: (anchor: HTMLElement) => void
}

function Shell(props: ShellProps) {
  // `md` is the switch: below it there is no room for side panels next to the graph.
  const mobile = useMediaQuery('(max-width:899.95px)')
  const [buildOpen, setBuildOpen] = useState(false)
  const [logOpen, setLogOpen] = useState(false)
  const phase = useStore((s) => s.phase)

  // The transcript opens itself when a run starts: that is where the words go.
  useEffect(() => {
    if (phase === 'running') setLogOpen(true)
  }, [phase])

  return (
    <Box
      sx={{
        // dvh follows the mobile URL bar; vh is the fallback for older engines. It has to be a real
        // CSS fallback: an ARRAY here is MUI's breakpoint syntax, so `['100vh', '100dvh']` meant
        // "100vh below sm, 100dvh above" — every phone got the one unit that ignores the URL bar,
        // and the bottom navigation sat under it, unreachable, on a page that cannot scroll.
        height: '100vh',
        '@supports (height: 100dvh)': { height: '100dvh' },
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        bgcolor: 'background.default',
      }}
    >
      <TopBar
        onOpenSettings={props.onOpenSettings}
        onOpenHelp={props.onOpenHelp}
        onOpenShare={props.onOpenShare}
        onOpenPrompt={props.onHeroOpen}
        onOpenPresets={props.onOpenPresets}
        buildOpen={!mobile && buildOpen}
        onToggleBuild={() => setBuildOpen((v) => !v)}
        logOpen={!mobile && logOpen}
        onToggleLog={() => setLogOpen((v) => !v)}
      />
      {mobile ? (
        <MobileBody {...props} />
      ) : (
        <DesktopBody
          {...props}
          buildOpen={buildOpen}
          onBuildOpen={() => setBuildOpen(true)}
          onBuildClose={() => setBuildOpen(false)}
          logOpen={logOpen}
          onLogClose={() => setLogOpen(false)}
        />
      )}
    </Box>
  )
}

function Canvas({
  onAgentOpen,
  compact = false,
  palette = true,
  layoutKey,
}: {
  onAgentOpen?: () => void
  compact?: boolean
  palette?: boolean
  layoutKey?: string
}) {
  const [libraryOpen, setLibraryOpen] = useState(false)
  return (
    <ReactFlowProvider>
      <GraphCanvas onAgentOpen={onAgentOpen} layoutKey={layoutKey}>
        {/* On the canvas, not in a side panel: adding a node is a canvas gesture, and on a phone
            the panels are sheets that would cover the place the node appears. */}
        {palette && (
          <Panel position="top-left">
            <NodePalette compact={compact} onOpenLibrary={() => setLibraryOpen(true)} />
          </Panel>
        )}
      </GraphCanvas>
      <BlockLibrary open={libraryOpen} onClose={() => setLibraryOpen(false)} />
    </ReactFlowProvider>
  )
}

/**
 * A side panel that takes its width only while open, so the canvas keeps the rest. It opens in one
 * step, not with a width transition: React Flow measures its container on every resize, and a
 * sliding panel gave it 200 ms of intermediate widths to frame the graph against.
 */
function SidePanel({ open, width, side, children }: { open: boolean; width: number; side: 'left' | 'right'; children: React.ReactNode }) {
  if (!open) return null
  return (
    <Box
      data-panel={side}
      sx={{
        width,
        flexShrink: 0,
        overflow: 'hidden',
        borderLeft: side === 'right' ? '1px solid' : 'none',
        borderRight: side === 'left' ? '1px solid' : 'none',
        borderColor: 'divider',
        bgcolor: 'background.paper',
      }}
    >
      {children}
    </Box>
  )
}

function DesktopBody({
  heroOpen,
  onHeroOpen,
  onHeroClose,
  onOpenSettings,
  onOpenPresets,
  buildOpen,
  onBuildOpen,
  onBuildClose,
  logOpen,
  onLogClose,
}: ShellProps & {
  buildOpen: boolean
  onBuildOpen: () => void
  onBuildClose: () => void
  logOpen: boolean
  onLogClose: () => void
}) {
  return (
    <>
      <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <SidePanel open={buildOpen} width={340} side="left">
          <Inspector onClose={onBuildClose} />
        </SidePanel>

        <Box sx={{ flex: 1, minWidth: 0, position: 'relative' }}>
          {/* Selecting on the canvas opens the panel with that node's settings: manual editing is a
              click away, never in the way. */}
          <Canvas onAgentOpen={onBuildOpen} palette={!heroOpen} layoutKey={`${buildOpen}:${logOpen}`} />
          {heroOpen && (
            <PromptHero
              onClose={onHeroClose}
              onOpenSettings={onOpenSettings}
              onOpenPresets={onOpenPresets}
              onBuildByHand={() => {
                onHeroClose()
                onBuildOpen()
              }}
            />
          )}
        </Box>

        <SidePanel open={logOpen} width={400} side="right">
          <TranscriptPanel onClose={onLogClose} />
        </SidePanel>
      </Box>

      {/* The command bar: describe on the left, run on the right. One row, nothing else. */}
      <Box
        sx={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'center',
          gap: 1.5,
          px: 2,
          py: 1.25,
          borderTop: '1px solid',
          borderColor: 'divider',
        }}
      >
        {heroOpen ? null : <PromptDock onExpand={onHeroOpen} />}
        <Box sx={{ pb: 0.25 }}>
          <RunControls />
        </Box>
      </Box>
    </>
  )
}

/**
 * Phone layout: the graph keeps the whole screen, because watching the run is the point. The three
 * panels become bottom sheets, the prompt is a strip above the navigation, and Run stays one tap
 * away whichever sheet is open.
 */
function MobileBody({ heroOpen, onHeroOpen, onHeroClose, onOpenSettings, onOpenPresets }: ShellProps) {
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
      <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <Canvas compact onAgentOpen={() => setSheet('agents')} palette={!heroOpen} />
        {heroOpen && (
          <PromptHero
            onClose={onHeroClose}
            onOpenSettings={onOpenSettings}
            onOpenPresets={onOpenPresets}
            onBuildByHand={() => {
              onHeroClose()
              setSheet('agents')
            }}
          />
        )}
      </Box>

      {!heroOpen && <PromptStrip onOpen={onHeroOpen} />}

      <Paper elevation={0} square sx={{ borderTop: '1px solid', borderColor: 'divider', flexShrink: 0 }}>
        {running && <LinearProgress sx={{ height: 2 }} />}
        <BottomNavigation
          showLabels
          value={sheet}
          // The home-indicator inset is padding ON TOP of the bar, not a slice out of it: with a
          // fixed height and border-box sizing it ate the icons instead, leaving 26px of bar on the
          // phones that have one.
          sx={{ bgcolor: 'transparent', height: 'auto', minHeight: 60, pb: 'env(safe-area-inset-bottom)' }}
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
        <Inspector onClose={() => setSheet(null)} />
      </BottomSheet>
      <BottomSheet open={sheet === 'setup'} onClose={() => setSheet(null)} height="auto">
        <RunBar />
      </BottomSheet>
      <BottomSheet open={sheet === 'log'} onClose={() => setSheet(null)}>
        <TranscriptPanel onClose={() => setSheet(null)} />
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
