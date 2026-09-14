/**
 * A run session: the part of a run that must OUTLIVE one call to `runSwarm`.
 *
 * Two things the engine could not do before, both asked for on 14/09:
 *  · **pause and resume** — the loop waits at a round boundary instead of unwinding;
 *  · **inject a message wherever you want** — a human message handed to a chosen agent, delivered
 *    with the next round, which also makes that agent active even if the swarm had moved past it.
 *
 * Per-agent memory and the round-robin cursors live here rather than inside `runSwarm`, so that a
 * finished run can be CONTINUED with its context intact instead of restarted from nothing.
 *
 * Pausing takes effect at the next round boundary, never mid-stream: a request already in flight is
 * left to finish. Cutting a stream in half would lose the answer, which is what Stop is for.
 */
import type { ChatMessage } from './providers.ts'

export interface Injection {
  /** Which agent receives it. */
  agentId: string
  text: string
}

export interface RunSession {
  /** Each agent's conversation so far. Survives across continued runs. */
  memory: Map<string, ChatMessage[]>
  /** Round-robin position per agent, so a continuation does not restart the rotation. */
  rrCursor: Map<string, number>
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
}

export function createRunSession(): RunSession {
  const memory = new Map<string, ChatMessage[]>()
  const rrCursor = new Map<string, number>()
  let injections: Injection[] = []
  let paused = false
  /** Everyone waiting on the pause gate. Resolved together by `resume`. */
  let waiters: Array<() => void> = []

  const release = () => {
    const pending = waiters
    waiters = []
    for (const resolve of pending) resolve()
  }

  return {
    memory,
    rrCursor,
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
  }
}
