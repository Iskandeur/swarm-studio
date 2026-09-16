import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  InputAdornment,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@mui/material'
import SearchRoundedIcon from '@mui/icons-material/SearchRounded'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import LayersRoundedIcon from '@mui/icons-material/LayersRounded'
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded'
import { allBlocks, useGraph, useStore } from '../store'
import { nodesOf } from '../engine/graph'
import type { BlockDef, FlowNodeKind } from '../types'

type Listed = BlockDef & { source: 'swarm' | 'saved' | 'builtin' }

const SECTIONS: Array<{ source: Listed['source']; title: string; empty: string }> = [
  {
    source: 'swarm',
    title: 'In this swarm',
    empty: 'None yet. Inserting a block copies its definition here, so it travels with the swarm when you share it.',
  },
  {
    source: 'saved',
    title: 'Saved in this browser',
    empty: 'Nothing else saved here. Save a selection above to reuse it in other swarms.',
  },
  { source: 'builtin', title: 'Built in', empty: '' },
]

/** Singular and plural for each node kind, in the order a summary reads best. */
const NOUNS: Array<[FlowNodeKind, string, string]> = [
  ['condition', 'condition', 'conditions'],
  ['join', 'join', 'joins'],
  ['human', 'human gate', 'human gates'],
  ['memory', 'memory', 'memories'],
  ['block', 'block', 'blocks'],
  ['output', 'output', 'outputs'],
]

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * What is inside, in one line: enough to tell a critic loop from a debate without opening either.
 * "recursive" is only the direct case — a block node pointing at its own definition.
 */
function summarize(def: BlockDef): string {
  const nodes = nodesOf(def.graph)
  const parts: string[] = []
  if (def.graph.agents.length > 0) parts.push(count(def.graph.agents.length, 'agent', 'agents'))
  for (const [kind, one, many] of NOUNS) {
    const n = nodes.filter((node) => node.kind === kind).length
    if (n > 0) parts.push(count(n, one, many))
  }
  if (nodes.some((node) => node.kind === 'block' && node.blockId === def.id)) parts.push('recursive')
  return parts.length > 0 ? parts.join(' · ') : 'empty'
}

/**
 * The block library: every graph you can drop as one node, and the place to make a new one.
 *
 * Saving comes first in the dialog because it is the step people miss: a block is not something you
 * only receive, it is any part of your own swarm you want to reuse.
 */
export function BlockLibrary({ open, onClose }: { open: boolean; onClose: () => void }) {
  const spec = useStore((s) => s.spec)
  const library = useStore((s) => s.library)
  const multiIds = useStore((s) => s.multiIds)
  const selectedId = useStore((s) => s.selectedId)
  const insertBlock = useStore((s) => s.insertBlock)
  const saveBlock = useStore((s) => s.saveBlock)
  const deleteLibraryBlock = useStore((s) => s.deleteLibraryBlock)
  const openBlock = useStore((s) => s.openBlock)
  const graph = useGraph()
  const fullScreen = useMediaQuery('(max-width:899.95px)')

  const [query, setQuery] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saved, setSaved] = useState<string | null>(null)

  // A reopened library should not still be congratulating you for the last save.
  useEffect(() => {
    if (open) setSaved(null)
  }, [open])

  const blocks = useMemo(() => allBlocks(spec, library), [spec, library])
  const savedIds = useMemo(() => new Set(library.map((b) => b.id)), [library])

  /**
   * What "the selection" means, the same way everywhere: the agents ticked in the roster plus the
   * node selected on the canvas. Only ids of the graph on screen count — a ticked agent of the swarm
   * is not part of a block whose inside you are editing.
   */
  const names = new Map([...graph.agents, ...nodesOf(graph)].map((n) => [n.id, n.name]))
  const selection = [...new Set([...multiIds, ...(selectedId ? [selectedId] : [])])].filter((id) => names.has(id))

  const needle = query.trim().toLowerCase()
  const matching = needle
    ? blocks.filter((b) => `${b.name}\n${b.description}`.toLowerCase().includes(needle))
    : blocks

  const save = () => {
    const def = saveBlock(selection, name, description)
    if (!def) return
    setSaved(def.name)
    setName('')
    setDescription('')
  }

  /** `allBlocks` tags each entry with where it came from; that tag must not be copied into the swarm. */
  const definition = ({ source: _source, ...def }: Listed): BlockDef => def

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" fullScreen={fullScreen}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <LayersRoundedIcon fontSize="small" sx={{ opacity: 0.75 }} />
        Block library
      </DialogTitle>

      <DialogContent>
        <Typography variant="body2" sx={{ mb: 2, opacity: 0.75 }}>
          A block is a graph used as one node. Insert one to drop it on the canvas; open it to edit its
          inside — every instance of it changes with it.
        </Typography>

        <Paper elevation={0} sx={{ p: 1.5, mb: 2.5, border: '1px solid', borderColor: 'divider' }}>
          <Typography variant="subtitle2" sx={{ mb: 0.75 }}>
            Save selection as a block
          </Typography>
          {selection.length === 0 ? (
            <Typography variant="body2" sx={{ opacity: 0.65 }}>
              Nothing is selected. Tick agents in the roster, or select a node on the canvas.
            </Typography>
          ) : (
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 1.25 }}>
              <Typography variant="caption" sx={{ opacity: 0.65, mr: 0.5, alignSelf: 'center' }}>
                Takes {count(selection.length, 'node', 'nodes')}, and the links between them:
              </Typography>
              {selection.map((id) => (
                <Chip key={id} size="small" label={names.get(id)} sx={{ height: 22, fontSize: 11 }} />
              ))}
            </Box>
          )}
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 1 }}>
            <TextField
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={selection.length === 0}
              sx={{ flex: 1 }}
            />
            <TextField
              label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={selection.length === 0}
              placeholder="What it does — agents allowed to spawn it read this"
              sx={{ flex: 2 }}
            />
            <Button
              variant="contained"
              onClick={save}
              disabled={selection.length === 0 || name.trim() === ''}
              startIcon={<AddRoundedIcon />}
            >
              Save
            </Button>
          </Stack>
          {saved && (
            <Alert severity="success" sx={{ mt: 1.25 }} onClose={() => setSaved(null)}>
              Saved “{saved}”. It is in this swarm and in this browser, ready to drop anywhere.
            </Alert>
          )}
        </Paper>

        <TextField
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or description"
          fullWidth
          inputProps={{ 'aria-label': 'Search blocks' }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchRoundedIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
          sx={{ mb: 2 }}
        />

        {needle && matching.length === 0 && (
          <Typography variant="body2" sx={{ opacity: 0.6, mb: 2 }}>
            No block matches “{query.trim()}”.
          </Typography>
        )}

        {SECTIONS.map((section) => {
          const list = matching.filter((b) => b.source === section.source)
          // While searching, an empty section is noise; otherwise its hint says how to fill it.
          if (list.length === 0 && (needle || !section.empty)) return null
          return (
            <Box key={section.source} component="section" aria-label={section.title} sx={{ mb: 2.5 }}>
              <Typography variant="subtitle2" sx={{ opacity: 0.7, mb: 1 }}>
                {section.title} · {list.length}
              </Typography>
              {list.length === 0 ? (
                <Typography variant="body2" sx={{ opacity: 0.55 }}>
                  {section.empty}
                </Typography>
              ) : (
                <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
                  {list.map((block) => (
                    <BlockCard
                      key={block.id}
                      block={block}
                      summary={summarize(block)}
                      // Deletable wherever it is listed: a block you just saved also sits in this swarm,
                      // and would otherwise be listed only where no Delete is offered.
                      savedHere={savedIds.has(block.id)}
                      onInsert={() => {
                        insertBlock(definition(block))
                        onClose()
                      }}
                      onOpen={() => {
                        openBlock(block.id)
                        onClose()
                      }}
                      onDelete={() => deleteLibraryBlock(block.id)}
                    />
                  ))}
                </Box>
              )}
            </Box>
          )
        })}
      </DialogContent>

      <Divider />
      <DialogActions>
        <Button color="inherit" onClick={onClose}>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  )
}

function BlockCard({
  block,
  summary,
  savedHere,
  onInsert,
  onOpen,
  onDelete,
}: {
  block: Listed
  summary: string
  savedHere: boolean
  onInsert: () => void
  onOpen: () => void
  onDelete: () => void
}) {
  return (
    <Paper
      elevation={0}
      component="article"
      aria-label={block.name}
      sx={{ p: 1.5, border: '1px solid', borderColor: 'divider', display: 'flex', flexDirection: 'column', gap: 0.5 }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
        <Typography variant="subtitle2" sx={{ flex: 1 }}>
          {block.name}
        </Typography>
        {savedHere && block.source !== 'saved' && (
          <Chip size="small" variant="outlined" label="saved in this browser" sx={{ height: 18, fontSize: 10 }} />
        )}
      </Box>
      {block.description && (
        <Typography variant="body2" sx={{ opacity: 0.75, lineHeight: 1.5 }}>
          {block.description}
        </Typography>
      )}
      <Typography variant="caption" sx={{ opacity: 0.6 }}>
        {summary}
      </Typography>
      <Box sx={{ display: 'flex', gap: 0.75, mt: 'auto', pt: 0.75, flexWrap: 'wrap' }}>
        <Button size="small" variant="contained" onClick={onInsert} aria-label={`Insert ${block.name}`}>
          Insert
        </Button>
        <Button size="small" variant="outlined" onClick={onOpen} aria-label={`Open inside ${block.name}`}>
          Open inside
        </Button>
        {savedHere && (
          <Tooltip describeChild title="Removes it from this browser's library. Swarms that already use it keep their copy.">
            <Button
              size="small"
              color="error"
              onClick={onDelete}
              startIcon={<DeleteOutlineRoundedIcon />}
              aria-label={`Delete ${block.name}`}
              sx={{ ml: 'auto' }}
            >
              Delete
            </Button>
          </Tooltip>
        )}
      </Box>
    </Paper>
  )
}
