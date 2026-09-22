import { useState } from 'react'
import {
  AppBar,
  Badge,
  Box,
  Button,
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Toolbar,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material'
import HubRoundedIcon from '@mui/icons-material/HubRounded'
import DarkModeRoundedIcon from '@mui/icons-material/DarkModeRounded'
import LightModeRoundedIcon from '@mui/icons-material/LightModeRounded'
import KeyRoundedIcon from '@mui/icons-material/KeyRounded'
import GitHubIcon from '@mui/icons-material/GitHub'
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import IosShareRoundedIcon from '@mui/icons-material/IosShareRounded'
import MoreVertRoundedIcon from '@mui/icons-material/MoreVertRounded'
import UndoRoundedIcon from '@mui/icons-material/UndoRounded'
import RedoRoundedIcon from '@mui/icons-material/RedoRounded'
import KeyboardRoundedIcon from '@mui/icons-material/KeyboardRounded'
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded'
import GroupsRoundedIcon from '@mui/icons-material/GroupsRounded'
import ForumRoundedIcon from '@mui/icons-material/ForumRounded'
import AutoFixHighRoundedIcon from '@mui/icons-material/AutoFixHighRounded'
import { useStore } from '../store'
import { PRESETS } from '../presets'
import { exportSwarm } from '../engine/portable'
import { PROMPT_SHORTCUT } from './PromptComposer'

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

/** The starter swarms. Anchored wherever it was asked for: the name in the bar, or the hero's link. */
export function PresetMenu({ anchorEl, onClose }: { anchorEl: HTMLElement | null; onClose: () => void }) {
  const loadPreset = useStore((s) => s.loadPreset)
  return (
    <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={onClose}>
      <Typography variant="overline" sx={{ px: 2, py: 0.5, display: 'block', color: 'text.secondary' }}>
        Starter swarms
      </Typography>
      {PRESETS.map((preset) => (
        <MenuItem
          key={preset.name}
          onClick={() => {
            loadPreset(preset)
            onClose()
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
  )
}

export function TopBar({
  onOpenSettings,
  onOpenHelp,
  onOpenShare,
  onOpenPrompt,
  onOpenPresets,
  buildOpen,
  onToggleBuild,
  logOpen,
  onToggleLog,
}: {
  onOpenSettings: () => void
  onOpenHelp: () => void
  onOpenShare: () => void
  onOpenPrompt: () => void
  onOpenPresets: (anchor: HTMLElement) => void
  buildOpen: boolean
  onToggleBuild: () => void
  logOpen: boolean
  onToggleLog: () => void
}) {
  const theme = useTheme()
  const compact = useMediaQuery(theme.breakpoints.down('md'))
  const spec = useStore((s) => s.spec)
  const themeMode = useStore((s) => s.themeMode)
  const toggleTheme = useStore((s) => s.toggleTheme)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)
  const canUndo = useStore((s) => s.past.length > 0)
  const canRedo = useStore((s) => s.future.length > 0)
  const agents = useStore((s) => s.spec.agents.length)
  const messages = useStore((s) => s.transcript.length)
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

  const closeOverflow = () => setOverflow(null)

  return (
    <AppBar position="static" color="transparent" elevation={0} sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
      <Toolbar variant="dense" disableGutters sx={{ gap: 0.5, minHeight: 52, px: { xs: 1, md: 2 } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 1 }}>
          <HubRoundedIcon color="primary" sx={{ fontSize: 24 }} />
          {!compact && (
            <Typography variant="subtitle1" sx={{ fontWeight: 600, letterSpacing: -0.1 }}>
              Swarm Studio
            </Typography>
          )}
        </Box>

        {!compact && <Divider orientation="vertical" flexItem sx={{ my: 1.5, mr: 1 }} />}

        <Tooltip title="Starter swarms">
          <Button
            color="inherit"
            onClick={(e) => onOpenPresets(e.currentTarget)}
            endIcon={<ExpandMoreRoundedIcon sx={{ opacity: 0.6 }} />}
            aria-label={`Swarm: ${spec.name}. Open a starter swarm`}
            sx={{ minWidth: 0, maxWidth: compact ? 170 : 300, fontWeight: 500, color: 'text.primary', '& .MuiButton-endIcon': { ml: 0.25 } }}
          >
            <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {spec.name}
            </Box>
          </Button>
        </Tooltip>

        <Box sx={{ flex: 1 }} />

        {/* Undo and redo are visible, not only bound: a graph editor where the only way back is a
            keystroke you have to guess is a graph editor people are afraid to touch. */}
        <Tooltip title="Undo (Ctrl/⌘ + Z)">
          <span>
            <IconButton onClick={undo} disabled={!canUndo} aria-label="Undo" size={compact ? 'small' : 'medium'}>
              <UndoRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Redo (Ctrl/⌘ + Shift + Z)">
          <span>
            <IconButton onClick={redo} disabled={!canRedo} aria-label="Redo" size={compact ? 'small' : 'medium'}>
              <RedoRoundedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        {!compact && (
          <>
            <Divider orientation="vertical" flexItem sx={{ my: 1.5, mx: 0.75 }} />
            <Tooltip title={buildOpen ? 'Hide the agents and their settings' : 'Agents and their settings'}>
              <IconButton
                onClick={onToggleBuild}
                aria-label="Build panel"
                aria-pressed={buildOpen}
                color={buildOpen ? 'primary' : 'default'}
                sx={{ bgcolor: buildOpen ? 'action.selected' : 'transparent' }}
              >
                <Badge badgeContent={agents} color="default" showZero={false} sx={{ '& .MuiBadge-badge': { fontSize: 10, height: 16, minWidth: 16 } }}>
                  <GroupsRoundedIcon fontSize="small" />
                </Badge>
              </IconButton>
            </Tooltip>
            <Tooltip title={logOpen ? 'Hide the transcript' : 'Transcript'}>
              <IconButton
                onClick={onToggleLog}
                aria-label="Transcript panel"
                aria-pressed={logOpen}
                color={logOpen ? 'primary' : 'default'}
                sx={{ bgcolor: logOpen ? 'action.selected' : 'transparent' }}
              >
                <Badge badgeContent={messages} color="primary" showZero={false} max={99} sx={{ '& .MuiBadge-badge': { fontSize: 10, height: 16, minWidth: 16 } }}>
                  <ForumRoundedIcon fontSize="small" />
                </Badge>
              </IconButton>
            </Tooltip>
            <Divider orientation="vertical" flexItem sx={{ my: 1.5, mx: 0.75 }} />
          </>
        )}

        <Tooltip title="Providers and API keys">
          <IconButton onClick={onOpenSettings} aria-label="Providers and keys" size={compact ? 'small' : 'medium'}>
            <KeyRoundedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <IconButton onClick={(e) => setOverflow(e.currentTarget)} aria-label="More" size={compact ? 'small' : 'medium'}>
          <MoreVertRoundedIcon fontSize="small" />
        </IconButton>
        <Menu anchorEl={overflow} open={Boolean(overflow)} onClose={closeOverflow}>
          <MenuItem
            onClick={() => {
              onOpenPrompt()
              closeOverflow()
            }}
          >
            <ListItemIcon>
              <AutoFixHighRoundedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText secondary={PROMPT_SHORTCUT}>Prompt the graph</ListItemText>
          </MenuItem>
          <Divider />
          <MenuItem
            onClick={() => {
              onOpenShare()
              closeOverflow()
            }}
          >
            <ListItemIcon>
              <IosShareRoundedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Share this configuration</ListItemText>
          </MenuItem>
          <MenuItem
            onClick={() => {
              exportSpec()
              closeOverflow()
            }}
          >
            <ListItemIcon>
              <DownloadRoundedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Download as JSON</ListItemText>
          </MenuItem>
          <Divider />
          <MenuItem
            onClick={() => {
              toggleTheme()
              closeOverflow()
            }}
          >
            <ListItemIcon>
              {themeMode === 'dark' ? <LightModeRoundedIcon fontSize="small" /> : <DarkModeRoundedIcon fontSize="small" />}
            </ListItemIcon>
            <ListItemText>{themeMode === 'dark' ? 'Light mode' : 'Dark mode'}</ListItemText>
          </MenuItem>
          <MenuItem
            onClick={() => {
              onOpenHelp()
              closeOverflow()
            }}
          >
            <ListItemIcon>
              <KeyboardRoundedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Keyboard shortcuts</ListItemText>
          </MenuItem>
          <Divider />
          <MenuItem component="a" href="https://github.com/Iskandeur/swarm-studio" target="_blank" rel="noreferrer" onClick={closeOverflow}>
            <ListItemIcon>
              <GitHubIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>Source on GitHub</ListItemText>
          </MenuItem>
        </Menu>
      </Toolbar>
    </AppBar>
  )
}
