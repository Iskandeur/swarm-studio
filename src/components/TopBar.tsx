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
import MoreVertRoundedIcon from '@mui/icons-material/MoreVertRounded'
import { useStore } from '../store'
import { PRESETS } from '../presets'
import { SwarmSettings } from './SwarmSettings'

export function TopBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const theme = useTheme()
  const compact = useMediaQuery(theme.breakpoints.down('md'))
  const spec = useStore((s) => s.spec)
  const loadPreset = useStore((s) => s.loadPreset)
  const themeMode = useStore((s) => s.themeMode)
  const toggleTheme = useStore((s) => s.toggleTheme)
  const [presetMenu, setPresetMenu] = useState<HTMLElement | null>(null)
  const [overflow, setOverflow] = useState<HTMLElement | null>(null)

  const exportSpec = () => {
    const blob = new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' })
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
              {preset.name}
            </MenuItem>
          ))}
        </Menu>

        <Box sx={{ flex: 1 }} />

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
            <Tooltip title="Export this swarm as JSON">
              <IconButton onClick={exportSpec}>
                <DownloadRoundedIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title="Providers and keys">
              <IconButton onClick={onOpenSettings}>
                <SettingsRoundedIcon />
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
