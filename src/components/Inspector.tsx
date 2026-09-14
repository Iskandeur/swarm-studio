import {
  Autocomplete,
  Box,
  Button,
  Chip,
  Divider,
  IconButton,
  MenuItem,
  Paper,
  Slider,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded'
import BoltRoundedIcon from '@mui/icons-material/BoltRounded'
import { useStore } from '../store'
import { PROVIDERS, providerInfo, resolveEndpoint } from '../engine/providers'
import { resolveEntryIds } from '../engine/runner'
import { agentColor } from '../theme'
import type { ProviderId } from '../types'

/** Left panel: the agent roster, and everything about the one you selected. */
export function Inspector() {
  const spec = useStore((s) => s.spec)
  const selectedId = useStore((s) => s.selectedId)
  const select = useStore((s) => s.select)
  const addAgent = useStore((s) => s.addAgent)
  const updateAgent = useStore((s) => s.updateAgent)
  const removeAgent = useStore((s) => s.removeAgent)
  const toggleEntry = useStore((s) => s.toggleEntry)
  const keys = useStore((s) => s.keys)
  const endpoints = useStore((s) => s.endpoints)
  const discoveredModels = useStore((s) => s.discoveredModels)
  const themeMode = useStore((s) => s.themeMode)

  const agent = spec.agents.find((a) => a.id === selectedId)
  const entryIds = resolveEntryIds(spec)
  const info = agent ? providerInfo(agent.provider) : undefined
  const missingKey = agent && agent.provider !== 'mock' && !keys[agent.provider]
  const missingEndpoint = agent ? !resolveEndpoint(agent.provider, endpoints) && agent.provider !== 'mock' : false
  // Models the endpoint actually reported win over the hardcoded suggestions.
  const modelOptions = agent ? discoveredModels[agent.provider] ?? info?.models ?? [] : []

  return (
    <Stack sx={{ height: '100%', overflow: 'hidden' }}>
      <Box sx={{ px: 2, pt: 2, pb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="subtitle2" sx={{ flex: 1, opacity: 0.7 }}>
          AGENTS · {spec.agents.length}
        </Typography>
        <Button size="small" startIcon={<AddRoundedIcon />} onClick={addAgent}>
          Add
        </Button>
      </Box>

      <Stack spacing={0.5} sx={{ px: 1.5, pb: 1.5, maxHeight: 190, overflowY: 'auto' }}>
        {spec.agents.map((a) => (
          <Paper
            key={a.id}
            elevation={0}
            onClick={() => select(a.id)}
            sx={{
              px: 1.25,
              py: 0.85,
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              cursor: 'pointer',
              border: '1px solid',
              borderColor: a.id === selectedId ? agentColor(a.hue, themeMode) : 'transparent',
              bgcolor: a.id === selectedId ? 'action.selected' : 'transparent',
              '&:hover': { bgcolor: 'action.hover' },
            }}
          >
            <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: agentColor(a.hue, themeMode) }} />
            <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>
              {a.name}
            </Typography>
            {entryIds.includes(a.id) && <BoltRoundedIcon sx={{ fontSize: 15, opacity: 0.6 }} />}
          </Paper>
        ))}
      </Stack>

      <Divider />

      {!agent && (
        <Box sx={{ p: 3, opacity: 0.6 }}>
          <Typography variant="body2">
            Select an agent to edit it. Drag from a node's right dot to another node's left dot to say
            who may speak to whom.
          </Typography>
        </Box>
      )}

      {agent && (
        <Stack spacing={2.25} sx={{ p: 2, overflowY: 'auto' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <TextField
              label="Name"
              value={agent.name}
              onChange={(e) => updateAgent(agent.id, { name: e.target.value })}
              fullWidth
            />
            <Tooltip title="Delete agent">
              <IconButton onClick={() => removeAgent(agent.id)} size="small">
                <DeleteOutlineRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>

          <TextField
            select
            label="Provider"
            value={agent.provider}
            onChange={(e) => {
              const provider = e.target.value as ProviderId
              const suggested = providerInfo(provider).models[0]
              updateAgent(agent.id, { provider, ...(suggested ? { model: suggested } : {}) })
            }}
            fullWidth
          >
            {PROVIDERS.map((p) => (
              <MenuItem key={p.id} value={p.id}>
                {p.label}
              </MenuItem>
            ))}
          </TextField>

          <Autocomplete
            freeSolo
            size="small"
            options={modelOptions}
            value={agent.model}
            onChange={(_, value) => updateAgent(agent.id, { model: value ?? '' })}
            onInputChange={(_, value) => updateAgent(agent.id, { model: value })}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Model"
                helperText={
                  missingEndpoint
                    ? 'No endpoint URL for this provider — open Providers'
                    : missingKey
                      ? `No ${info?.label} key set — open Providers`
                      : modelOptions.length > 0
                        ? `${modelOptions.length} suggestions, or type any model id`
                        : 'Free text: type any model id'
                }
                error={Boolean(missingKey || missingEndpoint)}
              />
            )}
          />

          <TextField
            label="System prompt"
            value={agent.systemPrompt}
            onChange={(e) => updateAgent(agent.id, { systemPrompt: e.target.value })}
            multiline
            minRows={5}
            fullWidth
          />

          <Box>
            <Typography variant="caption" sx={{ opacity: 0.7 }}>
              Temperature · {agent.temperature.toFixed(2)}
            </Typography>
            <Slider
              value={agent.temperature}
              min={0}
              max={1.5}
              step={0.05}
              size="small"
              onChange={(_, value) => updateAgent(agent.id, { temperature: value as number })}
            />
          </Box>

          <Box>
            <Typography variant="caption" sx={{ opacity: 0.7, display: 'block', mb: 0.75 }}>
              Colour
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
              {[262, 210, 168, 132, 48, 32, 4, 300].map((hue) => (
                <Box
                  key={hue}
                  onClick={() => updateAgent(agent.id, { hue })}
                  sx={{
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    cursor: 'pointer',
                    bgcolor: agentColor(hue, themeMode),
                    outline: agent.hue === hue ? '2px solid' : 'none',
                    outlineColor: 'text.primary',
                    outlineOffset: 2,
                  }}
                />
              ))}
            </Box>
          </Box>

          <Box>
            <Chip
              size="small"
              icon={<BoltRoundedIcon />}
              label={spec.entryIds.includes(agent.id) ? 'Receives the task' : 'Make it receive the task'}
              color={spec.entryIds.includes(agent.id) ? 'primary' : 'default'}
              variant={spec.entryIds.includes(agent.id) ? 'filled' : 'outlined'}
              onClick={() => toggleEntry(agent.id)}
            />
            <Typography variant="caption" sx={{ display: 'block', mt: 1, opacity: 0.6 }}>
              With none marked, every agent that has no incoming link starts the run.
            </Typography>
          </Box>
        </Stack>
      )}
    </Stack>
  )
}
