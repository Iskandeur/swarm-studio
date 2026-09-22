import { useState } from 'react'
import {
  Autocomplete,
  Box,
  Button,
  Checkbox,
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
  useMediaQuery,
} from '@mui/material'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import CloseRoundedIcon from '@mui/icons-material/CloseRounded'
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded'
import BoltRoundedIcon from '@mui/icons-material/BoltRounded'
import LinkOffRoundedIcon from '@mui/icons-material/LinkOffRounded'
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded'
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded'
import PauseRoundedIcon from '@mui/icons-material/PauseRounded'
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded'
import StopRoundedIcon from '@mui/icons-material/StopRounded'
import { useGraph, useStore } from '../store'
import { nodesOf } from '../engine/graph'
import { AgentGraphSettings, LinkInspector, NodeInspector } from './NodeInspector'
import { modelForProvider, PROVIDERS, providerInfo, resolveEndpoint } from '../engine/providers'
import { DEFAULT_MAX_TOKENS, resolveEntryIds } from '../engine/runner'
import { agentColor } from '../theme'
import type { ProviderId } from '../types'

/** Names for the eight hues, so a colour swatch can be announced as something other than a number. */
const HUE_NAMES: Record<number, string> = {
  262: 'violet',
  210: 'blue',
  168: 'teal',
  132: 'green',
  48: 'amber',
  32: 'orange',
  4: 'red',
  300: 'magenta',
}

/** The Build panel: the agent roster, and everything about the one you selected. */
export function Inspector({ onClose }: { onClose?: () => void } = {}) {
  // The graph on the canvas: the swarm, or the inside of the block being edited.
  const spec = useGraph()
  const selectedId = useStore((s) => s.selectedId)
  const selectedLinkId = useStore((s) => s.selectedLinkId)
  const select = useStore((s) => s.select)
  const addAgent = useStore((s) => s.addAgent)
  const updateAgent = useStore((s) => s.updateAgent)
  const removeAgent = useStore((s) => s.removeAgent)
  const removeAgents = useStore((s) => s.removeAgents)
  const removeLink = useStore((s) => s.removeLink)
  const toggleEntry = useStore((s) => s.toggleEntry)
  const multiIds = useStore((s) => s.multiIds)
  const toggleMulti = useStore((s) => s.toggleMulti)
  const setMulti = useStore((s) => s.setMulti)
  const applyToAgents = useStore((s) => s.applyToAgents)
  const phase = useStore((s) => s.phase)
  const pause = useStore((s) => s.pause)
  const resume = useStore((s) => s.resume)
  const stop = useStore((s) => s.stop)
  const compact = useMediaQuery('(max-width:899.95px)')
  const [bulkModel, setBulkModel] = useState('')
  const keys = useStore((s) => s.keys)
  const endpoints = useStore((s) => s.endpoints)
  const discoveredModels = useStore((s) => s.discoveredModels)
  const themeMode = useStore((s) => s.themeMode)

  const agent = spec.agents.find((a) => a.id === selectedId)
  const flowNodes = nodesOf(spec)
  const flowNode = flowNodes.find((n) => n.id === selectedId)
  const link = selectedLinkId ? spec.links.find((l) => l.id === selectedLinkId) : undefined
  const entryIds = resolveEntryIds(spec)
  const info = agent ? providerInfo(agent.provider) : undefined
  const missingKey = agent && agent.provider !== 'mock' && !keys[agent.provider]
  const missingEndpoint = agent ? !resolveEndpoint(agent.provider, endpoints) && agent.provider !== 'mock' : false
  const nameOf = (id: string) => spec.agents.find((a) => a.id === id)?.name ?? flowNodes.find((n) => n.id === id)?.name ?? id
  /** Both directions, because "who can speak to me" is half of what a topology means. */
  const links = agent
    ? spec.links
        .filter((l) => l.source === agent.id || l.target === agent.id)
        .map((link) => ({
          link,
          outgoing: link.source === agent.id,
          other: nameOf(link.source === agent.id ? link.target : link.source),
        }))
    : []
  // Models the endpoint actually reported win over the hardcoded suggestions.
  const modelOptions = agent ? discoveredModels[agent.provider] ?? info?.models ?? [] : []
  /** For the bulk field: every model known across the providers the ticked agents actually use. */
  const bulkModelOptions = [
    ...new Set(
      spec.agents
        .filter((a) => multiIds.includes(a.id))
        .flatMap((a) => discoveredModels[a.provider] ?? providerInfo(a.provider).models),
    ),
  ].sort()

  return (
    <Stack sx={{ height: '100%', overflow: 'hidden' }}>
      <Box sx={{ px: 2, pt: 1.5, pb: 1, display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
        <Typography variant="overline" sx={{ flex: 1, color: 'text.secondary', lineHeight: 1.6 }}>
          Agents · {spec.agents.length}
        </Typography>
        {/* On a phone this panel is a modal sheet, so the bottom bar's Pause and Stop are behind it.
            A run you are watching from here has to be stoppable from here. */}
        {compact && (phase === 'running' || phase === 'paused') && (
          <>
            {phase === 'running' ? (
              <Tooltip title="Pause after the current round">
                <IconButton size="small" onClick={pause} aria-label="Pause the run">
                  <PauseRoundedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            ) : (
              <Tooltip title="Resume">
                <IconButton size="small" color="primary" onClick={resume} aria-label="Resume the run">
                  <PlayArrowRoundedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
            <Tooltip title="Stop the run">
              <IconButton size="small" color="error" onClick={stop} aria-label="Stop the run">
                <StopRoundedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </>
        )}
        <Button size="small" startIcon={<AddRoundedIcon />} onClick={addAgent}>
          Add
        </Button>
        {onClose && (
          <Tooltip title="Close">
            <IconButton size="small" onClick={onClose} aria-label="Close the build panel" sx={{ ml: 0.5 }}>
              <CloseRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Box>

      {/* flexShrink 0 on everything above the detail: in a column flex the roster was squeezed under
          its own content once the node list joined it, and the rows drew over each other. */}
      <Stack spacing={0.5} sx={{ px: 1.5, pb: 1.5, maxHeight: 190, overflowY: 'auto', flexShrink: 0 }}>
        {spec.agents.map((a) => (
          <Paper
            key={a.id}
            elevation={0}
            // Reachable by keyboard and announced by name: it was a click-only div, which means it
            // did not exist for anyone navigating with Tab or a screen reader.
            role="button"
            tabIndex={0}
            aria-label={`Select ${a.name}, model ${a.model || 'not set'}`}
            aria-pressed={a.id === selectedId}
            onClick={() => select(a.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                select(a.id)
              }
            }}
            sx={{
              px: 1.25,
              py: 0.5,
              '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              cursor: 'pointer',
              border: '1px solid',
              borderColor: a.id === selectedId ? agentColor(a.hue, themeMode) : 'transparent',
              bgcolor: a.id === selectedId ? 'action.selected' : 'transparent',
              '&:hover': { bgcolor: 'action.hover' },
            }}
          >
            <Checkbox
              size="small"
              checked={multiIds.includes(a.id)}
              onClick={(event) => event.stopPropagation()}
              onChange={() => toggleMulti(a.id)}
              inputProps={{ 'aria-label': `Select ${a.name} for bulk editing` }}
              sx={{ p: 0.5 }}
            />
            <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: agentColor(a.hue, themeMode) }} />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="body2" noWrap>
                {a.name}
              </Typography>
              {/* The model is shown here too: it is the first thing you look for, and reading it
                  should not require selecting the agent first. */}
              <Typography
                variant="caption"
                noWrap
                sx={{ display: 'block', opacity: 0.55, fontFamily: '"Roboto Mono", monospace', fontSize: 10.5 }}
              >
                {a.model || 'no model set'}
              </Typography>
            </Box>
            {entryIds.includes(a.id) && <BoltRoundedIcon sx={{ fontSize: 15, opacity: 0.6 }} />}
            <Tooltip title={`Delete ${a.name}`}>
              <IconButton
                size="small"
                aria-label={`Delete agent ${a.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  removeAgent(a.id)
                }}
                sx={{ p: 0.4, opacity: 0.45, '&:hover': { opacity: 1, color: 'error.main' } }}
              >
                <DeleteOutlineRoundedIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          </Paper>
        ))}
      </Stack>

      {/* Bulk edit. Without it, giving eight agents the same model means eight identical trips
          through the same three fields. */}
      {multiIds.length > 0 && (
        <Box sx={{ px: 2, pb: 2, flexShrink: 0 }}>
          <Paper
            elevation={0}
            sx={{ p: 1.5, border: '1px solid', borderColor: 'primary.main', bgcolor: 'action.hover' }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.25 }}>
              <Typography variant="subtitle2" sx={{ flex: 1 }}>
                {multiIds.length} selected
              </Typography>
              <Button size="small" onClick={() => setMulti(spec.agents.map((a) => a.id))}>
                All
              </Button>
              <Button size="small" color="inherit" onClick={() => setMulti([])}>
                Clear
              </Button>
            </Box>

            <Stack spacing={1.5}>
              <TextField
                select
                label="Provider for all selected"
                value=""
                onChange={(e) => {
                  const provider = e.target.value as ProviderId
                  // Per agent, because each one is carrying a different model into the switch.
                  for (const id of multiIds) {
                    const current = spec.agents.find((a) => a.id === id)
                    if (current) applyToAgents([id], { provider, model: modelForProvider(provider, current.model) })
                  }
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
                options={bulkModelOptions}
                value={bulkModel}
                onChange={(_, value) => setBulkModel(value ?? '')}
                onInputChange={(_, value) => setBulkModel(value)}
                renderInput={(params) => <TextField {...params} label="Model for all selected" />}
              />
              <Button
                size="small"
                variant="contained"
                disabled={bulkModel.trim() === ''}
                onClick={() => applyToAgents(multiIds, { model: bulkModel.trim() })}
              >
                Apply model to {multiIds.length}
              </Button>

              <Button
                size="small"
                color="error"
                startIcon={<DeleteOutlineRoundedIcon />}
                onClick={() => removeAgents(multiIds)}
              >
                Delete {multiIds.length} agents
              </Button>
            </Stack>
          </Paper>
        </Box>
      )}

      {flowNodes.length > 0 && (
        <>
          <Typography variant="overline" sx={{ px: 2, pb: 0.5, color: 'text.secondary', flexShrink: 0, lineHeight: 1.6 }}>
            Nodes · {flowNodes.length}
          </Typography>
          <Stack direction="row" spacing={0.5} useFlexGap sx={{ px: 1.5, pb: 1.5, flexWrap: 'wrap', maxHeight: 96, overflowY: 'auto', flexShrink: 0 }}>
            {flowNodes.map((n) => (
              <Chip
                key={n.id}
                size="small"
                label={`${n.name} · ${n.kind}`}
                variant={n.id === selectedId ? 'filled' : 'outlined'}
                onClick={() => select(n.id)}
                sx={{ height: 22, fontSize: 11 }}
              />
            ))}
          </Stack>
        </>
      )}

      <Divider />

      {link && (
        <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <LinkInspector linkId={link.id} />
        </Box>
      )}

      {!link && flowNode && (
        <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <NodeInspector nodeId={flowNode.id} />
        </Box>
      )}

      {!link && !agent && !flowNode && (
        <Box sx={{ p: 3, color: 'text.secondary' }}>
          <Typography variant="body2">
            Pick an agent above to set its <b>model</b>, provider and system prompt.
          </Typography>
          <Typography variant="body2" sx={{ mt: 1.5 }}>
            To link agents, drag from a node's right dot onto another node's left dot. Click a link to
            give it a label, a condition or a loop budget; the ✕ on the curve cuts it.
          </Typography>
          <Typography variant="body2" sx={{ mt: 1.5 }}>
            Or skip the clicking: describe the swarm in the bar below and a model builds it.
          </Typography>
        </Box>
      )}

      {!link && agent && (
        <Stack spacing={2.25} sx={{ p: 2, overflowY: 'auto', flex: 1, minHeight: 0 }}>
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
              updateAgent(agent.id, { provider, model: modelForProvider(provider, agent.model) })
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
                  agent.model.trim() === ''
                    ? 'No model set — this run would fail'
                    : missingEndpoint
                      ? 'No endpoint URL for this provider — open Providers'
                      : missingKey
                      ? `No ${info?.label} key set — open Providers`
                      : modelOptions.length > 0
                        ? `${modelOptions.length} suggestions, or type any model id`
                        : 'Free text: type any model id'
                }
                error={Boolean(missingKey || missingEndpoint || agent.model.trim() === '')}
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

          {/* The real brake on verbosity. Asking for "one short paragraph" in the prompt is a
              suggestion a model can ignore, and it did: a run produced 1 554 tokens of bullet lists. */}
          <TextField
            label="Max tokens"
            type="number"
            value={agent.maxTokens ?? DEFAULT_MAX_TOKENS}
            onChange={(e) =>
              updateAgent(agent.id, { maxTokens: Math.max(1, Math.floor(Number(e.target.value) || DEFAULT_MAX_TOKENS)) })
            }
            inputProps={{ min: 1, step: 20, inputMode: 'numeric' }}
            helperText="Hard ceiling on this agent's answer"
            fullWidth
          />

          <Box>
            <Typography variant="caption" sx={{ opacity: 0.7, display: 'block', mb: 0.75 }}>
              Colour
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
              {[262, 210, 168, 132, 48, 32, 4, 300].map((hue) => (
                <Box
                  key={hue}
                  component="button"
                  type="button"
                  // A real button, with a name: the swatches were bare divs, invisible to Tab and
                  // unnamed to a screen reader. 28px so a fingertip can hit one.
                  aria-label={`Colour ${HUE_NAMES[hue] ?? hue}`}
                  aria-pressed={agent.hue === hue}
                  onClick={() => updateAgent(agent.id, { hue })}
                  sx={{
                    width: 28,
                    height: 28,
                    p: 0,
                    border: 'none',
                    borderRadius: '50%',
                    cursor: 'pointer',
                    bgcolor: agentColor(hue, themeMode),
                    outline: agent.hue === hue ? '2px solid' : 'none',
                    outlineColor: 'text.primary',
                    outlineOffset: 2,
                    '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 3 },
                  }}
                />
              ))}
            </Box>
          </Box>

          <Box>
            <Typography variant="caption" sx={{ opacity: 0.7, display: 'block', mb: 0.75 }}>
              Links · {links.length}
            </Typography>
            {links.length === 0 && (
              <Typography variant="caption" sx={{ opacity: 0.55 }}>
                None yet. Drag from this node's right dot onto another node.
              </Typography>
            )}
            <Stack spacing={0.5}>
              {links.map(({ link, other, outgoing }) => (
                <Box key={link.id} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                  {outgoing ? (
                    <ArrowForwardRoundedIcon sx={{ fontSize: 15, opacity: 0.6 }} />
                  ) : (
                    <ArrowBackRoundedIcon sx={{ fontSize: 15, opacity: 0.6 }} />
                  )}
                  <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>
                    {other}
                  </Typography>
                  <Tooltip title="Cut this link">
                    <IconButton size="small" aria-label={`Cut link to ${other}`} onClick={() => removeLink(link.id)}>
                      <LinkOffRoundedIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                </Box>
              ))}
            </Stack>
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

          <Divider />
          <AgentGraphSettings agentId={agent.id} />
        </Stack>
      )}
    </Stack>
  )
}
