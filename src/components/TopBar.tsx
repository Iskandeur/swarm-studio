import { useState } from 'react'
import {
  AppBar,
  Box,
  Button,
  IconButton,
  Menu,
  MenuItem,
  Stack,
  TextField,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material'
import HubRoundedIcon from '@mui/icons-material/HubRounded'
import DarkModeRoundedIcon from '@mui/icons-material/DarkModeRounded'
import LightModeRoundedIcon from '@mui/icons-material/LightModeRounded'
import SettingsRoundedIcon from '@mui/icons-material/SettingsRounded'
import GitHubIcon from '@mui/icons-material/GitHub'
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import { useStore } from '../store'
import { PRESETS } from '../presets'
import type { Topology } from '../types'

const TOPOLOGIES: Array<{ id: Topology; label: string; hint: string }> = [
  { id: 'broadcast', label: 'Broadcast', hint: 'Every outgoing link carries the message.' },
  { id: 'round-robin', label: 'Round-robin', hint: 'One outgoing link per turn, rotating.' },
  { id: 'manager', label: 'Manager', hint: 'Workers answer, then the entry agent speaks again.' },
]

export function TopBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const spec = useStore((s) => s.spec)
  const setSpec = useStore((s) => s.setSpec)
  const setTopology = useStore((s) => s.setTopology)
  const loadPreset = useStore((s) => s.loadPreset)
  const themeMode = useStore((s) => s.themeMode)
  const toggleTheme = useStore((s) => s.toggleTheme)
  const [menu, setMenu] = useState<HTMLElement | null>(null)

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
      <Toolbar variant="dense" sx={{ gap: 1.5, py: 1 }}>
        <HubRoundedIcon color="primary" />
        <Typography variant="h6" sx={{ mr: 1 }}>
          Swarm Studio
        </Typography>

        <Button color="inherit" onClick={(e) => setMenu(e.currentTarget)} sx={{ opacity: 0.8 }}>
          {spec.name}
        </Button>
        <Menu anchorEl={menu} open={Boolean(menu)} onClose={() => setMenu(null)}>
          {PRESETS.map((preset) => (
            <MenuItem
              key={preset.name}
              onClick={() => {
                loadPreset(preset)
                setMenu(null)
              }}
            >
              {preset.name}
            </MenuItem>
          ))}
        </Menu>

        <Box sx={{ flex: 1 }} />

        <Stack direction="row" spacing={1.5} alignItems="center">
          <Tooltip title={TOPOLOGIES.find((t) => t.id === spec.topology)?.hint ?? ''}>
            <TextField
              select
              label="Topology"
              value={spec.topology}
              onChange={(e) => setTopology(e.target.value as Topology)}
              sx={{ width: 150 }}
            >
              {TOPOLOGIES.map((t) => (
                <MenuItem key={t.id} value={t.id}>
                  {t.label}
                </MenuItem>
              ))}
            </TextField>
          </Tooltip>

          <TextField
            label="Max rounds"
            type="number"
            value={spec.maxRounds}
            onChange={(e) => setSpec({ maxRounds: Math.max(1, Math.min(24, Number(e.target.value) || 1)) })}
            sx={{ width: 100 }}
            inputProps={{ min: 1, max: 24 }}
          />

          <Tooltip title="Export this swarm as JSON">
            <IconButton onClick={exportSpec}>
              <DownloadRoundedIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="API keys">
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
      </Toolbar>
    </AppBar>
  )
}
