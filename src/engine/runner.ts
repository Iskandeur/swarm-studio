/**
 * The swarm engine.
 *
 * One round = every currently-active agent speaks (in parallel), then each message is
 * handed to the agents its author is allowed to speak to. Those become the next round's
 * active set. The run ends when nobody is left to speak or `maxRounds` is reached.
 *
 * Everything the UI animates comes out of the callbacks below, so the visualisation is
 * never guessing: it draws exactly what the engine did.
 */
import type { Agent, AgentStatus, SwarmSpec, TranscriptEntry } from '../types.ts'
import { callProvider, estimateTokens, resolveEndpoint, type ChatMessage, type Endpoints } from './providers.ts'

export interface RunnerCallbacks {
  onPhase: (phase: 'running' | 'done' | 'error' | 'stopped', detail?: string) => void
  onRound: (round: number) => void
  onAgentStatus: (agentId: string, status: AgentStatus) => void
  onMessageStart: (entry: TranscriptEntry) => void
  onMessageDelta: (entryId: string, delta: string) => void
  onMessageEnd: (entryId: string, patch: Partial<TranscriptEntry>) => void
  /** A message travelling along these links, for the flight animation. */
  onTransit: (linkIds: string[]) => void
}

export type ApiKeys = Partial<Record<string, string>>

/** One agent's completed turn: what it said, and which links carry it onwards. */
interface Turn {
  agent: Agent
  text: string
  targets: Array<{ id: string; target: string }>
}

/** Agents that receive the task: the explicit entry list, or every root of the graph. */
export function resolveEntryIds(spec: SwarmSpec): string[] {
  if (spec.entryIds.length > 0) return spec.entryIds.filter((id) => spec.agents.some((a) => a.id === id))
  const hasIncoming = new Set(spec.links.map((l) => l.target))
  const roots = spec.agents.filter((a) => !hasIncoming.has(a.id)).map((a) => a.id)
  return roots.length > 0 ? roots : spec.agents.slice(0, 1).map((a) => a.id)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function runSwarm(
  spec: SwarmSpec,
  keys: ApiKeys,
  cb: RunnerCallbacks,
  signal: AbortSignal,
  endpoints: Endpoints = {},
): Promise<void> {
  const byId = new Map(spec.agents.map((a) => [a.id, a]))
  const entryIds = resolveEntryIds(spec)
  if (entryIds.length === 0) {
    cb.onPhase('error', 'Add at least one agent before running.')
    return
  }

  const outgoing = (id: string) => spec.links.filter((l) => l.source === id && byId.has(l.target))
  const incomingFromEntry = (id: string) => spec.links.filter((l) => l.target === id && entryIds.includes(l.source))

  /** Each agent keeps its own conversation, so it remembers what it already said. */
  const memory = new Map<string, ChatMessage[]>()
  const rrCursor = new Map<string, number>()
  let counter = 0

  let active = entryIds.slice()
  let inbox = new Map<string, ChatMessage[]>(active.map((id) => [id, [{ role: 'user', content: spec.task }]]))

  cb.onPhase('running')

  try {
    for (let round = 1; round <= spec.maxRounds; round++) {
      if (signal.aborted) break
      if (active.length === 0) break
      cb.onRound(round)
      for (const id of active) cb.onAgentStatus(id, 'queued')

      const turns = active.map(async (agentId, index) => {
        const agent = byId.get(agentId)!
        // A small stagger: the swarm wakes up as a wave instead of a flat blink.
        await sleep(index * 140)
        if (signal.aborted) return null
        return speak(agent, round)
      })

      const spoken = (await Promise.all(turns)).filter(Boolean) as Turn[]
      if (signal.aborted) break

      // Hand each message to the agents its author may speak to. The targets were chosen once,
      // inside the turn — picking them again here would advance the round-robin cursor twice.
      const nextInbox = new Map<string, ChatMessage[]>()
      const transiting: string[] = []
      for (const { agent, text, targets } of spoken) {
        for (const link of targets) {
          transiting.push(link.id)
          const queue = nextInbox.get(link.target) ?? []
          queue.push({ role: 'user', content: `${agent.name} said:\n${text}` })
          nextInbox.set(link.target, queue)
        }
      }
      if (transiting.length > 0) {
        cb.onTransit(transiting)
        await sleep(650)
      }

      inbox = nextInbox
      active = [...nextInbox.keys()]
    }

    cb.onPhase(signal.aborted ? 'stopped' : 'done')
  } catch (err) {
    if (signal.aborted) cb.onPhase('stopped')
    else cb.onPhase('error', err instanceof Error ? err.message : String(err))
  }

  /** Who this agent hands its message to, under the current topology. */
  function pickTargets(agent: Agent) {
    const isEntry = entryIds.includes(agent.id)
    if (spec.topology === 'manager' && !isEntry) {
      // Workers report back up to the manager rather than onwards.
      return incomingFromEntry(agent.id).map((l) => ({ id: l.id, target: l.source }))
    }
    const links = outgoing(agent.id)
    if (links.length === 0) return []
    if (spec.topology === 'round-robin') {
      const cursor = rrCursor.get(agent.id) ?? 0
      rrCursor.set(agent.id, cursor + 1)
      const link = links[cursor % links.length]
      return [{ id: link.id, target: link.target }]
    }
    return links.map((l) => ({ id: l.id, target: l.target }))
  }

  async function speak(agent: Agent, round: number): Promise<Turn | null> {
    const arriving = inbox.get(agent.id) ?? []
    const history = memory.get(agent.id) ?? []
    const messages = [...history, ...arriving]
    const entryId = `m${++counter}`
    // Chosen once per turn: the transcript and the animation must agree with the delivery.
    const targets = pickTargets(agent)
    const targetIds = targets.map((t) => t.target)

    const entry: TranscriptEntry = {
      id: entryId,
      round,
      agentId: agent.id,
      to: targetIds,
      text: '',
      status: 'streaming',
      tokensIn: estimateTokens(agent.systemPrompt + messages.map((m) => m.content).join('')),
      tokensOut: 0,
      startedAt: Date.now(),
    }
    cb.onMessageStart(entry)
    cb.onAgentStatus(agent.id, 'thinking')

    let firstDelta = true
    try {
      const result = await callProvider(agent.provider, {
        model: agent.model,
        system: buildSystem(agent, spec, targetIds.map((id) => byId.get(id)?.name ?? id)),
        messages,
        temperature: agent.temperature,
        apiKey: keys[agent.provider] ?? '',
        endpoint: resolveEndpoint(agent.provider, endpoints),
        signal,
        onDelta: (delta) => {
          if (firstDelta) {
            firstDelta = false
            cb.onAgentStatus(agent.id, 'speaking')
          }
          cb.onMessageDelta(entryId, delta)
        },
      })
      memory.set(agent.id, [...messages, { role: 'assistant', content: result.text }])
      cb.onMessageEnd(entryId, {
        text: result.text,
        status: 'complete',
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        endedAt: Date.now(),
      })
      cb.onAgentStatus(agent.id, 'done')
      return { agent, text: result.text, targets }
    } catch (err) {
      if (signal.aborted) {
        cb.onMessageEnd(entryId, { status: 'error', text: '(stopped)', endedAt: Date.now() })
        cb.onAgentStatus(agent.id, 'idle')
        return null
      }
      const message = err instanceof Error ? err.message : String(err)
      cb.onMessageEnd(entryId, { status: 'error', text: message, endedAt: Date.now() })
      cb.onAgentStatus(agent.id, 'error')
      throw err
    }
  }
}

/** The agent's own prompt, plus just enough context to know where its words go. */
function buildSystem(agent: Agent, spec: SwarmSpec, targetNames: string[]): string {
  const lines = [agent.systemPrompt.trim()]
  lines.push('')
  lines.push(`You are "${agent.name}", one agent in a multi-agent swarm working on a shared task.`)
  lines.push(`Shared task: ${spec.task.trim()}`)
  if (targetNames.length > 0) {
    lines.push(`Your answer will be sent to: ${targetNames.join(', ')}. Write for them, not for a human reader.`)
  } else {
    lines.push('You are the last agent in the chain: your answer is the swarm output.')
  }
  lines.push('Be substantive and brief — at most one short paragraph.')
  return lines.join('\n')
}
