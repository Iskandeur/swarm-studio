import { useState } from 'react'
import {
  AppBar,
  Box,
  Button,
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Toolbar,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material'
import HubRoundedIcon from '@mui/icons-material/HubRounded'
import DarkModeRoundedIcon from '@mui/icons-material/DarkModeRounded'
import LightModeRoundedIcon from '@mui/icons-material/LightModeRounded'
import SettingsRoundedIcon from '@mui/icons-material/SettingsRounded'
import GitHubIcon from '@mui/icons-material/GitHub'
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import IosShareRoundedIcon from '@mui/icons-material/IosShareRounded'
import MoreVertRoundedIcon from '@mui/icons-material/MoreVertRounded'
import UndoRoundedIcon from '@mui/icons-material/UndoRounded'
import RedoRoundedIcon from '@mui/icons-material/RedoRounded'
import KeyboardRoundedIcon from '@mui/icons-material/KeyboardRounded'
import AutoFixHighRoundedIcon from '@mui/icons-material/AutoFixHighRounded'
import { useStore } from '../store'
import { PRESETS } from '../presets'
import { exportSwarm } from '../engine/portable'
import { SwarmSettings } from './SwarmSettings'

/** What each starter swarm shows, so the menu says why you would open it. */
const PRESET_HINTS: Record<string, string> = {
  'The Cat Council': 'fan-out, then fan-in',
  'The Best Man Speech': 'a manager and its workers',
  'The Dignity Pipeline': 'a straight pipeline',
  'The Fridge Tribunal': 'shared memory, a join, a condition, a human gate',
  'The Delegation Spiral': 'agents spawning agents, down to the depth limit',
  'The Recursive Excuse': 'a block that contains itself',
  'Triage (System 1 → System 2)': 'a decision model routes; unsure answers escalate to an LLM',
}

export function TopBar({
  onOpenSettings,
  onOpenHelp,
  onOpenShare,
  onOpenPrompt,
}: {
  onOpenSettings: () => void
  onOpenHelp: () => void
  onOpenShare: () => void
  onOpenPrompt: () => void
}) {
  const theme = useTheme()
  const compact = useMediaQuery(theme.breakpoints.down('md'))
  const spec = useStore((s) => s.spec)
  const loadPreset = useStore((s) => s.loadPreset)
  const themeMode = useStore((s) => s.themeMode)
  const toggleTheme = useStore((s) => s.toggleTheme)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)
  const canUndo = useStore((s) => s.past.length > 0)
  const canRedo = useStore((s) => s.future.length > 0)
  const [presetMenu, setPresetMenu] = useState<HTMLElement | null>(null)
  const [overflow, setOverflow] = useState<HTMLElement | null>(null)

  const exportSpec = () => {
    // The same documented shape the Share dialog copies, so a downloaded file and a pasted block
    // are interchangeable. Two export formats for one app would be one format too many.
    const blob = new Blob([exportSwarm(spec)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${spec.name.toLowerCase().replace(/\s+/g, '-')}.swarm.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <AppBar
      position="static"
      color="transparent"
      elevation={0}
      sx={{ borderBottom: '1px solid', borderColor: 'divider', backdropFilter: 'blur(6px)' }}
    >
      <Toolbar variant="dense" sx={{ gap: { xs: 0.5, md: 1.5 }, py: 1, px: { xs: 1, md: 3 } }}>
        <HubRoundedIcon color="primary" />
        {!compact && (
          <Typography variant="h6" sx={{ mr: 1 }}>
            Swarm Studio
          </Typography>
        )}

        <Button
          color="inherit"
          onClick={(e) => setPresetMenu(e.currentTarget)}
          sx={{ opacity: 0.85, minWidth: 0, maxWidth: compact ? 170 : 'none' }}
        >
          <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {spec.name}
          </Box>
        </Button>
        <Menu anchorEl={presetMenu} open={Boolean(presetMenu)} onClose={() => setPresetMenu(null)}>
          {PRESETS.map((preset) => (
            <MenuItem
              key={preset.name}
              onClick={() => {
                loadPreset(preset)
                setPresetMenu(null)
              }}
            >
              <ListItemText
                primary={preset.name}
                secondary={PRESET_HINTS[preset.name]}
                secondaryTypographyProps={{ sx: { fontSize: 11.5 } }}
              />
            </MenuItem>
          ))}
        </Menu>

        {/* The one feature that replaces clicking: kept in the bar on every layout, never in a menu. */}
        {compact ? (
          <Tooltip title="Prompt the graph: describe the swarm you want">
            <IconButton onClick={onOpenPrompt} aria-label="Prompt the graph" color="primary">
              <AutoFixHighRoundedIcon />
            </IconButton>
          </Tooltip>
        ) : (
          <Button
            variant="outlined"
            size="small"
            startIcon={<AutoFixHighRoundedIcon />}
            onClick={onOpenPrompt}
            sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}
          >
            Prompt the graph
          </Button>
        )}

        <Box sx={{ flex: 1 }} />

        {/* Undo and redo are visible, not only bound: a graph editor where the only way back is a
            keystroke you have to guess is a graph editor people are afraid to touch. */}
        <Tooltip title="Undo (Ctrl/⌘ + Z)">
          <span>
            <IconButton onClick={undo} disabled={!canUndo} aria-label="Undo">
              <UndoRoundedIcon />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Redo (Ctrl/⌘ + Shift + Z)">
          <span>
            <IconButton onClick={redo} disabled={!canRedo} aria-label="Redo">
              <RedoRoundedIcon />
            </IconButton>
          </span>
        </Tooltip>

        {compact ? (
          <>
            <Tooltip title="Providers and keys">
              <IconButton onClick={onOpenSettings} edge="end">
                <SettingsRoundedIcon />
              </IconButton>
            </Tooltip>
            <IconButton onClick={(e) => setOverflow(e.currentTarget)} aria-label="more">
              <MoreVertRoundedIcon />
            </IconButton>
            <Menu anchorEl={overflow} open={Boolean(overflow)} onClose={() => setOverflow(null)}>
              <MenuItem
                onClick={() => {
                  toggleTheme()
                  setOverflow(null)
                }}
              >
                <ListItemIcon>
                  {themeMode === 'dark' ? <LightModeRoundedIcon fontSize="small" /> : <DarkModeRoundedIcon fontSize="small" />}
                </ListItemIcon>
                <ListItemText>{themeMode === 'dark' ? 'Light mode' : 'Dark mode'}</ListItemText>
              </MenuItem>
              <MenuItem
                onClick={() => {
                  exportSpec()
                  setOverflow(null)
                }}
              >
                <ListItemIcon>
                  <DownloadRoundedIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>Export JSON</ListItemText>
              </MenuItem>
              <MenuItem
                onClick={() => {
                  onOpenShare()
                  setOverflow(null)
                }}
              >
                <ListItemIcon>
                  <IosShareRoundedIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>Share configuration</ListItemText>
              </MenuItem>
              <MenuItem
                onClick={() => {
                  onOpenHelp()
                  setOverflow(null)
                }}
              >
                <ListItemIcon>
                  <KeyboardRoundedIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>Keyboard shortcuts</ListItemText>
              </MenuItem>
              <Divider />
              <MenuItem
                component="a"
                href="https://github.com/Iskandeur/swarm-studio"
                target="_blank"
                rel="noreferrer"
                onClick={() => setOverflow(null)}
              >
                <ListItemIcon>
                  <GitHubIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>Source</ListItemText>
              </MenuItem>
            </Menu>
          </>
        ) : (
          <Stack direction="row" spacing={1.5} alignItems="center">
            <SwarmSettings />
            <Tooltip title="Share this configuration (copy or paste JSON)">
              <IconButton onClick={onOpenShare} aria-label="Share this configuration">
                <IosShareRoundedIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title="Download this swarm as a JSON file">
              <IconButton onClick={exportSpec}>
                <DownloadRoundedIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title="Providers and keys">
              <IconButton onClick={onOpenSettings}>
                <SettingsRoundedIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title="Keyboard shortcuts (?)">
              <IconButton onClick={onOpenHelp} aria-label="Keyboard shortcuts">
                <KeyboardRoundedIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title={themeMode === 'dark' ? 'Light mode' : 'Dark mode'}>
              <IconButton onClick={toggleTheme}>
                {themeMode === 'dark' ? <LightModeRoundedIcon /> : <DarkModeRoundedIcon />}
              </IconButton>
            </Tooltip>
            <Tooltip title="Source on GitHub">
              <IconButton href="https://github.com/Iskandeur/swarm-studio" target="_blank" rel="noreferrer">
                <GitHubIcon />
              </IconButton>
            </Tooltip>
          </Stack>
        )}
      </Toolbar>
    </AppBar>
  )
}
