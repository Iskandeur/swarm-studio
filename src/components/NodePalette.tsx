import type { ReactNode } from 'react'
import { Alert, Box, Button, IconButton, Paper, Stack, Tooltip, Typography } from '@mui/material'
import SmartToyRoundedIcon from '@mui/icons-material/SmartToyRounded'
import AltRouteRoundedIcon from '@mui/icons-material/AltRouteRounded'
import RuleRoundedIcon from '@mui/icons-material/RuleRounded'
import MergeTypeRoundedIcon from '@mui/icons-material/MergeTypeRounded'
import FlagRoundedIcon from '@mui/icons-material/FlagRounded'
import PanToolRoundedIcon from '@mui/icons-material/PanToolRounded'
import StorageRoundedIcon from '@mui/icons-material/StorageRounded'
import LayersRoundedIcon from '@mui/icons-material/LayersRounded'
import PushPinRoundedIcon from '@mui/icons-material/PushPinRounded'
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded'
import { useStore } from '../store'
import type { FlowNodeKind } from '../types'

interface Item {
  id: 'agent' | Exclude<FlowNodeKind, 'block'> | 'block'
  label: string
  /** The accessible name, the same in both layouts, so a test or a screen reader finds one thing. */
  aria: string
  /** What it DOES, not what it is called: the palette is where someone meets these kinds first. */
  hint: string
  icon: ReactNode
}

const ITEMS: Item[] = [
  {
    id: 'agent',
    label: 'Agent',
    aria: 'Add an agent',
    hint: 'A model with a prompt: it reads what reaches it and answers.',
    icon: <SmartToyRoundedIcon fontSize="small" />,
  },
  {
    id: 'condition',
    label: 'Condition',
    aria: 'Add a condition',
    hint: 'Sends a message down its true or its false link. Costs no tokens.',
    icon: <AltRouteRoundedIcon fontSize="small" />,
  },
  {
    id: 'decision',
    label: 'Decision',
    aria: 'Add a decision',
    hint: 'A typed decision model (Jev): answers choice, yes/no and score questions, and links route on the answers.',
    icon: <RuleRoundedIcon fontSize="small" />,
  },
  {
    id: 'join',
    label: 'Join',
    aria: 'Add a join',
    hint: 'Waits for every incoming branch, then passes one combined message on.',
    icon: <MergeTypeRoundedIcon fontSize="small" />,
  },
  {
    id: 'output',
    label: 'Output',
    aria: 'Add an output',
    hint: 'Marks what reaches it as a result of the graph. Nothing leaves it.',
    icon: <FlagRoundedIcon fontSize="small" />,
  },
  {
    id: 'human',
    label: 'Human gate',
    aria: 'Add a human gate',
    hint: 'Holds the run until you approve, reject or edit what reached it.',
    icon: <PanToolRoundedIcon fontSize="small" />,
  },
  {
    id: 'memory',
    label: 'Memory',
    aria: 'Add a memory',
    hint: 'Knowledge agents share: a blackboard, a log, or a document they write together.',
    icon: <StorageRoundedIcon fontSize="small" />,
  },
  {
    id: 'block',
    label: 'Block',
    aria: 'Add a block',
    hint: 'A saved graph used as one node. Opens the library.',
    icon: <LayersRoundedIcon fontSize="small" />,
  },
]

/**
 * Everything that can be put on the canvas, in one place.
 *
 * `compact` is the phone layout: a bare row of icons. Desktop gets the same row on a paper, with each
 * name in its tooltip.
 */
export function NodePalette({ onOpenLibrary, compact = false }: { onOpenLibrary: () => void; compact?: boolean }) {
  const addAgent = useStore((s) => s.addAgent)
  const addNode = useStore((s) => s.addNode)
  const keepSpawned = useStore((s) => s.keepSpawned)
  const openBlock = useStore((s) => s.openBlock)
  const editingBlockId = useStore((s) => s.editingBlockId)
  const blockName = useStore((s) => s.spec.blocks?.find((b) => b.id === s.editingBlockId)?.name)
  const spawned = useStore((s) => s.runGraph.agents.length + s.runGraph.nodes.length)
  const phase = useStore((s) => s.phase)

  const add = (item: Item) => {
    if (item.id === 'agent') addAgent()
    else if (item.id === 'block') onOpenLibrary()
    else addNode(item.id)
  }

  // Offered only once the run stops moving: keeping helpers mid-run would copy a structure that is
  // still growing, and the copy would silently miss whatever is spawned next.
  const keep =
    spawned > 0 && phase !== 'running' ? (
      <Tooltip describeChild title="Copy the helpers this run spawned into the swarm, as ordinary agents you can edit">
        <Button
          size="small"
          variant="outlined"
          color="secondary"
          onClick={() => keepSpawned()}
          startIcon={<PushPinRoundedIcon fontSize="small" />}
          sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}
        >
          Keep {spawned} spawned
        </Button>
      </Tooltip>
    ) : null

  // Editing a block edits its definition, which every instance shares. That is easy to forget one
  // screen deep, and costly: the change shows up in places you are not looking at.
  const banner = editingBlockId ? (
    <Alert
      severity="info"
      icon={<LayersRoundedIcon fontSize="small" />}
      sx={{ py: 0, px: 1.25, alignItems: 'center', '& .MuiAlert-message': { py: 0.75 } }}
      action={
        <Button
          size="small"
          color="inherit"
          onClick={() => openBlock(undefined)}
          startIcon={<ArrowBackRoundedIcon fontSize="small" />}
          sx={{ whiteSpace: 'nowrap' }}
        >
          Back to swarm
        </Button>
      }
    >
      <Typography variant="body2" sx={{ lineHeight: 1.35 }}>
        Editing a block — changes apply to every instance
      </Typography>
      {blockName && (
        <Typography variant="caption" sx={{ opacity: 0.75, fontWeight: 600 }}>
          {blockName}
        </Typography>
      )}
    </Alert>
  ) : null

  if (compact) {
    return (
      <Stack spacing={0.75} sx={{ minWidth: 0 }}>
        {banner}
        <Box
          role="toolbar"
          aria-label="Add to the canvas"
          sx={{ display: 'flex', alignItems: 'center', gap: 0.25, overflowX: 'auto', flexWrap: 'nowrap' }}
        >
          {ITEMS.map((item) => (
            <Tooltip key={item.id} describeChild title={`${item.label}: ${item.hint}`}>
              <IconButton onClick={() => add(item)} aria-label={item.aria} sx={{ flexShrink: 0 }}>
                {item.icon}
              </IconButton>
            </Tooltip>
          ))}
          {keep && <Box sx={{ ml: 'auto', pl: 0.5 }}>{keep}</Box>}
        </Box>
      </Stack>
    )
  }

  // Desktop: one row too, on a paper so it reads over the graph. The first version was a column of
  // labelled buttons, and a real screenshot showed it: it covered a third of the canvas height and
  // the graph it sits on shrank to fit around it. The names live in the tooltips.
  return (
    <Stack spacing={0.75} sx={{ minWidth: 0 }}>
      {banner}
      <Paper
        elevation={0}
        role="toolbar"
        aria-label="Add to the canvas"
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.25,
          pl: 1.25,
          pr: 0.5,
          py: 0.25,
          borderRadius: 5,
          border: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.paper',
          width: 'fit-content',
        }}
      >
        <Typography variant="caption" sx={{ opacity: 0.6, fontWeight: 600, letterSpacing: 0.8, mr: 0.5 }}>
          ADD
        </Typography>
        {ITEMS.map((item) => (
          <Tooltip key={item.id} describeChild title={`${item.label}: ${item.hint}`}>
            <IconButton size="small" onClick={() => add(item)} aria-label={item.aria}>
              {item.icon}
            </IconButton>
          </Tooltip>
        ))}
        {keep && <Box sx={{ ml: 0.5 }}>{keep}</Box>}
      </Paper>
    </Stack>
  )
}
