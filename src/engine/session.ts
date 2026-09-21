/**
 * A run session: the part of a run that must OUTLIVE one call to `runSwarm`.
 *
 * Two things the engine could not do before, both asked for on 14/09:
 *  · **pause and resume** — the loop waits at a round boundary instead of unwinding;
 *  · **inject a message wherever you want** — a human message handed to a chosen agent, delivered
 *    with the next round, which also makes that agent active even if the swarm had moved past it.
 *
 * Per-agent memory and the round-robin cursors live here rather than inside `runSwarm`, so that a
 * finished run can be CONTINUED with its context intact instead of restarted from nothing. The same
 * goes for the graph state added with version 2: shared memories, loop budgets, join holdings.
 *
 * Pausing takes effect at the next round boundary, never mid-stream: a request already in flight is
 * left to finish. Cutting a stream in half would lose the answer, which is what Stop is for.
 *
 * Human gates are the one place the engine waits on a person inside a round: a message reached a
 * gate node, and the flow behind it stays put until `decideGate` is called (or the run is stopped).
 */
import type { ChatMessage } from './providers.ts'
import type { MemoryState } from './memory.ts'
import type { DecisionAnswers } from '../types.ts'

export interface Injection {
  /** Which agent receives it. */
  agentId: string
  text: string
}

export interface GateDecision {
  approved: boolean
  /** The text that goes on, possibly edited by the human. */
  text: string
}

export interface PendingGate {
  id: string
  nodeId: string
  /** Where the gate is: block node ids from the top level down. */
  path: string[]
  name: string
  prompt: string
  text: string
}

/** Something waiting in a node's inbox. Converted to a chat message only when an agent reads it. */
export interface Delivery {
  kind: 'task' | 'part' | 'human' | 'system' | 'bus' | 'delegation'
  author?: string
  text: string
  /**
   * Typed answers a Decision node attached. They travel with the message through zero-token nodes,
   * so a guard two hops downstream can still read `route.choice`; the next agent's turn is a new
   * message and does not carry them.
   */
  decision?: DecisionAnswers
}

/** Everything a graph level remembers between rounds, and between a run and its continuation. */
export interface GraphState {
  memory: Map<string, ChatMessage[]>
  rrCursor: Map<string, number>
  memories: Map<string, MemoryState>
  /** How many times each link has carried a message. */
  traversals: Map<string, number>
  /** How many times each deterministic node has fired. */
  fires: Map<string, number>
  /** What each join is holding, by incoming link id, and since which round. */
  holdings: Map<string, { since: number; parts: Map<string, Delivery[]>; armed: boolean }>
}

export function createGraphState(): GraphState {
  return {
    memory: new Map(),
    rrCursor: new Map(),
    memories: new Map(),
    traversals: new Map(),
    fires: new Map(),
    holdings: new Map(),
  }
}

export interface RunSession {
  /** Each agent's conversation so far. Survives across continued runs. */
  memory: Map<string, ChatMessage[]>
  /** Round-robin position per agent, so a continuation does not restart the rotation. */
  rrCursor: Map<string, number>
  /** The top-level graph state; `memory` and `rrCursor` above are its two oldest fields. */
  graph: GraphState
  isPaused: () => boolean
  pause: () => void
  resume: () => void
  /** Queue a human message for an agent. Returns the injection as queued. */
  inject: (agentId: string, text: string) => Injection
  /** Hands over everything queued and empties the queue. */
  takeInjections: () => Injection[]
  /** How many are waiting — for a UI that has to say "2 messages will be delivered on resume". */
  pendingInjections: () => number
  /** Resolves when the session is not paused, or immediately if the signal is already aborted. */
  waitWhilePaused: (signal: AbortSignal) => Promise<void>
  /** Parks the flow at a gate. Resolves with the decision, or `null` if the run is stopped first. */
  waitForGate: (gate: PendingGate, signal: AbortSignal) => Promise<GateDecision | null>
  /** Returns false when no gate with that id is waiting (already decided, or stopped). */
  decideGate: (id: string, decision: GateDecision) => boolean
  pendingGates: () => PendingGate[]
}

export function createRunSession(): RunSession {
  const graph = createGraphState()
  let injections: Injection[] = []
  let paused = false
  /** Everyone waiting on the pause gate. Resolved together by `resume`. */
  let waiters: Array<() => void> = []
  const gates = new Map<string, { gate: PendingGate; resolve: (d: GateDecision | null) => void }>()

  const release = () => {
    const pending = waiters
    waiters = []
    for (const resolve of pending) resolve()
  }

  return {
    memory: graph.memory,
    rrCursor: graph.rrCursor,
    graph,
    isPaused: () => paused,

    pause: () => {
      paused = true
    },

    resume: () => {
      paused = false
      release()
    },

    inject: (agentId, text) => {
      const injection = { agentId, text }
      injections.push(injection)
      return injection
    },

    takeInjections: () => {
      const taken = injections
      injections = []
      return taken
    },

    pendingInjections: () => injections.length,

    waitWhilePaused: (signal) =>
      new Promise<void>((resolve) => {
        if (!paused || signal.aborted) return resolve()
        // Stopping while paused must not hang the loop for ever: the abort releases the gate too.
        const onAbort = () => {
          waiters = waiters.filter((w) => w !== wake)
          resolve()
        }
        const wake = () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        }
        signal.addEventListener('abort', onAbort, { once: true })
        waiters.push(wake)
      }),

    waitForGate: (gate, signal) =>
      new Promise<GateDecision | null>((resolve) => {
        if (signal.aborted) return resolve(null)
        const onAbort = () => {
          gates.delete(gate.id)
          resolve(null)
        }
        signal.addEventListener('abort', onAbort, { once: true })
        gates.set(gate.id, {
          gate,
          resolve: (decision) => {
            signal.removeEventListener('abort', onAbort)
            gates.delete(gate.id)
            resolve(decision)
          },
        })
      }),

    decideGate: (id, decision) => {
      const waiting = gates.get(id)
      if (!waiting) return false
      waiting.resolve(decision)
      return true
    },

    pendingGates: () => [...gates.values()].map((g) => g.gate),
  }
}
