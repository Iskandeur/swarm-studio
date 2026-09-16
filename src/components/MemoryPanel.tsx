import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  Button,
  Chip,
  Divider,
  FormControlLabel,
  Paper,
  Slider,
  Stack,
  Switch,
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from '@mui/material'
import PodcastsRoundedIcon from '@mui/icons-material/PodcastsRounded'
import StorageRoundedIcon from '@mui/icons-material/StorageRounded'
import { useGraph, useStore } from '../store'
import { agentColor, agentGlow } from '../theme'
import { nodesOf } from '../engine/graph'
import { RichText } from './RichText'
import type { MemoryEntry, MemoryNode } from '../types'

const MONO = '"Roboto Mono", monospace'

/** An entry with its place in the write order, which is what "newest", "latest" and "fresh" are measured on. */
interface Indexed {
  entry: MemoryEntry
  index: number
}

/**
 * The shared memories of the graph on the canvas, as they are right now.
 *
 * The point is to watch agents share knowledge while a run goes: a write shows up here the moment
 * the engine reports it, highlighted, in its author's colour — so "who told whom what" is readable
 * even between agents that never exchange a message.
 */
export function MemoryPanel() {
  const graph = useGraph()
  const editingBlockId = useStore((s) => s.editingBlockId)
  const memoryEntries = useStore((s) => s.memoryEntries)
  const selectedId = useStore((s) => s.selectedId)
  const [tab, setTab] = useState<string>()

  const memories = useMemo(() => nodesOf(graph).filter((n): n is MemoryNode => n.kind === 'memory'), [graph])

  // Selecting a memory on the canvas is a way of asking about it: its tab comes forward.
  useEffect(() => {
    if (selectedId && memories.some((m) => m.id === selectedId)) setTab(selectedId)
  }, [selectedId, memories])

  const active = memories.find((m) => m.id === tab) ?? memories[0]

  return (
    <Stack sx={{ height: '100%', overflow: 'hidden' }}>
      <Box sx={{ px: 2, pt: 2, pb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="subtitle2" sx={{ opacity: 0.7, flex: 1 }}>
          MEMORY · {memories.length}
        </Typography>
      </Box>

      {memories.length > 1 && (
        <Tabs
          value={active?.id ?? false}
          onChange={(_, value: string) => setTab(value)}
          variant="scrollable"
          scrollButtons="auto"
          sx={{ px: 1, minHeight: 36 }}
        >
          {memories.map((memory) => (
            <Tab key={memory.id} value={memory.id} label={memory.name} sx={{ minHeight: 36, py: 0.5, fontSize: 12.5 }} />
          ))}
        </Tabs>
      )}
      <Divider />

      <Box sx={{ p: 1.5, overflowY: 'auto', flex: 1 }}>
        {active ? (
          <MemorySection
            // Keyed so switching tabs starts a fresh section: nothing already there flashes as "new".
            key={active.id}
            memory={active}
            // Live entries are the TOP-LEVEL memories'. Inside a block each nested run has its own private
            // copy, and a block's ids may even collide with top-level ones, so only the seed is true here.
            live={editingBlockId ? undefined : memoryEntries[active.id]}
            insideBlock={Boolean(editingBlockId)}
          />
        ) : (
          <EmptyState />
        )}
      </Box>
    </Stack>
  )
}

function EmptyState() {
  return (
    <Box sx={{ p: 1.5, opacity: 0.75 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <StorageRoundedIcon fontSize="small" sx={{ opacity: 0.7 }} />
        <Typography variant="subtitle2">No memory in this graph yet</Typography>
      </Box>
      <Typography variant="body2" sx={{ mb: 1, lineHeight: 1.6 }}>
        A memory is knowledge the agents share instead of passing it in messages: a blackboard of keys, a
        log that can wake its readers like a bus, or a document they write together.
      </Typography>
      <Typography variant="body2" sx={{ lineHeight: 1.6 }}>
        Add a Memory node from the palette, then draw agent → memory to write and memory → agent to read.
      </Typography>
    </Box>
  )
}

/**
 * What the engine holds for this memory.
 *
 * `memoryEntries` only receives WRITES — the engine starts every memory from its seed (stamped round
 * 0) and reports what agents add. Showing the writes alone would hide seeded keys that every reader
 * still sees, and make a first overwrite look like "v2" of nothing. So the seed is put back in front,
 * unless the live list already carries it (round 0 is never a turn, only a seed).
 */
function entriesOf(memory: MemoryNode, live: MemoryEntry[] | undefined): { entries: MemoryEntry[]; seedOnly: boolean } {
  const seed = memory.seed.map((entry) => ({ ...entry, round: 0 }))
  if (!live) return { entries: seed, seedOnly: true }
  if (live.some((entry) => entry.round === 0)) return { entries: live, seedOnly: false }
  return { entries: [...seed, ...live], seedOnly: false }
}

/**
 * The write index from which an entry counts as new, for the arrival highlight.
 *
 * Fixed at mount, so what was already there when you opened the panel does not flash. Lowered when
 * the list shrinks (a new run cleared it), otherwise the next run's first writes would sit below an
 * old high-water mark and arrive unannounced.
 */
function useFreshFrom(length: number): number {
  const baseline = useRef(length)
  if (length < baseline.current) baseline.current = length
  return baseline.current
}

function MemorySection({ memory, live, insideBlock }: { memory: MemoryNode; live?: MemoryEntry[]; insideBlock: boolean }) {
  const { entries, seedOnly } = entriesOf(memory, live)
  const freshFrom = useFreshFrom(entries.length)
  const indexed: Indexed[] = entries.map((entry, index) => ({ entry, index }))

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.5, flexWrap: 'wrap' }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, lineHeight: 1.3 }}>
          {memory.name}
        </Typography>
        <Chip size="small" label={memory.mode} variant="outlined" sx={{ height: 20, fontSize: 11 }} />
        {memory.wakeReaders && (
          <Tooltip title="Bus: every write wakes each reader next round">
            {/* The icon itself is aria-hidden by MUI; the span carries the meaning for a screen reader. */}
            <Box component="span" role="img" aria-label="Bus: every write wakes each reader next round" sx={{ display: 'inline-flex' }}>
              <PodcastsRoundedIcon sx={{ fontSize: 17, opacity: 0.7 }} />
            </Box>
          </Tooltip>
        )}
      </Box>

      {seedOnly && entries.length > 0 && (
        <Typography variant="caption" component="div" sx={{ opacity: 0.6, mb: 1 }}>
          seed — before the run
        </Typography>
      )}
      {insideBlock && (
        <Typography variant="caption" component="div" sx={{ opacity: 0.6, mb: 1 }}>
          Inside a block, each run keeps a private copy of this memory, so only its seed is shown here.
        </Typography>
      )}

      {entries.length === 0 ? (
        <Typography variant="body2" sx={{ py: 1, opacity: 0.55 }}>
          Empty. Nothing was seeded, and no agent has written here yet.
        </Typography>
      ) : memory.mode === 'blackboard' ? (
        <BlackboardView items={indexed} freshFrom={freshFrom} />
      ) : memory.mode === 'log' ? (
        <LogView items={indexed} freshFrom={freshFrom} />
      ) : (
        <DocumentView items={indexed} freshFrom={freshFrom} />
      )}
    </Box>
  )
}

/**
 * The author's colour. Spawned helpers write too, and they live in the run graph, not the spec, so
 * both are searched; anything else (the seed, a name from inside a block) stays neutral rather than
 * borrowing a hue that belongs to someone.
 */
function useAuthorHue(): (author: string) => number | undefined {
  const graph = useGraph()
  const spawned = useStore((s) => s.runGraph.agents)
  return (author) => (graph.agents.find((a) => a.name === author) ?? spawned.find((a) => a.name === author))?.hue
}

/** A short highlight when an entry arrives, so a write is visible while you watch the run. */
function arrival(hue: number | undefined, fresh: boolean) {
  if (!fresh) return {}
  const from = hue === undefined ? 'rgba(128,128,128,0.28)' : agentGlow(hue, 0.35)
  return {
    animation: 'memory-arrive 1.8s ease-out',
    '@keyframes memory-arrive': { from: { backgroundColor: from }, to: { backgroundColor: 'transparent' } },
    '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
  }
}

function EntryRow({ item, fresh, showKey }: { item: Indexed; fresh: boolean; showKey: boolean }) {
  const hueOf = useAuthorHue()
  const themeMode = useStore((s) => s.themeMode)
  const { entry } = item
  const hue = hueOf(entry.author)
  return (
    <Box
      data-fresh={fresh || undefined}
      sx={{
        px: 1.25,
        py: 0.75,
        borderRadius: 1,
        borderLeft: '3px solid',
        borderLeftColor: hue === undefined ? 'divider' : agentColor(hue, themeMode),
        ...arrival(hue, fresh),
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, flexWrap: 'wrap', mb: 0.25 }}>
        {showKey && entry.key && (
          <Typography variant="body2" sx={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 600 }}>
            {entry.key}
          </Typography>
        )}
        <Typography
          variant="caption"
          sx={{ fontWeight: 700, color: hue === undefined ? 'text.secondary' : agentColor(hue, themeMode) }}
        >
          {entry.author}
        </Typography>
        <Typography variant="caption" sx={{ opacity: 0.55 }}>
          round {entry.round}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" sx={{ opacity: 0.45, fontFamily: MONO, fontSize: 10.5 }}>
          v{entry.version}
        </Typography>
      </Box>
      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.55 }}>
        {entry.value}
      </Typography>
    </Box>
  )
}

/**
 * A blackboard is read by key: what matters is the value NOW, as a reader gets it. The overwritten
 * values are still worth seeing — a key that flipped three times is a disagreement — so they are one
 * toggle away rather than mixed into the current state.
 */
function BlackboardView({ items, freshFrom }: { items: Indexed[]; freshFrom: number }) {
  const [history, setHistory] = useState(false)
  // Latest write per key, exactly as the engine keys it; newest update first.
  const latest = new Map<string, Indexed>()
  for (const item of items) latest.set(item.entry.key, item)
  const current = [...latest.values()].sort((a, b) => b.index - a.index)
  const shown = history ? [...items].reverse() : current
  const overwritten = items.length - current.length

  return (
    <Stack spacing={0.75}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="caption" sx={{ opacity: 0.6, flex: 1 }}>
          {current.length} {current.length === 1 ? 'key' : 'keys'} · {items.length} {items.length === 1 ? 'write' : 'writes'}
        </Typography>
        <FormControlLabel
          control={<Switch size="small" checked={history} onChange={(e) => setHistory(e.target.checked)} />}
          label={<Typography variant="caption">Show history</Typography>}
          disabled={overwritten === 0}
          sx={{ mr: 0 }}
        />
      </Box>
      {shown.map((item) => (
        // Keyed by write, not by key: an overwrite is a new row, so its arrival highlight plays.
        <EntryRow key={`${item.entry.key}#${item.index}`} item={item} fresh={item.index >= freshFrom} showKey />
      ))}
    </Stack>
  )
}

function LogView({ items, freshFrom }: { items: Indexed[]; freshFrom: number }) {
  return (
    <Stack spacing={0.75}>
      <Typography variant="caption" sx={{ opacity: 0.6 }}>
        {items.length} {items.length === 1 ? 'entry' : 'entries'}, newest first
      </Typography>
      {[...items].reverse().map((item) => (
        <LogRow key={item.index} item={item} fresh={item.index >= freshFrom} />
      ))}
    </Stack>
  )
}

function LogRow({ item, fresh }: { item: Indexed; fresh: boolean }) {
  const hueOf = useAuthorHue()
  const themeMode = useStore((s) => s.themeMode)
  const { entry } = item
  const hue = hueOf(entry.author)
  return (
    <Box
      data-fresh={fresh || undefined}
      sx={{
        px: 1.25,
        py: 0.75,
        borderRadius: 1,
        borderLeft: '3px solid',
        borderLeftColor: hue === undefined ? 'divider' : agentColor(hue, themeMode),
        ...arrival(hue, fresh),
      }}
    >
      <Typography variant="caption" component="div" sx={{ mb: 0.25 }}>
        <Box component="span" sx={{ fontWeight: 700, color: hue === undefined ? 'text.secondary' : agentColor(hue, themeMode) }}>
          {entry.author}
        </Box>
        <Box component="span" sx={{ opacity: 0.55 }}>
          {' · '}round {entry.round}
        </Box>
      </Typography>
      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.55 }}>
        {entry.key && (
          <Box component="span" sx={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 600, mr: 0.75 }}>
            {entry.key}:
          </Box>
        )}
        {entry.value}
      </Typography>
    </Box>
  )
}

/**
 * A document is one text rewritten in turns: every entry is a whole version. The latest is what a
 * reader gets; the slider is there because "what did the critic's rewrite change" is the question.
 */
function DocumentView({ items, freshFrom }: { items: Indexed[]; freshFrom: number }) {
  const hueOf = useAuthorHue()
  const themeMode = useStore((s) => s.themeMode)
  // `null` = follow the latest, so a new version replaces the view while you watch; a picked index
  // stays put, so reading an old version is not yanked away by the next write.
  const [picked, setPicked] = useState<number | null>(null)
  const last = items.length - 1
  const position = picked === null ? last : Math.min(picked, last)
  const item = items[position]
  const { entry } = item
  const hue = hueOf(entry.author)
  const latest = position === last

  return (
    <Stack spacing={1}>
      <Paper
        // Re-keyed per version, so a new one plays its arrival highlight.
        key={item.index}
        elevation={0}
        data-fresh={item.index >= freshFrom || undefined}
        sx={{
          p: 1.5,
          border: '1px solid',
          borderColor: 'divider',
          borderLeft: '3px solid',
          borderLeftColor: hue === undefined ? 'divider' : agentColor(hue, themeMode),
          ...arrival(hue, item.index >= freshFrom),
        }}
      >
        <RichText source={entry.value} />
      </Paper>

      <Typography variant="caption" sx={{ opacity: 0.7 }}>
        version {entry.version}, last edited by{' '}
        <Box component="span" sx={{ fontWeight: 700, color: hue === undefined ? 'text.secondary' : agentColor(hue, themeMode) }}>
          {entry.author}
        </Box>
        {' · '}round {entry.round}
      </Typography>

      {items.length > 1 && (
        <Box sx={{ px: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="caption" sx={{ opacity: 0.6, flex: 1 }}>
              {latest ? `${items.length} versions — showing the latest` : `An earlier version — ${last - position} newer`}
            </Typography>
            {!latest && (
              <Button size="small" onClick={() => setPicked(null)} sx={{ py: 0, minWidth: 0, fontSize: 12 }}>
                Latest
              </Button>
            )}
          </Box>
          <Slider
            size="small"
            min={0}
            max={last}
            step={1}
            marks
            value={position}
            onChange={(_, value) => {
              const next = value as number
              setPicked(next === last ? null : next)
            }}
            valueLabelDisplay="auto"
            valueLabelFormat={(value) => `v${items[value]?.entry.version ?? value + 1}`}
            getAriaValueText={(value) => `version ${items[value]?.entry.version ?? value + 1}`}
            aria-label="Document version"
          />
        </Box>
      )}
    </Stack>
  )
}
