/**
 * Getting a run out of the app — for a human to read, and for a model to reason about.
 *
 * One markdown document serves both, and that is deliberate rather than lazy: what a model needs to
 * answer questions about a run is exactly what a person needs, namely who spoke, to whom, in which
 * round, under which configuration. So the markdown carries a **configuration header** — agents,
 * models, links, topology — because a transcript without its graph is a conversation with no shape,
 * and a model asked "why did the Narrator agree with everyone" cannot answer from the text alone.
 *
 * The JSON export is for tooling: same content, machine shape, stable keys.
 */
import type { SwarmSpec, TranscriptEntry } from '../types.ts'
import { DEFAULT_MAX_TOKENS } from './runner.ts'

export interface RunMeta {
  /** ISO timestamp, passed in rather than read: this module stays pure and testable. */
  exportedAt: string
  phase: string
  rounds: number
}

/** Agents first, then any other node, then what lives inside blocks: a nested entry's id is not the swarm's. */
const nameOf = (spec: SwarmSpec, id: string) =>
  spec.agents.find((a) => a.id === id)?.name ??
  (spec.nodes ?? []).find((n) => n.id === id)?.name ??
  (spec.blocks ?? []).flatMap((b) => [...b.graph.agents, ...(b.graph.nodes ?? [])]).find((n) => n.id === id)?.name ??
  id

/** Totals worth stating once at the top rather than making the reader add them up. */
export function summarise(transcript: TranscriptEntry[]) {
  let tokensIn = 0
  let tokensOut = 0
  let ms = 0
  for (const entry of transcript) {
    tokensIn += entry.tokensIn
    tokensOut += entry.tokensOut
    if (entry.endedAt) ms += entry.endedAt - entry.startedAt
  }
  return { messages: transcript.length, tokensIn, tokensOut, seconds: Math.round(ms / 100) / 10 }
}

export function toMarkdown(spec: SwarmSpec, transcript: TranscriptEntry[], meta: RunMeta): string {
  const totals = summarise(transcript)
  const out: string[] = []

  out.push(`# ${spec.name} — swarm run`)
  out.push('')
  out.push(`*Exported ${meta.exportedAt} · run ${meta.phase} · ${meta.rounds} round(s) · ${totals.messages} messages · ${totals.tokensIn} in / ${totals.tokensOut} out · ${totals.seconds}s of model time*`)
  out.push('')
  out.push(`**Task given to the entry agents:** ${spec.task.trim() || '(empty)'}`)
  out.push('')

  out.push('## Configuration')
  out.push('')
  out.push(`- **Topology:** ${spec.topology} · **max rounds:** ${spec.maxRounds}`)
  const entries = spec.entryIds.length > 0 ? spec.entryIds.map((id) => nameOf(spec, id)) : ['(every agent with no incoming link)']
  out.push(`- **Entry agents:** ${entries.join(', ')}`)
  out.push('')
  out.push('| Agent | Provider | Model | Temp | Max tokens |')
  out.push('| --- | --- | --- | --: | --: |')
  for (const agent of spec.agents) {
    out.push(`| ${agent.name} | ${agent.provider} | \`${agent.model || '(none)'}\` | ${agent.temperature} | ${agent.maxTokens ?? DEFAULT_MAX_TOKENS} |`)
  }
  out.push('')
  out.push('**Who may speak to whom:**')
  out.push('')
  if (spec.links.length === 0) out.push('- (no links: every agent speaks only when it is an entry point)')
  for (const link of spec.links) {
    out.push(`- ${nameOf(spec, link.source)} → ${nameOf(spec, link.target)}`)
  }
  out.push('')

  out.push('## Prompts')
  out.push('')
  for (const agent of spec.agents) {
    out.push(`### ${agent.name}`)
    out.push('')
    out.push('```')
    out.push(agent.systemPrompt.trim() || '(empty)')
    out.push('```')
    out.push('')
  }

  out.push('## Transcript')
  out.push('')
  if (transcript.length === 0) out.push('*(nothing was said)*')

  let round = -1
  for (const entry of transcript) {
    // Rounds inside a block restart at 1; only the swarm's own rounds make a heading.
    if (!entry.path?.length && entry.round !== round) {
      round = entry.round
      out.push(`### Round ${round}`)
      out.push('')
    }
    const who = entry.kind === 'human' ? 'YOU (human)' : entry.speaker ?? nameOf(spec, entry.agentId)
    const where = entry.path?.length ? ` *(inside ${entry.path.map((id) => nameOf(spec, id)).join(' › ')})*` : ''
    const to = entry.to.length > 0 ? ` → ${entry.to.map((id) => nameOf(spec, id)).join(', ')}` : ' → (swarm output)'
    const seconds = entry.endedAt ? ` · ${((entry.endedAt - entry.startedAt) / 1000).toFixed(1)}s` : ''
    const status = entry.status === 'complete' ? '' : ` · ${entry.status}`
    out.push(`**${who}**${to}${where}  `)
    out.push(`*${entry.tokensIn} in / ${entry.tokensOut} out${seconds}${status}*`)
    out.push('')
    // Quoted, so a model reading this cannot mistake an agent's words for an instruction to itself.
    for (const line of (entry.text.trim() || '(empty)').split('\n')) out.push(`> ${line}`)
    out.push('')
    if (entry.actions?.length) {
      for (const action of entry.actions) out.push(`- *${action.type}:* ${action.text}`)
      out.push('')
    }
  }

  return out.join('\n')
}

export function toJson(spec: SwarmSpec, transcript: TranscriptEntry[], meta: RunMeta): string {
  return JSON.stringify(
    {
      format: 'swarm-studio-run',
      version: 1,
      exportedAt: meta.exportedAt,
      phase: meta.phase,
      rounds: meta.rounds,
      totals: summarise(transcript),
      // The spec travels WITH the run: a transcript alone cannot answer "why did they all agree".
      // Keys and endpoints are absent here as everywhere else.
      swarm: {
        name: spec.name,
        task: spec.task,
        topology: spec.topology,
        maxRounds: spec.maxRounds,
        entryIds: spec.entryIds,
        agents: spec.agents,
        links: spec.links,
      },
      messages: transcript.map((entry) => ({
        id: entry.id,
        round: entry.round,
        from: entry.kind === 'human' ? 'human' : entry.speaker ?? nameOf(spec, entry.agentId),
        ...(entry.path?.length ? { inside: entry.path.map((id) => nameOf(spec, id)) } : {}),
        ...(entry.actions?.length ? { actions: entry.actions } : {}),
        fromId: entry.agentId,
        to: entry.to.map((id) => nameOf(spec, id)),
        status: entry.status,
        tokensIn: entry.tokensIn,
        tokensOut: entry.tokensOut,
        ms: entry.endedAt ? entry.endedAt - entry.startedAt : null,
        text: entry.text,
      })),
    },
    null,
    2,
  )
}

/** `the-cat-council-run.md` — a filename someone can find again in a downloads folder. */
export function exportFilename(spec: SwarmSpec, extension: 'md' | 'json'): string {
  const slug = spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'swarm'
  return `${slug}-run.${extension}`
}
