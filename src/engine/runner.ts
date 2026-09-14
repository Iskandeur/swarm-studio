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
import { createRunSession, type Injection, type RunSession } from './session.ts'

export interface RunnerCallbacks {
  onPhase: (phase: 'running' | 'done' | 'error' | 'stopped' | 'paused', detail?: string) => void
  onRound: (round: number) => void
  onAgentStatus: (agentId: string, status: AgentStatus) => void
  onMessageStart: (entry: TranscriptEntry) => void
  onMessageDelta: (entryId: string, delta: string) => void
  onMessageEnd: (entryId: string, patch: Partial<TranscriptEntry>) => void
  /**
   * Messages in flight, for the animation.
   *
   * `reversed` matters: in manager topology a worker's reply travels UP its own downward link, so
   * the packet has to run from target to source. Without the flag, the delegation round and the
   * collection round were pixel-identical and the animation contradicted the transcript.
   */
  onTransit: (packets: TransitPacket[]) => void
  /** Something worth telling the user that did not stop the run. */
  onNotice?: (message: string) => void
  /** A human message entering the swarm, so the transcript shows it in its place. */
  onInjection?: (injection: Injection & { round: number }) => void
}

export type ApiKeys = Partial<Record<string, string>>

/** A message on a link, and which way along it. */
export interface TransitPacket {
  id: string
  /** true when the message runs against the link's own direction (a manager-mode reply). */
  reversed: boolean
}

/** One agent's completed turn: what it said, and which links carry it onwards. */
interface Turn {
  agent: Agent
  text: string
  targets: Array<{ id: string; target: string; reversed?: boolean }>
}

/** Agents that receive the task: the explicit entry list, or every root of the graph. */
export function resolveEntryIds(spec: SwarmSpec): string[] {
  if (spec.entryIds.length > 0) return spec.entryIds.filter((id) => spec.agents.some((a) => a.id === id))
  const hasIncoming = new Set(spec.links.map((l) => l.target))
  const roots = spec.agents.filter((a) => !hasIncoming.has(a.id)).map((a) => a.id)
  return roots.length > 0 ? roots : spec.agents.slice(0, 1).map((a) => a.id)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface RunOptions {
  endpoints?: Endpoints
  /** Reuse a session to keep memory and cursors across a continued run. */
  session?: RunSession
  /** Agents that speak first, overriding the spec's entry points (used to continue from one agent). */
  startFrom?: string[]
}

export async function runSwarm(
  spec: SwarmSpec,
  keys: ApiKeys,
  cb: RunnerCallbacks,
  signal: AbortSignal,
  options: RunOptions = {},
): Promise<void> {
  const endpoints = options.endpoints ?? {}
  const session = options.session ?? createRunSession()
  const byId = new Map(spec.agents.map((a) => [a.id, a]))
  const entryIds = resolveEntryIds(spec)
  if (entryIds.length === 0) {
    cb.onPhase('error', 'Add at least one agent before running.')
    return
  }

  const outgoing = (id: string) => spec.links.filter((l) => l.source === id && byId.has(l.target))
  const incomingFromEntry = (id: string) => spec.links.filter((l) => l.target === id && entryIds.includes(l.source))

  /** Each agent keeps its own conversation, so it remembers what it already said. */
  const memory = session.memory
  const rrCursor = session.rrCursor
  let counter = 0

  /**
   * An inner signal, so that one agent's failure stops its siblings.
   *
   * Agents in a round run concurrently. Without this, a provider error in one of them set the run
   * to "error" while the others kept streaming text into the transcript — a failed run that goes on
   * talking, which is worse than either outcome on its own.
   */
  const inner = new AbortController()
  const stopEverything = () => inner.abort()
  if (signal.aborted) inner.abort()
  else signal.addEventListener('abort', stopEverything, { once: true })
  /**
   * Set when a turn fails for a real reason, to tell "stopped by the user" from "broke".
   * A holder object rather than a bare `let`: it is written inside a closure, and the compiler
   * narrows a closure-assigned local to `never` at the read site.
   */
  const failed: { error: Error | null } = { error: null }
  /** Agents told "queued" that have not reached a terminal status yet. */
  const queued = new Set<string>()

  const start = (options.startFrom ?? entryIds).filter((id) => byId.has(id))
  let active = start.length > 0 ? start : entryIds.slice()
  // A continued run does not repeat the task: the agents already have it in their memory.
  const seed = options.startFrom ? [] : [{ role: 'user' as const, content: spec.task }]
  let inbox = new Map<string, ChatMessage[]>(seed.length > 0 ? active.map((id) => [id, [...seed]]) : [])

  /**
   * Hands queued human messages to their agents and makes them active.
   *
   * An injected message can wake an agent the swarm had already moved past — that is the point of
   * "input wherever I want": the graph says who may speak to whom, and a human is outside it.
   */
  const deliverInjections = (round: number) => {
    for (const injection of session.takeInjections()) {
      if (!byId.has(injection.agentId)) continue
      const queue = inbox.get(injection.agentId) ?? []
      queue.push({ role: 'user', content: `The human running this swarm says:\n${injection.text}` })
      inbox.set(injection.agentId, queue)
      if (!active.includes(injection.agentId)) active.push(injection.agentId)
      cb.onInjection?.({ ...injection, round })
    }
  }

  cb.onPhase('running')

  try {
    for (let round = 1; round <= spec.maxRounds; round++) {
      if (signal.aborted) break

      // The pause gate sits at the round boundary, before the "nobody left to speak" check: an
      // injection arriving while paused can repopulate the active set, which is how a finished-
      // looking run picks up again.
      if (session.isPaused()) {
        cb.onPhase('paused')
        await session.waitWhilePaused(signal)
        if (signal.aborted) break
        cb.onPhase('running')
      }
      deliverInjections(round)

      if (active.length === 0) break
      cb.onRound(round)
      for (const id of active) {
        cb.onAgentStatus(id, 'queued')
        queued.add(id)
      }

      const turns = active.map(async (agentId, index) => {
        const agent = byId.get(agentId)!
        // A small stagger: the swarm wakes up as a wave instead of a flat blink.
        await sleep(index * 140)
        if (inner.signal.aborted) return null
        return speak(agent, round)
      })

      // allSettled, not all: a rejection must not leave the siblings unobserved and still writing.
      // `speak` already aborts the inner signal on a real failure, so they wind down on their own.
      const settled = await Promise.allSettled(turns)
      const spoken = settled
        .map((result) => (result.status === 'fulfilled' ? result.value : null))
        .filter(Boolean) as Turn[]
      if (failed.error) throw failed.error
      if (inner.signal.aborted) break

      // Hand each message to the agents its author may speak to. The targets were chosen once,
      // inside the turn — picking them again here would advance the round-robin cursor twice.
      const nextInbox = new Map<string, ChatMessage[]>()
      const transiting: TransitPacket[] = []
      for (const { agent, text, targets } of spoken) {
        for (const link of targets) {
          transiting.push({ id: link.id, reversed: Boolean(link.reversed) })
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

    if (failed.error) cb.onPhase('error', failed.error.message)
    else cb.onPhase(signal.aborted ? 'stopped' : 'done')
  } catch (err) {
    // `failed.error` wins over the abort flag: the inner signal is aborted BY the failure, so reading the
    // signal alone would report every breakage as "the user stopped it".
    if (failed.error) cb.onPhase('error', failed.error.message)
    else if (signal.aborted) cb.onPhase('stopped')
    else cb.onPhase('error', err instanceof Error ? err.message : String(err))
  } finally {
    signal.removeEventListener('abort', stopEverything)
    // Nodes marked `queued` that never got to speak would keep that badge for ever — stopping
    // during the wake-up stagger left the graph claiming agents were still waiting their turn.
    for (const id of queued) cb.onAgentStatus(id, 'idle')
  }

  /**
   * Who this agent hands its message to, under the current topology.
   * `reversed` says the message travels against the link's own direction, which only manager-mode
   * replies do — and which the animation has to know, or it draws the opposite of what happened.
   */
  function pickTargets(agent: Agent): Array<{ id: string; target: string; reversed?: boolean }> {
    const isEntry = entryIds.includes(agent.id)
    if (spec.topology === 'manager' && !isEntry) {
      // Workers report back up to the manager rather than onwards.
      return incomingFromEntry(agent.id).map((l) => ({ id: l.id, target: l.source, reversed: true }))
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
        signal: inner.signal,
        onNotice: cb.onNotice,
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
      queued.delete(agent.id)
      cb.onAgentStatus(agent.id, 'done')
      return { agent, text: result.text, targets }
    } catch (err) {
      // Stopped — either by the user, or by a sibling's failure winding the round down.
      // ⚠️ The text is NOT overwritten: whatever already streamed is the most interesting part of a
      // halted answer, and replacing it with "(stopped)" threw away work the user watched arrive.
      if (inner.signal.aborted) {
        cb.onMessageEnd(entryId, { status: 'stopped', endedAt: Date.now() })
        queued.delete(agent.id)
        cb.onAgentStatus(agent.id, 'idle')
        return null
      }
      const message = err instanceof Error ? err.message : String(err)
      cb.onMessageEnd(entryId, { status: 'error', text: message, endedAt: Date.now() })
      queued.delete(agent.id)
      cb.onAgentStatus(agent.id, 'error')
      // Remember the cause, THEN stop the siblings: they must not keep streaming into a failed run.
      failed.error = err instanceof Error ? err : new Error(message)
      inner.abort()
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
