/**
 * Shared memory: the state of one Memory node during a run, how a reader sees it, how a write lands.
 *
 * Pure on purpose. The runner decides WHO may read and write (that is the graph's business, through
 * access links); this module only decides WHAT a read shows and WHAT a write changes.
 */
import type { MemoryEntry, MemoryNode } from '../types.ts'

export interface MemoryState {
  node: MemoryNode
  /** Every write, oldest first. Seed entries come first, with round 0. */
  entries: MemoryEntry[]
}

export function createMemoryState(node: MemoryNode): MemoryState {
  return { node, entries: node.seed.map((entry) => ({ ...entry, round: 0 })) }
}

/** Current value per key for a blackboard: the latest write wins, and carries its version. */
function currentByKey(state: MemoryState): MemoryEntry[] {
  const latest = new Map<string, MemoryEntry>()
  for (const entry of state.entries) latest.set(entry.key, entry)
  return [...latest.values()]
}

/** What a predicate or a reader gets for `key`. A log answers with its newest entry under that key. */
export function readValue(state: MemoryState, key: string): string | undefined {
  if (state.node.mode === 'document') return state.entries.at(-1)?.value
  const wanted = key.trim().toLowerCase()
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const entry = state.entries[i]
    if (entry.key.trim().toLowerCase() === wanted) return entry.value
  }
  return undefined
}

export interface WriteResult {
  ok: boolean
  entry?: MemoryEntry
  problem?: string
}

/**
 * Applies one write. A blackboard needs a key: a value with nowhere to live would silently become
 * unreachable by every predicate and every reader looking for it.
 */
export function applyWrite(
  state: MemoryState,
  write: { key?: string; value: string },
  author: string,
  round: number,
): WriteResult {
  const value = write.value.trim()
  if (!value) return { ok: false, problem: `empty write to ${state.node.name}` }
  const key = (write.key ?? '').trim()
  const mode = state.node.mode
  if (mode === 'blackboard' && !key) {
    return { ok: false, problem: `${state.node.name} is a blackboard: a write needs key="…"` }
  }
  let version = 1
  if (mode === 'document') version = (state.entries.at(-1)?.version ?? 0) + 1
  if (mode === 'blackboard') {
    const previous = [...state.entries].reverse().find((e) => e.key === key)
    version = (previous?.version ?? 0) + 1
  }
  if (mode === 'log') version = state.entries.length + 1
  const entry: MemoryEntry = { key: mode === 'document' ? '' : key, value, author, round, version }
  state.entries.push(entry)
  return { ok: true, entry }
}

const WORD = /[\p{L}\p{N}]{3,}/gu

function terms(text: string): Set<string> {
  return new Set((text.toLowerCase().match(WORD) ?? []))
}

/** How much an entry shares with what the reader is about to answer. Plain overlap, no embeddings. */
export function relevance(entryText: string, context: Set<string>): number {
  if (context.size === 0) return 0
  let score = 0
  for (const term of terms(entryText)) if (context.has(term)) score++
  return score
}

/**
 * The memory as one reader sees it this turn, within `maxChars`.
 *
 * When everything fits, the order is the natural one (latest first). When it does not, entries are
 * ranked by overlap with `context` — the messages the reader is about to answer — so the part of a
 * large knowledge base that concerns the question is what gets through. What is left out is counted,
 * never silently dropped: a reader told "14 more entries" knows the memory is bigger than its view.
 */
export function renderMemory(state: MemoryState, context: string): string {
  const { node } = state
  const budget = node.maxChars
  if (node.mode === 'document') {
    const current = state.entries.at(-1)
    if (!current) return '(empty document)'
    const footer = `\n(version ${current.version}, last edited by ${current.author})`
    const room = Math.max(0, budget - footer.length)
    const text = current.value.length > room ? `${current.value.slice(0, room)}… (truncated)` : current.value
    return text + footer
  }

  const items =
    node.mode === 'blackboard'
      ? currentByKey(state)
          .slice()
          .reverse()
          .map((e) => ({ entry: e, line: `- ${e.key}: ${e.value} (by ${e.author}, round ${e.round})` }))
      : state.entries
          .slice()
          .reverse()
          .map((e) => ({ entry: e, line: `- ${e.author} (round ${e.round}): ${e.key ? `${e.key}: ` : ''}${e.value}` }))
  if (items.length === 0) return '(empty)'

  const total = items.reduce((sum, item) => sum + item.line.length + 1, 0)
  if (total <= budget) return items.map((i) => i.line).join('\n')

  const wanted = terms(context)
  const ranked = items
    .map((item, index) => ({ ...item, index, score: relevance(`${item.entry.key} ${item.entry.value}`, wanted) }))
    // Highest overlap first; recency (the natural order) breaks ties.
    .sort((a, b) => b.score - a.score || a.index - b.index)
  const kept: typeof ranked = []
  let used = 0
  const reserve = 48
  for (const item of ranked) {
    const line = item.line.length > budget - reserve ? `${item.line.slice(0, budget - reserve)}…` : item.line
    if (used + line.length + 1 > budget - reserve) continue
    kept.push({ ...item, line })
    used += line.length + 1
  }
  // Shown back in natural order, so a log still reads as a log.
  kept.sort((a, b) => a.index - b.index)
  const hidden = items.length - kept.length
  const lines = kept.map((k) => k.line)
  if (hidden > 0) lines.push(`… ${hidden} more ${hidden === 1 ? 'entry' : 'entries'} not shown`)
  return lines.join('\n')
}
